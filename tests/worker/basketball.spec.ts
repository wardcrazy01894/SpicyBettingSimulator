/**
 * Basketball — men's college (`'ncaab'`) and the NBA — against a real D1
 * (M13c, PLAN.md §24.15): the ESPN URLs and the truncation warning (the
 * contracts tests/unit/basketball.spec.ts cannot reach across the tsconfig
 * boundary), the planner's targets, pull counting through a refresh, the
 * kill switches (betting OPEN since M13d, PLAN.md §24.17), the teaser refusal,
 * settlement end to end with the shared FULL_ACTION arm, the next-day
 * postponed void, the dormant per-conference switch (§24.8), and the §24.13
 * write-budget soak.
 *
 * Betting is open, so the kill-switch test closes the gate for its block
 * through a cast and restores it in a `finally` (mlb.spec.ts's `closeMlb`).
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { postponedVoidConfirmAt } from '../../src/shared/action.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import type { GameCard, PlaceBetRequest, UserResponse } from '../../src/shared/api-types.js';
import {
  CBB_CONFERENCES,
  INITIAL_BANKROLL_CENTS,
  MLB_POSTPONED_CONFIRM_MS,
  REFRESH_DISCOVERY_TICKS,
  REFRESH_TICK_MS,
  SECONDARY_LEAGUES,
  TEASABLE_LEAGUES,
} from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { boardWindowEnd, etDateKeyRange, etDayBounds } from '../../src/shared/time.js';
import { LEAGUES } from '../../src/shared/types.js';
import type { League } from '../../src/shared/types.js';
import { LEAGUE_BETTING_OPEN, placeBet } from '../../src/worker/bets.js';
import { buildScoreboardUrl, EspnProvider, truncationWarning } from '../../src/worker/espn.js';
import {
  bumpTargetForGame,
  computeNextRunAt,
  ingestTarget,
  NCAAB_TARGET_SHAPE,
  planTargets,
  runRefresh,
  segmentTargetId,
  toSlateTarget,
  upsertSlate,
} from '../../src/worker/ingest.js';
import type { IngestTargetRow } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import { NEXT_DAY_VOID_LEAGUES, runMaintenance } from '../../src/worker/maintenance.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import { runSettle } from '../../src/worker/settle.js';
import { buildScoreboard, stubEspn } from './fixtures.js';
import type { EspnStub, EventSpec } from './fixtures.js';
import { bankrollDrift, mainBankrollId, seedGame, seedGameWithLine, updateGame } from './seed.js';

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Saturday 2026-11-07, 00:00 ET — college basketball's opening day. */
const DAY = etDayBounds(Date.parse('2026-11-07T17:00:00Z'));
const DAY_START = DAY.startAt;
const at = (h: number, m = 0): number => DAY_START + h * HOUR + m * MIN;

let espn: EspnStub;
let seq = 0;

beforeEach(async () => {
  espn = stubEspn({});
  seq += 1;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_lines'),
    env.DB.prepare('DELETE FROM games WHERE id NOT IN (SELECT game_id FROM bet_legs)'),
    env.DB.prepare('DELETE FROM ingest_targets'),
    env.DB.prepare('DELETE FROM job_runs'),
  ]);
});

afterEach(() => {
  espn.restore();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function post(path: string, payload: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-SBS-Client': '1',
  };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return Promise.resolve(
    buildApp().request(
      `${ORIGIN}${path}`,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      env,
    ),
  );
}

function get(path: string, cookie: string): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, { headers: { cookie } }, env));
}

