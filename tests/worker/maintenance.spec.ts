import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { VOID_AFTER_MS } from '../../src/shared/constants.js';
import { placeBet } from '../../src/worker/bets.js';
import { runJob } from '../../src/worker/jobs.js';
import {
  JOB_RUNS_KEPT_PER_JOB,
  autoVoidStuckGames,
  findStuckInProgressGames,
  pruneAuthThrottle,
  pruneExpiredSessions,
  pruneJobRuns,
  runMaintenance,
} from '../../src/worker/maintenance.js';
import { runSettle } from '../../src/worker/settle.js';
import { seedGame, seedGameWithLine, updateGame } from './seed.js';
import { buildApp } from '../../src/worker/index.js';
import type { UserResponse } from '../../src/shared/api-types.js';

/**
 * TDD contract for M6's maintenance sweeps — PLAN.md §7.5.
 *
 * The point of this job is that money is never frozen forever: a game that is
 * postponed and never replayed, or that ESPN simply stops publishing, is turned
 * into `canceled` so the NEXT settle run voids the legs and returns the stakes.
 * It deliberately never auto-voids a game that might just be a feed hiccup —
 * those are reported for a human instead.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let NOW = 0;
let testIndex = 0;
let userSeq = 0;

beforeEach(async () => {
  NOW = Date.now();
  testIndex += 1;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare('DELETE FROM auth_throttle'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
  ]);
});

function g(n: number | string): string {
  return `nfl:m${String(testIndex)}-${String(n)}`;
}

async function statusOf(id: string): Promise<{ status: string; detail: string | null }> {
  const row = await env.DB.prepare(`SELECT status, status_detail FROM games WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; status_detail: string | null }>();
  return { status: row?.status ?? 'missing', detail: row?.status_detail ?? null };
}

async function register(): Promise<{ id: string; cookie: string }> {
  userSeq += 1;
  const res = await Promise.resolve(
    buildApp().request(
      `${ORIGIN}/api/auth/signup`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
        body: JSON.stringify({
          username: `keeper${String(userSeq)}`,
          dk: 'a'.repeat(64),
          inviteCode: INVITE,
        }),
      },
      env,
    ),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json<UserResponse>();
  const raw = res.headers.get('set-cookie') ?? '';
  return { id: body.user.id, cookie: /sbs_session=[^;]*/.exec(raw)?.[0] ?? '' };
}

/* ------------------------------------------------------------------ *
 * Auto-void
 * ------------------------------------------------------------------ */

