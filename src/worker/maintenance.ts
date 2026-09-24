/**
 * Daily maintenance. PLAN.md §7.5.
 *
 * Its job is to make sure money is never frozen forever: it converts games that
 * are stuck (postponed too long, or dropped from the ESPN feed) into `canceled`,
 * which lets the settle job void the legs and return the stakes. It never
 * auto-voids a game that might simply be a feed hiccup — those are reported in
 * `job_runs.stats.stuck[]` for a human to look at.
 *
 * Nothing here touches `bets`, `ledger` or `bankrolls`. The only way a stake
 * comes back is the NEXT settle run grading the leg `void`, through the same
 * single atomic batch every other settlement uses. Keeping the money out of this
 * file is deliberate: a sweep that both cancels a game AND pays a bet would be a
 * two-table mutation with no transaction to hold it together.
 */

import { MLB_POSTPONED_CONFIRM_MS, VOID_AFTER_MS } from '../shared/constants.js';
import { etDateKey } from '../shared/time.js';
import type { EpochMs } from '../shared/types.js';
import { changesAt, rowsWrittenAt } from './db.js';
import type { Env } from './env.js';

/**
 * One sweep's two numbers. They are NOT the same number and must not be
 * conflated: `count` is `meta.changes` (rows the sweep actually changed, the
 * figure a human reads in `GET /api/admin/jobs`), `rowsWritten` is
 * `meta.rows_written` — the row PLUS every index entry the statement rewrote,
 * which is the unit D1's hard-enforced 100,000-rows-per-day cap counts.
 */
export interface SweepResult {
  readonly count: number;
  readonly rowsWritten: number;
}

/** `autoVoidStuckGames`' report: the ids are the point, the rows are the budget. */
export interface AutoVoidResult {
  readonly gameIds: readonly string[];
  readonly rowsWritten: number;
}

/**
 * An MLB game whose CURRENT `kickoff_at` falls on a different ET date from its
 * `original_kickoff_at` (PLAN.md §23.7). Never observed — every makeup seen was
 * a NEW event id — but if ESPN ever reschedules under the SAME id, its bets
 * would grade on the rescheduled game rather than void; this names it so a
 * human sees it rather than a rule guessing. Reported, never changed.
 */
export interface MlbRescheduledGame {
  readonly gameId: string;
  readonly status: string;
  /** ET date keys (`YYYYMMDD`), from `etDateKey` — never an hour offset. */
  readonly originalDate: string;
  readonly currentDate: string;
}

export interface MaintenanceStats {
  readonly autoVoidedGames: readonly string[];
  readonly stuckGames: readonly string[];
  /** PLAN.md §23.7: MLB games moved to another ET date under the same id. */
  readonly mlbRescheduled: readonly MlbRescheduledGame[];
  readonly sessionsPruned: number;
  readonly throttleRowsPruned: number;
  readonly jobRunsPruned: number;
  /**
   * D1 `meta.rows_written` summed over every statement this job issued.
   *
   * Maintenance is NOT a read-only job: the auto-void UPDATE writes `status`,
   * which is indexed, and the session/throttle/job_runs DELETEs remove hundreds
   * of rows a week. Without this field `jobs.ts::dayRowsWritten` — which sums
   * `stats.rowsWritten` across every job — counts all of it as zero, and the
   * rolling 24 h total an operator checks against the cap is quietly wrong
   * (PLAN.md §8.6).
   */
  readonly rowsWritten: number;
}

/** PLAN.md §7.5: `job_runs` keeps the newest 200 rows PER JOB. */
export const JOB_RUNS_KEPT_PER_JOB = 200;

/**
 * How long a game may be absent from the feed before its disappearance counts as
 * real. PLAN.md §7.5's second row; it is ANDed with the 7-day
 * `original_kickoff_at` test, so a game must be both long past due AND unseen.
 *
 * Local rather than in `constants.ts`, which is frozen after M2d and is the
 * browser's contract too — nothing outside this sweep has an opinion about it.
 */
const FEED_STALE_MS = 2 * 24 * 60 * 60 * 1000;

/** A game stuck `in_progress` this long past kickoff is reported, never voided. */
const IN_PROGRESS_STUCK_MS = 12 * 60 * 60 * 1000;
const IN_PROGRESS_UNSEEN_MS = 6 * 60 * 60 * 1000;

