/**
 * ESPN ingestion: plan targets, fetch, upsert games + lines. PLAN.md §8.
 *
 * Non-negotiables:
 *   * Parse fully into memory FIRST; write only after a clean parse. An ESPN
 *     outage or schema change must leave existing rows untouched.
 *   * A `final` game is never regressed to `scheduled` (the upsert's WHERE
 *     clause), so a feed glitch cannot re-open betting on a played game.
 *   * Scores are COALESCEd, so a payload that omits a score cannot null it out.
 *   * Games are never deleted while `bet_legs` reference them.
 *
 * WRITE BUDGET IS A CORRECTNESS CONCERN, NOT AN OPTIMISATION. D1 free allows
 * 100,000 rows written per UTC day and has hard-enforced it since 2026-09-01:
 * past the cap D1 returns errors, which blocks BET PLACEMENT and SETTLEMENT, not
 * just the board. Three levers are v1 requirements, not future work:
 *
 *   L1 COMPARE-AND-SKIP. Every write's `WHERE` compares old and new row values
 *      and skips entirely when nothing changed. A refresh of a game whose data
 *      has not moved writes ZERO rows -- and therefore zero index entries.
 *   L1b INDEXED/NON-INDEXED SPLIT. L1 alone buys nothing for a LIVE game,
 *      because `display_clock` changes on every single refresh. SQLite rewrites
 *      an index whenever its column appears in an UPDATE's SET list, whether or
 *      not the value changed, so a single statement carrying the whole SET list
 *      costs 4 rows written (table + `idx_games_board` + `idx_games_status` +
 *      `idx_games_week`) for a clock-only change. Each game is therefore written
 *      as TWO statements: (A) the full upsert, whose WHERE demands that an
 *      INDEXED column (`status`/`kickoff_at`/`week`) actually changed, and
 *      (B) a plain UPDATE carrying only NON-indexed columns, which costs exactly
 *      1 row. Measured on miniflare D1: clock-only 1, score-only 1, rank-only 1,
 *      L3 touch 1, status transition 4, unchanged 0. See PLAN.md §8.5/§8.6.
 *   L2 NO LINE WRITES FOR NON-SCHEDULED GAMES. Measured on the committed
 *      samples: 0 of 84 in-progress/final events carried odds. Refreshing
 *      `game_lines` for a live game is pure waste; skip it at the mapper.
 *   L3 TOUCH INTERVALS. `games.last_seen_at` is only bumped when it is older
 *      than GAME_SEEN_TOUCH_MS (6 h) and `game_lines.seen_at` when older than
 *      LINE_SEEN_TOUCH_MS (45 min), so "still here" costs at most 4 and 32 row
 *      writes per game per day instead of 96.
 *
 * Observability, not faith: every run reports `rowsWritten` (summed from D1's
 * `meta.rows_written`, which counts index entries) and `rowsSkipped` into
 * `job_runs.stats`, and `tests/worker/ingest.spec.ts` carries the CI regression
 * guard for an 86-game Saturday refreshed on all 480 three-minute ticks
 * (M13b: 7,922 rows measured, < 13,300 asserted, PLAN.md §24.13).
 *
 * MLB (PLAN.md §23.11) is CHEAPER per live refresh than football: ESPN's MLB
 * `displayClock` is always "0:00", so (B) writes only when the score or the
 * inning (`period`) moves. ≈ 55 rows per game per day, ≈ 1,050/day for a
 * 15-game slate including its target's reschedules — about 1% of the cap.
 * `tests/worker/mlb.spec.ts` guards it at < 1,000 rows for 15 games over 480
 * ticks (741 measured at M13b), beside the CFB guard.
 *
 * STATEMENT COUNT: two per game plus one per line, chunked through `runBatch` at
 * MAX_BATCH_STATEMENTS. An 86-game target is ~172 statements in one invocation,
 * which is the deliberate exception to db.ts's per-invocation budget note.
 */

import { postponedVoidConfirmAt } from '../shared/action.js';
import {
  ESPN_MAX_WARNINGS_RECORDED,
  GAME_SEEN_TOUCH_MS,
  HEALTH_STALE_TICKS,
  INGEST_MAX_INCOMPLETE_ATTEMPTS,
  INGEST_PARKED_RETRY_MS,
  INGEST_WINDOW_MS,
  LINE_SEEN_TOUCH_MS,
  REFRESH_BACKOFF_BASE_TICKS,
  REFRESH_DISCOVERY_EVERY_NTH_TICK,
  REFRESH_DISCOVERY_TICKS,
  REFRESH_TICK_MS,
  REFRESH_WEIGHT_BUDGET,
} from '../shared/constants.js';
import type { ParseWarning } from '../shared/espn.js';
import {
  LIVE_HORIZON_MS,
  REFRESH_DISCOVERY_MS,
  boardWindowEnd,
  REFRESH_DONE_MS,
  REFRESH_LIVE_MS,
  REFRESH_SOON_MS,
  SOON_HORIZON_MS,
  etDateKey,
  etDateKeyRange,
  etDayBounds,
} from '../shared/time.js';
import { LEAGUES } from '../shared/types.js';
import type { EpochMs, Game, GameLines, League } from '../shared/types.js';
import { changesAt, MAX_BATCH_STATEMENTS, rowsWrittenAt, rowsWrittenOf, runBatch } from './db.js';
import type { Env } from './env.js';
import { readConfig } from './env.js';
import { EspnProvider } from './espn.js';
import { ProviderError } from './providers.js';
import type { ProviderSlate, ScoreProvider, SlateTarget } from './providers.js';
import { runSecondary } from './secondary.js';
import type { SecondaryStats } from './secondary.js';

export interface IngestTargetRow {
  readonly id: string;
  readonly league: League;
  /** v1 always constructs 'date'. See PLAN.md §8.2. */
  readonly kind: 'week' | 'date';
  readonly key: string;
  readonly windowStartAt: EpochMs;
  readonly windowEndAt: EpochMs;
  readonly priority: number;
  readonly nextRunAt: EpochMs;
  readonly consecutiveFailures: number;
  /**
   * The poison-target guard's counter (PLAN.md §24.4): attempts stamped but
   * never rescheduled. > 0 means the target runs alone; at
   * `INGEST_MAX_INCOMPLETE_ATTEMPTS` it is PARKED.
   */
  readonly incompleteAttempts: number;
}

export interface IngestStats extends LineGapStats {
  readonly targetsProcessed: number;
  /** `games` rows that actually changed (one per game, however many statements). */
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  /**
   * D1 `meta.rows_written` summed over every statement the run issued: TABLE
   * rows PLUS index entries, which is the unit the hard-enforced 100,000/day cap
   * counts. THIS is the number to watch, not `gamesUpserted` — a single indexed
   * `games` update costs 4 of these. PLAN.md §8.6.
   */
  readonly rowsWritten: number;
  /** Upsert UNITS (one per game, one per line) the compare-and-skip guard left alone. */
  readonly rowsSkipped: number;
  readonly warnings: readonly string[];
  /**
   * One entry per failed target. `espn` is the fetch's outcome (§24.6's
   * vocabulary) and `consecutiveFailures` the streak AFTER this failure, which
   * is what the `espn-status` alert keys on (§24.6b: a blip is not an email).
   */
  readonly failures: readonly IngestFailure[];
  /**
   * ESPN outcomes, one per target fetched this run, in §24.6's fixed vocabulary
   * (`'200'`, `'403'`, `'429'`, `'5xx'`, `'4xx'`, `'timeout'`, `'network'`,
   * `'bad-json'`), so the totals are summable across runs (`dayEspnStatus`).
   */
  readonly espnStatus: Readonly<Record<string, number>>;
  /**
   * Every PARKED target (`incomplete_attempts >= INGEST_MAX_INCOMPLETE_ATTEMPTS`)
   * after this run, read once from the ~30-row table. The admin Jobs page shows
   * the newest run's list as a banner (PLAN.md §24.4).
   */
  readonly parked: readonly ParkedTarget[];
  /**
   * The `LineGapStats` counts per target, because the run total conflates two
   * different things: the live date's board (what a bettor sees today) and the
   * discovery slot's future date (later in the week, where the book has often
   * posted nothing yet). Only the per-target rows are comparable run to run.
   */
  readonly coverage: readonly TargetCoverage[];
  /** The secondary odds sweep's report for this run, every path (PLAN.md §21.8). */
  readonly secondary: SecondaryStats;
}

export interface IngestFailure {
  readonly targetId: string;
  readonly error: string;
  readonly espn: string;
  readonly consecutiveFailures: number;
}

export interface ParkedTarget {
  readonly targetId: string;
  readonly incompleteAttempts: number;
  readonly attemptStartedAt: EpochMs | null;
}

