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
 *   L1 COMPARE-AND-SKIP. The upsert's `DO UPDATE ... WHERE` compares old and new
 *      row values and skips entirely when nothing changed. A live 15-minute
 *      refresh of a game whose score has not moved writes ZERO rows -- and
 *      therefore zero index entries, which matters because all three `games`
 *      indexes cover mutable columns.
 *   L2 NO LINE WRITES FOR NON-SCHEDULED GAMES. Measured on the committed
 *      samples: 0 of 84 in-progress/final events carried odds. Refreshing
 *      `game_lines` for a live game is pure waste; skip it at the mapper.
 *   L3 TOUCH INTERVALS. `games.last_seen_at` is only bumped when it is older
 *      than GAME_SEEN_TOUCH_MS (6 h) and `game_lines.seen_at` when older than
 *      LINE_SEEN_TOUCH_MS (45 min), so "still here" costs at most 4 and 32 row
 *      writes per game per day instead of 96.
 */

import {
  ESPN_MAX_WARNINGS_RECORDED,
  GAME_SEEN_TOUCH_MS,
  INGEST_WINDOW_MS,
  LINE_SEEN_TOUCH_MS,
  RESERVED_DISCOVERY_SLOTS,
} from '../shared/constants.js';
import { etDateKeyRange, etDayBounds } from '../shared/time.js';
import { LEAGUES } from '../shared/types.js';
import type { EpochMs, Game, GameLines, League } from '../shared/types.js';
import { changesAt, MAX_BATCH_STATEMENTS, runBatch } from './db.js';
import type { Env } from './env.js';
import { readConfig } from './env.js';
import { EspnProvider } from './espn.js';
import type { ProviderSlate, ScoreProvider, SlateTarget } from './providers.js';

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
}

export interface IngestStats {
  readonly targetsProcessed: number;
  /** Rows that actually changed. Watch this against the 100k/day cap. */
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  /** Rows the compare-and-skip guard left alone. */
  readonly rowsSkipped: number;
  readonly warnings: readonly string[];
  readonly failures: readonly { readonly targetId: string; readonly error: string }[];
}

