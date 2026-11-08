/**
 * Scheduler hardening (M13a) and the three-minute tick (M13b) — the contracts,
 * written FIRST (PLAN.md §24.15) as `it.todo`s and discharged by the milestone
 * named in each `describe`. The rules they name are PLAN.md §24.4–§24.7; a rule
 * added there is a contract added here in the same PR.
 *
 * A CPU kill is not catchable, so these tests simulate one the only honest
 * way: they run the stamp (`stampAttempt`, exactly what `ingestTarget` issues
 * before its fetch) and then simply do NOT run the reschedule.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_COMMENT_INTERVAL_MS,
  ALERT_COMMENT_MAX_INTERVAL_MS,
  ALERT_D1_ROWS_NEAR_CAP,
  ALERT_GITHUB_LABEL,
  ALERT_MAX_GITHUB_CALLS_PER_RUN,
  ALERT_REOPEN_WINDOW_MS,
  ALERT_RESOLVE_AFTER_MS,
  HEALTH_STALE_TICKS,
  INGEST_MAX_INCOMPLETE_ATTEMPTS,
  INGEST_PARKED_RETRY_MS,
  JOB_LEASE_TTL_MS,
  JOB_REAP_AFTER_MS,
  MAX_SETTLE_ATTEMPTS,
  REFRESH_BACKOFF_BASE_TICKS,
  REFRESH_DISCOVERY_EVERY_NTH_TICK,
  REFRESH_DISCOVERY_TICKS,
  REFRESH_LIVE_TICKS,
  REFRESH_SOON_TICKS,
  REFRESH_TICK_MS,
  REFRESH_WEIGHT_BUDGET,
} from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { etDateKey, etDayBounds } from '../../src/shared/time.js';
import { LEAGUES } from '../../src/shared/types.js';
import type { League } from '../../src/shared/types.js';
import { processAlerts, recordAlertConditions, evaluateAlerts } from '../../src/worker/alerts.js';
import type { AlertCondition, AlertStats } from '../../src/worker/alerts.js';
import type { Env } from '../../src/worker/env.js';
import { readConfig } from '../../src/worker/env.js';
import { EspnProvider, fetchScoreboard } from '../../src/worker/espn.js';
import {
  bumpTargetForGame,
  claimDueTargets,
  computeNextRunAt,
  espnOutcome,
  HEALTH_STALE_AFTER_MS,
  ingestTarget,
  isDiscoveryTick,
  nextDiscoveryTick,
  NO_LIVE_GAME,
  planTargets,
  refreshTickBase,
  RETIRE_PREDICATE,
  runRefresh,
  stampAttempt,
  targetWeight,
} from '../../src/worker/ingest.js';
import type { IngestTargetRow } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import { recentRuns, runJob, withJobRun } from '../../src/worker/jobs.js';
import type { JobRun } from '../../src/worker/jobs.js';
import { JOB_RUNS_KEPT_PER_JOB } from '../../src/worker/maintenance.js';
import { ProviderError } from '../../src/worker/providers.js';
import type { ProviderSlate, ScoreProvider } from '../../src/worker/providers.js';
import { buildScoreboard, stubEspn } from './fixtures.js';
import type { EspnStub, EventSpec } from './fixtures.js';
import { seedGame } from './seed.js';

/** Sunday 2026-09-13, noon ET. */
const T0 = Date.parse('2026-09-13T16:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The 15-minute provisional step (5 ticks) from the tick's base (§24.4, §24.7). */
const BACKOFF_STEP = 5 * REFRESH_TICK_MS;

let espn: EspnStub;

beforeEach(async () => {
  espn = stubEspn({});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_lines'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM ingest_targets'),
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare('DELETE FROM alerts'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
  ]);
});

afterEach(() => {
  espn.restore();
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

interface TargetSpec {
  readonly league?: League;
  /** ET calendar day offset from T0 (0 = 2026-09-13). */
  readonly day?: number;
  readonly nextRunAt?: number;
  readonly incomplete?: number;
  readonly attemptStartedAt?: number | null;
  readonly lastStatus?: 'ok' | 'error' | null;
  readonly lastOkAt?: number | null;
  readonly consecutiveFailures?: number;
  readonly conferenceId?: string | null;
  /** The weight (§24.7): games seen by the last successful fetch. */
  readonly gamesSeen?: number;
}

async function insertTarget(spec: TargetSpec = {}): Promise<string> {
  const league = spec.league ?? 'nfl';
  const at = T0 + (spec.day ?? 0) * DAY;
  const key = etDateKey(at);
  const bounds = etDayBounds(at);
  const id =
    spec.conferenceId === undefined || spec.conferenceId === null
      ? `${league}:date:${key}`
      : `${league}:conf:${spec.conferenceId}:date:${key}`;
  await env.DB.prepare(
    `INSERT INTO ingest_targets
       (id, league, kind, key, window_start_at, window_end_at, priority, next_run_at,
        consecutive_failures, games_seen, created_at, updated_at,
        incomplete_attempts, attempt_started_at, last_status, last_ok_at, conference_id)
     VALUES (?1, ?2, 'date', ?3, ?4, ?5, 100, ?6, ?7, ?14, ?8, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      id,
      league,
      key,
      bounds.startAt,
      bounds.endAt,
      spec.nextRunAt ?? T0 - HOUR,
      spec.consecutiveFailures ?? 0,
      T0 - DAY,
      spec.incomplete ?? 0,
      spec.attemptStartedAt ?? null,
      spec.lastStatus ?? null,
      spec.lastOkAt ?? null,
      spec.conferenceId ?? null,
      spec.gamesSeen ?? 0,
    )
    .run();
  return id;
}

interface GuardRow {
  readonly id: string;
  readonly next_run_at: number;
  readonly updated_at: number;
  readonly incomplete_attempts: number;
  readonly attempt_started_at: number | null;
  readonly last_ok_at: number | null;
  readonly last_status: string | null;
  readonly consecutive_failures: number;
}

async function guardRow(id: string): Promise<GuardRow> {
  const row = await env.DB.prepare(
    `SELECT id, next_run_at, updated_at, incomplete_attempts, attempt_started_at, last_ok_at,
            last_status, consecutive_failures
       FROM ingest_targets WHERE id = ?1`,
  )
    .bind(id)
    .first<GuardRow>();
  if (row === null) throw new Error(`no target ${id}`);
  return row;
}

async function loadTarget(id: string): Promise<IngestTargetRow> {
  const row = await env.DB.prepare('SELECT * FROM ingest_targets WHERE id = ?1').bind(id).first<{
    id: string;
    league: League;
    kind: 'date';
    key: string;
    window_start_at: number;
    window_end_at: number;
    priority: number;
    next_run_at: number;
    consecutive_failures: number;
    incomplete_attempts: number;
    last_ok_at: number | null;
  }>();
  if (row === null) throw new Error(`no target ${id}`);
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
    lastOkAt: row.last_ok_at,
    incompleteAttempts: row.incomplete_attempts,
  };
}

function emptyBoard(): Response {
  return new Response(JSON.stringify(buildScoreboard([])), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function keyOf(day: number): string {
  return etDateKey(T0 + day * DAY);
}

/* ------------------------------------------------------------------ *
 * GitHub stub (the bugs.spec pattern, widened to comments and PATCH)
 * ------------------------------------------------------------------ */

interface GitHubCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface GitHubStub {
  readonly calls: GitHubCall[];
  /** Return a Response to override, or null for the default success. */
  respond: (call: GitHubCall) => Response | null | Promise<Response | null>;
  restore(): void;
}

let issueSeq = 500;
function stubGitHub(): GitHubStub {
  const original = globalThis.fetch;
  const calls: GitHubCall[] = [];
  const stub: GitHubStub = {
    calls,
    respond: () => null,
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://github.test/')) return original(input, init);
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const call: GitHubCall = {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname,
      body: JSON.parse(raw) as Record<string, unknown>,
    };
    calls.push(call);
    const override = await stub.respond(call);
    if (override !== null) return override;
    if (call.method === 'POST' && call.path.endsWith('/issues')) {
      issueSeq += 1;
      return Response.json(
        {
          number: issueSeq,
          html_url: `https://github.com/wardcrazy01894/SpicyBettingSimulator/issues/${String(issueSeq)}`,
        },
        { status: 201 },
      );
    }
    if (call.method === 'POST' && call.path.endsWith('/comments')) {
      return Response.json({ id: 1 }, { status: 201 });
    }
    return Response.json({}, { status: 200 });
  };
  return stub;
}

const ISSUES_PATH = '/repos/wardcrazy01894/SpicyBettingSimulator/issues';

function creates(gh: GitHubStub): GitHubCall[] {
  return gh.calls.filter((c) => c.method === 'POST' && c.path === ISSUES_PATH);
}
function comments(gh: GitHubStub): GitHubCall[] {
  return gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'));
}
function patches(gh: GitHubStub): GitHubCall[] {
  return gh.calls.filter((c) => c.method === 'PATCH');
}

/** `env` is not spreadable; build an Env variant key by key (bugs.spec's pattern). */
function envWith(overrides: { token?: string | undefined; mention?: string }): Env {
  const token = 'token' in overrides ? overrides.token : env.GITHUB_TOKEN;
  return {
    DB: env.DB,
    ASSETS: env.ASSETS,
    ESPN_BASE_URL: env.ESPN_BASE_URL,
    COOKIE_SECURE: env.COOKIE_SECURE,
    REFRESH_TARGETS_PER_RUN: env.REFRESH_TARGETS_PER_RUN,
    SETTLE_CHUNK: env.SETTLE_CHUNK,
    APP_VERSION: env.APP_VERSION,
    GITHUB_REPO: env.GITHUB_REPO,
    GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL,
    ODDS_API_BASE_URL: env.ODDS_API_BASE_URL,
    ALERT_MENTION_LOGIN: overrides.mention ?? env.ALERT_MENTION_LOGIN ?? '',
    ...(env.INVITE_CODE === undefined ? {} : { INVITE_CODE: env.INVITE_CODE }),
    ...(token === undefined ? {} : { GITHUB_TOKEN: token }),
  };
}