export interface RefreshOptions {
  /**
   * The admin's per-game Refresh: waive THAT game's `SECONDARY_RETRY_MS`
   * backoff and nothing else (PLAN.md §21.2). Null on the cron and on the
   * admin "Run refresh".
   */
  readonly forceSecondaryGameId: string | null;
  /**
   * The tick's NOMINAL instant, `controller.scheduledTime` on a cron run
   * (PLAN.md §24.7). Absent (an admin run, a direct call): the floor fallback,
   * the tick at or before `now`.
   */
  readonly scheduledTime?: EpochMs | null;
  /**
   * `'admin'` runs are ALWAYS general — never discovery-first — so a per-game
   * Refresh claims the slate it just bumped (§9.3). Default `'cron'`.
   */
  readonly trigger?: 'cron' | 'admin';
}

export interface TargetCoverage {
  readonly targetId: string;
  readonly upcomingGames: number;
  readonly lineGaps: number;
}

/**
 * How much of the board the odds feed actually covers — the measurement that
 * decides whether a second odds provider is worth building (PLAN.md §8.3).
 *
 * `upcomingGames` is every game that is SCHEDULED and whose kickoff is still
 * ahead of `now` — `lineRowsWorthWriting` keys on status alone, and the extra
 * clock test is deliberate: writing a line for a game ESPN still calls "pre" a
 * minute after kickoff is harmless, but counting its just-pulled market as a
 * coverage gap is noise. `lineGaps` is how many of those have no line at all or
 * are missing a market, and the per-market counters say WHICH — a missing
 * moneyline on a heavy favourite is normal at every book (PLAN.md §14.9), so
 * `noMoneyline` is the one to discount. `lineGapDetails` names them; the
 * counts are never capped and the details are capped once, in `runRefresh`.
 */
export interface LineGapStats {
  readonly upcomingGames: number;
  readonly lineGaps: number;
  readonly noLine: number;
  readonly noSpread: number;
  readonly noTotal: number;
  readonly noMoneyline: number;
  readonly lineGapDetails: readonly string[];
}

export interface IngestTargetResult extends LineGapStats {
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  /** See `IngestStats.rowsWritten`. Includes this target's own reschedule write. */
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly error: string | null;
  /** The fetch's outcome in §24.6's vocabulary; `'200'` when the fetch succeeded. */
  readonly espn: string;
  /**
   * Parser warnings for this target, already rendered as text. They are the
   * schema-drift alarm (PLAN.md §14.8) and are surfaced in `job_runs.stats`, so
   * they must travel back with the counts rather than being swallowed here.
   */
  readonly warnings: readonly string[];
  // The LineGapStats fields measure the PARSED slate, like `warnings`: zeros
  // when the fetch or parse failed (no slate), but a slate whose upsert threw
  // is still measured, and reported alongside its `error`.
}

/* ------------------------------------------------------------------ *
 * Tunables that are pure §8.4 policy rather than shared constants.
 * ------------------------------------------------------------------ */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Reschedule tiers live in src/shared/time.ts (PLAN.md §8.4) alongside the
 * staleness window that is derived from them; `KICKOFF_GRACE_MS` is only
 * meaningful to the planner and stays here. */
const KICKOFF_GRACE_MS = 4 * 60 * 60 * 1000;
/**
 * Failure backoff: `min(5 ticks × 2^consecutive_failures, 120 ticks)` = 15 min
 * doubling to 6 h — the pre-M13b wall-clock values, kept so a failing ESPN is
 * not retried 20 times an hour (§24.7). Counted from the tick's base.
 */
const BACKOFF_BASE_MS = REFRESH_BACKOFF_BASE_TICKS * REFRESH_TICK_MS;
const BACKOFF_CAP_MS = REFRESH_DISCOVERY_TICKS * REFRESH_TICK_MS;
/** A target whose window ended this long ago is retired by the planner. */
const TARGET_RETIRE_AFTER_MS = 2 * DAY_MS;

/** Statuses that mean "this game will never change again". */
const TERMINAL_STATUSES = new Set(['final', 'canceled']);

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

interface EtDay {
  readonly key: string;
  readonly startAt: EpochMs;
  readonly endAt: EpochMs;
}

/**
 * The ET calendar days covering `[from, to]` (a league's board window), with their
 * midnight-to-midnight bounds. `etDateKeyRange` walks day boundary to day
 * boundary, so re-walking with `etDayBounds` from the same cursor yields
 * exactly the same days — 23 h and 25 h DST days included.
 */
function etDaysInWindow(from: EpochMs, to: EpochMs): readonly EtDay[] {
  const keys = etDateKeyRange(from, to);
  const days: EtDay[] = [];
  let cursor = from;
  for (const key of keys) {
    const bounds = etDayBounds(cursor);
    days.push({ key, startAt: bounds.startAt, endAt: bounds.endAt });
    cursor = bounds.endAt;
  }
  return days;
}

export function targetId(league: League, key: string): string {
  return `${league}:date:${key}`;
}

/**
 * PLAN.md §9.3: an admin's "refresh this game". The unit of an ESPN request is a
 * DATE slate, so the game's own target is made the most due thing in the queue
 * — `next_run_at = 0`, which `claimDueTargets` orders first among equal
 * priorities — and the caller then runs one admin refresh, which takes exactly
 * one target. `priority` is deliberately untouched: the reschedule after the run
 * writes `next_run_at` only, so a lowered priority would pin the target at the
 * head of every later run.
 *
 * `'retired'` mirrors `planTargets`' retire rule EXACTLY (window ended more than
 * TARGET_RETIRE_AFTER_MS ago and nothing in it can still move): the run begins
 * with `planTargets`, which would delete the bumped row before it could be
 * claimed and then quietly refresh something else. Refusing up front is the
 * honest answer — there is nothing left to pull. A stuck (postponed, never
 * parsed) game keeps its slate alive and CAN be re-pulled however old it is;
 * the upsert re-creates the target row in case it is gone. `null` = no such game.
 *
 * ACCEPTED RACE: the bump and the caller's `runJob` are two round trips. A cron
 * tick that takes the lease in between claims the bumped target itself (it is
 * the most due for slot 1 there too), and the admin's run then refreshes the
 * next most due slate — the game IS refreshed, by the cron, but the admin's
 * `job_runs` row describes a different slate. Closing it would need the bump
 * inside the lease; at one cron tick per 15 min the window is not worth that.
 */
export async function bumpTargetForGame(
  env: Env,
  gameId: string,
  now: EpochMs,
): Promise<{ readonly targetId: string } | 'retired' | null> {
  const game = await env.DB.prepare('SELECT league, kickoff_at FROM games WHERE id = ?1')
    .bind(gameId)
    .first<{ league: League; kickoff_at: number }>();
  if (game === null) return null;
  const key = etDateKey(game.kickoff_at);
  const bounds = etDayBounds(game.kickoff_at);
  const id = targetId(game.league, key);
  if (bounds.endAt < now - TARGET_RETIRE_AFTER_MS) {
    const live = await env.DB.prepare(
      `SELECT 1 AS x FROM games
        WHERE league = ?1 AND kickoff_at >= ?2 AND kickoff_at < ?3
          AND status NOT IN ('final', 'canceled')
        LIMIT 1`,
    )
      .bind(game.league, bounds.startAt, bounds.endAt)
      .first<{ x: number }>();
    if (live === null) return 'retired';
  }
  await env.DB.prepare(
    `INSERT INTO ingest_targets
       (id, league, kind, key, window_start_at, window_end_at, priority,
        next_run_at, consecutive_failures, games_seen, created_at, updated_at)
     VALUES (?1, ?2, 'date', ?3, ?4, ?5, 100, 0, 0, 0, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET next_run_at = 0, updated_at = excluded.updated_at,
       -- The admin UN-PARK (PLAN.md §24.4): the one sanctioned reset outside
       -- the two reschedule paths (CLAUDE.md rule 8i). The run this bump then
       -- triggers stamps attempt 1.
       incomplete_attempts = 0, attempt_started_at = NULL`,
  )
    .bind(id, game.league, key, bounds.startAt, bounds.endAt, now)
    .run();
  return { targetId: id };
}

/**
 * Ensure an `ingest_targets` row exists for every US-Eastern calendar date in
 * each league's BOARD WINDOW — `now … boardWindowEnd(league, now)`, the Monday
 * that closes the football week (PLAN.md §22), or TODAY for MLB (§23.5, one
 * `mlb:date:YYYYMMDD` target per ET day) — and retire targets whose window
 * ended more than two days ago with no non-final games. Pure DB work, no
 * network, and no knowledge of the league calendar beyond "weeks end on Monday"
 * -- which is why the NFL postseason and bowl season need no special case.
 *
 * The day list is computed PER LEAGUE, not once: the two football leagues
 * differ for part of every Sunday (CFB rolls over to next week at 00:00 ET, the
 * NFL at 20:00 ET), and MLB's window is a single day. Yesterday's MLB target is
 * NOT deleted at midnight — the retirement rule keeps it until its games are
 * final plus two days, so for an hour or two after midnight a late game keeps
 * two MLB targets live. `INGEST_WINDOW_MS` is kept as a hard ceiling so that a bug in the
 * week arithmetic can never turn one invocation into thousands of statements.
 * The window only ever narrows day by day from Tuesday to the Sunday rollover,
 * and a target already created keeps refreshing until the retirement rule takes
 * it, so a game that leaves the BOARD keeps being ingested (§22.3).
 *
 * Returns the number of targets CREATED (0 on a steady-state rerun), which is
 * what makes the idempotency assertion in the spec a one-liner.
 */