export interface IngestTargetResult {
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  readonly rowsSkipped: number;
  readonly error: string | null;
  /**
   * Parser warnings for this target, already rendered as text. They are the
   * schema-drift alarm (PLAN.md §14.8) and are surfaced in `job_runs.stats`, so
   * they must travel back with the counts rather than being swallowed here.
   */
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Tunables that are pure §8.4 policy rather than shared constants.
 * ------------------------------------------------------------------ */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Reschedule tiers (PLAN.md §8.4). */
const REFRESH_LIVE_MS = 15 * MIN_MS;
const REFRESH_SOON_MS = 60 * MIN_MS;
const REFRESH_DISCOVERY_MS = 6 * HOUR_MS;
const REFRESH_DONE_MS = 24 * HOUR_MS;
/** "kickoff within 3h" / "within 48h" — the two tier boundaries. */
const LIVE_HORIZON_MS = 3 * HOUR_MS;
const SOON_HORIZON_MS = 48 * HOUR_MS;
/** Failure backoff: `min(15min * 2^consecutive_failures, 6h)`. */
const BACKOFF_BASE_MS = REFRESH_LIVE_MS;
const BACKOFF_CAP_MS = REFRESH_DISCOVERY_MS;
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
 * The ET calendar days covering `[from, from + INGEST_WINDOW_MS]`, with their
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
 * Ensure an `ingest_targets` row exists for every US-Eastern calendar date in
 * `now … now + INGEST_WINDOW_MS`, for BOTH leagues, and retire targets whose
 * window ended more than two days ago with no non-final games. Pure DB work, no
 * network, and no knowledge of the league calendar -- which is exactly why the
 * NFL postseason and bowl season need no special case.
 *
 * Returns the number of targets CREATED (0 on a steady-state rerun), which is
 * what makes the idempotency assertion in the spec a one-liner.
 */
export async function planTargets(env: Env, now: EpochMs): Promise<number> {
  const days = etDaysInWindow(now, now + INGEST_WINDOW_MS);

  const statements: D1PreparedStatement[] = [];
  for (const day of days) {
    for (const league of LEAGUES) {
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
  await env.DB.prepare(
    `DELETE FROM ingest_targets
      WHERE window_end_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM games g
           WHERE g.league = ingest_targets.league
             AND g.kickoff_at >= ingest_targets.window_start_at
             AND g.kickoff_at <  ingest_targets.window_end_at
             AND g.status NOT IN ('final', 'canceled'))`,
  )
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
  };
}

const TARGET_COLUMNS = `id, league, kind, key, window_start_at, window_end_at,
                        priority, next_run_at, consecutive_failures`;

/** The `NOT EXISTS` that makes a target "not live" — no in-progress game in it. */
const NO_LIVE_GAME = `NOT EXISTS (
  SELECT 1 FROM games g
   WHERE g.league = t.league
     AND g.kickoff_at >= t.window_start_at
     AND g.kickoff_at <  t.window_end_at
     AND g.status = 'in_progress')`;

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
 * Claim the due targets for this run. The slots are NOT interchangeable:
 *
 *   slot 1            the most-due target overall (in practice, a live one)
 *   slot 2 (RESERVED) the most-overdue target that has NO in-progress game
 *
 * Without the reservation a Saturday with a live CFB target and a live NFL
 * target would eat both slots on all 96 runs and the other ~20 targets (next
 * week's line discovery) would starve forever — `ORDER BY priority, next_run_at`
 * alone does not prevent that, because live targets are perpetually the most due.
 *
 * Budget (computed): 11 ET dates x 2 leagues = 22 targets; worst case 2 live
 * leaves 20 discovery targets wanting 4 refreshes/day each = 80 slot-uses/day
 * against a supply of 96. Fits with 16 to spare. Two simultaneously-live targets
 * alternate in slot 1 and each get a 30-minute cadence.
 *
 * The reserved-slot query MUST exclude the id already claimed by slot 1
 * (`AND id <> :slot1Id`): on a run with no live target — most runs — slot 1's
 * pick also satisfies slot 2's predicate, and without the exclusion the run
 * fetches the same URL twice and wastes half its capacity. The two picks are
 * always distinct ids. If the reserved slot has no eligible non-live target, it
 * falls through to the general queue (same exclusion) so a run is never wasted.
 *
 * NOTE this reads but does not write: the lease (PLAN.md §9.2) is what makes two
 * runs non-overlapping, so "claiming" needs no marker row and costs no writes.
 */
export async function claimDueTargets(
  env: Env,
  now: EpochMs,
  limit: number,
  reservedDiscoverySlots: number,
): Promise<readonly IngestTargetRow[]> {
  if (limit <= 0) return [];
  // SLOT 1 IS NEVER RESERVED. §8.4 numbers the reservation from slot 2, so on a
  // one-slot run — `REFRESH_TARGETS_PER_RUN` forced to 1 for an admin trigger
  // (§9.3), or a future tightening — the single slot must still be "most due
  // overall". Reserving it would leave a live Saturday target unrefreshed for as
  // long as any discovery target was due, which is exactly backwards.
  const reserved = Math.min(Math.max(reservedDiscoverySlots, 0), Math.max(limit - 1, 0));
  const general = limit - reserved;
  const claimed: IngestTargetRow[] = [];

  const pick = async (sql: string, extraArgs: readonly unknown[]): Promise<void> => {
    const ids = claimed.map((t) => t.id);
    const stmt = env.DB.prepare(sql.replace('/*EXCLUDE*/', notInClause(ids.length))).bind(
      now,
      ...ids,
      ...extraArgs,
    );
    const res = await stmt.all<TargetDbRow>();
    for (const row of res.results) claimed.push(toTargetRow(row));
  };

  // Slot 1 (and any further general slots): the most-due target overall.
  if (general > 0) {
    await pick(
      `SELECT ${TARGET_COLUMNS} FROM ingest_targets
        WHERE next_run_at <= ? /*EXCLUDE*/
        ORDER BY priority ASC, next_run_at ASC, id ASC
        LIMIT ?`,
      [general],
    );
  }

  // The RESERVED slots, one at a time so each exclusion list is up to date.
  for (let i = 0; i < reserved; i += 1) {
    if (claimed.length >= limit) break;
    const before = claimed.length;
    await pick(
      `SELECT ${TARGET_COLUMNS} FROM ingest_targets AS t
        WHERE next_run_at <= ? /*EXCLUDE*/
          AND ${NO_LIVE_GAME}
        ORDER BY priority ASC, next_run_at ASC, id ASC
        LIMIT 1`,
      [],
    );
    if (claimed.length === before) {
      // Nothing non-live is due: fall through to the general queue (same
      // exclusion) so the run is never wasted.
      await pick(
        `SELECT ${TARGET_COLUMNS} FROM ingest_targets
          WHERE next_run_at <= ? /*EXCLUDE*/
          ORDER BY priority ASC, next_run_at ASC, id ASC
          LIMIT 1`,
        [],
      );
      if (claimed.length === before) break; // nothing at all is due
    }
  }

  return claimed;
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
 * The clause-(b) comparison tuple, shared verbatim by the `WHERE` and by the
 * `updated_at` CASE so the two can never drift. `status_detail` is DELIBERATELY
 * absent: it is cosmetic, nothing reads it, and including it would buy writes
 * for no behavioural gain (PLAN.md §8.5).
 */
const GAMES_OLD_TUPLE = `(games.status, games.kickoff_at, games.period, games.display_clock,
   COALESCE(games.home_score, -1), COALESCE(games.away_score, -1),
   COALESCE(games.week, -1))`;

const GAMES_NEW_TUPLE = `(excluded.status, excluded.kickoff_at, excluded.period, excluded.display_clock,
   COALESCE(COALESCE(excluded.home_score, games.home_score), -1),
   COALESCE(COALESCE(excluded.away_score, games.away_score), -1),
   COALESCE(COALESCE(excluded.week, games.week), -1))`;

const GAME_UPSERT_SQL = `
INSERT INTO games (
  id, provider, provider_event_id, league, season, season_type, week,
  name, short_name, kickoff_at, original_kickoff_at, status, status_detail,
  period, display_clock, neutral_site,
  home_team_id, home_abbr, home_name, home_logo, home_rank, home_score,
  away_team_id, away_abbr, away_name, away_logo, away_rank, away_score,
  first_seen_at, last_seen_at, updated_at
) VALUES (?, 'espn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  -- updated_at means "data changed", NOT "seen again": it advances only when the
  -- clause-(b) tuple differs. An L3 touch (clause c) moves last_seen_at alone.
  updated_at    = CASE WHEN ${GAMES_OLD_TUPLE} IS NOT ${GAMES_NEW_TUPLE}
                       THEN excluded.updated_at ELSE games.updated_at END
WHERE
  -- (a) never regress a final game; but do allow score corrections
  (games.status <> 'final' OR excluded.status = 'final')
  AND (
    -- (b) L1: only write if a value actually differs (row-value IS NOT)
    ${GAMES_OLD_TUPLE} IS NOT ${GAMES_NEW_TUPLE}
    -- (c) L3: or the "still here" stamp is older than the touch interval
    OR games.last_seen_at < excluded.last_seen_at - ${String(GAME_SEEN_TOUCH_MS)}
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
    now, // first_seen_at
    now, // last_seen_at
    now, // updated_at
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

/**
 * The upsert batch for a slate. See PLAN.md §8.5 for the exact SQL semantics.
 * Returns the number of rows that ACTUALLY changed (from `meta.changes`), not
 * the number of statements issued -- that difference is the whole point of L1.
 *
 * Every timestamp comes from `now`, never from `slate.fetchedAt`: the job
 * captures one clock and every guard in the run agrees with it.
 */
export async function upsertSlate(
  env: Env,
  slate: ProviderSlate,
  now: EpochMs,
): Promise<{ readonly games: number; readonly lines: number; readonly skipped: number }> {
  const lines = lineRowsWorthWriting(slate);

  const gameStatements = slate.games.map((g) => gameStatement(env, g, now));
  const gameResults = await runChunked(env.DB, gameStatements);
  let games = 0;
  for (let i = 0; i < gameResults.length; i += 1) games += changesAt(gameResults, i);

  // Lines go AFTER games in their own batch: `game_lines.game_id` has an FK to
  // `games(id)`, so a brand-new game's line cannot be written in the same batch
  // position before its parent row exists.
  const lineStatements = lines.map((l) => lineStatement(env, l, now));
  const lineResults = await runChunked(env.DB, lineStatements);
  let lineCount = 0;
  for (let i = 0; i < lineResults.length; i += 1) lineCount += changesAt(lineResults, i);

  const issued = gameStatements.length + lineStatements.length;
  return { games, lines: lineCount, skipped: issued - games - lineCount };
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
 *
 * DELIBERATE ORDERING NOTE: §8.4's table lists "all final" last, but it is
 * checked FIRST here. A game that went final an hour ago still satisfies
 * "kickoff within 3h" (the horizon is signed), so evaluating the table top-down
 * would pin a finished slate to the 15-minute live cadence forever — 96 pointless
 * refreshes a day of rows that can never change again. The four tiers are a
 * partition, not a sequence.
 */
export function computeNextRunAt(
  target: IngestTargetRow,
  slate: ProviderSlate | null,
  failed: boolean,
  now: EpochMs,
): EpochMs {
  if (failed) {
    // `2 ** 40` is finite but enormous; clamp the exponent so the arithmetic
    // stays exact and the cap is what actually decides.
    const exponent = Math.min(Math.max(target.consecutiveFailures, 0), 20);
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
    return now + delay;
  }

  const games = slate?.games ?? [];
  // An empty slate is line discovery, not a finished day: ESPN returns zero
  // events for a date whose games are not yet published (PLAN.md §14.9).
  if (games.length === 0) return now + REFRESH_DISCOVERY_MS;

  const unfinished = games.filter((g) => !TERMINAL_STATUSES.has(g.status));
  if (unfinished.length === 0) return now + REFRESH_DONE_MS;

  const live = unfinished.some(
    (g) => g.status === 'in_progress' || g.kickoffAt - now <= LIVE_HORIZON_MS,
  );
  if (live) return now + REFRESH_LIVE_MS;

  const soon = unfinished.some((g) => g.kickoffAt - now <= SOON_HORIZON_MS);
  return now + (soon ? REFRESH_SOON_MS : REFRESH_DISCOVERY_MS);
}

/* ------------------------------------------------------------------ *
 * One target
 * ------------------------------------------------------------------ */

function warningText(w: { readonly eventId: string | null; readonly reason: string }): string {
  return w.eventId === null ? w.reason : `${w.eventId}: ${w.reason}`;
}

/** A short, safe rendering of a thrown value. Never leaks a stack. */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return typeof err === 'string' ? err.slice(0, 500) : typeof err;
}

/** Fetch + parse + upsert one target. Never throws; failures are returned. */
export async function ingestTarget(
  env: Env,
  provider: ScoreProvider,
  target: IngestTargetRow,
  now: EpochMs,
): Promise<IngestTargetResult> {
  let slate: ProviderSlate | null = null;
  let error: string | null = null;

  try {
    // Fetch AND parse before anything touches the database: an outage or a
    // schema change must leave existing rows exactly as they were (§14.8).
    slate = await provider.fetchSlate(target.league, toSlateTarget(target));
  } catch (err) {
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
    } catch (err) {
      // A D1 failure mid-slate is still a target failure: back the target off
      // and report it. Each statement is idempotent, so a partial apply heals.
      error = errorText(err);
    }
  }

  const failed = error !== null;
  const nextRunAt = computeNextRunAt(target, failed ? null : slate, failed, now);

  if (failed) {
    await env.DB.prepare(
      `UPDATE ingest_targets
          SET next_run_at = ?, last_run_at = ?, last_status = 'error', last_error = ?,
              consecutive_failures = consecutive_failures + 1, updated_at = ?
        WHERE id = ?`,
    )
      .bind(nextRunAt, now, error, now, target.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE ingest_targets
          SET next_run_at = ?, last_run_at = ?, last_status = 'ok', last_error = NULL,
              consecutive_failures = 0, games_seen = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(nextRunAt, now, slate?.games.length ?? 0, now, target.id)
      .run();
  }

  return {
    gamesUpserted: games,
    linesUpserted: lines,
    rowsSkipped: skipped,
    error,
    warnings: (slate?.warnings ?? []).map(warningText),
  };
}

/* ------------------------------------------------------------------ *
 * The refresh job
 * ------------------------------------------------------------------ */

/** Entry point for the `refresh` job. */
export async function runRefresh(env: Env, now: EpochMs, maxTargets: number): Promise<IngestStats> {
  await planTargets(env, now);

  const targets = await claimDueTargets(env, now, maxTargets, RESERVED_DISCOVERY_SLOTS);
  const provider = new EspnProvider(env, now);

  let gamesUpserted = 0;
  let linesUpserted = 0;
  let rowsSkipped = 0;
  const warnings: string[] = [];
  const failures: { targetId: string; error: string }[] = [];

  for (const target of targets) {
    const result = await ingestTarget(env, provider, target, now);
    gamesUpserted += result.gamesUpserted;
    linesUpserted += result.linesUpserted;
    rowsSkipped += result.rowsSkipped;
    warnings.push(...result.warnings);
    if (result.error !== null) failures.push({ targetId: target.id, error: result.error });
  }

  return {
    targetsProcessed: targets.length,
    gamesUpserted,
    linesUpserted,
    rowsSkipped,
    // The cap governs what is RECORDED, never what is parsed (PLAN.md §8.3).
    warnings: warnings.slice(0, ESPN_MAX_WARNINGS_RECORDED),
    failures,
  };
}

/**
 * How many targets one run may take. PLAN.md §9.3: an admin trigger runs INLINE
 * in an HTTP invocation with the same 10 ms CPU budget, so it takes one target
 * rather than two and returns 200 with the stats.
 */
export function refreshTargetsPerRun(env: Env, trigger: 'cron' | 'admin'): number {
  const configured = readConfig(env).refreshTargetsPerRun;
  return trigger === 'admin' ? 1 : configured;
}
