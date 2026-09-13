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

import { JOB_LEASE_TTL_MS } from '../shared/constants.js';
import type { EpochMs } from '../shared/types.js';
import type { Env } from './env.js';
import { newId } from './db.js';
import { refreshTargetsPerRun, runRefresh } from './ingest.js';
import { runMaintenance } from './maintenance.js';
import { runSettle } from './settle.js';
import { readConfig } from './env.js';

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

/**
 * Returns null when the lease is held by another run.
 *
 * NO READ-THEN-WRITE: the guard is the `WHERE job_locks.lease_until <= :now`
 * inside the write, and `meta.changes` is how we learn whether it applied. A
 * `SELECT` followed by an `UPDATE` would have a race exactly as wide as the two
 * cron invocations this exists to separate.
 */
export async function acquireLease(
  env: Env,
  job: JobName,
  runId: string,
  now: EpochMs,
): Promise<boolean> {
  const until = now + JOB_LEASE_TTL_MS[job];
  const res = await env.DB.prepare(
    `INSERT INTO job_locks (name, lease_until, run_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE
        SET lease_until = excluded.lease_until,
            run_id      = excluded.run_id,
            updated_at  = excluded.updated_at
      WHERE job_locks.lease_until <= ?`,
  )
    .bind(job, until, runId, now, now)
    .run();
  const changes = (res.meta as { changes?: unknown }).changes;
  return typeof changes === 'number' && changes > 0;
}

/**
 * Sets `lease_until = 0` so the next run can start immediately.
 *
 * Guarded on `run_id` so a run that overran its TTL — and whose lease another
 * run has therefore legitimately taken — cannot release somebody else's lease
 * on its way out.
 */
export function releaseLeaseStatement(
  env: Env,
  job: JobName,
  runId: string,
  now: EpochMs,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE job_locks SET lease_until = 0, updated_at = ?
      WHERE name = ? AND run_id = ?`,
  ).bind(now, job, runId);
}

export async function releaseLease(
  env: Env,
  job: JobName,
  runId: string,
  now: EpochMs,
): Promise<void> {
  await releaseLeaseStatement(env, job, runId, now).run();
}

/* ------------------------------------------------------------------ *
 * job_runs
 * ------------------------------------------------------------------ */

interface JobRunDbRow {
  readonly id: string;
  readonly job: string;
  readonly trigger: string;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly status: string;
  readonly stats: string | null;
  readonly error: string | null;
}

function toJobRun(row: JobRunDbRow): JobRun {
  return {
    id: row.id,
    job: row.job as JobName,
    trigger: row.trigger === 'admin' ? 'admin' : 'cron',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as JobRun['status'],
    stats: parseStats(row.stats),
    error: row.error,
  };
}

/** `stats` is opaque JSON we wrote ourselves; a corrupt value must not throw. */
function parseStats(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** JSON that is guaranteed to fit a TEXT column and never throw on a cycle. */
function encodeStats(stats: Readonly<Record<string, unknown>> | null): string | null {
  if (stats === null) return null;
  try {
    const out: unknown = JSON.stringify(stats);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/** A short, safe rendering of a thrown value. Never carries a stack. */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 1000);
  return typeof err === 'string' ? err.slice(0, 1000) : typeof err;
}

/**
 * Acquire the lease, write a `job_runs` row, run `body`, finalize the row.
 * Always resolves — an error inside `body` OR in any of the three `job_runs`
 * writes is recorded/logged, never rethrown, so one bad job (or a D1 hiccup
 * while recording it) cannot take down the scheduled handler.
 *
 * `acquireLease` is the one call left unguarded on purpose: if the lock table
 * itself is unreachable there is nothing to run and nowhere to record it, and
 * the caller — `scheduled()` or the admin route — should see that.
 */
export async function withJobRun(
  env: Env,
  job: JobName,
  trigger: 'cron' | 'admin',
  now: EpochMs,
  body: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<JobRun> {
  const runId = newId();

  const acquired = await acquireLease(env, job, runId, now);
  if (!acquired) {
    // Somebody else holds the lease: record the fact and get out of the way.
    // This is the normal outcome of an overlapping cron, not an error.
    const skipped: JobRun = {
      id: runId,
      job,
      trigger,
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      stats: null,
      error: null,
    };
    try {
      await insertRun(env, skipped);
    } catch (err) {
      console.error('[jobs] failed to record skipped run', job, runId, err);
    }
    return skipped;
  }

  // `insertRun` goes inside a try for the same reason the finalize batch below
  // does: this function's contract is "always resolves", and an uncaught D1
  // error here would reject into `scheduled()` and take the whole cron
  // invocation down BEFORE the job body ever ran. If the row cannot be written
  // we record nothing, log, and press on — the lease is held either way, and the
  // finalize batch below will fail its UPDATE harmlessly (0 rows matched).
  try {
    await insertRun(env, {
      id: runId,
      job,
      trigger,
      startedAt: now,
      finishedAt: null,
      status: 'running',
      stats: null,
      error: null,
    });
  } catch (err) {
    console.error('[jobs] failed to record run start', job, runId, err);
  }

  let stats: Readonly<Record<string, unknown>> | null = null;
  let error: string | null = null;
  try {
    stats = await body();
  } catch (err) {
    error = errorText(err);
  }

  const finished: JobRun = {
    id: runId,
    job,
    trigger,
    startedAt: now,
    finishedAt: Date.now(),
    status: error === null ? 'ok' : 'error',
    stats,
    error,
  };

  try {
    // ONE batch, two tables (PLAN.md §9.2): a job can never be recorded as
    // finished while it still holds its lease, or vice versa.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, stats = ?, error = ? WHERE id = ?`,
      ).bind(finished.finishedAt, finished.status, encodeStats(stats), error, runId),
      releaseLeaseStatement(env, job, runId, finished.finishedAt ?? now),
    ]);
  } catch (err) {
    // Recording failed. The lease will expire on its own (TTL < cron period),
    // and the `running` row is the evidence. Never rethrow into `scheduled()`.
    console.error('[jobs] failed to finalize run', job, runId, err);
  }

  return finished;
}