interface AlertRow {
  readonly fingerprint: string;
  readonly state: string;
  readonly issue_number: number | null;
  readonly opened_at: number;
  readonly last_seen_at: number;
  readonly last_notified_at: number;
  readonly resolved_at: number | null;
  readonly occurrences: number;
  readonly pending: number;
  readonly comments: number;
  readonly last_detail: string | null;
}

async function alertRow(fingerprint: string): Promise<AlertRow | null> {
  return env.DB.prepare('SELECT * FROM alerts WHERE fingerprint = ?1')
    .bind(fingerprint)
    .first<AlertRow>();
}

async function allAlerts(): Promise<AlertRow[]> {
  return (await env.DB.prepare('SELECT * FROM alerts ORDER BY fingerprint').all<AlertRow>())
    .results;
}

const PARKED_COND: AlertCondition = {
  kind: 'target-parked',
  key: 'nfl:date:20260913',
  detail: '3 incomplete attempts',
};

/** One evaluation step the way `evaluateAlerts` does it: record, then act. */
async function step(
  now: number,
  conditions: readonly AlertCondition[],
  e: Env = env,
): Promise<AlertStats> {
  await recordAlertConditions(e, now, conditions);
  return processAlerts(e, now);
}

function fakeRun(job: JobRun['job'], over: Partial<JobRun> = {}): JobRun {
  return {
    id: `fake-${job}`,
    job,
    trigger: 'cron',
    startedAt: T0,
    finishedAt: T0,
    status: 'ok',
    stats: {},
    error: null,
    ...over,
  };
}

async function insertRun(
  job: string,
  startedAt: number,
  status: string,
  stats: string | null = null,
): Promise<string> {
  const id = `${job}-${String(startedAt)}-${status}-${String(Math.random()).slice(2, 8)}`;
  await env.DB.prepare(
    `INSERT INTO job_runs (id, job, trigger, started_at, finished_at, status, stats, error)
     VALUES (?1, ?2, 'cron', ?3, ?4, ?5, ?6, NULL)`,
  )
    .bind(id, job, startedAt, status === 'running' ? null : startedAt, status, stats)
    .run();
  return id;
}

/* ================================================================== */