let accountSeq = 0;
async function registerAccount(): Promise<{ cookie: string; id: string }> {
  accountSeq += 1;
  const res = await post('/api/auth/signup', {
    username: `bb${String(seq)}x${String(accountSeq)}`,
    dk: 'a'.repeat(64),
    inviteCode: INVITE,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json<UserResponse>();
  const cookie = /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
  return { cookie, id: body.user.id };
}

/** Close basketball betting for ONE block (the kill switch, used); always restored. */
async function withBasketballClosed<T>(fn: () => Promise<T>): Promise<T> {
  const gate = LEAGUE_BETTING_OPEN as Record<League, boolean>;
  gate.ncaab = false;
  gate.nba = false;
  try {
    return await fn();
  } finally {
    gate.ncaab = true;
    gate.nba = true;
  }
}

function makeSlate(specs: readonly EventSpec[], league: League, fetchedAt: number): ProviderSlate {
  const parsed = parseScoreboard(buildScoreboard(specs), league, fetchedAt);
  return {
    games: parsed.games,
    lines: parsed.lines,
    warnings: parsed.warnings,
    pulled: parsed.pulled,
    fetchedAt,
    season: parsed.season,
    week: parsed.week,
  };
}

/** Independent witness of `meta.rows_written` (the ingest.spec.ts probe). */
function probeBatchRows(): { readonly rows: number; restore(): void } {
  const realBatch = env.DB.batch.bind(env.DB);
  let rows = 0;
  env.DB.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const results = await realBatch<T>(statements);
    for (const r of results) {
      const meta: { rows_written?: unknown } = r.meta;
      rows += typeof meta.rows_written === 'number' ? meta.rows_written : 0;
    }
    return results;
  };
  return {
    get rows() {
      return rows;
    },
    restore() {
      env.DB.batch = realBatch;
    },
  };
}

async function readTarget(id: string): Promise<IngestTargetRow> {
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
    conference_id: string | null;
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
    incompleteAttempts: row.incomplete_attempts,
    conferenceId: row.conference_id,
  };
}