async function insertRun(env: Env, run: JobRun): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      run.id,
      run.job,
      run.trigger,
      run.startedAt,
      run.finishedAt,
      run.status,
      encodeStats(run.stats),
      run.error,
    )
    .run();
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
  env: Env,
  job: JobName,
  trigger: 'cron' | 'admin',
  now: EpochMs,
): Promise<JobRun> {
  return withJobRun(env, job, trigger, now, async () => {
    switch (job) {
      case 'refresh': {
        const stats = await runRefresh(env, now, refreshTargetsPerRun(env, trigger));
        return { ...stats };
      }
      case 'settle': {
        // M6 owns settle.ts. Until it lands this throws and `withJobRun` records
        // the run as `error` — which is the honest state, and is visible in
        // GET /api/admin/jobs rather than silently succeeding.
        const stats = await runSettle(env, now, readConfig(env).settleChunk);
        return { ...stats };
      }
      case 'maintenance': {
        const stats = await runMaintenance(env, now);
        return { ...stats };
      }
    }
  });
}

/** The rolling window `dayRowsWritten` covers. PLAN.md §8.6 / §15 M8. */
const ROWS_WRITTEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sum of `job_runs.stats.rowsWritten` over the last 24 hours, across every job.
 *
 * This is the number to check against D1's hard-enforced 100,000-rows-per-day
 * free-tier cap (PLAN.md §8.6): past the cap D1 ERRORS, which blocks bet
 * placement and settlement, not just the board. It is a rolling 24 h rather than
 * a UTC day because the operator wants "are we running hot right now", and a
 * UTC-day total is misleading at 00:05.
 *
 * THE `json_valid` GUARD IS LOAD-BEARING, not defensive dressing: SQLite's
 * `json_extract` RAISES on malformed JSON rather than returning NULL (verified —
 * `D1_ERROR: malformed JSON`), so a single corrupt `stats` blob would take down
 * the whole admin jobs page, which is the one place you look when something is
 * already wrong. `json_valid(NULL)` is NULL, so a missing `stats` is skipped by
 * the same clause, and `SUM` ignores the NULLs either way.
 */
async function dayRowsWritten(env: Env, now: EpochMs): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(
              CASE WHEN json_valid(stats) THEN json_extract(stats, '$.rowsWritten') END
            ), 0) AS n
       FROM job_runs
      WHERE started_at >= ?`,
  )
    .bind(now - ROWS_WRITTEN_WINDOW_MS)
    .first<{ n: number }>();
  return typeof row?.n === 'number' ? row.n : 0;
}

/**
 * The last `limit` runs, newest first, each with a rolling-24h `dayRowsWritten`
 * folded INTO its `stats`.
 *
 * Why inside `stats` rather than beside it: `api-types.ts` is frozen after M2d
 * (CLAUDE.md "Merge-conflict etiquette"), `JobRunsResponse` has no room for an
 * extra field, and `JobRunView.stats` is already `Record<string, unknown>`. So
 * the daily total rides along there and the admin page reads it off any run.
 */
export async function recentRuns(
  env: Env,
  limit: number,
  now: EpochMs = Date.now(),
): Promise<readonly JobRun[]> {
  const res = await env.DB.prepare(
    `SELECT id, job, trigger, started_at, finished_at, status, stats, error
       FROM job_runs
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<JobRunDbRow>();

  const total = await dayRowsWritten(env, now);
  return res.results.map((row) => {
    const run = toJobRun(row);
    return { ...run, stats: { ...(run.stats ?? {}), dayRowsWritten: total } };
  });
}
