import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRunResponse, JobRunsResponse, UserResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { JOB_LEASE_TTL_MS, SESSION_COOKIE_NAME } from '../../src/shared/constants.js';
import {
  acquireLease,
  jobForCron,
  recentRuns,
  releaseLease,
  runJob,
  withJobRun,
} from '../../src/worker/jobs.js';
import { buildApp } from '../../src/worker/index.js';
import { DK_VECTORS } from './setup.js';
import { stubEspn } from './fixtures.js';
import type { EspnStub } from './fixtures.js';

/** TDD contract for M4 (leases) — PLAN.md §9.2. */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const NOW = Date.parse('2026-09-13T12:00:00Z');

let espn: EspnStub;

beforeEach(async () => {
  espn = stubEspn({});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

afterEach(() => {
  espn.restore();
});

interface LockRow {
  readonly name: string;
  readonly lease_until: number;
  readonly run_id: string;
}

function lockRow(name: string): Promise<LockRow | null> {
  return env.DB.prepare('SELECT * FROM job_locks WHERE name = ?').bind(name).first<LockRow>();
}

describe('leases', () => {
  it('a second concurrent run cannot acquire the lease and exits as skipped', async () => {
    expect(await acquireLease(env, 'refresh', 'run-1', NOW)).toBe(true);
    expect(await acquireLease(env, 'refresh', 'run-2', NOW + 1_000)).toBe(false);

    // ...and a job body that runs while the lease is held is never invoked.
    let ran = false;
    const run = await withJobRun(env, 'refresh', 'cron', NOW + 2_000, () => {
      ran = true;
      return Promise.resolve({});
    });
    expect(ran).toBe(false);
    expect(run.status).toBe('skipped');
    // The lease holder is untouched by the skipped run.
    expect((await lockRow('refresh'))?.run_id).toBe('run-1');
  });

  it('an EXPIRED lease is reclaimed by the next run', async () => {
    expect(await acquireLease(env, 'refresh', 'run-1', NOW)).toBe(true);
    const ttl = JOB_LEASE_TTL_MS.refresh;
    // One ms before expiry: still held.
    expect(await acquireLease(env, 'refresh', 'run-2', NOW + ttl - 1)).toBe(false);
    // At expiry (lease_until <= now): reclaimed.
    expect(await acquireLease(env, 'refresh', 'run-3', NOW + ttl)).toBe(true);
    expect((await lockRow('refresh'))?.run_id).toBe('run-3');
  });

  it('release sets lease_until to 0 so the next run starts immediately', async () => {
    expect(await acquireLease(env, 'settle', 'run-1', NOW)).toBe(true);
    await releaseLease(env, 'settle', 'run-1', NOW + 10);
    expect((await lockRow('settle'))?.lease_until).toBe(0);
    expect(await acquireLease(env, 'settle', 'run-2', NOW + 20)).toBe(true);
  });

  it('release by a DIFFERENT run id is a no-op (it does not steal the lease)', async () => {
    expect(await acquireLease(env, 'settle', 'run-1', NOW)).toBe(true);
    await releaseLease(env, 'settle', 'someone-else', NOW + 10);
    expect((await lockRow('settle'))?.lease_until).toBeGreaterThan(NOW);
  });

  it('a crashed run (no release) is unblocked once the TTL passes', async () => {
    // Simulate a crash: take the lease and never release it.
    expect(await acquireLease(env, 'maintenance', 'crashed', NOW)).toBe(true);
    const ttl = JOB_LEASE_TTL_MS.maintenance;
    expect((await lockRow('maintenance'))?.lease_until).toBe(NOW + ttl);
    expect(await acquireLease(env, 'maintenance', 'next', NOW + ttl - 1)).toBe(false);
    expect(await acquireLease(env, 'maintenance', 'next', NOW + ttl + 1)).toBe(true);
  });

  it('withJobRun releases the lease on the way out, even when the body throws', async () => {
    const run = await withJobRun(env, 'refresh', 'cron', NOW, () =>
      Promise.reject(new Error('boom')),
    );
    expect(run.status).toBe('error');
    expect((await lockRow('refresh'))?.lease_until).toBe(0);
    // ...so the very next run can start.
    expect(await acquireLease(env, 'refresh', 'after', NOW + 1)).toBe(true);
  });
});

describe('job_runs', () => {
  it('records status ok with stats on success', async () => {
    const run = await withJobRun(env, 'refresh', 'cron', NOW, () =>
      Promise.resolve({ targetsProcessed: 3, gamesUpserted: 7 }),
    );
    expect(run.status).toBe('ok');
    expect(run.job).toBe('refresh');
    expect(run.trigger).toBe('cron');
    expect(run.startedAt).toBe(NOW);
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBeNull();
    expect(run.stats).toEqual({ targetsProcessed: 3, gamesUpserted: 7 });

    const rows = await recentRuns(env, 50, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(run.id);
    expect(rows[0]?.status).toBe('ok');
    // What was STORED is exactly what the body returned; `recentRuns` folds the
    // rolling-24h total in on the way out (PLAN.md §8.6).
    expect(rows[0]?.stats).toEqual({
      targetsProcessed: 3,
      gamesUpserted: 7,
      dayRowsWritten: 0,
    });
  });

  it('recentRuns folds a rolling-24h dayRowsWritten into every run stats', async () => {
    // Three runs: two inside the window, one a day and a bit before it.
    await withJobRun(env, 'refresh', 'cron', NOW - 25 * 60 * 60_000, () =>
      Promise.resolve({ rowsWritten: 9_000 }),
    );
    await withJobRun(env, 'refresh', 'cron', NOW - 60_000, () =>
      Promise.resolve({ rowsWritten: 120 }),
    );
    await withJobRun(env, 'refresh', 'cron', NOW, () => Promise.resolve({ rowsWritten: 43 }));

    const rows = await recentRuns(env, 50, NOW);
    expect(rows).toHaveLength(3);
    // 120 + 43; the 25-hour-old 9,000 is outside the window.
    for (const row of rows) expect(row.stats?.['dayRowsWritten']).toBe(163);
    // ...and the per-run figure is untouched.
    expect(rows[0]?.stats?.['rowsWritten']).toBe(43);
  });

  it('recentRuns survives a run with null or non-numeric stats', async () => {
    await withJobRun(env, 'refresh', 'cron', NOW, () => Promise.resolve({ rowsWritten: 7 }));
    await env.DB.prepare(
      `INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
       VALUES ('corrupt', 'refresh', 'cron', ?, ?, 'ok', 'not json', NULL)`,
    )
      .bind(NOW, NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
       VALUES ('nostats', 'settle', 'cron', ?, ?, 'ok', NULL, NULL)`,
    )
      .bind(NOW, NOW)
      .run();

    const rows = await recentRuns(env, 50, NOW);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.stats?.['dayRowsWritten']).toBe(7);
  });

  it('withJobRun still resolves when the job_runs INSERT itself fails', async () => {
    // The docstring promises "always resolves" — and the INSERT used to sit
    // OUTSIDE the try, so a D1 hiccup while recording the START of a run would
    // reject into `scheduled()` and take the whole cron invocation down before
    // the body ever ran. Make every `INSERT INTO job_runs` throw and assert the
    // run still completes, still runs its body, and still releases its lease.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let bodyRan = false;
    env.DB.prepare = (sql: string) => {
      if (sql.includes('INSERT INTO job_runs')) {
        throw new Error('D1_ERROR: no such table: job_runs');
      }
      return realPrepare(sql);
    };

    try {
      const run = await withJobRun(env, 'refresh', 'cron', NOW, () => {
        bodyRan = true;
        return Promise.resolve({ ok: true });
      });
      expect(bodyRan).toBe(true);
      expect(run.status).toBe('ok');
      expect(run.stats).toEqual({ ok: true });
    } finally {
      env.DB.prepare = realPrepare;
    }

    // Nothing was recorded — that is the documented degradation — but the lease
    // was released, so the next scheduled run is not blocked for a whole TTL.
    expect(await recentRuns(env, 50, NOW)).toHaveLength(0);
    expect((await lockRow('refresh'))?.lease_until).toBe(0);
  });

  it('withJobRun still resolves when the lease is held AND the INSERT fails', async () => {
    expect(await acquireLease(env, 'refresh', 'holder', NOW)).toBe(true);
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      if (sql.includes('INSERT INTO job_runs')) throw new Error('D1_ERROR: recording is down');
      return realPrepare(sql);
    };

    try {
      const run = await withJobRun(env, 'refresh', 'admin', NOW + 1, () => Promise.resolve({}));
      expect(run.status).toBe('skipped');
    } finally {
      env.DB.prepare = realPrepare;
    }
    // The holder's lease is untouched.
    expect((await lockRow('refresh'))?.run_id).toBe('holder');
  });

  it('records status error with the message, and does NOT rethrow', async () => {
    const run = await withJobRun(env, 'settle', 'cron', NOW, () => {
      throw new Error('upstream exploded');
    });
    expect(run.status).toBe('error');
    expect(run.error).toContain('upstream exploded');

    const rows = await recentRuns(env, 50);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.error).toContain('upstream exploded');
  });

  it('records status skipped when the lease is held', async () => {
    expect(await acquireLease(env, 'refresh', 'holder', NOW)).toBe(true);
    const run = await withJobRun(env, 'refresh', 'admin', NOW + 1, () => Promise.resolve({}));
    expect(run.status).toBe('skipped');
    expect(run.finishedAt).toBe(NOW + 1);

    const rows = await recentRuns(env, 50);
    expect(rows[0]?.status).toBe('skipped');
  });

  it('recentRuns returns the newest first and honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await withJobRun(env, 'refresh', 'cron', NOW + i * 1_000, () => Promise.resolve({ i }));
    }
    const rows = await recentRuns(env, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.startedAt).toBe(NOW + 4_000);
    expect(rows[2]?.startedAt).toBe(NOW + 2_000);
  });

  it('runJob("refresh") records an ok run end to end', async () => {
    const run = await runJob(env, 'refresh', 'cron', NOW);
    expect(run.status).toBe('ok');
    expect(run.job).toBe('refresh');
    expect(run.stats).not.toBeNull();
    expect(run.stats?.['targetsProcessed']).toBeTypeOf('number');
  });

  it('runJob("settle") records an ERROR while M6 is unimplemented, and never throws', async () => {
    // The settle implementation is M6's; until it lands, `runJob` must record
    // the failure rather than let it escape into `scheduled()`.
    const run = await runJob(env, 'settle', 'cron', NOW);
    expect(run.status).toBe('error');
    expect(run.error).toContain('M6');
  });

  it('runJob("maintenance") is a callable no-op that records a run (M6 fills it in)', async () => {
    const run = await runJob(env, 'maintenance', 'cron', NOW);
    expect(run.status).toBe('ok');
  });
});

describe('cron dispatch', () => {
  it('"*/15 * * * *" -> refresh', () => {
    expect(jobForCron('*/15 * * * *')).toBe('refresh');
  });
  it('"5-59/15 * * * *" -> settle', () => {
    expect(jobForCron('5-59/15 * * * *')).toBe('settle');
  });
  it('"30 8 * * *" -> maintenance', () => {
    expect(jobForCron('30 8 * * *')).toBe('maintenance');
  });
  it('an unknown cron expression is a no-op, not a crash', () => {
    expect(jobForCron('0 0 1 1 *')).toBeNull();
    expect(jobForCron('')).toBeNull();
    expect(jobForCron('   ')).toBeNull();
  });
  it('the three expressions match wrangler.jsonc exactly', () => {
    // If someone edits a cron in wrangler.jsonc without editing jobForCron, the
    // deployed Worker silently stops running that job. Pin both ends.
    expect(['*/15 * * * *', '5-59/15 * * * *', '30 8 * * *'].map(jobForCron)).toEqual([
      'refresh',
      'settle',
      'maintenance',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * admin trigger (PLAN.md §9.3 / §11.6)
 * ------------------------------------------------------------------ */

function send(path: string, init: RequestInit): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, env));
}

async function registerAdmin(username: keyof typeof DK_VECTORS): Promise<string> {
  const res = await send('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
    body: JSON.stringify({ username, dk: DK_VECTORS[username], inviteCode: INVITE }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<UserResponse>();
  expect(body.user.isAdmin).toBe(true);
  const raw = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`).exec(raw);
  return `${SESSION_COOKIE_NAME}=${m?.[1] ?? ''}`;
}

async function registerPlain(username: keyof typeof DK_VECTORS): Promise<string> {
  const res = await send('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
    body: JSON.stringify({ username, dk: DK_VECTORS[username], inviteCode: INVITE }),
  });
  expect(res.status).toBe(201);
  const raw = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`).exec(raw);
  return `${SESSION_COOKIE_NAME}=${m?.[1] ?? ''}`;
}

describe('admin trigger', () => {
  it('POST /api/admin/jobs/refresh runs the same function with trigger=admin', async () => {
    const cookie = await registerAdmin('alex');
    const res = await send('/api/admin/jobs/refresh', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json<JobRunResponse>();
    expect(body.run.job).toBe('refresh');
    expect(body.run.trigger).toBe('admin');
    expect(body.run.status).toBe('ok');
    expect(body.run.stats).not.toBeNull();
  });

  it('GET /api/admin/jobs returns the last 50 runs, newest first', async () => {
    const cookie = await registerAdmin('alex');
    await runJob(env, 'refresh', 'cron', NOW);
    await runJob(env, 'refresh', 'cron', NOW + 60_000);
    const res = await send('/api/admin/jobs', { method: 'GET', headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<JobRunsResponse>();
    expect(body.runs.length).toBeGreaterThanOrEqual(2);
    expect(body.runs.length).toBeLessThanOrEqual(50);
    expect(body.runs[0]?.startedAt).toBeGreaterThanOrEqual(body.runs[1]?.startedAt ?? 0);
  });

  it('returns 409 JOB_LOCKED when the lease is held', async () => {
    const cookie = await registerAdmin('alex');
    await env.DB.prepare(
      'UPDATE job_locks SET lease_until = ?, run_id = ?, updated_at = ? WHERE name = ?',
    )
      .bind(Date.now() + 5 * 60_000, 'somebody-else', Date.now(), 'refresh')
      .run();

    const res = await send('/api/admin/jobs/refresh', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('JOB_LOCKED');
  });

  it('is 404 for a non-admin user', async () => {
    await registerAdmin('alex'); // first user takes the admin flag
    const cookie = await registerPlain('bob');
    const res = await send('/api/admin/jobs/refresh', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(404);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('NOT_FOUND');

    const list = await send('/api/admin/jobs', { method: 'GET', headers: { cookie } });
    expect(list.status).toBe(404);
  });

  it('is 401 for an anonymous caller', async () => {
    const res = await send('/api/admin/jobs/refresh', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown job name with 404 rather than running anything', async () => {
    const cookie = await registerAdmin('alex');
    const res = await send('/api/admin/jobs/not-a-job', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(404);
    expect(await recentRuns(env, 50)).toHaveLength(0);
  });
});