/**
 * The retire rule's WHERE clause, `?1` = the cutoff. A NULL `conference_id` —
 * every target the planner emits today — makes the added parenthesis TRUE, so
 * it selects exactly what the pre-M13a SQL selected; a non-NULL one scopes the
 * "anything still moving" test to that conference's games (PLAN.md §24.8's
 * dormant per-conference groundwork). Exported for the equivalence test.
 */
export const RETIRE_PREDICATE = `window_end_at < ?1
        AND NOT EXISTS (
          SELECT 1 FROM games g
           WHERE g.league = ingest_targets.league
             AND g.kickoff_at >= ingest_targets.window_start_at
             AND g.kickoff_at <  ingest_targets.window_end_at
             AND (ingest_targets.conference_id IS NULL
                  OR ingest_targets.conference_id IN (g.home_conference_id, g.away_conference_id))
             AND g.status NOT IN ('final', 'canceled'))`;

export async function planTargets(env: Env, now: EpochMs): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const league of LEAGUES) {
    const end = Math.min(boardWindowEnd(league, now), now + INGEST_WINDOW_MS);
    for (const day of etDaysInWindow(now, end)) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO ingest_targets
             (id, league, kind, key, window_start_at, window_end_at, priority,
              next_run_at, consecutive_failures, games_seen, created_at, updated_at)
           VALUES (?, ?, 'date', ?, ?, ?, 100, ?, 0, 0, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          targetId(league, day.key),
          league,
          day.key,
          day.startAt,
          day.endAt,
          // Due immediately: a brand new date has no lines at all, and the
          // reserved discovery slot is what actually paces it afterwards.
          now,
          now,
          now,
        ),
      );
    }
  }

  const inserts = await runChunked(env.DB, statements);
  let created = 0;
  for (let i = 0; i < inserts.length; i += 1) created += changesAt(inserts, i);

  // Retire: window ended > 2 days ago AND nothing in it can still move. The
  // NOT EXISTS is the guard — a postponed game keeps its date alive so the
  // maintenance job can still watch it (PLAN.md §7.5).
  await env.DB.prepare(`DELETE FROM ingest_targets WHERE ${RETIRE_PREDICATE}`)
    .bind(now - TARGET_RETIRE_AFTER_MS)
    .run();

  return created;
}

/* ------------------------------------------------------------------ *
 * Claiming
 * ------------------------------------------------------------------ */

interface TargetDbRow {
  readonly id: string;
  readonly league: League;
  readonly kind: 'week' | 'date';
  readonly key: string;
  readonly window_start_at: number;
  readonly window_end_at: number;
  readonly priority: number;
  readonly next_run_at: number;
  readonly consecutive_failures: number;
  readonly incomplete_attempts: number;
}

/** A claim candidate: the target plus what it WEIGHS (§24.7). */
interface ClaimDbRow extends TargetDbRow {
  readonly games_seen: number;
  readonly last_ok_at: number | null;
}

function toTargetRow(row: TargetDbRow): IngestTargetRow {
  return {
    id: row.id,
    league: row.league,
    kind: row.kind,
    key: row.key,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    priority: row.priority,
    nextRunAt: row.next_run_at,
    consecutiveFailures: row.consecutive_failures,
    incompleteAttempts: row.incomplete_attempts,
  };
}

const TARGET_COLUMNS = `id, league, kind, key, window_start_at, window_end_at,
                        priority, next_run_at, consecutive_failures, incomplete_attempts`;

/**
 * The `NOT EXISTS` that makes a target "not live" — no in-progress game in it.
 * The `conference_id` parenthesis is TRUE for a NULL id (every target today),
 * so for those it is byte-for-byte the pre-M13a predicate; a segment target
 * (§24.8, dormant) is judged by its own conference's games only. Exported for
 * the equivalence test.
 */
export const NO_LIVE_GAME = `NOT EXISTS (
  SELECT 1 FROM games g
   WHERE g.league = t.league
     AND g.kickoff_at >= t.window_start_at
     AND g.kickoff_at <  t.window_end_at
     AND (t.conference_id IS NULL
          OR t.conference_id IN (g.home_conference_id, g.away_conference_id))
     AND g.status = 'in_progress')`;

/**
 * NOT PARKED, or parked long enough for ONE probation attempt (PLAN.md §24.4).
 * Bound: `?` = now. A parked target's `attempt_started_at` is never NULL (the
 * stamp wrote it; only the reschedules and the admin un-park clear it, and both
 * also zero the counter), so the NULL comparison never decides anything.
 */
const NOT_PARKED = `(incomplete_attempts < ${String(INGEST_MAX_INCOMPLETE_ATTEMPTS)}
       OR attempt_started_at <= ? - ${String(INGEST_PARKED_RETRY_MS)})`;

/**
 * `id NOT IN (...)` with a literal placeholder list. The ids are our own target
 * ids, never user input, but they still go through `bind` — this only builds the
 * placeholder text.
 */
function notInClause(count: number): string {
  return count === 0
    ? ''
    : ` AND id NOT IN (${Array.from({ length: count }, () => '?').join(', ')})`;
}

/**
 * The tick's NOMINAL instant (PLAN.md §24.7): `scheduledTime` from the cron
 * controller, else the floor fallback — the tick at or before `now` — for an
 * admin trigger or a direct call. Both are floored to the tick, which is the
 * identity for a `*\/3` controller and makes the base robust to anything else.
 * Every refresh cadence is a whole number of ticks from THIS, never from `now`:
 * a run that starts 7 s late and stamps `now + 1 tick` misses the next tick by
 * 7 s and waits a whole extra one (the alignment trap). Integer arithmetic:
 * `t - t % tick` is the floor without `Math.floor` (banned here, rule 2).
 */
export function refreshTickBase(now: EpochMs, scheduledTime?: EpochMs | null): EpochMs {
  const t = scheduledTime ?? now;
  return t - (t % REFRESH_TICK_MS);
}

/**
 * Is this tick DISCOVERY-FIRST (PLAN.md §24.7)? Every
 * `REFRESH_DISCOVERY_EVERY_NTH_TICK`-th tick — :00 :15 :30 :45, 96 a day,
 * exactly the supply the pre-M13b reserved slot gave. Judged on the tick's
 * nominal instant. Admin runs never ask (they are always general).
 */
export function isDiscoveryTick(tick: EpochMs): boolean {
  const base = refreshTickBase(tick);
  return (base / REFRESH_TICK_MS) % REFRESH_DISCOVERY_EVERY_NTH_TICK === 0;
}

/**
 * A target's WEIGHT for the per-run budget (PLAN.md §24.7): `games_seen` from
 * its last SUCCESSFUL fetch, at least 1 (an empty slate that succeeded still
 * costs a request). A target that has never succeeded (`last_ok_at IS NULL`,
 * written only by the success reschedule) weighs `REFRESH_WEIGHT_BUDGET + 1`,
 * i.e. BIG: its size is unknown, and a failed first fetch leaves
 * `games_seen = 0`, which must not make a 155-game date look empty.
 */
export function targetWeight(gamesSeen: number, lastOkAt: EpochMs | null): number {
  if (lastOkAt === null) return REFRESH_WEIGHT_BUDGET + 1;
  return Math.max(gamesSeen, 1);
}

/** What the packing reads per candidate. Pure, so it is unit-testable. */
export interface PackCandidate {
  readonly weight: number;
  readonly incompleteAttempts: number;
}

/**
 * THE PACKING RULE (PLAN.md §24.7), over candidates already in claim order.
 * Returns how many to take:
 *
 *   1. the first ALWAYS runs, whatever it weighs;
 *   2. a first with `incomplete_attempts > 0` runs ALONE (§24.4, M13a);
 *   3. then the next is added while the summed weight, the first's included,
 *      stays `<= budget` and the count `<= countCap`;
 *   4. it STOPS at the first candidate that does not fit, or that is blamed
 *      (`incomplete_attempts > 0`): no skipping ahead, so a big slate is never
 *      overtaken indefinitely by small ones, and a blamed target is never
 *      packed behind another (it is first in line on the next tick).
 */
export function packCount(
  candidates: readonly PackCandidate[],
  countCap: number,
  budget: number = REFRESH_WEIGHT_BUDGET,
): number {
  const first = candidates[0];
  if (first === undefined || countCap <= 0) return 0;
  if (first.incompleteAttempts > 0) return 1;
  let total = first.weight;
  let taken = 1;
  for (const next of candidates.slice(1)) {
    if (taken >= countCap) break;
    if (next.incompleteAttempts > 0) break;
    if (total + next.weight > budget) break;
    total += next.weight;
    taken += 1;
  }
  return taken;
}