/** An `auth_throttle` row older than this is dead weight (windows are 15 min). */
const THROTTLE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded so one sweep can never exceed D1's 100-bound-parameter-per-statement
 * limit. Realistically this matches 0-2 games a day; if it ever matched more,
 * the next daily run picks up the remainder.
 */
const AUTO_VOID_LIMIT = 90;
const STUCK_REPORT_LIMIT = 50;

/**
 * PLAN.md §23.7: the MLB next-day void. A postponed MLB game is voided once a
 * SUCCESSFUL fetch of its own ET date (the target whose window holds its
 * CURRENT `kickoff_at`) was made at or after `window_end_at + ?5`, bound to
 * `MLB_POSTPONED_CONFIRM_MS` — 03:00 ET the next morning, i.e.
 * `postponedVoidConfirmAt('mlb', window_end_at)` restated per row in SQL.
 *
 * Evidence, not the clock: "postponed and the day is over" alone would void a
 * rain-delayed game that resumed after the last refresh and finished before
 * this run (the rain-delay race). `last_status = 'ok'` is written only after
 * the slate's upsert succeeded, so had that fetch seen the game final or in
 * progress, the row would say so and would not match here.
 *
 * `kickoff_at`, not `original_kickoff_at`: a suspended game ESPN moves to its
 * resumption date under the same id is judged against that date.
 * `window_start_at`/`window_end_at` came from `etDayBounds`, so no timezone
 * appears here and the 23 h / 25 h days are already right.
 */
const MLB_POSTPONED_CONFIRMED = `
  (league = 'mlb' AND status = 'postponed'
   AND EXISTS (SELECT 1 FROM ingest_targets t
                WHERE t.league = games.league
                  AND games.kickoff_at >= t.window_start_at
                  AND games.kickoff_at <  t.window_end_at
                  AND t.last_status = 'ok'
                  AND t.last_run_at >= t.window_end_at + ?5))`;

/**
 * The §7.5 auto-void situations, as ONE predicate:
 *
 *   1. postponed and never replayed — `status='postponed'` and more than
 *      VOID_AFTER_MS past `original_kickoff_at`. No staleness test: a game ESPN
 *      still publishes as postponed a week after its original kickoff is not
 *      coming back. Every league, MLB included.
 *   2. dropped from the feed — still `scheduled`/`in_progress`/`unknown`, more
 *      than VOID_AFTER_MS past `original_kickoff_at`, AND not seen for two days.
 *      The staleness conjunct is what stops us voiding a game that is merely
 *      mis-stated by a live feed.
 *   3. MLB only — postponed, and confirmed so by a post-day fetch of its own
 *      date (`MLB_POSTPONED_CONFIRMED` above, PLAN.md §23.7).
 *
 * `original_kickoff_at` (written once, never updated) rather than `kickoff_at`
 * is the reference for 1 and 2 on purpose: a postponed game's `kickoff_at` may
 * have been pushed forward by ESPN, which would reset the clock on every
 * reschedule.
 *
 * Bound parameters, shared by the SELECT and the UPDATE: ?1 now,
 * ?2 VOID_AFTER_MS, ?3 FEED_STALE_MS, ?5 MLB_POSTPONED_CONFIRM_MS (?4 is the
 * SELECT's LIMIT; the UPDATE's id list starts at ?6).
 */
const AUTO_VOID_PREDICATE = `
  (
    (status = 'postponed' AND ?1 > original_kickoff_at + ?2)
    OR (status IN ('scheduled','in_progress','unknown')
        AND ?1 > original_kickoff_at + ?2
        AND last_seen_at < ?1 - ?3)
    OR ${MLB_POSTPONED_CONFIRMED}
  )`;

/**
 * postponed / vanished for > VOID_AFTER_MS past `original_kickoff_at` ->
 * `canceled`, so the next settle run voids the legs and returns the stakes.
 *
 * SELECT-then-UPDATE, which is normally forbidden here (CLAUDE.md rule 5) —
 * justified because the ids are the REPORT (`job_runs.stats`, PLAN.md §7.5
 * "every auto-void writes a stats entry naming the game id") and the UPDATE
 * re-states the whole predicate itself, so a game that stopped matching in
 * between is not voided. No money is involved; the worst case of the race is a
 * report that names one id too many.
 */