describe('maintenance — auto-void', () => {
  it('a game postponed > 7 days past original_kickoff_at becomes canceled', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 8 * DAY,
      originalKickoffAt: NOW - 8 * DAY,
      status: 'postponed',
      lastSeenAt: NOW - HOUR,
    });

    const voided = await autoVoidStuckGames(env, NOW);
    expect(voided).toContain(id);
    const after = await statusOf(id);
    expect(after.status).toBe('canceled');
    expect(after.detail).toContain('auto-void');
  });

  it('a game postponed 2 days is left alone', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 2 * DAY,
      originalKickoffAt: NOW - 2 * DAY,
      status: 'postponed',
      lastSeenAt: NOW - HOUR,
    });

    expect(await autoVoidStuckGames(env, NOW)).not.toContain(id);
    expect((await statusOf(id)).status).toBe('postponed');
  });

  it('a game missing from the feed > 7 days past kickoff becomes canceled', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 8 * DAY,
      originalKickoffAt: NOW - 8 * DAY,
      status: 'scheduled',
      lastSeenAt: NOW - 3 * DAY, // ESPN stopped publishing it
    });

    expect(await autoVoidStuckGames(env, NOW)).toContain(id);
    expect((await statusOf(id)).status).toBe('canceled');
  });

  it('a still-published scheduled game past its kickoff is NOT auto-voided', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 8 * DAY,
      originalKickoffAt: NOW - 8 * DAY,
      status: 'scheduled',
      lastSeenAt: NOW - HOUR, // still in the feed: a human should look
    });

    expect(await autoVoidStuckGames(env, NOW)).not.toContain(id);
    expect((await statusOf(id)).status).toBe('scheduled');
  });

  it('a final game is never touched', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 30 * DAY,
      originalKickoffAt: NOW - 30 * DAY,
      status: 'final',
      homeScore: 31,
      awayScore: 17,
      lastSeenAt: NOW - 29 * DAY,
    });
    await autoVoidStuckGames(env, NOW);
    expect((await statusOf(id)).status).toBe('final');
  });

  it('a stuck in_progress game is REPORTED but not auto-voided', async () => {
    const id = g(1);
    await seedGame(env.DB, {
      id,
      kickoffAt: NOW - 13 * HOUR,
      originalKickoffAt: NOW - 13 * HOUR,
      status: 'in_progress',
      lastSeenAt: NOW - 7 * HOUR,
    });

    expect(await findStuckInProgressGames(env, NOW)).toContain(id);
    expect(await autoVoidStuckGames(env, NOW)).not.toContain(id);
    expect((await statusOf(id)).status).toBe('in_progress');
  });

  it('an auto-voided game lets the next settle run return the stake', async () => {
    const user = await register();
    const id = await seedGameWithLine(env.DB, {
      id: g(1),
      kickoffAt: NOW + 2 * HOUR,
      lastSeenAt: NOW - 60_000,
    });
    const { bet } = await placeBet(
      env,
      user.id,
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 2500,
        legs: [{ gameId: id, market: 'spread', side: 'home' }],
      },
      NOW,
    );
    // ESPN postpones it, and it is never replayed.
    await updateGame(env.DB, id, { status: 'postponed' });
    await env.DB.prepare(`UPDATE games SET original_kickoff_at = ?2 WHERE id = ?1`)
      .bind(id, NOW - 8 * DAY)
      .run();

    // Before maintenance the bet is untouchable: `postponed` is not settleable.
    expect((await runSettle(env, NOW, 20)).selected).toBe(0);

    await runMaintenance(env, NOW + 1);
    const stats = await runSettle(env, NOW + 2, 20);
    expect(stats.void).toBe(1);

    const row = await env.DB.prepare(`SELECT status, payout_cents AS p FROM bets WHERE id = ?1`)
      .bind(bet.id)
      .first<{ status: string; p: number }>();
    expect(row?.status).toBe('void');
    expect(row?.p).toBe(2500);
  });

  it('VOID_AFTER_MS is the documented 7 days', () => {
    expect(VOID_AFTER_MS).toBe(7 * DAY);
  });
});

/* ------------------------------------------------------------------ *
 * Pruning
 * ------------------------------------------------------------------ */