/**
 * Claim the due targets for this run (PLAN.md §24.7, M13b).
 *
 * ONE read of the due candidates in claim order (`priority ASC, next_run_at
 * ASC, id ASC`), at most `countCap` of them, then `packCount` decides how many
 * run: the first always, then more while the WEIGHT BUDGET
 * (`REFRESH_WEIGHT_BUDGET`, 40 games) and the count cap
 * (`REFRESH_TARGETS_PER_RUN`, 5) allow, stopping at the first misfit. So a CFB
 * Saturday or a D-I basketball slate always runs alone, an NFL date and an MLB
 * day share, and empty future dates pack up to five to a run.
 *
 * DISCOVERY, IN TIME (`discoveryFirst`, every fifth tick): the first pick is
 * the most-overdue target with NO in-progress game (`NO_LIVE_GAME`), and the
 * rest follow in the general order (excluding it). If no non-live target is
 * due the tick falls through to the plain read, so no tick is wasted. Live
 * slates are perpetually due, so without this a day with two live slates
 * would starve next week's line discovery forever. The bound (§24.7): a due
 * non-live target with k others ahead of it waits at most 15·(k + 1) minutes.
 *
 * THE POISON-TARGET GUARD (§24.4, M13a). A PARKED target is skipped until
 * `INGEST_PARKED_RETRY_MS` after its last attempt (`NOT_PARKED`), then
 * claimable for one probation run. A BLAMED one (`incomplete_attempts > 0`)
 * runs alone if first and ends the packing otherwise (`packCount`). Every
 * guard is a WHERE clause or a pure rule over the rows just read (rule 5).
 *
 * Budget (computed, PLAN.md §8.4/§22/§23.11): at most 19 in-window targets
 * plus two or three past MLB dates on the +24 h tier; ≈ 70 discovery
 * refreshes a day against 96 discovery-first ticks. ROLLOVER BURST: the
 * Sunday rollover adds seven or eight never-fetched dates at once; each weighs
 * big and runs alone, so they drain one a tick — about 25 minutes on an idle
 * queue, and on the discovery-first ticks (one per 15 minutes) behind a live
 * Saturday (§22.6).
 *
 * NOTE this reads but does not write: the lease (PLAN.md §9.2) is what makes two
 * runs non-overlapping, so "claiming" needs no marker row and costs no writes.
 * The guard's stamp is NOT a claim marker — it is issued per target, by
 * `ingestTarget`, immediately before that target's own fetch.
 */
export async function claimDueTargets(
  env: Env,
  now: EpochMs,
  countCap: number,
  discoveryFirst: boolean,
): Promise<readonly IngestTargetRow[]> {
  if (countCap <= 0) return [];

  const read = async (
    where: string,
    exclude: readonly string[],
    limit: number,
  ): Promise<readonly ClaimDbRow[]> => {
    const res = await env.DB.prepare(
      `SELECT ${TARGET_COLUMNS}, games_seen, last_ok_at FROM ingest_targets AS t
        WHERE next_run_at <= ? ${notInClause(exclude.length)}
          AND ${NOT_PARKED} ${where}
        ORDER BY priority ASC, next_run_at ASC, id ASC
        LIMIT ?`,
    )
      .bind(now, ...exclude, now, limit)
      .all<ClaimDbRow>();
    return res.results;
  };

  let candidates: readonly ClaimDbRow[] = [];
  if (discoveryFirst) {
    const head = await read(`AND ${NO_LIVE_GAME}`, [], 1);
    const first = head[0];
    if (first !== undefined) {
      candidates = [first, ...(await read('', [first.id], countCap - 1))];
    }
  }
  // A general tick, or a discovery tick with nothing non-live due.
  if (candidates.length === 0) candidates = await read('', [], countCap);

  const take = packCount(
    candidates.map((row) => ({
      weight: targetWeight(row.games_seen, row.last_ok_at),
      incompleteAttempts: row.incomplete_attempts,
    })),
    countCap,
  );
  return candidates.slice(0, take).map(toTargetRow);
}

/** Translate an `ingest_targets` row into the provider's target shape. */
export function toSlateTarget(row: IngestTargetRow): SlateTarget {
  if (row.kind !== 'date') {
    // v1 never writes a 'week' row (PLAN.md §8.2). Failing loudly beats guessing
    // a season/seasonType/week decomposition out of an opaque key.
    throw new Error(`toSlateTarget: unsupported target kind '${row.kind}' for ${row.id}`);
  }
  return { kind: 'date', dateKey: row.key };
}

/* ------------------------------------------------------------------ *
 * Upserts (PLAN.md §8.5)
 * ------------------------------------------------------------------ */

/**
 * THE A/B SPLIT (PLAN.md §8.5). Read this before touching either statement.
 *
 * SQLite rewrites an index entry whenever the index's column appears in an
 * UPDATE's SET list, REGARDLESS of whether the value changed. Measured on
 * miniflare D1:
 *
 *     UPDATE games SET last_seen_at = ?                             -> 1 row
 *     UPDATE games SET last_seen_at = ?, status = status,
 *                      kickoff_at = kickoff_at, week = week          -> 4 rows
 *
 * `games` has three indexes and they cover exactly three mutable columns:
 * `idx_games_board(league, kickoff_at)`, `idx_games_status(status, kickoff_at)`,
 * `idx_games_week(league, season, season_type, week)`. So ONE statement carrying
 * the whole SET list costs 4 rows written for ANY applied update — a clock-only
 * change and an L3 "seen" touch included. For a live game `display_clock` moves
 * on every refresh, so compare-and-skip (L1) never fires and the old single
 * statement cost 4 rows x 86 games x 96 refreshes = 33k rows on a Saturday, i.e.
 * PLAN §8.6's "without the levers" figure.
 *
 * Hence two statements per game, in this order:
 *
 *   (A) GAME_UPSERT_SQL  INSERT ... ON CONFLICT DO UPDATE with the full SET
 *       list, gated on an INDEXED column having actually changed. New rows take
 *       the INSERT path. Only real status/kickoff/week transitions pay 4 rows.
 *   (B) GAME_LIVE_SQL    a plain UPDATE whose SET list contains NO indexed
 *       column, so it costs exactly 1 row. It carries the live churn
 *       (period, clock, scores, detail) plus the fields that used to be
 *       INSERT-only and went stale (ranks, logos, names).
 *
 * (A) runs first, so when it applies it already carries the new values and (B)
 * finds nothing to do. Statement count doubles; rows written collapse.
 *
 * DELIBERATELY NOT UPDATED AT ALL:
 *   * `original_kickoff_at` — a reschedule must keep the original (§8.5).
 *   * `neutral_site` — a DECISION, not an oversight: ESPN sets it when the
 *     event is created and flipping it after a bet was placed would silently
 *     change nothing we grade on (grading reads the `bet_legs` snapshot), while
 *     adding a column to the compare tuple that never moves. If ESPN is ever
 *     observed to correct it, move it into (B), where it costs 1 row.
 *   * `provider_event_id`, `league`, `season`, `season_type`, team ids/abbrs —
 *     identity. A change there is a different game.
 */

/** The three INDEXED mutable columns. A change here is what (A) exists for. */
const GAMES_INDEXED_OLD = `(games.status, games.kickoff_at, COALESCE(games.week, -1))`;
const GAMES_INDEXED_NEW = `(excluded.status, excluded.kickoff_at,
   COALESCE(COALESCE(excluded.week, games.week), -1))`;

/**
 * (B)'s comparison tuple: every column (B) writes except `last_seen_at` (the L3
 * stamp, which has its own clause) and `status_detail`.
 *
 * `status_detail` is DELIBERATELY absent — it is in the SET list but not the
 * tuple, so a change to only the human-readable detail string ("Final" ->
 * "Final/OT") is skipped until something else changes or the touch fires. It is
 * cosmetic, nothing reads it, and including it would buy writes for no
 * behavioural gain (PLAN.md §8.5).
 *
 * The old and new halves are shared verbatim by the `WHERE` and by the
 * `updated_at` CASE so the two can never drift.
 */
const GAMES_LIVE_OLD = `(period, display_clock,
   COALESCE(home_score, -1), COALESCE(away_score, -1),
   COALESCE(home_rank, -1), COALESCE(away_rank, -1),
   COALESCE(home_conference_id, ''), COALESCE(away_conference_id, ''),
   COALESCE(home_logo, ''), COALESCE(away_logo, ''),
   name, short_name, home_name, away_name)`;

/**
 * The bound counterpart of `GAMES_LIVE_OLD`. Scores are COALESCEd against the
 * stored value first, exactly as the SET list does, so a payload that omits a
 * score neither nulls it out nor counts as a change.
 *
 * Conference ids get the same treatment: a CFB payload that omits one is an
 * absence, never "this team left its conference", so an ESPN flap must not
 * clear the column, bump `updated_at`, and hand every pending bet on the game a
 * fresh settle budget (§7.1). Rank is deliberately NOT coalesced — for a rank,
 * NULL means "dropped out of the poll" and is a fact.
 */
const GAMES_LIVE_NEW = `(?, ?,
   COALESCE(COALESCE(?, home_score), -1), COALESCE(COALESCE(?, away_score), -1),
   COALESCE(?, -1), COALESCE(?, -1),
   COALESCE(COALESCE(?, home_conference_id), ''), COALESCE(COALESCE(?, away_conference_id), ''),
   COALESCE(?, ''), COALESCE(?, ''),
   ?, ?, ?, ?)`;

