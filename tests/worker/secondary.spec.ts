import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GamesResponse, JobRunResponse, UserResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import {
  ODDS_API_COOLDOWN_MAX_MS,
  ODDS_API_COOLDOWN_MS,
  ODDS_API_COST_PER_SWEEP,
  ODDS_API_CREDIT_RESERVE,
  ODDS_API_BUDGET_PROBE_MS,
  SECONDARY_MIN_SWEEP_INTERVAL_MS,
  SECONDARY_RESWEEP_MARGIN_MS,
  SECONDARY_RETRY_MS,
  SESSION_COOKIE_NAME,
} from '../../src/shared/constants.js';
import { mergeEffectiveLine } from '../../src/shared/lines.js';
import type { LineRowView } from '../../src/shared/lines.js';
import { boardWindowEnd, lineStaleAfterMs } from '../../src/shared/time.js';
import type { Env } from '../../src/worker/env.js';
import { runRefresh } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import { runJob } from '../../src/worker/jobs.js';
import { sweepSecondary } from '../../src/worker/secondary.js';
import { stubEspn, stubOddsApi } from './fixtures.js';
import type { EspnStub, OddsApiEventSpec, OddsApiStub } from './fixtures.js';
import { fullLine, seedGame, seedLine, wipeAccounts } from './seed.js';
import { DK_VECTORS } from './setup.js';

/**
 * TDD contract for src/worker/secondary.ts (M9c). PLAN.md §21.2 / §21.5 /
 * §21.8 / §21.9, and the M9c list in §21.11.
 *
 * ISOLATION: every test starts from an EMPTY board and the 0007 seed of
 * `secondary_budget`, because the candidate scan is by league and window — a
 * game left over from the previous test would be a candidate in this one.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite';
const HOUR = 3_600_000;
const MIN = 60_000;
/** Thursday 2026-09-17 16:00Z: the board window runs to Monday 09-21 for both leagues. */
const NOW = Date.parse('2026-09-17T16:00:00Z');
/** Sunday 09-20 17:00Z, well inside the window and 73 h out. */
const KICK = Date.parse('2026-09-20T17:00:00Z');
const NFL = 'americanfootball_nfl';
const NCAAF = 'americanfootball_ncaaf';

let espn: EspnStub;
let odds: OddsApiStub;

beforeEach(async () => {
  espn = stubEspn({});
  odds = stubOddsApi();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_lines'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM ingest_targets'),
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
    env.DB.prepare(
      `UPDATE secondary_budget SET remaining_credits = 500, checked_at = 0, last_attempt_at = 0,
         nfl_last_sweep_at = 0, ncaaf_last_sweep_at = 0, cooldown_until = 0,
         consecutive_failures = 0, last_status = NULL, last_error = NULL, updated_at = 0 WHERE id = 1`,
    ),
  ]);
  await wipeAccounts(env.DB);
});