describe('M13a: the poison-target guard (PLAN.md §24.4)', () => {
  it('each target is stamped immediately before ITS OWN fetch, never all at claim time', async () => {
    // Both small (fetched OK before, empty) so the weight budget packs them (§24.7).
    const a = await insertTarget({ day: 0, nextRunAt: T0 - 2 * HOUR, lastOkAt: T0 - DAY });
    const b = await insertTarget({ day: 1, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    const seen: Record<string, [number, number]> = {};
    const snapshot = (label: string) => async (): Promise<Response> => {
      seen[label] = [
        (await guardRow(a)).incomplete_attempts,
        (await guardRow(b)).incomplete_attempts,
      ];
      return emptyBoard();
    };
    espn.setResponder(keyOf(0), snapshot('a'));
    espn.setResponder(keyOf(1), snapshot('b'));

    const claimed = await claimDueTargets(env, T0, 2, false);
    expect(claimed.map((t) => t.id)).toEqual([a, b]);
    // Claiming writes nothing: both counters are still 0 after the claim.
    expect((await guardRow(a)).incomplete_attempts).toBe(0);
    expect((await guardRow(b)).incomplete_attempts).toBe(0);

    const provider = new EspnProvider(env, T0);
    for (const t of claimed) await ingestTarget(env, provider, t, T0);
    // During A's fetch only A was stamped; during B's, A had already reset.
    expect(seen['a']).toEqual([1, 0]);
    expect(seen['b']).toEqual([0, 1]);
    expect((await guardRow(a)).incomplete_attempts).toBe(0);
    expect((await guardRow(b)).incomplete_attempts).toBe(0);
  });

  it('a run killed during target 1 leaves target 2 untouched: no increment, no provisional backoff', async () => {
    const a = await insertTarget({ day: 0, nextRunAt: T0 - 2 * HOUR, lastOkAt: T0 - DAY });
    const b = await insertTarget({ day: 1, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    const before = await guardRow(b);
    const claimed = await claimDueTargets(env, T0, 2, false);
    const first = claimed[0];
    if (first === undefined) throw new Error('nothing claimed');
    // The kill: the stamp ran, the reschedule never did.
    await stampAttempt(env, first, T0);

    const blamed = await guardRow(a);
    expect(blamed.incomplete_attempts).toBe(1);
    expect(blamed.attempt_started_at).toBe(T0);
    // Provisional: the floor-fallback base (T0 is on a tick) + 5 ticks = 15 min.
    expect(blamed.next_run_at).toBe(T0 + BACKOFF_STEP);
    expect(await guardRow(b)).toEqual(before);
  });

  it('a stamp that cannot be written fetches nothing, reschedules nothing, and reports skipped', async () => {
    const a = await insertTarget({ day: 0, nextRunAt: T0 - HOUR });
    await env.DB.prepare(
      'UPDATE ingest_targets SET consecutive_failures = 2, incomplete_attempts = 1 WHERE id = ?1',
    )
      .bind(a)
      .run();
    const before = await env.DB.prepare(
      'SELECT next_run_at, incomplete_attempts, attempt_started_at, consecutive_failures, last_status FROM ingest_targets WHERE id = ?1',
    )
      .bind(a)
      .first();
    let fetched = 0;
    espn.setResponder(keyOf(0), () => {
      fetched += 1;
      return Promise.resolve(emptyBoard());
    });
    const realPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: typeof env.DB.prepare }).prepare = (sql: string) => {
      if (sql.includes('incomplete_attempts = incomplete_attempts + 1'))
        throw new Error('d1 stamp blip');
      return realPrepare(sql);
    };
    try {
      const result = await ingestTarget(env, new EspnProvider(env, T0), await loadTarget(a), T0);
      expect(result.espn).toBe('skipped');
      expect(result.error).toContain('d1 stamp blip');
      expect(result.rowsWritten).toBe(0);
    } finally {
      delete (env.DB as { prepare?: unknown }).prepare;
    }
    // Never fetched, and NOTHING written: no reschedule, so the earlier strike
    // and the failure streak are exactly as they were and the target is still due.
    expect(fetched).toBe(0);
    const after = await env.DB.prepare(
      'SELECT next_run_at, incomplete_attempts, attempt_started_at, consecutive_failures, last_status FROM ingest_targets WHERE id = ?1',
    )
      .bind(a)
      .first();
    expect(after).toEqual(before);
  });

  it('the provisional backoff doubles per incomplete attempt: 15, 30, then 60 min', async () => {
    const a = await insertTarget({ day: 0 });
    for (const [attempt, minutes] of [
      [0, 15],
      [1, 30],
      [2, 60],
    ] as const) {
      await env.DB.prepare('UPDATE ingest_targets SET incomplete_attempts = ?2 WHERE id = ?1')
        .bind(a, attempt)
        .run();
      // 40 s past a tick: the base is the tick, not `now` (§24.7's floor fallback).
      await stampAttempt(env, await loadTarget(a), T0 + 40_000);
      expect((await guardRow(a)).next_run_at).toBe(T0 + minutes * MIN);
    }
  });

  it('a target with incomplete_attempts > 0 is never packed behind another target: it runs alone', async () => {
    const blamed = await insertTarget({
      day: 0,
      nextRunAt: T0 - 2 * HOUR,
      incomplete: 1,
      lastOkAt: T0 - DAY,
    });
    await insertTarget({ day: 1, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    const claimed = await claimDueTargets(env, T0, 2, false);
    expect(claimed.map((t) => t.id)).toEqual([blamed]);
    // A wider run (3 slots, both weigh 1) still adds nothing after a blamed first.
    expect((await claimDueTargets(env, T0, 3, false)).map((t) => t.id)).toEqual([blamed]);
  });

  it('a candidate with incomplete_attempts > 0 ENDS the packing: nothing is claimed behind or after it (M13b form)', async () => {
    // All three weigh 1, so only the blamed rule can stop the packing.
    const healthy = await insertTarget({ day: 0, nextRunAt: T0 - 3 * HOUR, lastOkAt: T0 - DAY });
    await insertTarget({ day: 1, nextRunAt: T0 - 2 * HOUR, incomplete: 2, lastOkAt: T0 - DAY });
    await insertTarget({ day: 2, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    // M13a skipped the blamed one and packed the third; the budget form stops
    // at it, so the blamed target is next in line, alone, on the next tick.
    expect((await claimDueTargets(env, T0, 5, false)).map((t) => t.id)).toEqual([healthy]);
  });

  it('the success path sets last_ok_at', async () => {
    const a = await insertTarget({ day: 0 });
    expect((await guardRow(a)).last_ok_at).toBeNull();
    await ingestTarget(env, new EspnProvider(env, T0), await loadTarget(a), T0);
    expect((await guardRow(a)).last_ok_at).toBe(T0);
  });

  it('the success reschedule resets incomplete_attempts to 0 and attempt_started_at to NULL', async () => {
    const a = await insertTarget({ day: 0, incomplete: 2, attemptStartedAt: T0 - HOUR });
    await ingestTarget(env, new EspnProvider(env, T0), await loadTarget(a), T0);
    const row = await guardRow(a);
    expect(row.incomplete_attempts).toBe(0);
    expect(row.attempt_started_at).toBeNull();
    expect(row.last_status).toBe('ok');
  });

  it('the failure reschedule (ESPN 5xx, timeout, bad JSON, D1 error in upsertSlate) resets them too', async () => {
    const responders: Record<string, () => Response> = {
      '5xx': () => new Response('upstream sad', { status: 503 }),
      timeout: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      'bad-json': () => new Response('<html>not json</html>', { status: 200 }),
    };
    for (const [label, responder] of Object.entries(responders)) {
      await env.DB.prepare('DELETE FROM ingest_targets').run();
      const a = await insertTarget({ day: 0, incomplete: 2, attemptStartedAt: T0 - HOUR });
      espn.setResponder(keyOf(0), responder);
      const result = await ingestTarget(env, new EspnProvider(env, T0), await loadTarget(a), T0);
      expect(result.error, label).not.toBeNull();
      expect(result.espn, label).toBe(label);
      const row = await guardRow(a);
      expect(row.incomplete_attempts, label).toBe(0);
      expect(row.attempt_started_at, label).toBeNull();
      expect(row.last_status, label).toBe('error');
      expect(row.last_ok_at, label).toBeNull();
    }

    // A D1 error inside upsertSlate: a slate whose game violates a CHECK.
    await env.DB.prepare('DELETE FROM ingest_targets').run();
    const a = await insertTarget({ day: 0, incomplete: 1, attemptStartedAt: T0 - HOUR });
    const parsed = parseScoreboard(
      buildScoreboard([
        {
          eventId: '401',
          league: 'nfl',
          kickoffAt: T0 + HOUR,
          status: 'pre',
          homeAbbr: 'CIN',
          awayAbbr: 'TB',
          season: 2026,
          week: 1,
        },
      ]),
      'nfl',
      T0,
    );
    const broken: ProviderSlate = {
      games: parsed.games.map((g) => ({ ...g, league: 'nhl' as League })),
      lines: [],
      warnings: [],
      fetchedAt: T0,
      season: 2026,
      week: 1,
    };
    const provider: ScoreProvider = { name: 'broken', fetchSlate: () => Promise.resolve(broken) };
    const result = await ingestTarget(env, provider, await loadTarget(a), T0);
    expect(result.error).toMatch(/CHECK|constraint/i);
    expect(result.espn).toBe('200');
    const row = await guardRow(a);
    expect(row.incomplete_attempts).toBe(0);
    expect(row.attempt_started_at).toBeNull();
    expect(row.last_status).toBe('error');
  });

  it('a target with incomplete_attempts >= INGEST_MAX_INCOMPLETE_ATTEMPTS is not claimed', async () => {
    await insertTarget({
      day: 0,
      nextRunAt: T0 - 3 * HOUR,
      incomplete: INGEST_MAX_INCOMPLETE_ATTEMPTS,
      attemptStartedAt: T0 - HOUR,
    });
    const other = await insertTarget({ day: 1, nextRunAt: T0 - HOUR });
    expect((await claimDueTargets(env, T0, 2, false)).map((t) => t.id)).toEqual([other]);
  });

  it('a parked target is claimable for ONE probation attempt INGEST_PARKED_RETRY_MS after its last attempt', async () => {
    const parked = await insertTarget({
      day: 0,
      nextRunAt: T0 - 7 * HOUR,
      incomplete: INGEST_MAX_INCOMPLETE_ATTEMPTS,
      attemptStartedAt: T0 - INGEST_PARKED_RETRY_MS + 1,
    });
    await insertTarget({ day: 1, nextRunAt: T0 - HOUR });
    // One ms short of the probation: still parked.
    expect((await claimDueTargets(env, T0, 2, false)).map((t) => t.id)).not.toContain(parked);
    // At the probation instant it is claimable — and, being blamed, alone.
    const claimed = await claimDueTargets(env, T0 + 1, 2, false);
    expect(claimed.map((t) => t.id)).toEqual([parked]);

    // Killed again: the counter was not reset by waiting, so it re-parks at once.
    const target = claimed[0];
    if (target === undefined) throw new Error('nothing claimed');
    await stampAttempt(env, target, T0 + 1);
    expect((await guardRow(parked)).incomplete_attempts).toBe(INGEST_MAX_INCOMPLETE_ATTEMPTS + 1);
    expect((await claimDueTargets(env, T0 + 2 * HOUR, 2, false)).map((t) => t.id)).not.toContain(
      parked,
    );
  });

  it('bumpTargetForGame un-parks (incomplete_attempts = 0) and the admin run stamps attempt 1', async () => {
    const now = T0;
    await seedGame(env.DB, { id: 'nfl:bump', kickoffAt: now + 2 * HOUR });
    const id = await insertTarget({
      day: 0,
      nextRunAt: now + HOUR,
      incomplete: 4,
      attemptStartedAt: now - HOUR,
    });
    const bumped = await bumpTargetForGame(env, 'nfl:bump', now);
    expect(bumped).toEqual({ targetId: id });
    const row = await guardRow(id);
    expect(row.incomplete_attempts).toBe(0);
    expect(row.attempt_started_at).toBeNull();
    expect(row.next_run_at).toBe(0);

    let duringFetch = -1;
    espn.setResponder(keyOf(0), async () => {
      duringFetch = (await guardRow(id)).incomplete_attempts;
      return emptyBoard();
    });
    const run = await runJob(env, 'refresh', 'admin', now);
    expect(run.status).toBe('ok');
    expect(duringFetch).toBe(1);
    expect((await guardRow(id)).incomplete_attempts).toBe(0);
  });

  it('stats.parked lists every parked target', async () => {
    const p1 = await insertTarget({
      day: 5,
      nextRunAt: T0 + DAY,
      incomplete: INGEST_MAX_INCOMPLETE_ATTEMPTS,
      attemptStartedAt: T0 - HOUR,
    });
    const p2 = await insertTarget({
      league: 'ncaaf',
      day: 6,
      nextRunAt: T0 + DAY,
      incomplete: INGEST_MAX_INCOMPLETE_ATTEMPTS + 2,
      attemptStartedAt: T0 - 2 * HOUR,
    });
    await insertTarget({ day: 4, nextRunAt: T0 + DAY, incomplete: 1, attemptStartedAt: T0 });
    const stats = await runRefresh(env, T0, 2);
    expect(stats.parked).toEqual([
      {
        targetId: p2,
        incompleteAttempts: INGEST_MAX_INCOMPLETE_ATTEMPTS + 2,
        attemptStartedAt: T0 - 2 * HOUR,
      },
      {
        targetId: p1,
        incompleteAttempts: INGEST_MAX_INCOMPLETE_ATTEMPTS,
        attemptStartedAt: T0 - HOUR,
      },
    ]);
  });

  it('withJobRun reaps running rows older than JOB_REAP_AFTER_MS; a slow live run past its lease is NOT reaped', async () => {
    const dead = await insertRun('refresh', T0 - JOB_REAP_AFTER_MS - 1, 'running');
    const slow = await insertRun('refresh', T0 - 10 * MIN, 'running');
    const otherJob = await insertRun('settle', T0 - DAY, 'running');
    const run = await withJobRun(env, 'refresh', 'cron', T0, () => Promise.resolve({}));
    expect(run.status).toBe('ok');

    const row = (id: string) =>
      env.DB.prepare('SELECT status, error, started_at, finished_at FROM job_runs WHERE id = ?1')
        .bind(id)
        .first<{ status: string; error: string | null; started_at: number; finished_at: number }>();
    const reaped = await row(dead);
    expect(reaped?.status).toBe('error');
    expect(reaped?.error).toBe('no finish recorded: killed (CPU or wall limit) or crashed');
    expect(reaped?.finished_at).toBe(reaped?.started_at);
    expect((await row(slow))?.status).toBe('running');
    // The reaper is per job: a settle run reaps settle rows, not this one.
    expect((await row(otherJob))?.status).toBe('running');
  });

  it('NO_LIVE_GAME and the retire rule select exactly what they did before for a NULL conference_id', async () => {
    // Today's (pre-M13a) SQL, verbatim.
    const OLD_NO_LIVE = `NOT EXISTS (
      SELECT 1 FROM games g
       WHERE g.league = t.league
         AND g.kickoff_at >= t.window_start_at
         AND g.kickoff_at <  t.window_end_at
         AND g.status = 'in_progress')`;
    const OLD_RETIRE = `window_end_at < ?1
        AND NOT EXISTS (
          SELECT 1 FROM games g
           WHERE g.league = ingest_targets.league
             AND g.kickoff_at >= ingest_targets.window_start_at
             AND g.kickoff_at <  ingest_targets.window_end_at
             AND g.status NOT IN ('final', 'canceled'))`;
    for (let day = -6; day <= 2; day += 1) {
      await insertTarget({ day });
      await insertTarget({ league: 'ncaaf', day });
    }
    const dayStart = (d: number) => etDayBounds(T0 + d * DAY).startAt;
    await seedGame(env.DB, { id: 'nfl:g1', kickoffAt: dayStart(0) + HOUR, status: 'in_progress' });
    await seedGame(env.DB, {
      id: 'ncaaf:g2',
      league: 'ncaaf',
      kickoffAt: dayStart(1) + HOUR,
      status: 'in_progress',
      homeConferenceId: '8',
    });
    await seedGame(env.DB, { id: 'nfl:g3', kickoffAt: dayStart(-5) + HOUR, status: 'scheduled' });
    await seedGame(env.DB, { id: 'nfl:g4', kickoffAt: dayStart(-6) + HOUR, status: 'final' });
    await seedGame(env.DB, {
      id: 'ncaaf:g5',
      league: 'ncaaf',
      kickoffAt: dayStart(-4) + HOUR,
      status: 'postponed',
    });
    const ids = async (sql: string, ...args: unknown[]) =>
      (
        await env.DB.prepare(sql)
          .bind(...args)
          .all<{ id: string }>()
      ).results.map((r) => r.id);

    const notLiveNew = await ids(
      `SELECT id FROM ingest_targets AS t WHERE ${NO_LIVE_GAME} ORDER BY id`,
    );
    const notLiveOld = await ids(
      `SELECT id FROM ingest_targets AS t WHERE ${OLD_NO_LIVE} ORDER BY id`,
    );
    expect(notLiveNew).toEqual(notLiveOld);
    expect(notLiveOld).not.toContain(`nfl:date:${keyOf(0)}`);

    const cutoff = T0 - 2 * DAY;
    const retireNew = await ids(
      `SELECT id FROM ingest_targets WHERE ${RETIRE_PREDICATE} ORDER BY id`,
      cutoff,
    );
    const retireOld = await ids(
      `SELECT id FROM ingest_targets WHERE ${OLD_RETIRE} ORDER BY id`,
      cutoff,
    );
    expect(retireNew).toEqual(retireOld);
    expect(retireOld.length).toBeGreaterThan(0);
    expect(retireOld).not.toContain(`nfl:date:${keyOf(-5)}`);

    // With a value, the predicates scope to that conference (§24.8 groundwork):
    // a segment of conference 8 sees g2 live; one of conference 4 does not.
    const seg8 = await insertTarget({ league: 'ncaaf', day: 1, conferenceId: '8' });
    const seg4 = await insertTarget({ league: 'ncaaf', day: 1, conferenceId: '4' });
    const notLive = await ids(`SELECT id FROM ingest_targets AS t WHERE ${NO_LIVE_GAME}`);
    expect(notLive).not.toContain(seg8);
    expect(notLive).toContain(seg4);
  });
});

describe('M13a: GET /api/health/ingest (PLAN.md §24.5)', () => {
  const get = (path: string) => buildApp().request(`https://example.com${path}`, undefined, env);

  interface IngestHealth {
    ok: boolean;
    now: number;
    lastRefreshOkAt: number | null;
    parkedTargets: number;
    reasons: string[];
  }

  it('the stale threshold is HEALTH_STALE_TICKS refresh ticks (M13b: 5 × 3 min = 15 min)', () => {
    expect(HEALTH_STALE_AFTER_MS).toBe(HEALTH_STALE_TICKS * REFRESH_TICK_MS);
    expect(HEALTH_STALE_AFTER_MS).toBe(15 * MIN);
  });

  it('200 with ok:true when a refresh run recorded ok within HEALTH_STALE_TICKS periods and nothing is parked', async () => {
    const okAt = Date.now() - 10 * MIN;
    await insertRun('refresh', okAt, 'ok');
    await insertRun('refresh', Date.now() - MIN, 'error');
    await insertTarget({ day: 0, lastStatus: 'ok' });
    const res = await get('/api/health/ingest');
    expect(res.status).toBe(200);
    const body = await res.json<IngestHealth>();
    expect(body).toMatchObject({ ok: true, lastRefreshOkAt: okAt, parkedTargets: 0, reasons: [] });
    expect(typeof body.now).toBe('number');
  });

  it('503 refresh-stale when the newest ok refresh run is older than the threshold, or there is none', async () => {
    let res = await get('/api/health/ingest');
    expect(res.status).toBe(503);
    expect(await res.json<IngestHealth>()).toMatchObject({
      ok: false,
      lastRefreshOkAt: null,
      reasons: ['refresh-stale'],
    });
    const old = Date.now() - HEALTH_STALE_AFTER_MS - MIN;
    await insertRun('refresh', old, 'ok');
    // A recent settle run is no evidence about refresh.
    await insertRun('settle', Date.now() - MIN, 'ok');
    res = await get('/api/health/ingest');
    expect(res.status).toBe(503);
    expect(await res.json<IngestHealth>()).toMatchObject({
      lastRefreshOkAt: old,
      reasons: ['refresh-stale'],
    });
  });

  it('503 targets-parked when any target is parked', async () => {
    await insertRun('refresh', Date.now() - MIN, 'ok');
    await insertTarget({
      day: 0,
      incomplete: INGEST_MAX_INCOMPLETE_ATTEMPTS,
      attemptStartedAt: Date.now() - HOUR,
      lastStatus: 'ok',
    });
    await insertTarget({ day: 1, incomplete: 2, lastStatus: 'ok' });
    const res = await get('/api/health/ingest');
    expect(res.status).toBe(503);
    expect(await res.json<IngestHealth>()).toMatchObject({
      ok: false,
      parkedTargets: 1,
      reasons: ['targets-parked'],
    });
  });

  it('503 espn-all-failing when some target errored and none is ok; NULL last_status ignored', async () => {
    await insertRun('refresh', Date.now() - MIN, 'ok');
    await insertTarget({ day: 0, lastStatus: 'error' });
    await insertTarget({ day: 1, lastStatus: null });
    let res = await get('/api/health/ingest');
    expect(res.status).toBe(503);
    expect((await res.json<IngestHealth>()).reasons).toEqual(['espn-all-failing']);
    await insertTarget({ day: 2, lastStatus: 'ok' });
    res = await get('/api/health/ingest');
    expect(res.status).toBe(200);
  });

  it('a refresh run that claims zero targets records ok', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?1')
      .bind(T0 + DAY)
      .run();
    const run = await runJob(env, 'refresh', 'cron', T0);
    expect(run.status).toBe('ok');
    expect(run.stats?.['targetsProcessed']).toBe(0);
    expect(espn.callCount).toBe(0);
  });

  it('GET /api/health is byte-identical to before M13a', async () => {
    // Ingest is unhealthy (no refresh run at all) and /api/health does not care.
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual([
      'ok',
      'version',
      'now',
      'inviteRequired',
      'bugReportsEnabled',
    ]);
    expect(body).toMatchObject({
      ok: true,
      version: 'test',
      inviteRequired: true,
      bugReportsEnabled: true,
    });
  });
});

describe('M13a: ESPN response-status counters (PLAN.md §24.6)', () => {
  it('ProviderError.kind distinguishes http, timeout, network and bad-json', async () => {
    const cases: [string, () => Response, string, number | null][] = [
      ['http', () => new Response('no', { status: 403 }), 'http', 403],
      [
        'timeout',
        () => {
          throw new DOMException('timed out', 'TimeoutError');
        },
        'timeout',
        null,
      ],
      [
        'network',
        () => {
          throw new TypeError('Network connection lost.');
        },
        'network',
        null,
      ],
      ['bad-json', () => new Response('{nope', { status: 200 }), 'bad-json', 200],
    ];
    for (const [label, responder, kind, status] of cases) {
      espn.setResponder(keyOf(0), responder);
      const err = await fetchScoreboard(
        'https://espn.test',
        'nfl',
        { kind: 'date', dateKey: keyOf(0) },
        T0,
      ).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind, label).toBe(kind);
      expect((err as ProviderError).status, label).toBe(status);
    }
  });

  it('stats.espnStatus counts one outcome per target in the fixed vocabulary', async () => {
    const http = (status: number) => new ProviderError('x', true, status, 'http');
    expect(espnOutcome(null)).toBe('200');
    expect(espnOutcome(http(403))).toBe('403');
    expect(espnOutcome(http(429))).toBe('429');
    expect(espnOutcome(http(500))).toBe('5xx');
    expect(espnOutcome(http(599))).toBe('5xx');
    expect(espnOutcome(http(404))).toBe('4xx');
    expect(espnOutcome(new ProviderError('x', true, null, 'timeout'))).toBe('timeout');
    expect(espnOutcome(new ProviderError('x', true, null, 'network'))).toBe('network');
    expect(espnOutcome(new ProviderError('x', true, 200, 'bad-json'))).toBe('bad-json');
    expect(espnOutcome(new Error('anything else'))).toBe('network');

    await insertTarget({ day: 0, nextRunAt: T0 - 2 * HOUR, lastOkAt: T0 - DAY });
    await insertTarget({ day: 1, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    espn.setResponder(keyOf(1), () => new Response('slow down', { status: 429 }));
    // Plan-created targets are due too, but never-fetched (big): only two are claimed.
    const stats = await runRefresh(env, T0, 2);
    expect(stats.targetsProcessed).toBe(2);
    expect(stats.espnStatus).toEqual({ '200': 1, '429': 1 });
  });

  it('recentRuns folds a rolling-24h dayEspnStatus, surviving a malformed stats blob', async () => {
    await insertRun(
      'refresh',
      T0 - HOUR,
      'ok',
      JSON.stringify({ espnStatus: { '200': 3, '429': 1 } }),
    );
    await insertRun(
      'refresh',
      T0 - 2 * HOUR,
      'error',
      JSON.stringify({ espnStatus: { '200': 2 } }),
    );
    await insertRun('refresh', T0 - 3 * HOUR, 'ok', 'not json{');
    await insertRun('refresh', T0 - 4 * HOUR, 'ok', JSON.stringify({ rowsWritten: 5 }));
    await insertRun('refresh', T0 - 25 * HOUR, 'ok', JSON.stringify({ espnStatus: { '200': 99 } }));
    await insertRun('settle', T0 - HOUR, 'ok', JSON.stringify({ espnStatus: { '5xx': 7 } }));
    const runs = await recentRuns(env, 50, T0);
    expect(runs.length).toBe(6);
    for (const run of runs) expect(run.stats?.['dayEspnStatus']).toEqual({ '200': 5, '429': 1 });
  });
});

describe('M13a: in-app alerts as GitHub issues (PLAN.md §24.6b)', () => {
  let gh: GitHubStub;
  beforeEach(() => {
    gh = stubGitHub();
  });
  afterEach(() => {
    gh.restore();
  });

  it('a new fingerprint creates ONE issue titled "[alert] <kind>: <key>" with the ops-alert label', async () => {
    const stats = await step(T0, [PARKED_COND]);
    expect(stats).toMatchObject({ enabled: true, created: 1, failed: 0 });
    expect(creates(gh)).toHaveLength(1);
    expect(creates(gh)[0]?.body).toMatchObject({
      title: '[alert] target-parked: nfl:date:20260913',
      labels: [ALERT_GITHUB_LABEL],
    });
    const row = await alertRow('target-parked:nfl:date:20260913');
    expect(row).toMatchObject({
      state: 'firing',
      occurrences: 1,
      pending: 0,
      last_notified_at: T0,
      last_detail: '3 incomplete attempts',
    });
    expect(row?.issue_number).toBeGreaterThan(0);
    // The same condition a minute later: recorded, no second issue.
    await step(T0 + MIN, [PARKED_COND]);
    expect(creates(gh)).toHaveLength(1);
  });

  it('two occurrences within ALERT_COMMENT_INTERVAL_MS produce one comment; pending carries over', async () => {
    await step(T0, [PARKED_COND]);
    await step(T0 + 10 * MIN, [PARKED_COND]);
    await step(T0 + 20 * MIN, [PARKED_COND]);
    expect(comments(gh)).toHaveLength(0);
    expect((await alertRow('target-parked:nfl:date:20260913'))?.pending).toBe(2);
    // The interval elapses with no new occurrence: one comment carrying both.
    await step(T0 + ALERT_COMMENT_INTERVAL_MS, []);
    expect(comments(gh)).toHaveLength(1);
    expect(String(comments(gh)[0]?.body['body'])).toContain('2 occurrences since the last comment');
    const row = await alertRow('target-parked:nfl:date:20260913');
    expect(row).toMatchObject({ pending: 0, comments: 1 });
  });

  it('a failed GitHub post loses neither pending nor the comment backoff step', async () => {
    await step(T0, [PARKED_COND]);
    await step(T0 + 10 * MIN, [PARKED_COND]);
    gh.respond = (call) => (call.method === 'POST' ? new Response('boom', { status: 500 }) : null);
    const stats = await step(T0 + HOUR, []);
    expect(stats.failed).toBe(1);
    let row = await alertRow('target-parked:nfl:date:20260913');
    expect(row).toMatchObject({ pending: 1, comments: 0, last_notified_at: 0 });
    gh.respond = () => null;
    // Released: the very next run retries instead of waiting an hour.
    await step(T0 + HOUR + 3 * MIN, []);
    row = await alertRow('target-parked:nfl:date:20260913');
    expect(row).toMatchObject({ pending: 0, comments: 1 });
  });

  it('settle-stuck is ONE fingerprint for any number of stuck bets', async () => {
    await insertRun('refresh', T0 - MIN, 'ok');
    const run = fakeRun('settle', { stats: { stuck: ['bet-1', 'bet-2', 'bet-3', 'bet-4'] } });
    await evaluateAlerts(env, T0, run);
    const rows = (await allAlerts()).filter((r) => r.fingerprint.startsWith('settle-stuck'));
    expect(rows.map((r) => r.fingerprint)).toEqual(['settle-stuck:-']);
    expect(rows[0]?.last_detail).toContain('bet-4');
    expect(creates(gh).map((c) => c.body['title'])).toEqual(['[alert] settle-stuck: -']);
  });

  it('d1-rows-near-cap is evaluated on discovery-first refresh ticks and by maintenance (M13b, §24.6b)', async () => {
    await insertRun(
      'settle',
      T0 - HOUR,
      'ok',
      JSON.stringify({ rowsWritten: ALERT_D1_ROWS_NEAR_CAP - 1 }),
    );
    // T0 is a discovery-first tick: evaluated, and under the threshold.
    await withJobRun(env, 'refresh', 'cron', T0, () => Promise.resolve({ rowsWritten: 0 }));
    expect(await alertRow('d1-rows-near-cap:-')).toBeNull();
    // Over the threshold now, but a GENERAL tick does not read the 24 h sum
    // (480 runs a day would read it 480 times).
    await withJobRun(env, 'refresh', 'cron', T0 + 3 * MIN, () =>
      Promise.resolve({ rowsWritten: 1 }),
    );
    expect(await alertRow('d1-rows-near-cap:-')).toBeNull();
    // The next discovery-first tick, 15 minutes on, does.
    await withJobRun(env, 'refresh', 'cron', T0 + 15 * MIN, () =>
      Promise.resolve({ rowsWritten: 0 }),
    );
    expect(await alertRow('d1-rows-near-cap:-')).toMatchObject({ state: 'firing' });
    // Settle does not evaluate it; maintenance does.
    await env.DB.prepare('DELETE FROM alerts').run();
    await withJobRun(env, 'settle', 'cron', T0 + 16 * MIN, () => Promise.resolve({}));
    expect(await alertRow('d1-rows-near-cap:-')).toBeNull();
    await withJobRun(env, 'maintenance', 'cron', T0 + 17 * MIN, () => Promise.resolve({}));
    expect(await alertRow('d1-rows-near-cap:-')).toMatchObject({ state: 'firing' });
  });

  it('the comment interval doubles per comment and caps at ALERT_COMMENT_MAX_INTERVAL_MS', async () => {
    await step(T0, [PARKED_COND]);
    let t = T0;
    // Comment 1 after 1 h, comment 2 after a further 2 h, comment 3 after 4 h.
    for (const gap of [1, 2, 4]) {
      await step(t + gap * HOUR - MIN, [PARKED_COND]);
      const n = comments(gh).length;
      await step(t + gap * HOUR - MIN + 1, []);
      expect(comments(gh).length, `not yet at ${String(gap)} h`).toBe(n);
      t = t + gap * HOUR;
      await step(t, []);
      expect(comments(gh).length, `at ${String(gap)} h`).toBe(n + 1);
    }
    // Far into the backoff the cap governs: 24 h, not 2^10 h.
    await env.DB.prepare('UPDATE alerts SET comments = 10, last_notified_at = ?1').bind(t).run();
    await step(t + ALERT_COMMENT_MAX_INTERVAL_MS - 1, [PARKED_COND]);
    const n = comments(gh).length;
    await step(t + ALERT_COMMENT_MAX_INTERVAL_MS, [PARKED_COND]);
    expect(comments(gh).length).toBe(n + 1);
  });

  it('quiet for ALERT_RESOLVE_AFTER_MS: a closing comment and the issue closed', async () => {
    await step(T0, [PARKED_COND]);
    const number = (await alertRow('target-parked:nfl:date:20260913'))?.issue_number;
    await step(T0 + ALERT_RESOLVE_AFTER_MS - 1, []);
    expect(patches(gh)).toHaveLength(0);
    const stats = await step(T0 + ALERT_RESOLVE_AFTER_MS, []);
    expect(stats.resolved).toBe(1);
    expect(comments(gh).at(-1)?.path).toBe(`${ISSUES_PATH}/${String(number)}/comments`);
    expect(String(comments(gh).at(-1)?.body['body'])).toMatch(/quiet for 6 h, closing/i);
    expect(patches(gh).at(-1)).toMatchObject({
      path: `${ISSUES_PATH}/${String(number)}`,
      body: { state: 'closed' },
    });
    expect(await alertRow('target-parked:nfl:date:20260913')).toMatchObject({
      state: 'resolved',
      resolved_at: T0 + ALERT_RESOLVE_AFTER_MS,
    });

    // A create that never succeeded goes quiet with no call at all.
    gh.respond = () => new Response('down', { status: 503 });
    const other: AlertCondition = { kind: 'job-error', key: 'settle', detail: 'x' };
    await step(T0, [other]);
    const calls = gh.calls.length;
    gh.respond = () => null;
    // Evaluated with the token off from here, so no retry is attempted: once
    // quiet, the row resolves silently.
    await step(T0 + ALERT_RESOLVE_AFTER_MS + 1, [], envWith({ token: undefined }));
    expect(gh.calls.length).toBe(calls);
    expect(await alertRow('job-error:settle')).toMatchObject({ state: 'resolved' });
  });

  it('a recurrence within ALERT_REOPEN_WINDOW_MS of resolve reopens the SAME issue', async () => {
    await step(T0, [PARKED_COND]);
    const number = (await alertRow('target-parked:nfl:date:20260913'))?.issue_number;
    const resolvedAt = T0 + ALERT_RESOLVE_AFTER_MS;
    await step(resolvedAt, []);
    const stats = await step(resolvedAt + 5 * HOUR, [PARKED_COND]);
    expect(stats.reopened).toBe(1);
    expect(creates(gh)).toHaveLength(1);
    expect(patches(gh).at(-1)).toMatchObject({
      path: `${ISSUES_PATH}/${String(number)}`,
      body: { state: 'open' },
    });
    expect(await alertRow('target-parked:nfl:date:20260913')).toMatchObject({
      state: 'firing',
      issue_number: number,
      resolved_at: null,
      pending: 0,
    });
  });

  it('a recurrence after the reopen window creates a NEW issue and resets the counters', async () => {
    await step(T0, [PARKED_COND]);
    await step(T0 + HOUR, [PARKED_COND]);
    const first = await alertRow('target-parked:nfl:date:20260913');
    const resolvedAt = T0 + HOUR + ALERT_RESOLVE_AFTER_MS;
    await step(resolvedAt, []);
    const later = resolvedAt + ALERT_REOPEN_WINDOW_MS + HOUR;
    await step(later, [PARKED_COND]);
    expect(creates(gh)).toHaveLength(2);
    const row = await alertRow('target-parked:nfl:date:20260913');
    expect(row?.issue_number).not.toBe(first?.issue_number);
    expect(row).toMatchObject({
      state: 'firing',
      occurrences: 1,
      comments: 0,
      opened_at: later,
      resolved_at: null,
      pending: 0,
    });
  });

  it('no GITHUB_TOKEN: no GitHub call, occurrences still recorded, stats.alerts.enabled false', async () => {
    const off = envWith({ token: undefined });
    const stats = await step(T0, [PARKED_COND], off);
    expect(stats).toMatchObject({ enabled: false, created: 0 });
    expect(gh.calls).toHaveLength(0);
    expect(await alertRow('target-parked:nfl:date:20260913')).toMatchObject({
      occurrences: 1,
      pending: 1,
      issue_number: null,
    });
    // Through withJobRun: the run's stats carry `alerts.enabled: false`.
    const run = await withJobRun(off, 'maintenance', 'cron', T0, () => Promise.resolve({}));
    expect(run.stats?.['alerts']).toMatchObject({ enabled: false });
    const stored = await recentRuns(env, 1, T0);
    expect(stored[0]?.stats?.['alerts']).toMatchObject({ enabled: false });
    expect(gh.calls).toHaveLength(0);
  });

  it('the issue body, comments and reopens begin with @ALERT_MENTION_LOGIN when configured; no mention when empty', async () => {
    // Set the login explicitly: a local `.dev.vars` (shipped with
    // ALERT_MENTION_LOGIN="" so a scratch repo never pings the real account)
    // overrides wrangler.jsonc's value inside the test pool, and this test must
    // not depend on which one a developer has.
    const loud = envWith({ mention: 'alancast' });
    expect(readConfig(loud).alertMentionLogin).toBe('alancast');
    await step(T0, [PARKED_COND], loud);
    await step(T0 + HOUR, [PARKED_COND], loud);
    await step(T0 + HOUR + ALERT_RESOLVE_AFTER_MS, [], loud);
    await step(T0 + HOUR + ALERT_RESOLVE_AFTER_MS + HOUR, [PARKED_COND], loud);
    expect(String(creates(gh)[0]?.body['body'])).toMatch(/^@alancast\b/);
    const posted = comments(gh).map((c) => String(c.body['body']));
    // comment, closing comment, reopen comment
    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatch(/^@alancast\b/);
    expect(posted[2]).toMatch(/^@alancast\b/);

    await env.DB.prepare('DELETE FROM alerts').run();
    gh.calls.length = 0;
    const quiet = envWith({ mention: '' });
    await step(T0, [PARKED_COND], quiet);
    await step(T0 + HOUR, [PARKED_COND], quiet);
    const bodies = [...creates(gh), ...comments(gh)].map((c) => String(c.body['body']));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).not.toContain('@');
  });

  it('a SETTLE run opens refresh-stale when no refresh run recorded ok for HEALTH_STALE_TICKS periods', async () => {
    await insertRun('refresh', T0 - HEALTH_STALE_AFTER_MS - MIN, 'ok');
    const run = await withJobRun(env, 'settle', 'cron', T0, () => Promise.resolve({ stuck: [] }));
    expect(run.status).toBe('ok');
    expect(creates(gh).map((c) => c.body['title'])).toEqual(['[alert] refresh-stale: -']);
    // Within the threshold it stays quiet.
    await env.DB.prepare('DELETE FROM alerts').run();
    gh.calls.length = 0;
    await insertRun('refresh', T0 + HOUR - HEALTH_STALE_AFTER_MS + MIN, 'ok');
    await withJobRun(env, 'settle', 'cron', T0 + HOUR, () => Promise.resolve({ stuck: [] }));
    expect(gh.calls).toHaveLength(0);
  });

  it('two racing evaluations of one fingerprint post once (meta.changes is the permission)', async () => {
    await recordAlertConditions(env, T0, [PARKED_COND]);
    const [a, b] = await Promise.all([processAlerts(env, T0), processAlerts(env, T0)]);
    expect(a.created + b.created).toBe(1);
    expect(creates(gh)).toHaveLength(1);
  });

  it('a bookkeeping failure AFTER a successful post keeps the claim: no duplicate issue', async () => {
    await recordAlertConditions(env, T0, [PARKED_COND]);
    // Fail the write that records the new issue number, twice (the call and its
    // one retry); the GitHub create itself succeeds.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let blips = 0;
    (env.DB as { prepare: typeof env.DB.prepare }).prepare = (sql: string) => {
      if (sql.includes('SET issue_number')) {
        blips += 1;
        throw new Error('d1 blip');
      }
      return realPrepare(sql);
    };
    try {
      const first = await processAlerts(env, T0);
      expect(blips).toBe(2);
      expect(first.failed).toBe(0);
      expect(creates(gh)).toHaveLength(1);
      // The claim stands (last_notified_at = T0), so a run inside the throttle
      // window does not post again — the old code released it and the next
      // run opened a second issue (and sent a second email).
      await processAlerts(env, T0 + 60_000);
      expect(creates(gh)).toHaveLength(1);
      expect(await alertRow(`${PARKED_COND.kind}:${PARKED_COND.key}`)).toMatchObject({
        last_notified_at: T0,
      });
    } finally {
      delete (env.DB as { prepare?: unknown }).prepare;
    }
  });

  it('a GitHub failure is logged and counted, never fails the job, and releases the claim', async () => {
    gh.respond = () => new Response('nope', { status: 500 });
    const run = await withJobRun(env, 'maintenance', 'cron', T0, () => Promise.resolve({}));
    expect(run.status).toBe('ok');
    expect(run.stats?.['alerts']).toMatchObject({ failed: 1 });
    const stored = await env.DB.prepare('SELECT status FROM job_runs WHERE id = ?1')
      .bind(run.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe('ok');
    expect(await alertRow('refresh-stale:-')).toMatchObject({ last_notified_at: 0 });

    // A timeout behaves the same.
    gh.respond = () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const again = await withJobRun(env, 'maintenance', 'cron', T0 + DAY, () => Promise.resolve({}));
    expect(again.status).toBe('ok');
    expect(again.stats?.['alerts']).toMatchObject({ failed: 1 });
  });

  it('at most ALERT_MAX_GITHUB_CALLS_PER_RUN GitHub calls per run', async () => {
    const many: AlertCondition[] = ['a', 'b', 'c', 'd', 'e'].map((k) => ({
      kind: 'job-error',
      key: k,
      detail: k,
    }));
    await step(T0, many);
    expect(gh.calls).toHaveLength(ALERT_MAX_GITHUB_CALLS_PER_RUN);
    await step(T0 + 3 * MIN, []);
    expect(gh.calls).toHaveLength(2 * ALERT_MAX_GITHUB_CALLS_PER_RUN);
  });
});

describe('M13b: the three-minute tick (PLAN.md §24.7)', () => {
  const TICK = REFRESH_TICK_MS;
  /** T0 (16:00Z) is on the 15-minute grid, so it is a DISCOVERY-FIRST tick; T0 + 1 tick is general. */
  const GENERAL = T0 + TICK;

  /** A parsed slate, the shape `computeNextRunAt` reads. */
  function slateOf(league: League, events: readonly EventSpec[], at: number): ProviderSlate {
    const parsed = parseScoreboard(buildScoreboard(events), league, at);
    return {
      games: parsed.games,
      lines: parsed.lines,
      warnings: parsed.warnings,
      fetchedAt: at,
      season: parsed.season,
      week: parsed.week,
    };
  }

  function event(league: League, status: EventSpec['status'], kickoffAt: number): EventSpec {
    return {
      eventId: `${league}-1`,
      league,
      kickoffAt,
      status,
      homeAbbr: 'HOM',
      awayAbbr: 'AWY',
      season: 2026,
      week: 1,
    };
  }

  /** Make a target LIVE: an in-progress game inside its ET day. */
  async function makeLive(league: League, day: number, id: string): Promise<void> {
    await seedGame(env.DB, {
      id,
      league,
      kickoffAt: etDayBounds(T0 + day * DAY).startAt + 13 * HOUR,
      status: 'in_progress',
    });
  }

  const ids = (rows: readonly IngestTargetRow[]): string[] => rows.map((t) => t.id);

  it('every cadence is a tick multiple from the NOMINAL instant: a run 5 s late still claims a live slate on the next tick', async () => {
    // THE ALIGNMENT TRAP. A live slate stamped `now + 1 tick` by a run that
    // started 7 s after its tick would be 7 s short of due at the next tick and
    // wait for the one after. Stamped from `scheduledTime`, it is due exactly
    // at the next tick.
    const id = await insertTarget({
      day: 0,
      nextRunAt: GENERAL - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 1,
    });
    espn.set(keyOf(0), [event('nfl', 'in', T0 - HOUR)]);

    const late = GENERAL + 7_000;
    const run = await runJob(env, 'refresh', 'cron', late, { scheduledTime: GENERAL });
    expect(run.status).toBe('ok');
    const next = (await guardRow(id)).next_run_at;
    expect(next).toBe(GENERAL + REFRESH_LIVE_TICKS * TICK);
    // `now + 1 tick` is exactly the stamp that would have missed it.
    expect(late + TICK).toBeGreaterThan(GENERAL + TICK);

    // The very next tick — itself 5 s late — claims it. (The run's planner
    // added never-fetched dates, due at `late` and big; drop them so the claim
    // shows this slate rather than queue order.)
    await env.DB.prepare('DELETE FROM ingest_targets WHERE id <> ?1').bind(id).run();
    expect(ids(await claimDueTargets(env, GENERAL + TICK + 5_000, 5, false))).toEqual([id]);
    expect(ids(await claimDueTargets(env, GENERAL + TICK - 1, 5, false))).toEqual([]);

    // An ADMIN run has no scheduledTime: its base is the tick at or before
    // `now` (the floor fallback), never `now` itself.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = 0 WHERE id = ?1').bind(id).run();
    const adminAt = GENERAL + 2 * TICK + 40_000;
    expect((await runJob(env, 'refresh', 'admin', adminAt)).status).toBe('ok');
    expect((await guardRow(id)).next_run_at).toBe(GENERAL + 3 * TICK);
    expect(refreshTickBase(adminAt)).toBe(GENERAL + 2 * TICK);
    expect(refreshTickBase(adminAt, GENERAL)).toBe(GENERAL);
  });

  it('a live slate is due again after REFRESH_LIVE_TICKS ticks, in every league', () => {
    const base = GENERAL;
    const now = base + 7_000;
    for (const league of LEAGUES) {
      const target: IngestTargetRow = {
        id: `${league}:date:${keyOf(0)}`,
        league,
        kind: 'date',
        key: keyOf(0),
        windowStartAt: etDayBounds(T0).startAt,
        windowEndAt: etDayBounds(T0).endAt,
        priority: 100,
        nextRunAt: base,
        consecutiveFailures: 0,
        lastOkAt: T0 - DAY, // a FETCHED slate: the 1-tick first retry applies
        incompleteAttempts: 0,
      };
      const at = (status: EventSpec['status'], kickoffAt: number): number =>
        computeNextRunAt(
          target,
          slateOf(league, [event(league, status, kickoffAt)], now),
          false,
          now,
          base,
        );
      // Live: in progress, or a kickoff within 3 h — the next tick.
      expect(at('in', now - HOUR), league).toBe(base + REFRESH_LIVE_TICKS * TICK);
      expect(at('pre', now + 2 * HOUR), league).toBe(base + REFRESH_LIVE_TICKS * TICK);
      // The other tiers are tick multiples from the same base.
      expect(at('pre', now + 30 * HOUR), league).toBe(base + REFRESH_SOON_TICKS * TICK);
      expect(at('post', now - 5 * HOUR), league).toBe(base + 480 * TICK);
      expect(computeNextRunAt(target, slateOf(league, [], now), false, now, base), league).toBe(
        base + REFRESH_DISCOVERY_TICKS * TICK,
      );
      // Failure backoff (F5): the first failure retries on the next tick, then
      // 5 ticks × 2^(n−2) from the base, capped at the discovery tier.
      for (const [failures, ticks] of [
        [0, 1],
        [1, REFRESH_BACKOFF_BASE_TICKS],
        [2, 2 * REFRESH_BACKOFF_BASE_TICKS],
        [9, REFRESH_DISCOVERY_TICKS],
      ] as const) {
        expect(
          computeNextRunAt({ ...target, consecutiveFailures: failures }, null, true, now, base),
          `${league} after ${String(failures)} failures`,
        ).toBe(base + ticks * TICK);
      }
    }
    // The values the tiers keep in wall-clock terms (§24.7's table).
    expect(REFRESH_LIVE_TICKS * TICK).toBe(3 * MIN);
    expect(REFRESH_SOON_TICKS * TICK).toBe(HOUR);
    expect(REFRESH_DISCOVERY_TICKS * TICK).toBe(6 * HOUR);
    expect(REFRESH_BACKOFF_BASE_TICKS * TICK).toBe(15 * MIN);
  });

  it('(F5) a NEVER-fetched date that 403s retries on the discovery grid, so the live slates keep every general tick', async () => {
    // F2's promise, under failure: the new date sits 1 ms before a discovery
    // tick; it fails there; a next-tick retry would make it the oldest due row
    // on the next GENERAL tick, where it runs alone (never-fetched weighs big)
    // and the live slate waits. Instead it goes back to the grid.
    const disc = nextDiscoveryTick(GENERAL);
    const live = await insertTarget({
      day: 0,
      nextRunAt: disc - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 10,
    });
    await makeLive('nfl', 0, 'nfl-live-f5-grid');
    const fresh = await insertTarget({ day: 2, nextRunAt: disc - 1 });
    espn.setResponder(keyOf(2), () => new Response('forbidden', { status: 403 }));

    const run = await runJob(env, 'refresh', 'cron', disc + 5_000, { scheduledTime: disc });
    expect(run.status).toBe('ok');
    const row = await guardRow(fresh);
    expect(row.consecutive_failures).toBe(1);
    expect(row.next_run_at).toBe(nextDiscoveryTick(disc));
    expect(row.next_run_at).not.toBe(disc + TICK);

    // The four general ticks that follow are the live slate's, every one.
    for (let k = 1; k < 5; k += 1) {
      expect(
        ids(await claimDueTargets(env, disc + k * TICK + 5_000, 5, false)),
        `tick +${String(k)}`,
      ).toEqual([live]);
    }
    // A target that HAS fetched before still pays only its own next tick (the
    // sibling test above); this exception is for the never-fetched alone.
  });

  it('(F5) inside a BURST a failed new date costs the live slate at most ONE general tick (accepted residual, PLAN.md §24.7 (c))', async () => {
    // Two burst dates stamped 1 ms before consecutive discovery ticks; the
    // first 403s once. Its grid retry collides with the second date's slot and
    // spills to the next general tick — the bound this test pins is "one".
    const d1 = nextDiscoveryTick(GENERAL);
    const d2 = nextDiscoveryTick(d1);
    const live = await insertTarget({
      day: 0,
      nextRunAt: d1 - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 10,
    });
    await makeLive('nfl', 0, 'nfl-live-f5-burst');
    // The live slate keeps answering with a live game, so it stays on the live
    // tier (an EMPTY board would drop it to the 6 h discovery tier).
    espn.set(keyOf(0), [event('nfl', 'in', T0 - HOUR)]);
    const date1 = await insertTarget({ day: 2, nextRunAt: d1 - 1 });
    const date2 = await insertTarget({ day: 3, nextRunAt: d2 - 1 });
    let date1Calls = 0;
    espn.setResponder(keyOf(2), () => {
      date1Calls += 1;
      return date1Calls === 1 ? new Response('forbidden', { status: 403 }) : emptyBoard();
    });
    espn.setResponder(keyOf(3), () => emptyBoard());

    const processed = async (tick: number): Promise<string[]> => {
      const run = await runJob(env, 'refresh', 'cron', tick + 5_000, { scheduledTime: tick });
      expect(run.status).toBe('ok');
      return (run.stats as { coverage: { targetId: string }[] }).coverage.map((c) => c.targetId);
    };

    expect(await processed(d1)).toEqual([date1]); // the discovery pick; 403
    expect((await guardRow(date1)).next_run_at).toBe(d2); // back to the grid…
    for (let k = 1; k < 5; k += 1) expect(await processed(d1 + k * TICK)).toEqual([live]);
    expect(await processed(d2)).toEqual([date2]); // …but date2 owns that slot
    const after: string[][] = [];
    for (let k = 1; k < 5; k += 1) after.push(await processed(d2 + k * TICK));
    const liveTicks = after.filter((ids) => ids.includes(live)).length;
    const date1Ticks = after.filter((ids) => ids.includes(date1)).length;
    expect(date1Ticks).toBe(1); // the spilled retry, exactly once
    expect(liveTicks).toBeGreaterThanOrEqual(3); // the live slate loses at most one
    expect((await guardRow(date1)).last_status).toBe('ok'); // and the retry succeeded
  });

  it('(F5) a live slate that 403s ONCE is due at the very next tick, and a 200 there puts it back on every tick', async () => {
    // Measured 2026-11-08 04:24 UTC: one transient 403 on the live CFB slate
    // backed it off 15 min. Now the first failure costs exactly one tick.
    const id = await insertTarget({
      day: 0,
      nextRunAt: GENERAL - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 1,
    });
    await makeLive('nfl', 0, 'nfl-live-f5');
    const dropOthers = (): Promise<unknown> =>
      env.DB.prepare('DELETE FROM ingest_targets WHERE id <> ?1').bind(id).run();

    espn.setResponder(keyOf(0), () => new Response('forbidden', { status: 403 }));
    const failed = await runJob(env, 'refresh', 'cron', GENERAL + 5_000, {
      scheduledTime: GENERAL,
    });
    expect(failed.status).toBe('ok');
    const stats = failed.stats as {
      espnStatus: Record<string, number>;
      failures: { targetId: string; espn: string; consecutiveFailures: number }[];
    };
    // The ESPN status counter (and so the `espn-status` alert) sees the 403
    // exactly as before: the schedule does not touch what is counted.
    expect(stats.espnStatus['403']).toBe(1);
    expect(stats.failures).toEqual([
      expect.objectContaining({ targetId: id, espn: '403', consecutiveFailures: 1 }),
    ]);
    // …and the per-run regime alert fires on that single 403, regardless of backoff.
    expect((await alertRow('espn-status:403'))?.state).toBe('firing');
    let row = await guardRow(id);
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_status).toBe('error');
    expect(row.next_run_at).toBe(GENERAL + TICK);

    // The next tick claims it (not one tick sooner).
    await dropOthers();
    expect(ids(await claimDueTargets(env, GENERAL + TICK - 1, 5, false))).toEqual([]);
    expect(ids(await claimDueTargets(env, GENERAL + TICK + 5_000, 5, false))).toEqual([id]);

    // ESPN answers 200 there: the streak resets and the slate is live again.
    espn.set(keyOf(0), [event('nfl', 'in', T0 - HOUR)]);
    const healed = await runJob(env, 'refresh', 'cron', GENERAL + TICK + 5_000, {
      scheduledTime: GENERAL + TICK,
    });
    expect(healed.status).toBe('ok');
    row = await guardRow(id);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_status).toBe('ok');
    expect(row.next_run_at).toBe(GENERAL + TICK + REFRESH_LIVE_TICKS * TICK);
  });

  it('(F5) a sustained outage backs off 1, 5, 10, 20 ticks — unchanged but for the first step', async () => {
    const id = await insertTarget({
      day: 0,
      nextRunAt: GENERAL - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 1,
    });
    await makeLive('nfl', 0, 'nfl-live-f5-outage');
    espn.setResponder(keyOf(0), () => new Response('forbidden', { status: 403 }));

    let tick = GENERAL;
    const steps: number[] = [];
    for (let n = 1; n <= 4; n += 1) {
      const run = await runJob(env, 'refresh', 'cron', tick + 5_000, { scheduledTime: tick });
      expect(run.status).toBe('ok');
      const row = await guardRow(id);
      expect(row.consecutive_failures).toBe(n);
      steps.push((row.next_run_at - tick) / TICK);
      tick = row.next_run_at;
      // Only this target, so the planner's never-fetched dates do not crowd it out.
      await env.DB.prepare('DELETE FROM ingest_targets WHERE id <> ?1').bind(id).run();
    }
    expect(steps).toEqual([1, REFRESH_BACKOFF_BASE_TICKS, 10, 20]);
  });

  it('a target with last_ok_at NULL weighs as big', async () => {
    expect(targetWeight(0, null)).toBe(REFRESH_WEIGHT_BUDGET + 1);
    expect(targetWeight(155, null)).toBe(REFRESH_WEIGHT_BUDGET + 1);
    // An empty slate that DID succeed weighs 1; otherwise its games.
    expect(targetWeight(0, T0)).toBe(1);
    expect(targetWeight(16, T0)).toBe(16);

    // In the claim. A failed first fetch leaves games_seen 0 and last_ok_at
    // NULL: its size is unknown, so it runs alone...
    const fresh = await insertTarget({ day: 0, nextRunAt: T0 - 2 * HOUR, lastStatus: 'error' });
    const small = await insertTarget({ day: 1, nextRunAt: T0 - HOUR, lastOkAt: T0 - DAY });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([fresh]);
    // ...and is never packed behind a small one.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?1 WHERE id = ?2')
      .bind(T0 - 3 * HOUR, small)
      .run();
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([small]);
  });

  it('weight packing: NFL + MLB share a run; a CFB slate runs alone; a never-fetched target runs alone', async () => {
    const nfl = await insertTarget({
      league: 'nfl',
      day: 0,
      nextRunAt: T0 - 3 * HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 14,
    });
    const mlb = await insertTarget({
      league: 'mlb',
      day: 0,
      nextRunAt: T0 - 2 * HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 15,
    });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([nfl, mlb]);

    // A CFB Saturday (86 games) first: alone, though both small ones are due.
    const cfb = await insertTarget({
      league: 'ncaaf',
      day: 0,
      nextRunAt: T0 - 4 * HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 86,
    });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([cfb]);

    // A never-fetched target first: alone too.
    await env.DB.prepare('DELETE FROM ingest_targets WHERE id = ?1').bind(cfb).run();
    const fresh = await insertTarget({ league: 'ncaaf', day: 1, nextRunAt: T0 - 5 * HOUR });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([fresh]);
  });

  it('weight packing stops at the first candidate that does not fit (no skipping ahead)', async () => {
    const a = await insertTarget({ day: 0, nextRunAt: T0 - 3 * HOUR, lastOkAt: T0, gamesSeen: 30 });
    // 30 + 20 > 40: does not fit, and the packing stops here...
    const b = await insertTarget({ day: 1, nextRunAt: T0 - 2 * HOUR, lastOkAt: T0, gamesSeen: 20 });
    // ...so this one, which WOULD fit (30 + 5), is not reached.
    await insertTarget({ day: 2, nextRunAt: T0 - HOUR, lastOkAt: T0, gamesSeen: 5 });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([a]);

    // Exactly at the budget fits: 30 + 10 = 40, and then 5 more does not.
    await env.DB.prepare('UPDATE ingest_targets SET games_seen = 10 WHERE id = ?1').bind(b).run();
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([a, b]);
  });

  it('the count cap REFRESH_TARGETS_PER_RUN bounds a run of empty slates', async () => {
    const cap = readConfig(env).refreshTargetsPerRun;
    expect(cap).toBe(5);
    for (let day = 0; day < cap + 2; day += 1) {
      await insertTarget({ day, nextRunAt: T0 - (10 - day) * HOUR, lastOkAt: T0 - DAY });
    }
    // Seven targets weighing 1 each fit the budget; the count stops at five.
    const claimed = await claimDueTargets(env, GENERAL, cap, false);
    expect(ids(claimed)).toEqual(Array.from({ length: cap }, (_, d) => `nfl:date:${keyOf(d)}`));
  });

  it('every REFRESH_DISCOVERY_EVERY_NTH_TICK-th tick claims a non-live target first, falling through when none is due', async () => {
    // Which ticks: :00 :15 :30 :45 — 96 a day.
    expect(isDiscoveryTick(T0)).toBe(true);
    for (let k = 1; k < REFRESH_DISCOVERY_EVERY_NTH_TICK; k += 1) {
      expect(isDiscoveryTick(T0 + k * TICK)).toBe(false);
    }
    expect(isDiscoveryTick(T0 + REFRESH_DISCOVERY_EVERY_NTH_TICK * TICK)).toBe(true);
    let perDay = 0;
    for (let t = T0; t < T0 + DAY; t += TICK) if (isDiscoveryTick(t)) perDay += 1;
    expect(perDay).toBe(96);

    // A live slate (most due) and a discovery date, each too heavy to share.
    const live = await insertTarget({
      day: 0,
      nextRunAt: T0 - 2 * HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 30,
    });
    await makeLive('nfl', 0, 'nfl:live-1');
    const quiet = await insertTarget({
      day: 3,
      nextRunAt: T0 - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 30,
    });
    expect(ids(await claimDueTargets(env, GENERAL, 5, false))).toEqual([live]);
    expect(ids(await claimDueTargets(env, T0, 5, true))).toEqual([quiet]);

    // The general order follows the discovery pick: a light live slate packs behind it.
    await env.DB.prepare('UPDATE ingest_targets SET games_seen = 10 WHERE id = ?1')
      .bind(live)
      .run();
    expect(ids(await claimDueTargets(env, T0, 5, true))).toEqual([quiet, live]);

    // Nothing non-live is due: the tick falls through to the plain order.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?1 WHERE id = ?2')
      .bind(T0 + DAY, quiet)
      .run();
    expect(ids(await claimDueTargets(env, T0, 5, true))).toEqual([live]);

    // End to end: a cron run AT a discovery tick fetches the discovery date.
    await env.DB.prepare(
      'UPDATE ingest_targets SET next_run_at = ?1, games_seen = 30 WHERE id IN (?2, ?3)',
    )
      .bind(T0 - HOUR, quiet, live)
      .run();
    const run = await runJob(env, 'refresh', 'cron', T0 + 4_000, { scheduledTime: T0 });
    expect(run.status).toBe('ok');
    expect((await guardRow(quiet)).last_ok_at).toBe(T0 + 4_000);
    expect((await guardRow(live)).last_ok_at).toBe(T0 - DAY);
  });

  it('nextDiscoveryTick is the first discovery tick STRICTLY after the tick, on the epoch grid', () => {
    const P = REFRESH_DISCOVERY_EVERY_NTH_TICK * TICK; // 15 min
    // The current tick IS a discovery tick: the NEXT one, never now.
    expect(isDiscoveryTick(T0)).toBe(true);
    expect(nextDiscoveryTick(T0)).toBe(T0 + P);
    // Every general tick of the window points at the same next discovery tick.
    for (let k = 1; k < REFRESH_DISCOVERY_EVERY_NTH_TICK; k += 1) {
      expect(nextDiscoveryTick(T0 + k * TICK)).toBe(T0 + P);
    }
    // An off-grid instant (the floor fallback's input) still lands on the grid.
    expect(nextDiscoveryTick(T0 + P - 1)).toBe(T0 + P);
    expect(nextDiscoveryTick(T0 + 1)).toBe(T0 + P);
    // Exhaustive over a day: on the grid, strictly later, and nothing between.
    for (let t = T0; t < T0 + DAY; t += TICK) {
      const next = nextDiscoveryTick(t);
      expect(isDiscoveryTick(next)).toBe(true);
      expect(next % TICK).toBe(0);
      expect(next).toBeGreaterThan(t);
      for (let between = t + TICK; between < next; between += TICK) {
        expect(isDiscoveryTick(between)).toBe(false);
      }
    }
    // DST is irrelevant: epoch multiples. The fall-back Sunday 2026-11-01 has
    // two 01:00–02:00 ET hours and the grid does not notice.
    const fallBack = Date.parse('2026-11-01T05:57:00Z'); // 01:57 EDT
    expect(nextDiscoveryTick(fallBack)).toBe(Date.parse('2026-11-01T06:00:00Z')); // 01:00 EST
  });

  it('an admin run is always general', async () => {
    const live = await insertTarget({
      day: 0,
      nextRunAt: T0 - 2 * HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 30,
    });
    await makeLive('nfl', 0, 'nfl:live-1');
    const quiet = await insertTarget({
      day: 3,
      nextRunAt: T0 - HOUR,
      lastOkAt: T0 - DAY,
      gamesSeen: 30,
    });
    // T0 IS a discovery tick, and the admin run still takes the most-due slate.
    expect(isDiscoveryTick(T0)).toBe(true);
    const run = await runJob(env, 'refresh', 'admin', T0);
    expect(run.status).toBe('ok');
    expect(run.stats?.['targetsProcessed']).toBe(1);
    expect((await guardRow(live)).last_ok_at).toBe(T0);
    expect((await guardRow(quiet)).last_ok_at).toBe(T0 - DAY);
  });

  it('both leases are strictly shorter than REFRESH_TICK_MS', () => {
    expect(JOB_LEASE_TTL_MS.refresh).toBeLessThan(REFRESH_TICK_MS);
    expect(JOB_LEASE_TTL_MS.settle).toBeLessThan(REFRESH_TICK_MS);
    expect(JOB_LEASE_TTL_MS.refresh).toBe(2.5 * MIN);
    expect(JOB_LEASE_TTL_MS.settle).toBe(2.5 * MIN);
    // Maintenance is daily and keeps its 10 minutes.
    expect(JOB_LEASE_TTL_MS.maintenance).toBe(10 * MIN);
  });

  it('JOB_RUNS_KEPT_PER_JOB keeps a full day of refresh and settle runs', () => {
    const runsPerDay = DAY / REFRESH_TICK_MS;
    expect(runsPerDay).toBe(480);
    expect(JOB_RUNS_KEPT_PER_JOB).toBeGreaterThanOrEqual(runsPerDay);
    expect(JOB_RUNS_KEPT_PER_JOB).toBe(600);
    // MAX_SETTLE_ATTEMPTS keeps meaning "24 h of patience" at one settle per tick.
    expect(MAX_SETTLE_ATTEMPTS * REFRESH_TICK_MS).toBe(DAY);
  });
});