const GAME_UPSERT_SQL = `
INSERT INTO games (
  id, provider, provider_event_id, league, season, season_type, week,
  name, short_name, kickoff_at, original_kickoff_at, status, status_detail,
  period, display_clock, neutral_site,
  home_team_id, home_abbr, home_name, home_logo, home_rank, home_score,
  away_team_id, away_abbr, away_name, away_logo, away_rank, away_score,
  home_conference_id, away_conference_id,
  first_seen_at, last_seen_at, updated_at
) VALUES (?, 'espn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  kickoff_at    = excluded.kickoff_at,
  status        = excluded.status,
  status_detail = excluded.status_detail,
  period        = excluded.period,
  display_clock = excluded.display_clock,
  home_score    = COALESCE(excluded.home_score, games.home_score),
  away_score    = COALESCE(excluded.away_score, games.away_score),
  week          = COALESCE(excluded.week, games.week),
  last_seen_at  = excluded.last_seen_at,
  -- (A) fires ONLY on a real status/kickoff/week transition, which is by
  -- definition a data change, so updated_at advances unconditionally here. The
  -- "seen again is not a change" rule lives in (B), which owns the L3 touch.
  updated_at    = excluded.updated_at
WHERE
  -- (a) never regress a final game; but do allow score corrections
  (games.status <> 'final' OR excluded.status = 'final')
  -- (a') CANCELED IS TERMINAL (PLAN.md §8.5 / §23.7). A game maintenance has
  -- auto-voided may already have void legs; ESPN re-publishing the original
  -- event (an MLB rainout stays STATUS_POSTPONED on its own date) must not flip
  -- it back to postponed — or to anything else. League-neutral.
  AND games.status <> 'canceled'
  -- (b) an INDEXED column must actually differ. Anything else is (B)'s job:
  -- naming status/kickoff_at/week in the SET list costs 4 rows even when the
  -- values are identical, so this statement must not run for clock churn.
  AND ${GAMES_INDEXED_OLD} IS NOT ${GAMES_INDEXED_NEW}`;

/**
 * (B) THE LIVE UPDATE. NO INDEXED COLUMN MAY EVER APPEAR IN THIS SET LIST —
 * adding `status`, `kickoff_at` or `week` here quadruples the cost of every
 * live refresh and silently undoes the whole §8.6 budget. 1 row written.
 *
 * EXPORTED so `ingest.spec.ts` can assert that property statically. It is the
 * one regression here that no functional test can see: the rows would still be
 * correct, just 4x more expensive, and the bill arrives on a Saturday.
 */
export const GAME_LIVE_SQL = `
UPDATE games SET
  period        = ?,
  display_clock = ?,
  home_score    = COALESCE(?, home_score),
  away_score    = COALESCE(?, away_score),
  status_detail = ?,
  home_rank     = ?,
  away_rank     = ?,
  home_conference_id = COALESCE(?, home_conference_id),
  away_conference_id = COALESCE(?, away_conference_id),
  home_logo     = ?,
  away_logo     = ?,
  name          = ?,
  short_name    = ?,
  home_name     = ?,
  away_name     = ?,
  last_seen_at  = ?,
  -- updated_at means "data changed", NOT "seen again": it advances only when the
  -- compare tuple differs. An L3 touch moves last_seen_at alone, which is what
  -- keeps §7.1's resetDeferredBets predicate honest.
  updated_at    = CASE WHEN ${GAMES_LIVE_OLD} IS NOT ${GAMES_LIVE_NEW}
                       THEN ? ELSE updated_at END
WHERE id = ?
  -- the same never-regress-final guard as (A): a feed glitch reporting a played
  -- game as scheduled must not move its clock or scores either.
  AND (status <> 'final' OR ? = 'final')
  -- and canceled is terminal, as in (A): the auto-void status_detail survives.
  AND status <> 'canceled'
  AND (
    -- L1: only write if a value actually differs
    ${GAMES_LIVE_OLD} IS NOT ${GAMES_LIVE_NEW}
    -- L3: or the "still here" stamp is older than the touch interval
    OR last_seen_at < ? - ${String(GAME_SEEN_TOUCH_MS)}
  )`;

const LINE_OLD_TUPLE = `(game_lines.spread_home_tenths, game_lines.spread_home_price,
   game_lines.spread_away_tenths, game_lines.spread_away_price,
   game_lines.total_tenths, game_lines.total_over_price, game_lines.total_under_price,
   game_lines.ml_home_price, game_lines.ml_away_price)`;

const LINE_NEW_TUPLE = `(excluded.spread_home_tenths, excluded.spread_home_price,
   excluded.spread_away_tenths, excluded.spread_away_price,
   excluded.total_tenths, excluded.total_over_price, excluded.total_under_price,
   excluded.ml_home_price, excluded.ml_away_price)`;

const LINE_UPSERT_SQL = `
INSERT INTO game_lines (
  game_id, provider, spread_home_tenths, spread_home_price,
  spread_away_tenths, spread_away_price, total_tenths, total_over_price,
  total_under_price, ml_home_price, ml_away_price, captured_at, seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id, provider) DO UPDATE SET
  spread_home_tenths = excluded.spread_home_tenths,
  spread_home_price  = excluded.spread_home_price,
  spread_away_tenths = excluded.spread_away_tenths,
  spread_away_price  = excluded.spread_away_price,
  total_tenths       = excluded.total_tenths,
  total_over_price   = excluded.total_over_price,
  total_under_price  = excluded.total_under_price,
  ml_home_price      = excluded.ml_home_price,
  ml_away_price      = excluded.ml_away_price,
  -- captured_at advances ONLY when a price actually changed; seen_at is the
  -- "we confirmed the book still offers this" stamp that staleness reads.
  captured_at = CASE WHEN ${LINE_OLD_TUPLE} IS NOT ${LINE_NEW_TUPLE}
                     THEN excluded.captured_at ELSE game_lines.captured_at END,
  seen_at = excluded.seen_at
WHERE ${LINE_OLD_TUPLE} IS NOT ${LINE_NEW_TUPLE}
   OR game_lines.seen_at < excluded.seen_at - ${String(LINE_SEEN_TOUCH_MS)}`;

function gameStatement(env: Env, game: Game, now: EpochMs): D1PreparedStatement {
  return env.DB.prepare(GAME_UPSERT_SQL).bind(
    game.id,
    game.id.slice(game.league.length + 1), // provider_event_id
    game.league,
    game.season,
    game.seasonType,
    game.week,
    game.name,
    game.shortName,
    game.kickoffAt,
    // Only ever INSERTed, never updated — a reschedule keeps the original.
    game.originalKickoffAt,
    game.status,
    game.statusDetail,
    game.period,
    game.displayClock,
    game.neutralSite ? 1 : 0,
    game.home.teamId,
    game.home.abbr,
    game.home.name,
    game.home.logo,
    game.home.rank,
    game.home.score,
    game.away.teamId,
    game.away.abbr,
    game.away.name,
    game.away.logo,
    game.away.rank,
    game.away.score,
    game.home.conferenceId,
    game.away.conferenceId,
    now, // first_seen_at
    now, // last_seen_at
    now, // updated_at
  );
}

/**
 * The 14 values of `GAMES_LIVE_NEW`, in its exact column order. Built once and
 * spliced into the bind list twice (the `updated_at` CASE and the `WHERE`
 * compare) so the SQL and the bindings cannot drift.
 */
function liveTupleArgs(game: Game): readonly unknown[] {
  return [
    game.period,
    game.displayClock,
    game.home.score,
    game.away.score,
    game.home.rank,
    game.away.rank,
    game.home.conferenceId,
    game.away.conferenceId,
    game.home.logo,
    game.away.logo,
    game.name,
    game.shortName,
    game.home.name,
    game.away.name,
  ];
}

/** (B): the non-indexed live update. See the A/B note above `GAME_UPSERT_SQL`. */
function gameLiveStatement(env: Env, game: Game, now: EpochMs): D1PreparedStatement {
  const tuple = liveTupleArgs(game);
  return env.DB.prepare(GAME_LIVE_SQL).bind(
    // SET list
    game.period,
    game.displayClock,
    game.home.score,
    game.away.score,
    game.statusDetail,
    game.home.rank,
    game.away.rank,
    game.home.conferenceId,
    game.away.conferenceId,
    game.home.logo,
    game.away.logo,
    game.name,
    game.shortName,
    game.home.name,
    game.away.name,
    now, // last_seen_at
    // updated_at = CASE WHEN <old> IS NOT <new> THEN ? ELSE updated_at END
    ...tuple,
    now,
    // WHERE
    game.id,
    game.status, // the never-regress-final guard
    ...tuple,
    now, // last_seen_at < ? - GAME_SEEN_TOUCH_MS
  );
}