export async function autoVoidStuckGames(env: Env, now: EpochMs): Promise<AutoVoidResult> {
  const found = await env.DB.prepare(
    `SELECT id FROM games WHERE ${AUTO_VOID_PREDICATE} ORDER BY original_kickoff_at LIMIT ?4`,
  )
    .bind(now, VOID_AFTER_MS, FEED_STALE_MS, AUTO_VOID_LIMIT, MLB_POSTPONED_CONFIRM_MS)
    .all<{ id: string }>();
  const ids = found.results.map((row) => row.id);
  if (ids.length === 0) return { gameIds: [], rowsWritten: 0 };

  // `status_detail` is PLAN.md §7.5's literal string, per branch of the
  // predicate. It was an integer-division day count; that told a reader nothing
  // the timestamps do not already say, and — because SQLite's `/` on two
  // INTEGERs truncates while on any REAL it does not — one non-integer column
  // would have started rendering a float into a human-facing field. The
  // `>7d`/`>2d` literals restate VOID_AFTER_MS and FEED_STALE_MS above; if
  // either constant moves, this string moves with it.
  //
  // `SET status = 'canceled'` in the same statement does not disturb the CASE:
  // SQLite evaluates every SET expression against the row's ORIGINAL values.
  // The MLB branch is tested FIRST: a postponed MLB game is normally voided by
  // it the morning after its date, long before 7 days; one that only matches
  // the 7-day branch (no evidence ever arrived) still says `>7d`.
  //
  // ?4 is unused by the UPDATE (it is the SELECT's LIMIT) and is bound to the
  // same value so the two statements share one numbering.
  const placeholders = ids.map((_id, i) => `?${String(i + 6)}`).join(', ');
  const res = await env.DB.prepare(
    `UPDATE games
        SET status        = 'canceled',
            status_detail = CASE WHEN ${MLB_POSTPONED_CONFIRMED}
                                 THEN 'auto-void: MLB postponed, not played on its date'
                                 WHEN status = 'postponed'
                                 THEN 'auto-void: postponed >7d'
                                 ELSE 'auto-void: not seen >2d' END,
            updated_at    = ?1
      WHERE id IN (${placeholders}) AND ${AUTO_VOID_PREDICATE}`,
  )
    .bind(now, VOID_AFTER_MS, FEED_STALE_MS, AUTO_VOID_LIMIT, MLB_POSTPONED_CONFIRM_MS, ...ids)
    .run();
  return { gameIds: ids, rowsWritten: rowsWrittenAt([res], 0) };
}

/**
 * Reported, never auto-changed: `in_progress` for > 12 h past kickoff with a
 * `last_seen_at` older than 6 h. PLAN.md §7.5 is explicit that this must NOT
 * auto-void — a game that might just be a feed glitch is a human's call.
 */
export async function findStuckInProgressGames(env: Env, now: EpochMs): Promise<readonly string[]> {
  const res = await env.DB.prepare(
    `SELECT id FROM games
      WHERE status = 'in_progress' AND ?1 > kickoff_at + ?2 AND last_seen_at < ?1 - ?3
      ORDER BY kickoff_at LIMIT ?4`,
  )
    .bind(now, IN_PROGRESS_STUCK_MS, IN_PROGRESS_UNSEEN_MS, STUCK_REPORT_LIMIT)
    .all<{ id: string }>();
  return res.results.map((row) => row.id);
}

/** How far back `mlbRescheduled[]` looks, by original first pitch. */
const RESCHEDULE_LOOKBACK_MS = VOID_AFTER_MS;

/**
 * PLAN.md §23.7: MLB games whose `kickoff_at` ET date differs from their
 * `original_kickoff_at` ET date — the "rescheduled under the SAME id" case no
 * rule handles. Reported, never changed. SQL prefilters on the two instants
 * differing at all (cheap, no timezone); the ET DATES are compared here with
 * `etDateKey` — never an hour offset in SQL (CLAUDE.md rule 3) — so a start
 * time moved within the same day is not reported.
 */
export async function findMlbRescheduled(
  env: Env,
  now: EpochMs,
): Promise<readonly MlbRescheduledGame[]> {
  const res = await env.DB.prepare(
    `SELECT id, status, kickoff_at, original_kickoff_at FROM games
      WHERE league = 'mlb' AND kickoff_at <> original_kickoff_at
        AND original_kickoff_at > ?1 - ?2
      ORDER BY original_kickoff_at LIMIT ?3`,
  )
    .bind(now, RESCHEDULE_LOOKBACK_MS, STUCK_REPORT_LIMIT)
    .all<{ id: string; status: string; kickoff_at: number; original_kickoff_at: number }>();
  const out: MlbRescheduledGame[] = [];
  for (const row of res.results) {
    const originalDate = etDateKey(row.original_kickoff_at);
    const currentDate = etDateKey(row.kickoff_at);
    if (originalDate !== currentDate) {
      out.push({ gameId: row.id, status: row.status, originalDate, currentDate });
    }
  }
  return out;
}