describe('maintenance — pruning', () => {
  it('prunes expired sessions and leaves live ones', async () => {
    const user = await register();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?3)`,
      ).bind(`dead-${String(testIndex)}`, user.id, NOW - 40 * DAY, NOW - DAY),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?3)`,
      ).bind(`live-${String(testIndex)}`, user.id, NOW, NOW + 30 * DAY),
    ]);

    expect(await pruneExpiredSessions(env, NOW)).toBeGreaterThanOrEqual(1);
    const dead = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?1`)
      .bind(`dead-${String(testIndex)}`)
      .first<{ n: number }>();
    const live = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?1`)
      .bind(`live-${String(testIndex)}`)
      .first<{ n: number }>();
    expect(dead?.n).toBe(0);
    expect(live?.n).toBe(1);
  });

  it('prunes stale auth_throttle rows but never an ACTIVE lockout', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auth_throttle (key, window_start, fail_count, locked_until)
           VALUES ('u:old', ?1, 3, 0)`,
      ).bind(NOW - 2 * DAY),
      env.DB.prepare(
        `INSERT INTO auth_throttle (key, window_start, fail_count, locked_until)
           VALUES ('u:locked', ?1, 10, ?2)`,
      ).bind(NOW - 2 * DAY, NOW + 10 * 60_000),
      env.DB.prepare(
        `INSERT INTO auth_throttle (key, window_start, fail_count, locked_until)
           VALUES ('u:recent', ?1, 1, 0)`,
      ).bind(NOW - 60_000),
    ]);

    expect(await pruneAuthThrottle(env, NOW)).toBe(1);
    const keys = await env.DB.prepare(`SELECT key FROM auth_throttle ORDER BY key`).all<{
      key: string;
    }>();
    expect(keys.results.map((r) => r.key)).toEqual(['u:locked', 'u:recent']);
  });

  it('prunes job_runs beyond the newest 200 per job, per job independently', async () => {
    // 205 `refresh` runs and 3 `settle` runs, in one statement each.
    await env.DB.prepare(
      `WITH RECURSIVE c(v) AS (SELECT 0 UNION ALL SELECT v + 1 FROM c WHERE v < 204)
       INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
       SELECT 'r-' || v, 'refresh', 'cron', ?1 + v, ?1 + v, 'ok', NULL, NULL FROM c`,
    )
      .bind(NOW - 500_000)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE c(v) AS (SELECT 0 UNION ALL SELECT v + 1 FROM c WHERE v < 2)
       INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
       SELECT 's-' || v, 'settle', 'cron', ?1 + v, ?1 + v, 'ok', NULL, NULL FROM c`,
    )
      .bind(NOW - 500_000)
      .run();

    expect(JOB_RUNS_KEPT_PER_JOB).toBe(200);
    expect(await pruneJobRuns(env, JOB_RUNS_KEPT_PER_JOB)).toBe(5);

    const counts = await env.DB.prepare(
      `SELECT job, COUNT(*) AS n FROM job_runs GROUP BY job ORDER BY job`,
    ).all<{ job: string; n: number }>();
    expect(counts.results).toEqual([
      { job: 'refresh', n: 200 },
      { job: 'settle', n: 3 },
    ]);

    // The NEWEST survive: r-0..r-4 (the oldest five) are the ones deleted.
    const oldest = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_runs WHERE id IN ('r-0','r-1','r-2','r-3','r-4')`,
    ).first<{ n: number }>();
    expect(oldest?.n).toBe(0);
    const newest = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_runs WHERE id = 'r-204'`,
    ).first<{ n: number }>();
    expect(newest?.n).toBe(1);
  });

  it('pruning is a no-op when there is nothing to prune', async () => {
    expect(await pruneJobRuns(env, JOB_RUNS_KEPT_PER_JOB)).toBe(0);
    expect(await pruneExpiredSessions(env, 0)).toBe(0);
    expect(await pruneAuthThrottle(env, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The job as a whole
 * ------------------------------------------------------------------ */

describe('maintenance — the job', () => {
  it('runMaintenance reports what it did', async () => {
    const voidable = g('void');
    const stuck = g('stuck');
    await seedGame(env.DB, {
      id: voidable,
      kickoffAt: NOW - 9 * DAY,
      originalKickoffAt: NOW - 9 * DAY,
      status: 'postponed',
      lastSeenAt: NOW - HOUR,
    });
    await seedGame(env.DB, {
      id: stuck,
      kickoffAt: NOW - 13 * HOUR,
      originalKickoffAt: NOW - 13 * HOUR,
      status: 'in_progress',
      lastSeenAt: NOW - 7 * HOUR,
    });

    const stats = await runMaintenance(env, NOW);
    expect(stats.autoVoidedGames).toContain(voidable);
    expect(stats.stuckGames).toContain(stuck);
    expect(stats.sessionsPruned).toBeTypeOf('number');
    expect(stats.throttleRowsPruned).toBeTypeOf('number');
    expect(stats.jobRunsPruned).toBeTypeOf('number');
    expect((await statusOf(stuck)).status).toBe('in_progress');
  });

  it('runJob("maintenance") records an ok run with stats', async () => {
    const run = await runJob(env, 'maintenance', 'cron', NOW);
    expect(run.status).toBe('ok');
    expect(run.error).toBeNull();
    expect(run.stats).not.toBeNull();
    expect(run.stats?.['autoVoidedGames']).toBeInstanceOf(Array);
    expect(run.stats?.['jobRunsPruned']).toBeTypeOf('number');
  });
});