function lineStatement(env: Env, line: GameLines, now: EpochMs): D1PreparedStatement {
  return env.DB.prepare(LINE_UPSERT_SQL).bind(
    line.gameId,
    line.provider,
    line.spread?.homeTenths ?? null,
    line.spread?.homePrice ?? null,
    line.spread?.awayTenths ?? null,
    line.spread?.awayPrice ?? null,
    line.total?.tenths ?? null,
    line.total?.overPrice ?? null,
    line.total?.underPrice ?? null,
    line.moneyline?.homePrice ?? null,
    line.moneyline?.awayPrice ?? null,
    now, // captured_at
    now, // seen_at
  );
}

/**
 * L2: a line row is written only for games whose status is `scheduled`. Exposed
 * separately so `ingest.spec.ts` can assert it directly.
 *
 * Measured on the committed samples: 0 of 84 in-progress/final events carried
 * odds at all, so this is not merely an optimisation of a rare case — it is the
 * normal shape of a Saturday afternoon.
 */
export function lineRowsWorthWriting(slate: ProviderSlate): ProviderSlate['lines'] {
  const scheduled = new Set(slate.games.filter((g) => g.status === 'scheduled').map((g) => g.id));
  return slate.lines.filter((l) => scheduled.has(l.gameId));
}

/**
 * Run a list of statements as a series of `batch()` calls, each within
 * MAX_BATCH_STATEMENTS. A CFB Saturday is ~80 games and therefore several
 * batches; that is fine, because every statement here is idempotent — the batch
 * boundary carries no atomicity requirement (unlike settlement, §7.4).
 */
async function runChunked(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<readonly D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < statements.length; i += MAX_BATCH_STATEMENTS) {
    const chunk = statements.slice(i, i + MAX_BATCH_STATEMENTS);
    out.push(...(await runBatch(db, chunk)));
  }
  return out;
}

export interface SlateWriteCounts {
  /** `games` rows that changed, counted ONCE per game however many of (A)/(B) applied. */
  readonly games: number;
  readonly lines: number;
  /**
   * D1 `meta.rows_written` summed over every statement: table rows PLUS index
   * entries, i.e. what the 100k/day cap actually counts. PLAN.md §8.6.
   */
  readonly rowsWritten: number;
  /** Upsert UNITS (one per game, one per line) that wrote nothing at all. */
  readonly skipped: number;
}

/**
 * The upsert batch for a slate. See PLAN.md §8.5 for the exact SQL semantics and
 * the A/B note above `GAME_UPSERT_SQL` for why each game is two statements.
 *
 * `games`/`lines` count CHANGED ROWS, not statements issued — that difference is
 * the whole point of L1. `rowsWritten` is the separate, larger number the D1 cap
 * counts; do not conflate them.
 *
 * Every timestamp comes from `now`, never from `slate.fetchedAt`: the job
 * captures one clock and every guard in the run agrees with it.
 */
export async function upsertSlate(
  env: Env,
  slate: ProviderSlate,
  now: EpochMs,
): Promise<SlateWriteCounts> {
  const lines = lineRowsWorthWriting(slate);

  // Interleaved (A, B) per game so the pair is always adjacent and always in
  // that order. MAX_BATCH_STATEMENTS is even, so a chunk boundary can never fall
  // between a game's two statements.
  const gameStatements: D1PreparedStatement[] = [];
  for (const g of slate.games) {
    gameStatements.push(gameStatement(env, g, now), gameLiveStatement(env, g, now));
  }
  const gameResults = await runChunked(env.DB, gameStatements);

  let games = 0;
  let rowsWritten = 0;
  for (let i = 0; i < gameResults.length; i += 1) rowsWritten += rowsWrittenAt(gameResults, i);
  for (let i = 0; i < gameResults.length; i += 2) {
    // One game == results[i] (A) and results[i + 1] (B). Either applying counts
    // as one changed game; both applying (a status transition that also moved a
    // rank) is still one game.
    if (changesAt(gameResults, i) + changesAt(gameResults, i + 1) > 0) games += 1;
  }

  // Lines go AFTER games in their own batch: `game_lines.game_id` has an FK to
  // `games(id)`, so a brand-new game's line cannot be written in the same batch
  // position before its parent row exists.
  const lineStatements = lines.map((l) => lineStatement(env, l, now));
  const lineResults = await runChunked(env.DB, lineStatements);
  let lineCount = 0;
  for (let i = 0; i < lineResults.length; i += 1) {
    lineCount += changesAt(lineResults, i);
    rowsWritten += rowsWrittenAt(lineResults, i);
  }

  const units = slate.games.length + lineStatements.length;
  return { games, lines: lineCount, rowsWritten, skipped: units - games - lineCount };
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Tiered reschedule (PLAN.md §8.4):
 *   live or kickoff < 3h  -> +15 min
 *   kickoff < 48h         -> +60 min
 *   otherwise             -> +6 h
 *   all games final       -> +24 h
 * On failure: `min(15min * 2^consecutiveFailures, 6h)`.
 * MLB only: a target holding an unfinished game is capped at
 * `postponedVoidConfirmAt(league, windowEndAt)` while that is still ahead
 * (PLAN.md §23.7) — see the end of the function.
 *
 * DELIBERATE ORDERING NOTE: §8.4's table lists "all final" last, but it is
 * checked FIRST here. A game that went final an hour ago still satisfies
 * "kickoff within 3h" (the horizon is signed), so evaluating the table top-down
 * would pin a finished slate to the 15-minute live cadence forever — 96 pointless
 * refreshes a day of rows that can never change again. The four tiers are a
 * partition, not a sequence.
 *
 * THE HORIZONS ARE CLAMPED AT BOTH ENDS for the same reason. `TERMINAL_STATUSES`
 * is only {final, canceled}, so a `postponed` or `unknown` game stays in
 * `unfinished` indefinitely — and with a one-sided `kickoffAt - now <= 3h` test a
 * nominal kickoff five hours in the PAST still reads as "live", pinning its
 * target to the 15-minute tier for as long as the game sits there. Requiring
 * `0 <= kickoffAt - now` drops postponed/unknown games to the discovery tier
 * (+6 h), which is the right cadence for "watch it in case it comes back";
 * `maintenance` (§7.5) is what eventually converts a stuck one to `canceled`.
 * A genuinely live game is caught by the `in_progress` arm, which has no horizon.
 */
export function computeNextRunAt(
  target: IngestTargetRow,
  slate: ProviderSlate | null,
  failed: boolean,
  now: EpochMs,
  tick: EpochMs = refreshTickBase(now),
): EpochMs {
  // THE BASE IS THE TICK'S NOMINAL INSTANT (PLAN.md §24.7), never `now`: the
  // claim compares `next_run_at <= now`, and a run starts seconds after its
  // tick, so `now + N ticks` would miss the Nth tick and wait one more. `now`
  // still decides WHICH tier (distances to kickoff); `base` decides WHEN.
  const base = refreshTickBase(tick);
  if (failed) {
    // `2 ** 40` is finite but enormous; clamp the exponent so the arithmetic
    // stays exact and the cap is what actually decides.
    const exponent = Math.min(Math.max(target.consecutiveFailures, 0), 20);
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
    return base + delay;
  }

  const games = slate?.games ?? [];
  // An empty slate is line discovery, not a finished day: ESPN returns zero
  // events for a date whose games are not yet published (PLAN.md §14.9).
  if (games.length === 0) return base + REFRESH_DISCOVERY_MS;

  const unfinished = games.filter((g) => !TERMINAL_STATUSES.has(g.status));
  if (unfinished.length === 0) return base + REFRESH_DONE_MS;

  /**
   * `kickoffAt` is ahead of `now` by no more than `horizon`. Clamped both ends —
   * except that a still-`scheduled` game gets a post-kickoff grace: ESPN can
   * take a few minutes to flip a game to `in_progress`, and a game that has
   * genuinely started must stay on the 15-minute tier or settlement waits
   * hours. The grace is bounded (KICKOFF_GRACE_MS) so a silently-postponed
   * game still drops to the discovery tier eventually. `postponed`/`unknown`
   * games get no grace.
   */
  const within = (g: Game, horizon: number): boolean => {
    const ahead = g.kickoffAt - now;
    const floor = g.status === 'scheduled' ? -KICKOFF_GRACE_MS : 0;
    return ahead >= floor && ahead <= horizon;
  };

  const live = unfinished.some((g) => g.status === 'in_progress' || within(g, LIVE_HORIZON_MS));
  // Live: due at the NEXT tick (`REFRESH_LIVE_TICKS` = 1), in every league.
  if (live) return base + REFRESH_LIVE_MS;

  const soon = unfinished.some((g) => within(g, SOON_HORIZON_MS));
  const tierNext = base + (soon ? REFRESH_SOON_MS : REFRESH_DISCOVERY_MS);

  // THE CONFIRM CAP (PLAN.md §23.7). An MLB target still holding an unfinished
  // game must be fetched at `postponedVoidConfirmAt` (03:00 ET after its date),
  // so maintenance's evidence exists before its 08:30 UTC run — instead of
  // whenever the +6 h tier next comes round, which after a late rain delay is
  // AFTER maintenance. Only ever EARLIER than the tier (the `min`), never
  // sooner than the live cadence (the `max`, the next tick), and only while
  // that instant is still ahead. It is an ABSOLUTE instant (03:00 ET, itself a
  // tick), not a tick multiple. `null` for football: no cap.
  const confirmAt = postponedVoidConfirmAt(target.league, target.windowEndAt);
  if (confirmAt !== null && confirmAt > now) {
    return Math.min(tierNext, Math.max(base + REFRESH_LIVE_MS, confirmAt));
  }
  return tierNext;
}

/* ------------------------------------------------------------------ *
 * One target
 * ------------------------------------------------------------------ */

function warningText(w: ParseWarning): string {
  if (w.eventId === null) return w.reason;
  const who = w.label === null ? w.eventId : `${w.eventId} (${w.label})`;
  return `${who}: ${w.reason}`;
}

const EMPTY_SLATE: Pick<ProviderSlate, 'games' | 'lines'> = { games: [], lines: [] };

/**
 * Pure: the `LineGapStats` of one slate at instant `now`, in the slate's own
 * game order, each game counted once however many times the payload lists it.
 * Details are NOT capped here — the cap is applied once, in `runRefresh`.
 */
export function lineGapsOf(
  slate: Pick<ProviderSlate, 'games' | 'lines'>,
  now: EpochMs,
): LineGapStats {
  const linesByGame = new Map(slate.lines.map((l) => [l.gameId, l]));
  const seen = new Set<string>();
  const counts = { upcomingGames: 0, noLine: 0, noSpread: 0, noTotal: 0, noMoneyline: 0 };
  const details: string[] = [];
  for (const game of slate.games) {
    if (game.status !== 'scheduled' || game.kickoffAt <= now || seen.has(game.id)) continue;
    seen.add(game.id);
    counts.upcomingGames += 1;
    const lines = linesByGame.get(game.id);
    const missing: string[] = [];
    if (lines === undefined) {
      counts.noLine += 1;
      missing.push('no line');
    } else {
      if (lines.spread === null) {
        counts.noSpread += 1;
        missing.push('no spread');
      }
      if (lines.total === null) {
        counts.noTotal += 1;
        missing.push('no total');
      }
      if (lines.moneyline === null) {
        counts.noMoneyline += 1;
        missing.push('no moneyline');
      }
    }
    if (missing.length > 0) details.push(`${game.shortName}: ${missing.join(', ')}`);
  }
  return { ...counts, lineGaps: details.length, lineGapDetails: details };
}

/** A short, safe rendering of a thrown value. Never leaks a stack. */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return typeof err === 'string' ? err.slice(0, 500) : typeof err;
}

