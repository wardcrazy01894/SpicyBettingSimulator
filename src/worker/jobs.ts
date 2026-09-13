/**
 * Cron job dispatch, leasing and run recording. PLAN.md §9.
 *
 * Overlap protection is a conditional upsert on `job_locks`:
 *   ... ON CONFLICT(name) DO UPDATE SET lease_until = :new
 *       WHERE job_locks.lease_until <= :now
 * `meta.changes === 0` means somebody else holds it -> exit immediately.
 *
 * Crash safety: every durable effect a job has is either an idempotent upsert or
 * a single atomic per-bet batch, so "died halfway" is always recoverable by
 * running again. The lease expires on its own; no cleanup is needed.
 */

import type { EpochMs } from '../shared/types.js';
import type { Env } from './env.js';

export type JobName = 'refresh' | 'settle' | 'maintenance';

export interface JobRun {
  readonly id: string;
  readonly job: JobName;
  readonly trigger: 'cron' | 'admin';
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs | null;
  readonly status: 'running' | 'ok' | 'skipped' | 'error';
  readonly stats: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
}

/** Returns null when the lease is held by another run. */
export function acquireLease(
  _env: Env,
  _job: JobName,
  _runId: string,
  _now: EpochMs,
): Promise<boolean> {
  throw new Error('not implemented: M4');
}

/** Sets `lease_until = 0` so the next run can start immediately. */
export function releaseLease(
  _env: Env,
  _job: JobName,
  _runId: string,
  _now: EpochMs,
): Promise<void> {
  throw new Error('not implemented: M4');
}

/**
 * Acquire the lease, write a `job_runs` row, run `body`, finalize the row.
 * Always resolves — an error inside `body` is recorded, never rethrown, so one
 * bad job cannot take down the scheduled handler.
 */
export function withJobRun(
  _env: Env,
  _job: JobName,
  _trigger: 'cron' | 'admin',
  _now: EpochMs,
  _body: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<JobRun> {
  throw new Error('not implemented: M4');
}

/** Maps a cron expression from `ScheduledEvent.cron` to a job name. */
export function jobForCron(cron: string): JobName | null {
  switch (cron.trim()) {
    case '*/15 * * * *':
      return 'refresh';
    case '5-59/15 * * * *':
      return 'settle';
    case '30 8 * * *':
      return 'maintenance';
    default:
      return null;
  }
}

/** Runs a named job. Shared by the cron handler and POST /api/admin/jobs/:job. */
export function runJob(
  _env: Env,
  _job: JobName,
  _trigger: 'cron' | 'admin',
  _now: EpochMs,
): Promise<JobRun> {
  throw new Error('not implemented: M4');
}

export function recentRuns(_env: Env, _limit: number): Promise<readonly JobRun[]> {
  throw new Error('not implemented: M4');
}
