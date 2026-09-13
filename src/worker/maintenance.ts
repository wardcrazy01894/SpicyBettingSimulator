/**
 * Daily maintenance. PLAN.md §7.5.
 *
 * Its job is to make sure money is never frozen forever: it converts games that
 * are stuck (postponed too long, or dropped from the ESPN feed) into `canceled`,
 * which lets the settle job void the legs and return the stakes. It never
 * auto-voids a game that might simply be a feed hiccup — those are reported in
 * `job_runs.stats.stuck[]` for a human to look at.
 */

import type { EpochMs } from '../shared/types.js';
import type { Env } from './env.js';

export interface MaintenanceStats {
  readonly autoVoidedGames: readonly string[];
  readonly stuckGames: readonly string[];
  readonly sessionsPruned: number;
  readonly throttleRowsPruned: number;
  readonly jobRunsPruned: number;
}

/** postponed / missing for > VOID_AFTER_MS past `original_kickoff_at` -> canceled. */
export function autoVoidStuckGames(_env: Env, _now: EpochMs): Promise<readonly string[]> {
  throw new Error('not implemented: M6');
}

/** Reported, never auto-changed: `in_progress` for > 12h with a stale `last_seen_at`. */
export function findStuckInProgressGames(_env: Env, _now: EpochMs): Promise<readonly string[]> {
  throw new Error('not implemented: M6');
}

export function pruneExpiredSessions(_env: Env, _now: EpochMs): Promise<number> {
  throw new Error('not implemented: M6');
}

export function pruneAuthThrottle(_env: Env, _now: EpochMs): Promise<number> {
  throw new Error('not implemented: M6');
}

/** Keeps the newest 200 rows per job. */
export function pruneJobRuns(_env: Env, _keepPerJob: number): Promise<number> {
  throw new Error('not implemented: M6');
}

/**
 * TODO(M6): implement the real pass. Every helper above throws
 * `not implemented: M6`; this list is the order they must be wired in:
 *
 *   1. `autoVoidStuckGames`   postponed / missing for > VOID_AFTER_MS past
 *                             `original_kickoff_at` -> `canceled`, so settle can
 *                             void the legs and return the stakes.
 *   2. `findStuckInProgressGames`  reported only, never auto-changed.
 *   3. `pruneExpiredSessions`  `sessions.expires_at < now`.
 *   4. `pruneAuthThrottle`     `auth_throttle.window_start` past its window.
 *   5. `pruneJobRuns(env, 200)` — PRUNE `job_runs`, KEEPING THE NEWEST 200 PER
 *      JOB. Until this exists `job_runs` grows without bound: three crons write
 *      ~4 runs every 15 minutes plus every admin trigger, i.e. ~380 rows/day
 *      forever, each carrying a JSON `stats` blob. Nothing deletes them today.
 *      It is not urgent — the table is small and D1's free storage cap is 5 GB —
 *      but it IS unbounded, and `GET /api/admin/jobs` (LIMIT 50 over
 *      `idx_job_runs_recent`) is the only thing keeping the read cheap.
 *
 * M4 lands a CALLABLE NO-OP on purpose. `runJob('maintenance')` and the
 * `30 8 * * *` cron must reach a function that returns, so the lease, the
 * `job_runs` row and `POST /api/admin/jobs/maintenance` are all exercisable
 * before M6 exists. Every helper above still throws `not implemented: M6`, so
 * there is no way to mistake this for a working implementation: it does nothing
 * and says so in its own stats.
 */
export function runMaintenance(_env: Env, _now: EpochMs): Promise<MaintenanceStats> {
  return Promise.resolve({
    autoVoidedGames: [],
    stuckGames: [],
    sessionsPruned: 0,
    throttleRowsPruned: 0,
    jobRunsPruned: 0,
  });
}