/**
 * The ESPN outcome of one target fetch in §24.6's FIXED vocabulary, so per-run
 * tallies sum across runs: `null` (no fetch error) is `'200'`; an HTTP error is
 * `'403'`, `'429'`, `'5xx'` (500–599) or `'4xx'` (any other status); then
 * `'timeout'`, `'network'`, `'bad-json'`. Anything that is not a
 * `ProviderError` failed before or around the request and counts as network.
 * Parser warnings are never a status: a 200 that partly failed to parse is 200.
 * A target whose guard stamp failed was never fetched and reports `'skipped'`
 * (written by `ingestTarget`, never by this function).
 */
export function espnOutcome(err: unknown): string {
  if (err === null) return '200';
  if (!(err instanceof ProviderError)) return 'network';
  switch (err.kind) {
    case 'timeout':
    case 'network':
    case 'bad-json':
      return err.kind;
    case 'unsupported':
      return '4xx';
    case 'http': {
      const status = err.status ?? 0;
      if (status === 403 || status === 429) return String(status);
      return status >= 500 && status <= 599 ? '5xx' : '4xx';
    }
  }
}

/**
 * The provisional `next_run_at` the guard's stamp writes (PLAN.md §24.4):
 * `base + min(REFRESH_BACKOFF_BASE_TICKS × 2^incomplete_attempts,
 * REFRESH_DISCOVERY_TICKS) × REFRESH_TICK_MS` — 15, 30, then 60 min — where
 * the base is the tick's nominal instant (`scheduledTime`, else the floor
 * fallback, §24.7).
 */
export function provisionalNextRunAt(
  target: IngestTargetRow,
  now: EpochMs,
  tick: EpochMs = refreshTickBase(now),
): EpochMs {
  const base = refreshTickBase(tick);
  const exponent = Math.min(Math.max(target.incompleteAttempts, 0), 20);
  const ticks = Math.min(REFRESH_BACKOFF_BASE_TICKS * 2 ** exponent, REFRESH_DISCOVERY_TICKS);
  return base + ticks * REFRESH_TICK_MS;
}

/**
 * THE GUARD'S STAMP (PLAN.md §24.4). One `UPDATE … WHERE id = ?` issued
 * IMMEDIATELY BEFORE this target's own fetch — never for the whole claim at
 * once — so when an invocation is killed for CPU exactly one target, the one in
 * flight, is left blamed. Both reschedule paths in `ingestTarget` undo it; a
 * kill, which no `catch` can see, is the only way it survives. The provisional
 * `next_run_at` drops a killed target BEHIND the other due ones instead of
 * letting it win slot 1 on the very next tick. Never move this after the
 * fetch (CLAUDE.md rule 8i). Returns D1's `rows_written` (2: the row and
 * `idx_ingest_targets_due`).
 */