export async function pruneExpiredSessions(env: Env, now: EpochMs): Promise<SweepResult> {
  const res = await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(now).run();
  return sweepResult(res);
}

/**
 * Throttle rows whose window is a day old. `locked_until <= now` is an extra
 * conjunct PLAN.md §7.5 does not spell out: a lockout is only 15 minutes, so it
 * can never co-exist with a day-old window in practice — but deleting a row that
 * is still locking an account out would silently hand an attacker their attempts
 * back, and that is not a bug worth leaving reachable by a clock change.
 */
export async function pruneAuthThrottle(env: Env, now: EpochMs): Promise<SweepResult> {
  const res = await env.DB.prepare(
    `DELETE FROM auth_throttle WHERE window_start < ?1 - ?2 AND locked_until <= ?1`,
  )
    .bind(now, THROTTLE_RETENTION_MS)
    .run();
  return sweepResult(res);
}

/**
 * Keeps the newest `keepPerJob` rows PER JOB. Without this `job_runs` grows
 * without bound: three crons write ~4 runs every 15 minutes plus every admin
 * trigger, i.e. ~380 rows/day forever, each carrying a JSON `stats` blob.
 *
 * `ROW_NUMBER() OVER (PARTITION BY job ...)` rather than a per-job
 * `OFFSET`-subquery loop, so one statement covers every job — including a job
 * name that no longer exists in `JOB_NAMES`.
 *
 * `status <> 'running'` protects the row of the maintenance run doing the
 * pruning, and any other job in flight: a `running` row is the ONLY evidence
 * that a job died before it could finalize (`withJobRun` degrades to exactly
 * that, deliberately), and the finalize UPDATE at the end of this very run would
 * silently match 0 rows if the row had been deleted underneath it.
 */
export async function pruneJobRuns(env: Env, keepPerJob: number): Promise<SweepResult> {
  const res = await env.DB.prepare(
    `DELETE FROM job_runs
      WHERE (status <> 'running'
             -- an orphaned 'running' row (job died before finalize) is reclaimed
             -- once it is far older than any lease TTL (max 10 min)
             OR started_at < ?2)
        AND id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC, rowid DESC) AS rn
            FROM job_runs
        ) WHERE rn > ?1
      )`,
  )
    .bind(keepPerJob, Date.now() - ORPHAN_RUN_MS)
    .run();
  return sweepResult(res);
}

/** A `running` job_runs row older than this can only be an orphan. */
const ORPHAN_RUN_MS = 24 * 60 * 60 * 1000;

/** `meta.changes` + `meta.rows_written` for a single-statement sweep. */
function sweepResult(res: D1Result): SweepResult {
  return { count: changesAt([res], 0), rowsWritten: rowsWrittenAt([res], 0) };
}

/**
 * The daily pass, in the order PLAN.md §7.5 lists it. Each step is independent
 * and idempotent, so a crash between two of them costs nothing but a day.
 */
export async function runMaintenance(env: Env, now: EpochMs): Promise<MaintenanceStats> {
  const autoVoid = await autoVoidStuckGames(env, now);
  const stuckGames = await findStuckInProgressGames(env, now);
  const mlbRescheduled = await findMlbRescheduled(env, now);
  const sessions = await pruneExpiredSessions(env, now);
  const throttle = await pruneAuthThrottle(env, now);
  const jobRuns = await pruneJobRuns(env, JOB_RUNS_KEPT_PER_JOB);

  if (autoVoid.gameIds.length > 0) {
    console.warn('[maintenance] auto-voided games', autoVoid.gameIds.join(', '));
  }
  if (mlbRescheduled.length > 0) {
    console.warn(
      '[maintenance] MLB games moved to another ET date under the same id',
      mlbRescheduled.map((g) => `${g.gameId} ${g.originalDate}->${g.currentDate}`).join(', '),
    );
  }
  return {
    autoVoidedGames: autoVoid.gameIds,
    stuckGames,
    mlbRescheduled,
    sessionsPruned: sessions.count,
    throttleRowsPruned: throttle.count,
    jobRunsPruned: jobRuns.count,
    rowsWritten:
      autoVoid.rowsWritten + sessions.rowsWritten + throttle.rowsWritten + jobRuns.rowsWritten,
  };
}