afterEach(() => {
  odds.restore();
  espn.restore();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const HOME = 'Tampa Bay Buccaneers';
const AWAY = 'Dallas Cowboys';

interface GameOpts {
  readonly league?: 'nfl' | 'ncaaf';
  readonly kickoffAt?: number;
  readonly homeRank?: number | null;
  readonly awayRank?: number | null;
  readonly status?: 'scheduled' | 'in_progress' | 'final';
  readonly home?: string;
  readonly away?: string;
  /** Which markets the PRIMARY row carries. Default: spread only (total + ML gapped). */
  readonly primary?: 'none' | 'spread' | 'spread+total' | 'full';
  readonly spreadHomeTenths?: number;
  readonly seenAt?: number;
}

let seq = 0;
/** A scheduled game with a gapped primary line; returns its id. */
async function game(opts: GameOpts = {}): Promise<string> {
  seq += 1;
  const league = opts.league ?? 'nfl';
  const id = `${league}:sec${String(seq)}`;
  await seedGame(env.DB, {
    id,
    league,
    kickoffAt: opts.kickoffAt ?? KICK,
    status: opts.status ?? 'scheduled',
    homeAbbr: opts.home ?? HOME,
    awayAbbr: opts.away ?? AWAY,
    homeRank: opts.homeRank ?? null,
    awayRank: opts.awayRank ?? null,
    lastSeenAt: NOW,
  });
  const primary = opts.primary ?? 'spread';
  if (primary === 'none') return id;
  const s = opts.spreadHomeTenths ?? -35;
  await seedLine(env.DB, {
    ...fullLine(id, opts.seenAt ?? NOW - 5 * MIN),
    spreadHomeTenths: s,
    spreadAwayTenths: -s,
    ...(primary === 'spread' || primary === 'spread+total'
      ? { mlHomePrice: null, mlAwayPrice: null }
      : {}),
    ...(primary === 'spread'
      ? { totalTenths: null, totalOverPrice: null, totalUnderPrice: null }
      : {}),
  });
  return id;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** An API event that matches `game()`'s default names and kickoff. */
function apiEvent(over: Partial<OddsApiEventSpec> = {}): OddsApiEventSpec {
  return {
    id: `ev${String(seq)}`,
    commenceTime: iso(KICK),
    homeTeam: HOME,
    awayTeam: AWAY,
    ...over,
  };
}

interface BudgetRow {
  remaining_credits: number;
  checked_at: number;
  last_attempt_at: number;
  nfl_last_sweep_at: number;
  ncaaf_last_sweep_at: number;
  cooldown_until: number;
  consecutive_failures: number;
  last_status: string | null;
}
const budget = (): Promise<BudgetRow | null> =>
  env.DB.prepare('SELECT * FROM secondary_budget WHERE id = 1').first<BudgetRow>();
const setBudget = (sets: string, ...values: unknown[]): Promise<D1Result> =>
  env.DB.prepare(`UPDATE secondary_budget SET ${sets} WHERE id = 1`)
    .bind(...values)
    .run();

interface LineDbRow {
  provider: string;
  spread_home_tenths: number | null;
  total_tenths: number | null;
  total_over_price: number | null;
  total_book: string | null;
  ml_home_price: number | null;
  ml_book: string | null;
  captured_at: number;
  seen_at: number;
}
const lineRows = (gameId: string): Promise<LineDbRow[]> =>
  env.DB.prepare('SELECT * FROM game_lines WHERE game_id = ? ORDER BY provider')
    .bind(gameId)
    .all<LineDbRow>()
    .then((r) => r.results);
const secondaryRow = async (gameId: string): Promise<LineDbRow | undefined> =>
  (await lineRows(gameId)).find((r) => r.provider === 'odds-api');
const triedAt = (gameId: string): Promise<number | null> =>
  env.DB.prepare('SELECT secondary_tried_at AS t FROM games WHERE id = ?')
    .bind(gameId)
    .first<{ t: number | null }>()
    .then((r) => r?.t ?? null);

/** The effective line as the board and placement would see it, from the DB. */
async function effective(
  gameId: string,
  now: number,
): Promise<ReturnType<typeof mergeEffectiveLine>> {
  const rows = await env.DB.prepare('SELECT * FROM game_lines WHERE game_id = ?')
    .bind(gameId)
    .all<Record<string, number | string | null>>();
  const kickoff = await env.DB.prepare('SELECT kickoff_at AS k FROM games WHERE id = ?')
    .bind(gameId)
    .first<{ k: number }>();
  const views: LineRowView[] = rows.results.map((r) => ({
    provider: String(r['provider']),
    spreadHomeTenths: r['spread_home_tenths'] as number | null,
    spreadHomePrice: r['spread_home_price'] as number | null,
    spreadAwayTenths: r['spread_away_tenths'] as number | null,
    spreadAwayPrice: r['spread_away_price'] as number | null,
    spreadBook: r['spread_book'] as string | null,
    totalTenths: r['total_tenths'] as number | null,
    totalOverPrice: r['total_over_price'] as number | null,
    totalUnderPrice: r['total_under_price'] as number | null,
    totalBook: r['total_book'] as string | null,
    mlHomePrice: r['ml_home_price'] as number | null,
    mlAwayPrice: r['ml_away_price'] as number | null,
    mlBook: r['ml_book'] as string | null,
    capturedAt: r['captured_at'] as number,
    seenAt: r['seen_at'] as number,
  }));
  return mergeEffectiveLine(views, kickoff?.k ?? 0, now);
}

/** The instant the re-sweep rule fires for the game's secondary row. */
async function resweepAt(gameId: string): Promise<number> {
  const row = await secondaryRow(gameId);
  const kickoff = await env.DB.prepare('SELECT kickoff_at AS k FROM games WHERE id = ?')
    .bind(gameId)
    .first<{ k: number }>();
  const seenAt = row?.seen_at ?? 0;
  return seenAt + lineStaleAfterMs(kickoff?.k ?? 0, seenAt) - SECONDARY_RESWEEP_MARGIN_MS;
}

const oddsCalls = (): number => odds.urls.filter((u) => u.includes('/odds?')).length;
const probeCalls = (): number => odds.urls.filter((u) => u.includes('/v4/sports?')).length;

async function refresh(now: number, force: string | null = null): ReturnType<typeof runRefresh> {
  return runRefresh(env, now, 2, { forceSecondaryGameId: force });
}

async function send(path: string, init: RequestInit): Promise<Response> {
  return buildApp().fetch(new Request(`${ORIGIN}${path}`, init), env);
}
/**
 * The admin routes run on the REAL clock (`c.var.now`), not `NOW`, so a game
 * they must find has to be seeded relative to `Date.now()` and inside today's
 * board window — never at the absolute `KICK`, which is a date bomb.
 */
function liveKickoff(): number {
  const real = Date.now();
  const end = boardWindowEnd('nfl', real);
  return Math.min(real + 2 * 24 * HOUR, end - HOUR);
}
const liveEvent = (kickoffAt: number, over: Partial<OddsApiEventSpec> = {}): OddsApiEventSpec =>
  apiEvent({ commenceTime: iso(kickoffAt), ...over });

async function registerAdmin(username: keyof typeof DK_VECTORS): Promise<string> {
  const res = await send('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
    body: JSON.stringify({ username, dk: DK_VECTORS[username], inviteCode: INVITE }),
  });
  expect(res.status).toBe(201);
  expect((await res.json<UserResponse>()).user.isAdmin).toBe(true);
  const raw = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`).exec(raw);
  return `${SESSION_COOKIE_NAME}=${m?.[1] ?? ''}`;
}

/* ------------------------------------------------------------------ *
 * Feature switch
 * ------------------------------------------------------------------ */

describe('secondary sweep — feature switch', () => {
  it('OFF with no key: no fetch, enabled false, sweeps empty, and the ESPN ingest is untouched', async () => {
    await game();
    const { ODDS_API_KEY: _unused, ...rest } = env;
    const off: Env = rest;
    const stats = await runRefresh(off, NOW, 2, { forceSecondaryGameId: null });
    expect(stats.secondary).toEqual({
      enabled: false,
      remaining: null,
      checkedAt: null,
      budgetSkipped: 0,
      sweeps: [],
    });
    expect(odds.callCount).toBe(0);
    expect(stats.targetsProcessed).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

describe('secondary sweep — the decision (PLAN.md §21.2 / §21.5)', () => {
  it('a gapped NFL game → one sweep, one odds-api row with the books named, and the board offers all three', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    const stats = await refresh(NOW);
    const sweep = stats.secondary.sweeps.find((s) => s.league === 'nfl');
    expect(sweep).toMatchObject({
      reason: 'retry',
      skipped: null,
      cost: ODDS_API_COST_PER_SWEEP,
      events: 1,
      matched: 1,
    });
    expect(sweep?.filled).toEqual({ spread: 0, total: 1, moneyline: 1 });
    expect(oddsCalls()).toBe(1);
    const row = await secondaryRow(id);
    expect(row).toMatchObject({
      provider: 'odds-api',
      total_tenths: 475,
      total_book: 'draftkings',
      ml_home_price: -180,
      ml_book: 'draftkings',
      spread_home_tenths: -35, // the row carries everything the API had; the merge keeps the primary's spread on the board
    });
    const line = await effective(id, NOW);
    expect(line?.spread?.provider).toBe('DraftKings');
    expect(line?.total?.provider).toBe('odds-api:draftkings');
    expect(line?.moneyline?.provider).toBe('odds-api:draftkings');
    expect(stats.secondary.remaining).toBe(497);
    expect((await budget())?.remaining_credits).toBe(497);
    expect((await budget())?.last_status).toBe('ok');
  });

  it('a fully-lined slate → no fetch at all, skipped: no-gap', async () => {
    await game({ primary: 'full' });
    const stats = await refresh(NOW);
    expect(oddsCalls()).toBe(0);
    expect(stats.secondary.sweeps.find((s) => s.league === 'nfl')).toMatchObject({
      reason: null,
      skipped: 'no-gap',
      cost: 0,
    });
  });

  it('an unranked CFB gap → no fetch; a top-25 CFB gap → a fetch', async () => {
    await game({ league: 'ncaaf' });
    await refresh(NOW);
    expect(oddsCalls()).toBe(0);
    await game({ league: 'ncaaf', homeRank: 7 });
    odds.set(NCAAF, [apiEvent({ sportKey: NCAAF })]);
    await refresh(NOW + MIN);
    expect(oddsCalls()).toBe(1);
    expect(odds.urls.at(-1)).toContain(`/v4/sports/${NCAAF}/odds`);
  });

  it('a game past kickoff, in progress, final, or past the board window is not a candidate', async () => {
    await game({ kickoffAt: NOW - HOUR });
    await game({ kickoffAt: KICK, status: 'in_progress' });
    await game({ kickoffAt: KICK, status: 'final' });
    await game({ kickoffAt: Date.parse('2026-09-27T17:00:00Z') }); // next week's Sunday
    await refresh(NOW);
    expect(oddsCalls()).toBe(0);
  });

  it('the moneyline rule: no ML at a −40.5 spread is not a gap; at −20.5 it is', async () => {
    await game({ league: 'ncaaf', homeRank: 1, primary: 'spread+total', spreadHomeTenths: -405 });
    await refresh(NOW);
    expect(oddsCalls()).toBe(0);
    await game({ league: 'ncaaf', homeRank: 2, primary: 'spread+total', spreadHomeTenths: -205 });
    await refresh(NOW + MIN);
    expect(oddsCalls()).toBe(1);
  });

  it('a game the sweep could NOT fill is stamped and not retried for 4 h; a filled game is never stamped', async () => {
    const filled = await game();
    const unfillable = await game({ home: 'Nowhere Nobodies', away: 'Elsewhere Everybodies' });
    odds.set(NFL, [apiEvent({ id: 'match-first' })]);
    const first = await refresh(NOW);
    expect(first.secondary.sweeps[0]).toMatchObject({
      stamped: 1,
      unmatchedEspn: ['Elsewhere Everybodies @ Nowhere Nobodies'],
    });
    expect(await triedAt(filled)).toBeNull();
    expect(await triedAt(unfillable)).toBe(NOW);
    // 1 h later: the only gapped game is inside its backoff → no fetch.
    await setBudget('nfl_last_sweep_at = 0');
    expect((await refresh(NOW + HOUR)).secondary.sweeps[0]?.skipped).toBe('no-gap');
    expect(oddsCalls()).toBe(1);
    // 4 h 1 min later: out of its backoff → fetch.
    await setBudget('nfl_last_sweep_at = 0');
    await refresh(NOW + SECONDARY_RETRY_MS + MIN);
    expect(oddsCalls()).toBe(2);
  });

  it('the re-sweep rule keeps a fill fresh: fires 45 min before the row would go stale, not 46', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW);
    const seenAt = (await secondaryRow(id))?.seen_at ?? 0;
    const window = lineStaleAfterMs(KICK, seenAt);
    const edge = seenAt + window - SECONDARY_RESWEEP_MARGIN_MS;
    // The fill un-gapped the game, so `retry` cannot fire — only `resweep` can.
    await setBudget('nfl_last_sweep_at = 0');
    expect((await refresh(edge - MIN)).secondary.sweeps[0]?.skipped).toBe('no-gap');
    expect(oddsCalls()).toBe(1);
    await setBudget('nfl_last_sweep_at = 0');
    expect((await refresh(edge)).secondary.sweeps[0]?.reason).toBe('resweep');
    expect(oddsCalls()).toBe(2);
  });

  it('the fill does not vanish: over a simulated Saturday of ticks the secondary total stays on the board', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    for (let t = NOW; t <= NOW + 12 * HOUR; t += 30 * MIN) {
      await refresh(t);
      const line = await effective(id, t);
      expect(line?.total?.provider, new Date(t).toISOString()).toBe('odds-api:draftkings');
    }
    // and it did so without a sweep every tick
    expect(oddsCalls()).toBeLessThanOrEqual(7);
  }, 60_000);

  it('withdrawal: a later sweep with no total for the game NULLs the column and advances seen_at', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW);
    const before = await secondaryRow(id);
    odds.set(NFL, [
      apiEvent({
        books: [
          {
            key: 'draftkings',
            h2h: [
              { name: AWAY, price: 155 },
              { name: HOME, price: -180 },
            ],
          },
        ],
      }),
    ]);
    await setBudget('nfl_last_sweep_at = 0');
    const later = await resweepAt(id);
    await refresh(later); // the re-sweep rule fires
    const after = await secondaryRow(id);
    expect(after?.total_tenths).toBeNull();
    expect(after?.total_book).toBeNull();
    expect(after?.ml_home_price).toBe(-180);
    expect(after?.seen_at ?? 0).toBeGreaterThan(before?.seen_at ?? 0);
    expect((await effective(id, later))?.total).toBeNull();
  });

  it('an identical second sweep does not move captured_at (compare-and-skip on the 12-column tuple)', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW);
    const before = await secondaryRow(id);
    await setBudget('nfl_last_sweep_at = 0');
    await refresh(await resweepAt(id));
    const after = await secondaryRow(id);
    expect(after?.captured_at).toBe(before?.captured_at);
    expect(after?.seen_at ?? 0).toBeGreaterThan(before?.seen_at ?? 0);
  });

  it('a book change at the identical number IS a write: total_book flips and captured_at advances', async () => {
    const id = await game();
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW);
    const before = await secondaryRow(id);
    const fdOnly = {
      key: 'fanduel',
      totals: [
        { name: 'Over', price: -110, point: 47.5 },
        { name: 'Under', price: -110, point: 47.5 },
      ],
      h2h: [
        { name: AWAY, price: 155 },
        { name: HOME, price: -180 },
      ],
    };
    odds.set(NFL, [apiEvent({ books: [fdOnly] })]);
    await setBudget('nfl_last_sweep_at = 0');
    await refresh(await resweepAt(id));
    const after = await secondaryRow(id);
    expect(after?.total_book).toBe('fanduel');
    expect(after?.total_tenths).toBe(before?.total_tenths);
    expect(after?.captured_at ?? 0).toBeGreaterThan(before?.captured_at ?? 0);
  });

  it('SECONDARY_MIN_SWEEP_INTERVAL_MS: two gapped runs 30 min apart → one fetch, the second throttled', async () => {
    await game({ home: 'Nowhere Nobodies' });
    await refresh(NOW);
    const second = await refresh(NOW + 30 * MIN);
    expect(oddsCalls()).toBe(1);
    expect(second.secondary.sweeps[0]).toMatchObject({ skipped: 'throttled', cost: 0 });
    await refresh(NOW + SECONDARY_MIN_SWEEP_INTERVAL_MS + SECONDARY_RETRY_MS);
    expect(oddsCalls()).toBe(2);
  });

  it('two leagues gapped in one run → at most two fetches, one per league', async () => {
    await game();
    await game({ league: 'ncaaf', homeRank: 3 });
    const stats = await refresh(NOW);
    expect(oddsCalls()).toBe(2);
    expect(stats.secondary.sweeps.map((s) => s.league).sort()).toEqual(['ncaaf', 'nfl']);
    // MLB is primary-only (PLAN.md §23.10): ABSENT from sweeps[], not skipped.
    expect(stats.secondary.sweeps).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The budget and the probes
 * ------------------------------------------------------------------ */

describe('secondary sweep — credits (PLAN.md §21.5)', () => {
  it('the reserve: at RESERVE + 2 credits a gapped slate makes NO odds fetch and reports budgetSkipped', async () => {
    const id = await game();
    await setBudget('remaining_credits = ?', ODDS_API_CREDIT_RESERVE + 2);
    odds.setCredits({ remaining: ODDS_API_CREDIT_RESERVE + 2 }); // the probe tells the truth
    const stats = await refresh(NOW);
    expect(oddsCalls()).toBe(0);
    // One refusal per league: the reserve is checked before the candidate scan.
    expect(stats.secondary.budgetSkipped).toBe(2);
    expect(stats.secondary.sweeps[0]).toMatchObject({ skipped: 'budget' });
    expect(await secondaryRow(id)).toBeUndefined();
    expect((await budget())?.remaining_credits).toBe(ODDS_API_CREDIT_RESERVE + 2);
  });

  it('the reset probe: reserve blocking and last_attempt_at 25 h old → one FREE /v4/sports call, no debit, checked_at advances, no repeat within a day', async () => {
    await game();
    await setBudget(
      'remaining_credits = ?, last_attempt_at = ?',
      ODDS_API_CREDIT_RESERVE,
      NOW - 25 * HOUR,
    );
    odds.setCredits({ remaining: 10, used: 490 });
    await refresh(NOW);
    expect(probeCalls()).toBe(1);
    expect(oddsCalls()).toBe(0);
    const row = await budget();
    expect(row?.remaining_credits).toBe(10);
    expect(row?.checked_at).toBe(NOW);
    expect(row?.last_attempt_at).toBe(NOW);
    await refresh(NOW + HOUR);
    expect(probeCalls()).toBe(1);
    await refresh(NOW + ODDS_API_BUDGET_PROBE_MS + MIN);
    expect(probeCalls()).toBe(2);
  });

  it('the probe rediscovers a monthly reset: it reports 500 and the next run sweeps normally', async () => {
    const id = await game();
    await setBudget(
      'remaining_credits = ?, last_attempt_at = ?',
      ODDS_API_CREDIT_RESERVE,
      NOW - 25 * HOUR,
    );
    odds.setCredits({ remaining: 500, used: 0 });
    await refresh(NOW);
    expect(probeCalls()).toBe(1);
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW + 15 * MIN);
    expect(oddsCalls()).toBe(1);
    expect(await secondaryRow(id)).toBeDefined();
  });

  it('the probe cannot exhaust: 40 days of a blocked reserve leave remaining_credits exactly where it started', async () => {
    await game();
    await setBudget(
      'remaining_credits = ?, last_attempt_at = ?',
      ODDS_API_CREDIT_RESERVE - 1,
      NOW - 25 * HOUR,
    );
    odds.setCredits({ remaining: ODDS_API_CREDIT_RESERVE - 1 });
    // One league's sweep per day is the whole mechanism; a full refresh per day
    // is 40 ESPN ingests of nothing and times out on the CI runner.
    for (let d = 0; d < 40; d += 1)
      await sweepSecondary(env, 'nfl', NOW + d * 24 * HOUR, { force: null });
    expect(oddsCalls()).toBe(0);
    expect(probeCalls()).toBe(40);
    expect((await budget())?.remaining_credits).toBe(ODDS_API_CREDIT_RESERVE - 1);
  }, 60_000);

  it('secondary_budget deleted → skipped: no-budget-row, run ok, the ESPN slate still landed, nothing throws', async () => {
    await game();
    await env.DB.prepare('DELETE FROM secondary_budget').run();
    const run = await runJob(env, 'refresh', 'cron', NOW);
    expect(run.status).toBe('ok');
    const secondary = run.stats?.['secondary'] as
      { sweeps: { skipped: string | null }[] } | undefined;
    expect(secondary?.sweeps.every((s) => s.skipped === 'no-budget-row')).toBe(true);
    expect(oddsCalls()).toBe(0);
    expect(run.stats?.['targetsProcessed']).toBe(2);
    await env.DB.prepare(
      'INSERT INTO secondary_budget (id, remaining_credits) VALUES (1, 500)',
    ).run();
  });

  it('a MISSING x-requests-remaining header leaves the stored balance alone, never sets it to 0', async () => {
    await game();
    odds.setResponder(
      NFL,
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await refresh(NOW);
    expect(oddsCalls()).toBe(1);
    expect((await budget())?.remaining_credits).toBe(500 - ODDS_API_COST_PER_SWEEP);
  });
});

/* ------------------------------------------------------------------ *
 * Failures (PLAN.md §21.9)
 * ------------------------------------------------------------------ */

describe('secondary sweep — failures', () => {
  it('401 → no rows, last_status unauthorized, cooldown UNCHANGED, run still ok, ESPN slate landed', async () => {
    const id = await game();
    odds.setResponder(NFL, () => new Response('{"message":"bad key"}', { status: 401 }));
    const run = await runJob(env, 'refresh', 'cron', NOW);
    expect(run.status).toBe('ok');
    expect(await secondaryRow(id)).toBeUndefined();
    const row = await budget();
    expect(row?.last_status).toBe('unauthorized');
    expect(row?.cooldown_until).toBe(0);
    expect(run.stats?.['targetsProcessed']).toBe(2);
    const secondary = run.stats?.['secondary'] as { sweeps: { error: string | null }[] };
    expect(secondary.sweeps[0]?.error).toBe('unauthorized');
  });

  it('429 → cooldown set; the next run makes no call; after the cooldown it does', async () => {
    await game();
    odds.setResponder(NFL, () => new Response('slow', { status: 429 }));
    await refresh(NOW);
    const row = await budget();
    expect(row?.cooldown_until).toBe(NOW + ODDS_API_COOLDOWN_MS);
    expect(row?.last_status).toBe('rate_limited');
    const blocked = await refresh(NOW + 30 * MIN);
    expect(blocked.secondary.sweeps[0]?.skipped).toBe('cooldown');
    expect(oddsCalls()).toBe(1);
    odds.set(NFL, [apiEvent()]);
    await refresh(NOW + ODDS_API_COOLDOWN_MS + SECONDARY_MIN_SWEEP_INTERVAL_MS + MIN);
    expect(oddsCalls()).toBe(2);
  });

  it('500 → cooldown, zero line rows, and the FREE post-failure probe restores the balance in the SAME run without touching last_attempt_at', async () => {
    const id = await game();
    odds.setResponder(NFL, () => new Response('boom', { status: 500 }));
    odds.setCredits({ remaining: 497, used: 3 });
    const stats = await refresh(NOW);
    expect(await secondaryRow(id)).toBeUndefined();
    expect(probeCalls()).toBe(1);
    const row = await budget();
    expect(row?.remaining_credits).toBe(497); // the provider's number (the next test proves it is not the debit by luck)
    expect(row?.cooldown_until).toBe(NOW + ODDS_API_COOLDOWN_MS);
    expect(row?.last_attempt_at).toBe(NOW);
    expect(row?.checked_at).toBe(NOW);
    expect(row?.consecutive_failures).toBe(1);
    expect(stats.secondary.sweeps[0]?.error).toBe('unavailable');
  });

  it('the un-debit really replaces the guess: provider says 480, we had guessed 497', async () => {
    await game();
    odds.setResponder(NFL, () => new Response('boom', { status: 503 }));
    odds.setCredits({ remaining: 480, used: 20 });
    await refresh(NOW);
    expect((await budget())?.remaining_credits).toBe(480);
  });

  it('a timeout-shaped throw is the same as a 5xx', async () => {
    await game();
    odds.setResponder(NFL, () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const stats = await refresh(NOW);
    expect(stats.secondary.sweeps[0]?.error).toBe('unavailable');
    expect((await budget())?.cooldown_until).toBe(NOW + ODDS_API_COOLDOWN_MS);
  });

  it('two failures a second apart issue ONE post-failure probe (the 60 s checked_at floor)', async () => {
    await game();
    await game({ league: 'ncaaf', homeRank: 4 });
    odds.setResponder(NFL, () => new Response('boom', { status: 500 }));
    odds.setResponder(NCAAF, () => new Response('boom', { status: 500 }));
    // The NFL failure sets the cooldown, so the NCAAF sweep is skipped; drive
    // sweepSecondary directly to produce two failures inside one minute.
    await sweepSecondary(env, 'nfl', NOW, { force: null });
    await setBudget('cooldown_until = 0');
    await sweepSecondary(env, 'ncaaf', NOW + 1000, { force: null });
    expect(oddsCalls()).toBe(2);
    expect(probeCalls()).toBe(1);
  });

  it('cooldown escalation: 1 h, 2 h, 4 h, capped at ODDS_API_COOLDOWN_MAX_MS; one success resets it', async () => {
    await game({ home: 'Nowhere Nobodies' });
    odds.setResponder(NFL, () => new Response('boom', { status: 500 }));
    let t = NOW;
    const expected = [1, 2, 4, 8, 8];
    for (const factor of expected) {
      await sweepSecondary(env, 'nfl', t, { force: null });
      const row = await budget();
      expect(row?.cooldown_until).toBe(
        t + Math.min(factor * ODDS_API_COOLDOWN_MS, ODDS_API_COOLDOWN_MAX_MS),
      );
      t = (row?.cooldown_until ?? t) + SECONDARY_MIN_SWEEP_INTERVAL_MS;
    }
    odds.set(NFL, []);
    await sweepSecondary(env, 'nfl', t, { force: null });
    expect((await budget())?.consecutive_failures).toBe(0);
  });

  it('a 200 that is not JSON → cooldown, one warning, zero rows', async () => {
    const id = await game();
    odds.setResponder(
      NFL,
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const stats = await refresh(NOW);
    expect(stats.secondary.sweeps[0]?.error).toBe('malformed');
    expect((await budget())?.cooldown_until).toBe(NOW + ODDS_API_COOLDOWN_MS);
    expect(await secondaryRow(id)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The three refresh paths (PLAN.md §21.2)
 * ------------------------------------------------------------------ */

describe('secondary sweep — every refresh path', () => {
  it('POST /api/admin/jobs/refresh sweeps on the same rules as the cron', async () => {
    const cookie = await registerAdmin('alex');
    const kickoffAt = liveKickoff();
    const id = await game({ kickoffAt, seenAt: Date.now() - 5 * MIN });
    odds.set(NFL, [liveEvent(kickoffAt)]);
    const res = await send('/api/admin/jobs/refresh', {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json<JobRunResponse>();
    const secondary = body.run.stats?.['secondary'] as {
      enabled: boolean;
      sweeps: { reason: string | null }[];
    };
    expect(secondary.enabled).toBe(true);
    expect(secondary.sweeps.find((s) => s.reason === 'retry')).toBeDefined();
    expect(await secondaryRow(id)).toBeDefined();
  });

  it('(c) the per-game Refresh on a gapped eligible game INSIDE its backoff sweeps anyway (force), and reports it', async () => {
    const cookie = await registerAdmin('alex');
    const kickoffAt = liveKickoff();
    const id = await game({ kickoffAt, seenAt: Date.now() - 5 * MIN });
    await env.DB.prepare('UPDATE games SET secondary_tried_at = ? WHERE id = ?')
      .bind(Date.now() - HOUR, id)
      .run();
    odds.set(NFL, [liveEvent(kickoffAt)]);
    const res = await send(`/api/admin/games/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<JobRunResponse>();
    const secondary = body.run.stats?.['secondary'] as {
      sweeps: { league: string; reason: string | null; skipped: string | null; cost: number }[];
    };
    expect(secondary.sweeps.find((s) => s.league === 'nfl')).toMatchObject({
      reason: 'forced',
      skipped: null,
      cost: ODDS_API_COST_PER_SWEEP,
    });
    expect(oddsCalls()).toBe(1);
    expect(await secondaryRow(id)).toBeDefined();
  });

  it('(c) the per-game Refresh on a fully-lined game, or an unranked CFB game, makes no odds fetch', async () => {
    const cookie = await registerAdmin('alex');
    const full = await game({
      primary: 'full',
      kickoffAt: liveKickoff(),
      seenAt: Date.now() - 5 * MIN,
    });
    await send(`/api/admin/games/${encodeURIComponent(full)}/refresh`, {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    const unranked = await game({
      league: 'ncaaf',
      kickoffAt: liveKickoff(),
      seenAt: Date.now() - 5 * MIN,
    });
    await env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = ''").run();
    await send(`/api/admin/games/${encodeURIComponent(unranked)}/refresh`, {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(oddsCalls()).toBe(0);
  });

  it('(c) the per-game Refresh with the reserve hit → no fetch, budgetSkipped 2 (one per league), still HTTP 200', async () => {
    const cookie = await registerAdmin('alex');
    const id = await game({ kickoffAt: liveKickoff(), seenAt: Date.now() - 5 * MIN });
    await setBudget('remaining_credits = ?', ODDS_API_CREDIT_RESERVE);
    odds.setCredits({ remaining: ODDS_API_CREDIT_RESERVE }); // the free probe confirms the block
    const res = await send(`/api/admin/games/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json<JobRunResponse>();
    expect((body.run.stats?.['secondary'] as { budgetSkipped: number }).budgetSkipped).toBe(2);
    expect(oddsCalls()).toBe(0);
  });

  it('(c) the per-game Refresh while the lease is held → 409 JOB_LOCKED and no fetch', async () => {
    const cookie = await registerAdmin('alex');
    const id = await game();
    await env.DB.prepare(
      'UPDATE job_locks SET lease_until = ?, run_id = ?, updated_at = ? WHERE name = ?',
    )
      .bind(Date.now() + 5 * MIN, 'somebody-else', Date.now(), 'refresh')
      .run();
    const res = await send(`/api/admin/games/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      headers: { 'X-SBS-Client': '1', cookie },
    });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('JOB_LOCKED');
    expect(odds.callCount).toBe(0);
  });

  it('the board a user sees after a sweep carries the secondary markets with their books', async () => {
    const cookie = await registerAdmin('alex');
    const kickoffAt = liveKickoff();
    const id = await game({ kickoffAt, seenAt: Date.now() - 5 * MIN });
    odds.set(NFL, [liveEvent(kickoffAt)]);
    await refresh(Date.now());
    const res = await send('/api/games?league=nfl', { method: 'GET', headers: { cookie } });
    const board = await res.json<GamesResponse>();
    const card = board.games.find((g) => g.id === id);
    expect(card?.lines?.total?.provider).toBe('odds-api:draftkings');
    expect(card?.lines?.spread?.provider).toBe('DraftKings');
  });
});