export async function stampAttempt(
  env: Env,
  target: IngestTargetRow,
  now: EpochMs,
  tick: EpochMs = refreshTickBase(now),
): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE ingest_targets
        SET attempt_started_at  = ?1,
            incomplete_attempts = incomplete_attempts + 1,
            next_run_at         = ?2,
            updated_at          = ?1
      WHERE id = ?3`,
  )
    .bind(now, provisionalNextRunAt(target, now, tick), target.id)
    .run();
  return rowsWrittenOf(res);
}

/**
 * Fetch + parse + upsert one target. Never throws; failures are returned.
 *
 * Stamp first (`stampAttempt`), then fetch, then exactly one of the two
 * reschedules — each of which resets the guard (`incomplete_attempts = 0`,
 * `attempt_started_at = NULL`; success also sets `last_ok_at`). A failure the
 * code can SEE (thrown fetch, non-2xx, timeout, bad JSON, a D1 error in
 * `upsertSlate`) is not an incomplete attempt: its reschedule runs.
 */
export async function ingestTarget(
  env: Env,
  provider: ScoreProvider,
  target: IngestTargetRow,
  now: EpochMs,
  tick: EpochMs = refreshTickBase(now),
): Promise<IngestTargetResult> {
  let slate: ProviderSlate | null = null;
  let error: string | null = null;
  let fetchError: unknown = null;

  // The stamp's own write is part of the run's §8.6 total. If it throws (D1
  // down) the target is not fetched at all and NOTHING else is written for it:
  // no reschedule (which would erase earlier strikes and count a D1 blip as an
  // ESPN failure), no ESPN outcome (`'skipped'`, which no alert streak counts).
  let rowsWritten = 0;
  try {
    rowsWritten += await stampAttempt(env, target, now, tick);
  } catch (err) {
    return {
      gamesUpserted: 0,
      linesUpserted: 0,
      rowsWritten,
      rowsSkipped: 0,
      error: errorText(err),
      espn: 'skipped',
      warnings: [],
      ...lineGapsOf(EMPTY_SLATE, now),
    };
  }

  try {
    // Fetch AND parse before anything touches the database: an outage or a
    // schema change must leave existing rows exactly as they were (§14.8).
    slate = await provider.fetchSlate(target.league, toSlateTarget(target));
  } catch (err) {
    fetchError = err;
    error = errorText(err);
  }

  let games = 0;
  let lines = 0;
  let skipped = 0;
  if (slate !== null) {
    try {
      const written = await upsertSlate(env, slate, now);
      games = written.games;
      lines = written.lines;
      skipped = written.skipped;
      rowsWritten += written.rowsWritten;
    } catch (err) {
      // A D1 failure mid-slate is still a target failure: back the target off
      // and report it. Each statement is idempotent, so a partial apply heals.
      error = errorText(err);
    }
  }

  const failed = error !== null;
  const nextRunAt = computeNextRunAt(target, failed ? null : slate, failed, now, tick);

  // The reschedule is itself a row write (plus `idx_ingest_targets_due`, since
  // `next_run_at` is indexed), so it belongs in the same total the §8.6 budget
  // is measured against rather than being quietly excluded. BOTH paths reset
  // the poison guard (§24.4); its columns are unindexed, so that is free.
  const reschedule = failed
    ? await env.DB.prepare(
        `UPDATE ingest_targets
            SET next_run_at = ?, last_run_at = ?, last_status = 'error', last_error = ?,
                consecutive_failures = consecutive_failures + 1, updated_at = ?,
                incomplete_attempts = 0, attempt_started_at = NULL
          WHERE id = ?`,
      )
        .bind(nextRunAt, now, error, now, target.id)
        .run()
    : await env.DB.prepare(
        `UPDATE ingest_targets
            SET next_run_at = ?, last_run_at = ?, last_status = 'ok', last_error = NULL,
                consecutive_failures = 0, games_seen = ?, updated_at = ?,
                incomplete_attempts = 0, attempt_started_at = NULL, last_ok_at = ?
          WHERE id = ?`,
      )
        .bind(nextRunAt, now, slate?.games.length ?? 0, now, now, target.id)
        .run();
  rowsWritten += rowsWrittenOf(reschedule);

  return {
    gamesUpserted: games,
    linesUpserted: lines,
    rowsWritten,
    rowsSkipped: skipped,
    error,
    espn: espnOutcome(fetchError),
    warnings: (slate?.warnings ?? []).map(warningText),
    ...lineGapsOf(slate ?? EMPTY_SLATE, now),
  };
}

/* ------------------------------------------------------------------ *
 * The refresh job
 * ------------------------------------------------------------------ */

/**
 * Entry point for the `refresh` job.
 *
 * `rowsWritten` covers the games, lines and `ingest_targets` reschedules this run
 * issued. It deliberately EXCLUDES `planTargets`, which is zero in steady state
 * (`ON CONFLICT DO NOTHING` on 22 existing rows) and writes only on the first run
 * after midnight ET; §8.6 budgets it as a separate ~192-rows/day line item.
 */
// TODO(M9c, PLAN.md §21.2): after the target loop below, call
// `runSecondary(env, now, { force })` — ONE call, into src/worker/secondary.ts,
// which loops the leagues itself — AFTER the ESPN ingest, so the decision sees
// the board the primary just wrote, and fold its `SecondaryStats` into
// `IngestStats.secondary`. All three refresh paths (cron, admin Run refresh,
// admin per-game Refresh) reach it through here. NOTE: `LINE_UPSERT_SQL` in this
// file is NOT touched; the secondary has its own upsert (PLAN.md §21.3).
export async function runRefresh(
  env: Env,
  now: EpochMs,
  maxTargets: number,
  options: RefreshOptions = { forceSecondaryGameId: null },
): Promise<IngestStats> {
  await planTargets(env, now);

  const tick = refreshTickBase(now, options.scheduledTime);
  const discoveryFirst = options.trigger !== 'admin' && isDiscoveryTick(tick);
  const targets = await claimDueTargets(env, now, maxTargets, discoveryFirst);
  const provider = new EspnProvider(env, now);

  let gamesUpserted = 0;
  let linesUpserted = 0;
  let rowsSkipped = 0;
  let rowsWritten = 0;
  const warnings: string[] = [];
  const failures: IngestFailure[] = [];
  const espnStatus: Record<string, number> = {};
  const gaps = {
    upcomingGames: 0,
    lineGaps: 0,
    noLine: 0,
    noSpread: 0,
    noTotal: 0,
    noMoneyline: 0,
  };
  const lineGapDetails: string[] = [];
  const coverage: TargetCoverage[] = [];

  for (const target of targets) {
    const result = await ingestTarget(env, provider, target, now, tick);
    gamesUpserted += result.gamesUpserted;
    linesUpserted += result.linesUpserted;
    rowsSkipped += result.rowsSkipped;
    rowsWritten += result.rowsWritten;
    warnings.push(...result.warnings);
    for (const key of Object.keys(gaps) as (keyof typeof gaps)[]) gaps[key] += result[key];
    lineGapDetails.push(...result.lineGapDetails);
    coverage.push({
      targetId: target.id,
      upcomingGames: result.upcomingGames,
      lineGaps: result.lineGaps,
    });
    espnStatus[result.espn] = (espnStatus[result.espn] ?? 0) + 1;
    if (result.error !== null) {
      failures.push({
        targetId: target.id,
        error: result.error,
        espn: result.espn,
        // A skipped target (its stamp failed) wrote no reschedule, so its
        // counter in the database did not move; report what is stored.
        consecutiveFailures:
          result.espn === 'skipped' ? target.consecutiveFailures : target.consecutiveFailures + 1,
      });
    }
  }

  // LAST, after the primary has written: the decision sees the board ESPN just
  // produced, and a gap the primary closed this run costs no credits. Never
  // throws (PLAN.md §21.2); its row writes join the run's §8.6 total.
  const secondary = await runSecondary(env, now, { force: options.forceSecondaryGameId });
  for (const sweep of secondary.sweeps) rowsWritten += sweep.rowsWritten;

  // A read that fails here must not turn a finished run into `error` (and drop
  // its rowsWritten from dayRowsWritten): report no parked targets and log.
  let parked: readonly ParkedTarget[] = [];
  try {
    parked = await listParkedTargets(env);
  } catch (err) {
    console.error('[refresh] listParkedTargets failed; reporting none this run', err);
  }

  return {
    targetsProcessed: targets.length,
    gamesUpserted,
    linesUpserted,
    rowsWritten,
    rowsSkipped,
    // The cap governs what is RECORDED, never what is parsed (PLAN.md §8.3).
    warnings: warnings.slice(0, ESPN_MAX_WARNINGS_RECORDED),
    failures,
    espnStatus,
    parked,
    ...gaps,
    lineGapDetails: lineGapDetails.slice(0, ESPN_MAX_WARNINGS_RECORDED),
    coverage,
    secondary,
  };
}

/**
 * The COUNT cap of one run (`REFRESH_TARGETS_PER_RUN`, 5 since M13b), under
 * the weight budget that actually decides sharing (§24.7). PLAN.md §9.3: an
 * admin trigger runs INLINE in an HTTP invocation with the same CPU budget, so
 * it takes ONE target and returns 200 with the stats.
 */
export function refreshTargetsPerRun(env: Env, trigger: 'cron' | 'admin'): number {
  const configured = readConfig(env).refreshTargetsPerRun;
  return trigger === 'admin' ? 1 : configured;
}

/**
 * Every PARKED target, by id (PLAN.md §24.4). One read of a ~30-row table; the
 * refresh run reports it in `stats.parked` and the alerts name each one.
 */
export async function listParkedTargets(env: Env): Promise<readonly ParkedTarget[]> {
  const res = await env.DB.prepare(
    `SELECT id, incomplete_attempts, attempt_started_at FROM ingest_targets
      WHERE incomplete_attempts >= ?1
      ORDER BY id`,
  )
    .bind(INGEST_MAX_INCOMPLETE_ATTEMPTS)
    .all<{ id: string; incomplete_attempts: number; attempt_started_at: number | null }>();
  return res.results.map((r) => ({
    targetId: r.id,
    incompleteAttempts: r.incomplete_attempts,
    attemptStartedAt: r.attempt_started_at,
  }));
}

/* ------------------------------------------------------------------ *
 * Ingest health (PLAN.md §24.5) — read by GET /api/health/ingest and by the
 * `refresh-stale` / `espn-all-failing` alerts (§24.6b), so the monitor and the
 * email can never disagree about what "stale" means.
 * ------------------------------------------------------------------ */

/**
 * No `ok` refresh run for this long = `refresh-stale`: `HEALTH_STALE_TICKS`
 * refresh ticks, 5 × 3 min = 15 min since M13b (75 min under M13a's 15-minute
 * cron). The uptime monitor's threshold moves with it (docs/OPERATIONS.md).
 */
export const HEALTH_STALE_AFTER_MS = HEALTH_STALE_TICKS * REFRESH_TICK_MS;

export type IngestHealthReason = 'refresh-stale' | 'targets-parked' | 'espn-all-failing';

export interface IngestHealth {
  readonly lastRefreshOkAt: EpochMs | null;
  readonly parkedTargets: number;
  readonly reasons: readonly IngestHealthReason[];
}

/**
 * ONE statement, three scalar subqueries, each on an index or the ~30-row
 * target table (§24.5). Nothing is written. `espn-all-failing` ignores targets
 * the planner just created (`last_status` NULL) and cannot fire while any
 * target's newest fetch succeeded.
 */
export async function readIngestHealth(env: Env, now: EpochMs): Promise<IngestHealth> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT MAX(started_at) FROM job_runs
         WHERE job = 'refresh' AND status = 'ok')                  AS last_ok,
       (SELECT COUNT(*) FROM ingest_targets
         WHERE incomplete_attempts >= ?1)                           AS parked,
       (EXISTS (SELECT 1 FROM ingest_targets WHERE last_status = 'error')
        AND NOT EXISTS (SELECT 1 FROM ingest_targets WHERE last_status = 'ok')) AS all_failing`,
  )
    .bind(INGEST_MAX_INCOMPLETE_ATTEMPTS)
    .first<{ last_ok: number | null; parked: number; all_failing: number }>();
  const lastOk = row?.last_ok ?? null;
  const parked = row?.parked ?? 0;
  const reasons: IngestHealthReason[] = [];
  if (lastOk === null || lastOk < now - HEALTH_STALE_AFTER_MS) reasons.push('refresh-stale');
  if (parked > 0) reasons.push('targets-parked');
  if (row?.all_failing === 1) reasons.push('espn-all-failing');
  return { lastRefreshOkAt: lastOk, parkedTargets: parked, reasons };
}
