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

export function runMaintenance(_env: Env, _now: EpochMs): Promise<MaintenanceStats> {
  throw new Error('not implemented: M6');
}