const targetIds = async (league: League): Promise<string[]> =>
  (
    await env.DB.prepare('SELECT id FROM ingest_targets WHERE league = ?1 ORDER BY id')
      .bind(league)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

async function gameRow(id: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT * FROM games WHERE id = ?1').bind(id).first();
  if (row === null) throw new Error(`no game ${id}`);
  return row;
}

function cbb(eventId: string, over: Partial<EventSpec> = {}): EventSpec {
  return {
    eventId,
    league: 'ncaab',
    kickoffAt: at(19),
    status: 'pre',
    homeAbbr: 'LOU',
    awayAbbr: 'MORE',
    season: 2027,
    homeConferenceId: '2',
    homeRank: 11,
    odds: { spreadHome: -36.5, total: 151.5, moneylineOff: true },
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * URLs (the unit file's URL todos, discharged here)
 * ------------------------------------------------------------------ */

describe('M13c: ESPN URLs and the truncation warning (PLAN.md §24.10)', () => {
  it('the ncaab URL is groups=50&limit=500&dates=…, and groups=<id> for a conference target', () => {
    expect(
      buildScoreboardUrl('https://site.api.espn.com', 'ncaab', {
        kind: 'date',
        dateKey: '20261107',
      }),
    ).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=500&dates=20261107',
    );
    expect(
      buildScoreboardUrl('https://site.api.espn.com/', 'ncaab', {
        kind: 'date',
        dateKey: '20261107',
        conferenceId: '23',
      }),
    ).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=23&limit=500&dates=20261107',
    );
  });

  it('the nba URL is dates=…&limit=100, and ignores a conference id', () => {
    const url =
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261107&limit=100';
    expect(
      buildScoreboardUrl('https://site.api.espn.com', 'nba', { kind: 'date', dateKey: '20261107' }),
    ).toBe(url);
    expect(
      buildScoreboardUrl('https://site.api.espn.com', 'nba', {
        kind: 'date',
        dateKey: '20261107',
        conferenceId: '23',
      }),
    ).toBe(url);
  });

  it('the four existing URLs are byte-identical', () => {
    const base = 'https://site.api.espn.com';
    const t = (dateKey: string) => ({ kind: 'date' as const, dateKey });
    expect(buildScoreboardUrl(base, 'nfl', t('20260913'))).toBe(
      `${base}/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913&limit=100`,
    );
    expect(buildScoreboardUrl(base, 'ncaaf', t('20260912'))).toBe(
      `${base}/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates=20260912`,
    );
    expect(buildScoreboardUrl(base, 'mlb', t('20260929'))).toBe(
      `${base}/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260929&limit=100`,
    );
    // A conference id on a football target changes nothing either.
    expect(buildScoreboardUrl(base, 'ncaaf', { ...t('20260912'), conferenceId: '8' })).toBe(
      `${base}/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates=20260912`,
    );
  });

  it('a payload of exactly `limit` events adds the truncation warning', async () => {
    expect(truncationWarning('nba', 99)).toBeNull();
    expect(truncationWarning('nba', 100)?.reason).toBe('slate may be truncated at limit=100');
    expect(truncationWarning('ncaab', 500)?.reason).toBe('slate may be truncated at limit=500');
    expect(truncationWarning('ncaaf', 300)?.reason).toBe('slate may be truncated at limit=300');
    // Through the real fetch: 100 NBA events → the warning is first.
    const events: EventSpec[] = Array.from({ length: 100 }, (_, i) => ({
      eventId: `n${String(i)}`,
      league: 'nba',
      kickoffAt: at(19),
      status: 'pre',
      homeAbbr: `H${String(i)}`,
      awayAbbr: `A${String(i)}`,
    }));
    espn.set('20261107', events);
    const slate = await new EspnProvider(env, at(12)).fetchSlate('nba', {
      kind: 'date',
      dateKey: '20261107',
    });
    expect(slate.games).toHaveLength(100);
    expect(slate.warnings[0]?.reason).toBe('slate may be truncated at limit=100');
    espn.set('20261107', events.slice(1));
    const short = await new EspnProvider(env, at(12)).fetchSlate('nba', {
      kind: 'date',
      dateKey: '20261107',
    });
    expect(short.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The planner and a refresh
 * ------------------------------------------------------------------ */

describe('M13c: planner and refresh', () => {
  it('plans three ncaab:date:* and two nba:date:* targets a day, idempotently, full shape', async () => {
    expect(NCAAB_TARGET_SHAPE).toBe('full');
    await planTargets(env, at(12));
    expect(await targetIds('ncaab')).toEqual([
      'ncaab:date:20261107',
      'ncaab:date:20261108',
      'ncaab:date:20261109',
    ]);
    expect(await targetIds('nba')).toEqual(['nba:date:20261107', 'nba:date:20261108']);
    expect(await planTargets(env, at(12) + MIN)).toBe(0);
    const nullConf = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM ingest_targets WHERE conference_id IS NOT NULL',
    ).first<{ n: number }>();
    expect(nullConf?.n).toBe(0);
    // The windows are exactly boardWindowEnd's.
    for (const league of ['ncaab', 'nba'] as const) {
      expect((await targetIds(league)).map((id) => id.slice(-8))).toEqual(
        etDateKeyRange(at(12), boardWindowEnd(league, at(12))),
      );
    }
  });

  it('a refresh ingests a college slate, counts the pulled moneyline in offTheBoard and warns nothing', async () => {
    await planTargets(env, at(12));
    const { odds: _drop, ...unpriced } = cbb('401918949', { homeAbbr: 'DUKE' });
    espn.set('20261107', [cbb('401918948'), unpriced]);
    const target = await readTarget('ncaab:date:20261107');
    const res = await ingestTarget(env, new EspnProvider(env, at(12)), target, at(12));
    expect(res.error).toBeNull();
    expect(res.warnings).toEqual([]);
    expect(res.offTheBoard).toBe(1);
    expect(res.gamesUpserted).toBe(2);
    // The pulled moneyline is still a gap; the spread and total landed.
    expect(res.noMoneyline).toBe(1);
    const line = await env.DB.prepare(
      "SELECT * FROM game_lines WHERE game_id = 'ncaab:401918948'",
    ).first();
    expect(line).toMatchObject({
      spread_home_tenths: -365,
      total_tenths: 1515,
      ml_home_price: null,
      ml_away_price: null,
    });
    expect(await gameRow('ncaab:401918948')).toMatchObject({
      league: 'ncaab',
      season: 2027,
      week: null,
      home_conference_id: '2',
      home_rank: 11,
    });
    // The URL the Worker asked for.
    expect(espn.urls.at(-1)).toContain('/basketball/mens-college-basketball/scoreboard?groups=50');
  });

  it('runRefresh sums offTheBoard into the run stats; basketball is never swept by the secondary', async () => {
    await planTargets(env, at(12));
    await env.DB.prepare(
      "UPDATE ingest_targets SET next_run_at = ?1 WHERE id <> 'ncaab:date:20261107'",
    )
      .bind(at(12) + 30 * HOUR)
      .run();
    espn.set('20261107', [cbb('401918948')]);
    const stats = await runRefresh(env, at(12), 5);
    expect(stats.targetsProcessed).toBe(1);
    expect(stats.offTheBoard).toBe(1);
    expect(stats.warnings).toEqual([]);
    expect(stats.secondary.sweeps.map((s) => s.league)).not.toContain('ncaab');
    expect(stats.secondary.sweeps.map((s) => s.league)).not.toContain('nba');
    expect(SECONDARY_LEAGUES).toEqual(['nfl', 'ncaaf']);
  });
});

/* ------------------------------------------------------------------ *
 * Betting is OPEN (M13d) — and the kill switch that can close it
 * ------------------------------------------------------------------ */

describe('M13c/M13d: the kill switches, the teaser refusal and settlement', () => {
  it('LEAGUE_BETTING_OPEN is true for both (M13d): a fresh card is bettable and a straight places', async () => {
    expect(LEAGUE_BETTING_OPEN.ncaab).toBe(true);
    expect(LEAGUE_BETTING_OPEN.nba).toBe(true);
    const { cookie } = await registerAccount();
    const now = Date.now();
    for (const league of ['ncaab', 'nba'] as const) {
      const id = `${league}:o${String(seq)}`;
      await seedGameWithLine(env.DB, {
        id,
        league,
        season: 2027,
        week: null,
        kickoffAt: now + 2 * HOUR,
        lastSeenAt: now,
      });
      const res = await get(`/api/games/${encodeURIComponent(id)}`, cookie);
      expect((await res.json<{ game: GameCard }>()).game.bettable).toBe(true);
      const req: PlaceBetRequest = {
        league,
        betType: 'straight',
        stakeCents: 1000,
        legs: [{ gameId: id, market: 'spread', side: 'home' }],
      };
      const placed = await post('/api/bets', req, cookie);
      expect(placed.status, await placed.clone().text()).toBe(201);
    }
  });

  it('the kill switch still works: closed, the board is read-only and placement → 409', async () => {
    const { cookie } = await registerAccount();
    const now = Date.now();
    const cbbId = `ncaab:k${String(seq)}`;
    const nbaId = `nba:k${String(seq)}`;
    await withBasketballClosed(async () => {
      for (const [id, league] of [
        [cbbId, 'ncaab'],
        [nbaId, 'nba'],
      ] as const) {
        await seedGameWithLine(env.DB, {
          id,
          league,
          season: 2027,
          week: null,
          kickoffAt: now + 2 * HOUR,
          lastSeenAt: now,
        });
        const res = await get(`/api/games/${encodeURIComponent(id)}`, cookie);
        const card = (await res.json<{ game: GameCard }>()).game;
        expect(card.league).toBe(league);
        expect(card.lines?.stale).toBe(false);
        expect(card.bettable).toBe(false);
        const req: PlaceBetRequest = {
          league,
          betType: 'straight',
          stakeCents: 1000,
          legs: [{ gameId: id, market: 'spread', side: 'home' }],
        };
        const placed = await post('/api/bets', req, cookie);
        expect(placed.status).toBe(409);
        expect((await placed.json<ApiErrorBody>()).error.code).toBe('GAME_NOT_BETTABLE');
      }
    });
  });

  it('basketball legs cannot be teased: 400 TEASER_INVALID with betting open', async () => {
    expect(TEASABLE_LEAGUES).toEqual(['nfl', 'ncaaf']);
    const { cookie } = await registerAccount();
    const now = Date.now();
    const a = `nba:t${String(seq)}a`;
    const b = `nba:t${String(seq)}b`;
    for (const id of [a, b]) {
      await seedGameWithLine(env.DB, {
        id,
        league: 'nba',
        week: null,
        kickoffAt: now + 2 * HOUR,
        lastSeenAt: now,
      });
    }
    {
      const res = await post(
        '/api/bets',
        {
          league: 'nba',
          betType: 'teaser',
          teaserPoints: 60,
          stakeCents: 1000,
          legs: [
            { gameId: a, market: 'spread', side: 'home' },
            { gameId: b, market: 'spread', side: 'home' },
          ],
        },
        cookie,
      );
      expect(res.status, await res.clone().text()).toBe(400);
      expect((await res.json<ApiErrorBody>()).error.code).toBe('TEASER_INVALID');
    }
  });

  it('a final settles on every market, overtime included and a NULL period included (FULL_ACTION)', async () => {
    const user = await registerAccount();
    const now = Date.now();
    const cbbId = `ncaab:s${String(seq)}`;
    const nbaId = `nba:s${String(seq)}`;
    const nbaNull = `nba:s${String(seq)}n`;
    for (const [id, league] of [
      [cbbId, 'ncaab'],
      [nbaId, 'nba'],
      [nbaNull, 'nba'],
    ] as const) {
      await seedGameWithLine(
        env.DB,
        { id, league, season: 2027, week: null, kickoffAt: now + 2 * HOUR, lastSeenAt: now },
        // A basketball-sized total (2225 tenths = 222.5 points).
        { totalTenths: 2225 },
      );
    }
    const bets = await (async () => {
      const place = (req: PlaceBetRequest) => placeBet(env, user.id, req, now);
      // College spread home −3.5, NBA over 222.5, NBA moneyline home.
      const spread = await place({
        league: 'ncaab',
        betType: 'straight',
        stakeCents: 1000,
        legs: [{ gameId: cbbId, market: 'spread', side: 'home' }],
      });
      const over = await place({
        league: 'nba',
        betType: 'straight',
        stakeCents: 1000,
        legs: [{ gameId: nbaId, market: 'total', side: 'over' }],
      });
      const parlay = await place({
        league: 'mixed',
        betType: 'parlay',
        stakeCents: 1000,
        legs: [
          { gameId: cbbId, market: 'moneyline', side: 'home' },
          { gameId: nbaNull, market: 'moneyline', side: 'away' },
        ],
      });
      return { spread: spread.bet, over: over.bet, parlay: parlay.bet };
    })();
    expect(bets.parlay.league).toBe('mixed');
    // College: one overtime (period 3), home by 5 — covers −3.5.
    await updateGame(env.DB, cbbId, { status: 'final', homeScore: 81, awayScore: 76, period: 3 });
    // NBA: double overtime (period 6), 118–112 = 230 > 222.5 — the over wins
    // ONLY because overtime counts.
    await updateGame(env.DB, nbaId, { status: 'final', homeScore: 118, awayScore: 112, period: 6 });
    // NBA with no period at all: still graded (no `undecidable` row), away wins.
    await updateGame(env.DB, nbaNull, {
      status: 'final',
      homeScore: 100,
      awayScore: 104,
      period: null,
    });
    await runSettle(env, now + 6 * HOUR, 200);
    const row = (id: string) =>
      env.DB.prepare('SELECT status, payout_cents, potential_payout_cents FROM bets WHERE id = ?1')
        .bind(id)
        .first<{ status: string; payout_cents: number; potential_payout_cents: number }>();
    for (const bet of [bets.spread, bets.over, bets.parlay]) {
      const r = await row(bet.id);
      expect(r?.status, bet.id).toBe('won');
      expect(r?.payout_cents).toBe(r?.potential_payout_cents);
    }
    expect(await bankrollDrift(env.DB)).toEqual([]);
    const bk = await mainBankrollId(env.DB, user.id);
    const bal = await env.DB.prepare('SELECT balance_cents AS b FROM bankrolls WHERE id = ?1')
      .bind(bk)
      .first<{ b: number }>();
    expect(bal?.b).toBeGreaterThan(INITIAL_BANKROLL_CENTS);
  });
});

/* ------------------------------------------------------------------ *
 * The postponed void (§24.11): MLB's next-day evidence rule, by league
 * ------------------------------------------------------------------ */

describe('M13c: the next-day postponed void (PLAN.md §24.11)', () => {
  const CONFIRM_AT = DAY.endAt + MLB_POSTPONED_CONFIRM_MS; // 03:00 ET on 11-08
  const MAINTENANCE_AT = Date.parse('2026-11-08T08:30:00Z');

  async function seedPostponed(id: string, league: League, lastRunAt: number): Promise<void> {
    await seedGame(env.DB, {
      id,
      league,
      week: league === 'nfl' || league === 'ncaaf' ? 9 : null,
      kickoffAt: at(19),
      status: 'postponed',
      lastSeenAt: at(22),
    });
    await env.DB.prepare(
      `INSERT INTO ingest_targets
         (id, league, kind, key, window_start_at, window_end_at, priority, next_run_at,
          last_run_at, last_status, consecutive_failures, created_at, updated_at)
       VALUES (?1, ?2, 'date', '20261107', ?3, ?4, 100, ?5, ?6, 'ok', 0, ?3, ?3)
       ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at`,
    )
      .bind(`${league}:date:20261107`, league, DAY.startAt, DAY.endAt, lastRunAt + HOUR, lastRunAt)
      .run();
  }

  it('the SQL league list is exactly the leagues postponedVoidConfirmAt covers', () => {
    const covered = LEAGUES.filter((l) => postponedVoidConfirmAt(l, DAY.endAt) !== null);
    expect([...NEXT_DAY_VOID_LEAGUES].sort()).toEqual([...covered].sort());
    expect(postponedVoidConfirmAt('ncaab', DAY.endAt)).toBe(CONFIRM_AT);
  });

  it('postponed NCAAB and NBA games with a post-day OK fetch are canceled, naming the league; MLB unchanged', async () => {
    const ids = {
      ncaab: `ncaab:pv${String(seq)}`,
      nba: `nba:pv${String(seq)}`,
      mlb: `mlb:pv${String(seq)}`,
      nfl: `nfl:pv${String(seq)}`,
    };
    for (const [league, id] of Object.entries(ids) as [League, string][]) {
      await seedPostponed(id, league, CONFIRM_AT);
    }
    const stats = await runMaintenance(env, MAINTENANCE_AT);
    expect(await gameRow(ids.ncaab)).toMatchObject({
      status: 'canceled',
      status_detail: 'auto-void: NCAAB postponed, not played on its date',
    });
    expect(await gameRow(ids.nba)).toMatchObject({
      status: 'canceled',
      status_detail: 'auto-void: NBA postponed, not played on its date',
    });
    // MLB's string is byte-identical to before M13c.
    expect(await gameRow(ids.mlb)).toMatchObject({
      status: 'canceled',
      status_detail: 'auto-void: MLB postponed, not played on its date',
    });
    // Football keeps the 7-day rule only.
    expect((await gameRow(ids.nfl))['status']).toBe('postponed');
    expect(stats.autoVoidedGames).toEqual(expect.arrayContaining([ids.ncaab, ids.nba, ids.mlb]));
  });

  it('evidence one millisecond early is not evidence (the rain-delay twin: a delayed tip)', async () => {
    const id = `nba:pe${String(seq)}`;
    await seedPostponed(id, 'nba', CONFIRM_AT - 1);
    expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(id);
    expect((await gameRow(id))['status']).toBe('postponed');
  });

  it('computeNextRunAt caps a basketball target holding a postponed game at the confirm instant', async () => {
    await planTargets(env, at(12));
    const target = await readTarget('ncaab:date:20261107');
    const slate = makeSlate([cbb('p1', { status: 'postponed' })], 'ncaab', at(22, 40));
    // Without the cap the discovery tier would put it at 04:40 ET, after maintenance.
    expect(computeNextRunAt(target, slate, false, at(22, 40))).toBe(CONFIRM_AT);
  });
});

/* ------------------------------------------------------------------ *
 * The dormant per-conference switch (§24.8)
 * ------------------------------------------------------------------ */

describe('M13c: the per-conference switch ships DORMANT (PLAN.md §24.8)', () => {
  it('is OFF: the default planner emits full targets only', async () => {
    expect(NCAAB_TARGET_SHAPE).toBe('full');
    await planTargets(env, at(12));
    expect(await targetIds('ncaab')).toHaveLength(3);
  });

  it("'conference': 32 segments per date with conference_id, the full targets deleted, groups=<id> URLs", async () => {
    await planTargets(env, at(12)); // the full targets exist first
    const created = await planTargets(env, at(12), 'conference');
    expect(created).toBe(3 * CBB_CONFERENCES.length);
    const ids = await targetIds('ncaab');
    expect(ids).toHaveLength(3 * CBB_CONFERENCES.length);
    expect(ids).not.toContain('ncaab:date:20261107');
    expect(ids).toContain(segmentTargetId('23', '20261107'));
    const seg = await readTarget(segmentTargetId('23', '20261107'));
    expect(seg).toMatchObject({ key: '20261107', conferenceId: '23' });
    expect(toSlateTarget(seg)).toEqual({ kind: 'date', dateKey: '20261107', conferenceId: '23' });
    expect(buildScoreboardUrl('https://espn.test', 'ncaab', toSlateTarget(seg))).toContain(
      'scoreboard?groups=23&limit=500&dates=20261107',
    );
    // Every other league is untouched by the switch.
    expect(await targetIds('nba')).toEqual(['nba:date:20261107', 'nba:date:20261108']);
  });

  it("'conference': bumpTargetForGame bumps the game's conference segment(s), or every segment when both ids are NULL", async () => {
    await planTargets(env, at(12), 'conference');
    await seedGame(env.DB, {
      id: 'ncaab:bump1',
      league: 'ncaab',
      week: null,
      kickoffAt: at(19),
      homeConferenceId: '2',
      awayConferenceId: '23',
    });
    await seedGame(env.DB, { id: 'ncaab:bump2', league: 'ncaab', week: null, kickoffAt: at(20) });
    const due = async () =>
      (
        await env.DB.prepare(
          "SELECT id FROM ingest_targets WHERE next_run_at = 0 AND league = 'ncaab' ORDER BY id",
        ).all<{ id: string }>()
      ).results.map((r) => r.id);
    expect(await bumpTargetForGame(env, 'ncaab:bump1', at(12), 'conference')).not.toBeNull();
    expect(await due()).toEqual(
      [segmentTargetId('23', '20261107'), segmentTargetId('2', '20261107')].sort(),
    );
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = 1').run();
    await bumpTargetForGame(env, 'ncaab:bump2', at(12), 'conference');
    expect(await due()).toHaveLength(CBB_CONFERENCES.length);
    // The full shape bumps the one date target, as before.
    await planTargets(env, at(12));
    const full = await bumpTargetForGame(env, 'ncaab:bump1', at(12), 'full');
    expect(full).toEqual({ targetId: 'ncaab:date:20261107' });
  });

  it("'conference': a FUTURE date's segment runs on the discovery tier; today's keeps the 60-minute one", async () => {
    await planTargets(env, at(12), 'conference');
    const tomorrow = await readTarget(segmentTargetId('2', '20261108'));
    const today = await readTarget(segmentTargetId('2', '20261107'));
    const now = at(12);
    const base = now - (now % REFRESH_TICK_MS);
    const soonGame = (kickoffAt: number) => makeSlate([cbb('f1', { kickoffAt })], 'ncaab', now);
    // Tomorrow 11:00 ET is within 48 h: a full target would be on the soon tier.
    expect(computeNextRunAt(tomorrow, soonGame(at(35)), false, now)).toBe(
      base + REFRESH_DISCOVERY_TICKS * REFRESH_TICK_MS,
    );
    // Today's segment with a game in 5 h stays on the soon tier (20 ticks).
    expect(computeNextRunAt(today, soonGame(at(17)), false, now)).toBe(base + 20 * REFRESH_TICK_MS);
    // A full (conference-less) target for tomorrow is unchanged by the rule.
    const fullTomorrow = { ...tomorrow, id: 'ncaab:date:20261108', conferenceId: null };
    expect(computeNextRunAt(fullTomorrow, soonGame(at(35)), false, now)).toBe(
      base + 20 * REFRESH_TICK_MS,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The write budget (§24.13)
 * ------------------------------------------------------------------ */

describe('M13c: the write budget at the 3-minute tick (PLAN.md §24.13)', () => {
  /**
   * A synthetic slate driven through all 480 ticks of a day: games tip in
   * waves, each live `liveTicks` ticks with the clock moving on EVERY tick
   * (as in the CFB soak), then final. Returns the summed rows_written, which
   * an `env.DB.batch` probe cross-checks.
   */
  async function soak(
    league: 'ncaab' | 'nba',
    games: number,
    wavesEt: readonly number[],
    liveTicks: number,
  ): Promise<{ rows: number; probe: number; live: number }> {
    const TICKS = (24 * HOUR) / REFRESH_TICK_MS;
    const tips = wavesEt.map((h) => at(h));
    const base: EventSpec[] = Array.from({ length: games }, (_, i) => ({
      eventId: `${league}-${String(i)}`,
      league,
      kickoffAt: tips[i % tips.length] ?? at(19),
      status: 'pre' as const,
      homeAbbr: `H${String(i)}`,
      awayAbbr: `A${String(i)}`,
      season: 2027,
      homeScore: 0,
      awayScore: 0,
      period: 0,
      displayClock: '0:00',
      ...(league === 'ncaab' ? { homeConferenceId: '2', awayConferenceId: '23' } : {}),
      odds: {
        spreadHome: -6.5,
        total: league === 'nba' ? 224.5 : 145.5,
        mlHome: -250,
        mlAway: 205,
      },
    }));
    const periods = league === 'nba' ? 4 : 2;
    const specAt = (tick: number, i: number): EventSpec => {
      const e = base[i];
      if (e === undefined) throw new Error('no game');
      const elapsedTicks = (DAY_START + tick * REFRESH_TICK_MS - e.kickoffAt) / REFRESH_TICK_MS;
      if (elapsedTicks < 0) return e;
      if (elapsedTicks >= liveTicks) {
        return { ...e, status: 'post', period: periods, homeScore: 80, awayScore: 74 };
      }
      const per = liveTicks / periods;
      const period = (elapsedTicks - (elapsedTicks % per)) / per + 1;
      return {
        ...e,
        status: 'in',
        period,
        // THE CLOCK MOVES EVERY TICK.
        displayClock: `${String(19 - (tick % 19))}:${String(10 + (tick % 50))}`,
        homeScore: 2 * elapsedTicks,
        awayScore: 2 * elapsedTicks - 1,
      };
    };
    const probe = probeBatchRows();
    let rows = 0;
    let live = 0;
    try {
      for (let tick = 0; tick < TICKS; tick += 1) {
        const now = DAY_START + tick * REFRESH_TICK_MS;
        const specs = base.map((_, i) => specAt(tick, i));
        live += specs.filter((s) => s.status === 'in').length;
        rows += (await upsertSlate(env, makeSlate(specs, league, now), now)).rowsWritten;
      }
    } finally {
      probe.restore();
    }
    return { rows, probe: probe.rows, live };
  }

  it('155 CBB games, six tip-off waves, 40 live ticks each: < 16,000 rows (the 9,400 model × 1.68)', async () => {
    const r = await soak('ncaab', 155, [12, 14, 16, 18, 19, 21], 40);
    expect(r.live).toBe(155 * 40);
    expect(r.rows).toBe(r.probe);
    // MEASURED (M13c, miniflare D1, this fixture, 2026-11-07): 12,032 rows —
    // above §24.13's 9,400 model (the fixture moves the score every tick, so
    // the line-free (B) row is the whole live stream) and under its 16,000
    // bound. Re-derive §24.13 if this fails; never raise it to fit.
    console.log(`[basketball soak] ncaab 155 games, 480 ticks: ${String(r.rows)} rows written`);
    expect(r.rows).toBeLessThan(16_000);
    expect(r.rows).toBeGreaterThan(155 * 40); // every live tick wrote its (B) row
  }, 300_000);

  it('a 15-game NBA night, 19:00 and 22:00 ET waves, 50 live ticks each: < 1,800 rows', async () => {
    const r = await soak('nba', 15, [19, 22], 50);
    // The 22:00 wave's last 10 live ticks fall after midnight, outside this
    // day's 480: 8 games × 50 + 7 games × 40 live game-ticks today.
    expect(r.live).toBe(8 * 50 + 7 * 40);
    expect(r.rows).toBe(r.probe);
    // MEASURED (M13c, this fixture): 1,295 rows, under §24.13's 1,800.
    console.log(`[basketball soak] nba 15 games, 480 ticks: ${String(r.rows)} rows written`);
    expect(r.rows).toBeLessThan(1_800);
    expect(r.rows).toBeGreaterThan(15 * 50);
  }, 120_000);
});
