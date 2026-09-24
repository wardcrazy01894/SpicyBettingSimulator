/**
 * MLB against a real D1 — ingest, the postponed-game void and its race,
 * settlement of shortened games, placement. PLAN.md §23.13.
 *
 * Written FIRST as `it.todo` contracts. M12a's describe (ingest, the board,
 * the betting gate, the secondary exclusion) is real from M12a — it needs
 * migration 0009's widened `league` CHECKs, which ship in the same PR. M12b
 * discharged the rest: the postponed void and its race, canceled-terminal,
 * shortened-game settlement and placement with MLB betting OPEN. The file is
 * the permanent home of these cases, not a staging area.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FULL_ACTION, gameAction, postponedVoidConfirmAt } from '../../src/shared/action.js';
import type {
  BetResponse,
  BetsResponse,
  ConfigResponse,
  GameCard,
  GamesResponse,
  PlaceBetRequest,
  UserResponse,
} from '../../src/shared/api-types.js';
import {
  INITIAL_BANKROLL_CENTS,
  MAX_SETTLE_ATTEMPTS,
  MLB_POSTPONED_CONFIRM_MS,
  VOID_AFTER_MS,
} from '../../src/shared/constants.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { boardWindowEnd, etDateKey, etDateKeyRange, etDayBounds } from '../../src/shared/time.js';
import type { League } from '../../src/shared/types.js';
import { LEAGUE_BETTING_OPEN, placeBet } from '../../src/worker/bets.js';
import { buildScoreboardUrl, EspnProvider } from '../../src/worker/espn.js';
import {
  computeNextRunAt,
  ingestTarget,
  planTargets,
  runRefresh,
  upsertSlate,
} from '../../src/worker/ingest.js';
import type { IngestTargetRow } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import { runMaintenance } from '../../src/worker/maintenance.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import { loadLegsForBets, runSettle } from '../../src/worker/settle.js';
import { buildScoreboard, stubEspn, stubOddsApi } from './fixtures.js';
import type { EspnStub, EventSpec, OddsApiStub } from './fixtures.js';
import {
  bankrollDrift,
  fullLine,
  ledgerSum,
  mainBankrollId,
  seedGame,
  seedGameWithLine,
  seedLine,
  updateGame,
} from './seed.js';

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Thursday 2026-09-24, 00:00 ET — the MLB day the write-budget test drives. */
const DAY_START = etDayBounds(Date.parse('2026-09-24T16:00:00Z')).startAt;

let espn: EspnStub;
let odds: OddsApiStub;
let seq = 0;

beforeEach(async () => {
  espn = stubEspn({});
  odds = stubOddsApi();
  seq += 1;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_lines'),
    env.DB.prepare('DELETE FROM games WHERE id NOT IN (SELECT game_id FROM bet_legs)'),
    env.DB.prepare('DELETE FROM ingest_targets'),
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
    env.DB.prepare(
      `UPDATE secondary_budget SET remaining_credits = 500, checked_at = 0, last_attempt_at = 0,
         nfl_last_sweep_at = 0, ncaaf_last_sweep_at = 0, cooldown_until = 0,
         consecutive_failures = 0, last_status = NULL, last_error = NULL, updated_at = 0 WHERE id = 1`,
    ),
  ]);
});

afterEach(() => {
  odds.restore();
  espn.restore();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function send(path: string, init: RequestInit): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, env));
}
function get(path: string, cookie?: string): Promise<Response> {
  return send(path, cookie === undefined ? { method: 'GET' } : { headers: { cookie } });
}
function post(path: string, payload: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-SBS-Client': '1',
  };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return send(path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

async function register(): Promise<string> {
  const res = await post('/api/auth/signup', {
    username: `mlb${String(seq)}x${String(Date.now() % 100_000)}`,
    dk: 'a'.repeat(64),
    inviteCode: INVITE,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  await res.json<UserResponse>();
  return /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
}

function makeSlate(specs: readonly EventSpec[], league: League, fetchedAt: number): ProviderSlate {
  const parsed = parseScoreboard(buildScoreboard(specs), league, fetchedAt);
  return {
    games: parsed.games,
    lines: parsed.lines,
    warnings: parsed.warnings,
    fetchedAt,
    season: parsed.season,
    week: parsed.week,
  };
}

/** Independent witness of `meta.rows_written` (the ingest.spec.ts probe, verbatim in spirit). */
function probeBatchRows(): { readonly rows: number; restore(): void } {
  const realBatch = env.DB.batch.bind(env.DB);
  let rows = 0;
  env.DB.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const results = await realBatch<T>(statements);
    for (const r of results) {
      const meta: { rows_written?: unknown; changes?: unknown } = r.meta;
      rows +=
        typeof meta.rows_written === 'number'
          ? meta.rows_written
          : typeof meta.changes === 'number'
            ? meta.changes
            : 0;
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

/**
 * Close the MLB kill switch for one test (M12b opened it). The constant is
 * `Readonly` for production code; a test flips it through a cast and MUST
 * restore it in a `finally`.
 */
function closeMlb(): () => void {
  const gate = LEAGUE_BETTING_OPEN as Record<League, boolean>;
  gate.mlb = false;
  return () => {
    gate.mlb = true;
  };
}

const targetIds = async (league: League): Promise<string[]> =>
  (
    await env.DB.prepare('SELECT id FROM ingest_targets WHERE league = ? ORDER BY id')
      .bind(league)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

/* ------------------------------------------------------------------ *
 * M12a
 * ------------------------------------------------------------------ */

describe('M12a — ingest and the board', () => {
  it('buildScoreboardUrl(base, "mlb", date) is /sports/baseball/mlb/scoreboard?dates=D&limit=100', () => {
    expect(
      buildScoreboardUrl('https://espn.test', 'mlb', { kind: 'date', dateKey: '20260929' }),
    ).toBe(
      'https://espn.test/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260929&limit=100',
    );
    expect(
      buildScoreboardUrl('https://espn.test/', 'mlb', { kind: 'date', dateKey: '20260929' }),
    ).not.toContain('seasontype');
  });

  it('buildScoreboardUrl for nfl and ncaaf is byte-identical to before the table', () => {
    // The literals the pre-M12a ternary produced, byte for byte.
    expect(
      buildScoreboardUrl('https://site.api.espn.com', 'nfl', { kind: 'date', dateKey: '20260913' }),
    ).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913&limit=100',
    );
    expect(
      buildScoreboardUrl('https://site.api.espn.com/', 'ncaaf', {
        kind: 'date',
        dateKey: '20260912',
      }),
    ).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates=20260912',
    );
  });

  it('planTargets creates exactly ONE mlb:date:<today ET> target per run, idempotently', async () => {
    const now = DAY_START + 12 * HOUR;
    await planTargets(env, now);
    expect(await targetIds('mlb')).toEqual([`mlb:date:${etDateKey(now)}`]);
    expect(await targetIds('mlb')).toEqual(['mlb:date:20260924']);
    await planTargets(env, now + 15 * MIN);
    await planTargets(env, now + 11 * HOUR);
    expect(await targetIds('mlb')).toEqual(['mlb:date:20260924']);
    const t = await env.DB.prepare(
      "SELECT window_start_at AS s, window_end_at AS e FROM ingest_targets WHERE id = 'mlb:date:20260924'",
    ).first<{ s: number; e: number }>();
    expect(t).toEqual({ s: DAY_START, e: etDayBounds(now).endAt });
  });

  it(
    'planTargets on a Tuesday creates 7 + 7 + 1 = 15; on a Sunday night 9 + 9 + 1 = 19 ' +
      '(counts computed by the test from boardWindowEnd, asserted against these literals)',
    async () => {
      const planned = (now: number): number =>
        (['nfl', 'ncaaf', 'mlb'] as const)
          .map((l) => etDateKeyRange(now, boardWindowEnd(l, now)).length)
          .reduce((a, b) => a + b, 0);
      const tue = Date.parse('2026-09-15T16:00:00Z'); // Tue 12:00 ET
      expect(planned(tue)).toBe(15);
      expect(await planTargets(env, tue)).toBe(15);
      await env.DB.prepare('DELETE FROM ingest_targets').run();
      const sunNight = Date.parse('2026-09-21T01:00:00Z'); // Sun 21:00 ET
      expect(planned(sunNight)).toBe(19);
      expect(await planTargets(env, sunNight)).toBe(19);
    },
  );

  it('at 00:00 ET the next day’s MLB target is created and yesterday’s is NOT deleted', async () => {
    const endOfDay = etDayBounds(DAY_START).endAt;
    await planTargets(env, endOfDay - 1);
    expect(await targetIds('mlb')).toEqual(['mlb:date:20260924']);
    await planTargets(env, endOfDay);
    expect(await targetIds('mlb')).toEqual(['mlb:date:20260924', 'mlb:date:20260925']);
  });

  it(
    'WRITE BUDGET: an MLB day of 15 games over 96 refreshes (scheduled → live with the score ' +
      'and period moving on every refresh → final) writes < 1,000 rows (§23.11; measured value ' +
      'recorded in the PR), cross-checked against an env.DB.batch probe',
    async () => {
      // §23.11's model: 15 games, staggered first pitches like a real slate
      // (the CFB test's waves), each live for ~3 h = 12 of the 96 refreshes,
      // with the score AND the inning moving on EVERY live refresh. The
      // displayClock never moves — ESPN's MLB clock is always "0:00" (§23.2).
      const GAMES = 15;
      const REFRESHES = 96;
      const LIVE_MS = 3 * HOUR;
      /** First pitches, ET: 12:05 13:05 16:05 19:05 20:05, three games each. */
      const WAVES = [12, 13, 16, 19, 20].map((h) => DAY_START + h * HOUR + 5 * MIN);
      const kickoffOf = (i: number): number => WAVES[i % WAVES.length] ?? DAY_START;
      const base: EventSpec[] = Array.from({ length: GAMES }, (_, i) => ({
        eventId: `mlb-${String(i)}`,
        league: 'mlb' as const,
        kickoffAt: kickoffOf(i),
        status: 'pre' as const,
        homeAbbr: `H${String(i)}`,
        awayAbbr: `A${String(i)}`,
        homeScore: 0,
        awayScore: 0,
        period: 1,
        displayClock: '0:00',
        // A run line, a whole-number total and a moneyline, as DraftKings posts.
        odds: { spreadHome: -1.5, total: 8, mlHome: -140, mlAway: 120 },
      }));
      const at = (run: number, i: number): EventSpec => {
        const e = base[i];
        if (e === undefined) throw new Error('no game');
        const elapsed = DAY_START + run * 15 * MIN - e.kickoffAt;
        if (elapsed < 0) return e;
        if (elapsed >= LIVE_MS) {
          return { ...e, status: 'post', period: 9, homeScore: 6, awayScore: 4 };
        }
        const liveRun = elapsed / (15 * MIN); // an integer: kickoffs are on the grid + 5 min
        const step = liveRun - (liveRun % 1);
        return {
          ...e,
          status: 'in',
          // The inning AND the score move on every live refresh — the worst case.
          period: step + 1,
          displayClock: '0:00',
          homeScore: step,
          awayScore: step,
        };
      };

      const probe = probeBatchRows();
      let rowsWritten = 0;
      let liveRefreshes = 0;
      try {
        for (let run = 0; run < REFRESHES; run += 1) {
          const now = DAY_START + run * 15 * MIN;
          const specs = base.map((_, i) => at(run, i));
          liveRefreshes += specs.filter((e) => e.status === 'in').length;
          const res = await upsertSlate(env, makeSlate(specs, 'mlb', now), now);
          rowsWritten += res.rowsWritten;
        }
      } finally {
        probe.restore();
      }
      // The model is what §23.11 says it is: ~12 live refreshes per game.
      expect(liveRefreshes).toBe(GAMES * 12);
      expect(rowsWritten).toBe(probe.rows);
      // THE GUARD. Re-derive §23.11 if this fails; never raise it to fit.
      // MEASURED on this exact fixture (miniflare D1, summed meta.rows_written,
      // 2026-09-24): 684 rows — against §23.11's ≈ 850 estimate for the games
      // stream, which assumed more line-price moves than this fixture makes.
      expect(rowsWritten).toBeLessThan(1_000);
      // ...and not trivially small: every live change landed.
      expect(rowsWritten).toBeGreaterThan(GAMES * 12);
      const finals = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM games WHERE league = 'mlb' AND status = 'final' AND period = 9",
      ).first<{ n: number }>();
      expect(finals?.n).toBe(GAMES);
    },
  );

  // 'the CFB-Saturday < 5,000 regression still passes unchanged beside it' —
  // discharged by tests/worker/ingest.spec.ts, which owns that test and is not
  // modified by M12a (a copy here would be a second guard to keep in sync).

  it('GET /api/games?league=mlb defaults to now − 12 h … the end of TODAY ET', async () => {
    const cookie = await register();
    const now = Date.now();
    const end = boardWindowEnd('mlb', now);
    expect(end).toBe(etDayBounds(now).endAt - 1);
    const id = (k: string): string => `mlb:w${String(seq)}-${k}`;
    await seedGame(env.DB, { id: id('late'), league: 'mlb', week: null, kickoffAt: end - MIN });
    await seedGame(env.DB, {
      id: id('tomorrow'),
      league: 'mlb',
      week: null,
      kickoffAt: end + HOUR,
    });
    await seedGame(env.DB, {
      id: id('old'),
      league: 'mlb',
      week: null,
      kickoffAt: now - 13 * HOUR,
      status: 'final',
    });
    const res = await get('/api/games?league=mlb&season=2026', cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const ids = (await res.json<GamesResponse>()).games.map((g) => g.id);
    expect(ids).toContain(id('late'));
    expect(ids).not.toContain(id('tomorrow'));
    expect(ids).not.toContain(id('old'));
  });

  it('an MLB game with a fresh line is bettable: false while LEAGUE_BETTING_OPEN.mlb is false', async () => {
    // M12b opened MLB; the switch stays as a kill switch, so close it here.
    expect(LEAGUE_BETTING_OPEN.mlb).toBe(true);
    const restore = closeMlb();
    try {
      await bettableFalseWhileClosed();
    } finally {
      restore();
    }
  });

  async function bettableFalseWhileClosed(): Promise<void> {
    const cookie = await register();
    const now = Date.now();
    const mlb = `mlb:b${String(seq)}`;
    const nfl = `nfl:b${String(seq)}`;
    await seedGameWithLine(
      env.DB,
      { id: mlb, league: 'mlb', week: null, kickoffAt: now + 2 * HOUR, lastSeenAt: now },
      { spreadHomeTenths: -15, spreadAwayTenths: 15, totalTenths: 85, seenAt: now },
    );
    await seedGameWithLine(env.DB, { id: nfl, kickoffAt: now + 2 * HOUR, lastSeenAt: now });
    const card = async (gameId: string): Promise<GameCard> =>
      (
        await (
          await get(`/api/games/${encodeURIComponent(gameId)}`, cookie)
        ).json<{
          game: GameCard;
        }>()
      ).game;
    const m = await card(mlb);
    expect(m.league).toBe('mlb');
    expect(m.lines).not.toBeNull();
    expect(m.lines?.stale).toBe(false);
    expect(m.bettable).toBe(false);
    // The control: the same game shape in an open league IS bettable.
    expect((await card(nfl)).bettable).toBe(true);
  }

  it('POST /api/bets with an MLB leg → 409 GAME_NOT_BETTABLE while the gate is closed', async () => {
    const restore = closeMlb();
    try {
      await refusedWhileClosed();
    } finally {
      restore();
    }
  });

  async function refusedWhileClosed(): Promise<void> {
    const cookie = await register();
    const now = Date.now();
    const mlb = `mlb:p${String(seq)}`;
    const nfl = `nfl:p${String(seq)}`;
    await seedGameWithLine(env.DB, {
      id: mlb,
      league: 'mlb',
      week: null,
      kickoffAt: now + 2 * HOUR,
      lastSeenAt: now,
    });
    await seedGameWithLine(env.DB, { id: nfl, kickoffAt: now + 2 * HOUR, lastSeenAt: now });
    const straight: PlaceBetRequest = {
      league: 'mlb',
      betType: 'straight',
      stakeCents: 1000,
      legs: [{ gameId: mlb, market: 'moneyline', side: 'home' }],
    };
    const one = await post('/api/bets', straight, cookie);
    expect(one.status, await one.clone().text()).toBe(409);
    expect((await one.json<ApiErrorBody>()).error.code).toBe('GAME_NOT_BETTABLE');
    // A cross-sport parlay is refused the same way, and no money moved.
    const parlay: PlaceBetRequest = {
      league: 'mixed',
      betType: 'parlay',
      stakeCents: 1000,
      legs: [
        { gameId: nfl, market: 'moneyline', side: 'home' },
        { gameId: mlb, market: 'moneyline', side: 'home' },
      ],
    };
    const two = await post('/api/bets', parlay, cookie);
    expect(two.status).toBe(409);
    expect((await two.json<ApiErrorBody>()).error.code).toBe('GAME_NOT_BETTABLE');
    const legs = await env.DB.prepare('SELECT COUNT(*) AS n FROM bet_legs WHERE game_id = ?')
      .bind(mlb)
      .first<{ n: number }>();
    expect(legs?.n).toBe(0);
  }

  it('GET /api/config: leagues ends with mlb and currentSeason has an mlb key', async () => {
    const res = await get('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json<ConfigResponse>();
    expect(body.leagues.at(-1)).toBe('mlb');
    expect(Object.keys(body.currentSeason).sort()).toEqual(['mlb', 'ncaaf', 'nfl']);
    await seedGame(env.DB, {
      id: `mlb:c${String(seq)}`,
      league: 'mlb',
      week: null,
      season: 2026,
      kickoffAt: Date.now() + HOUR,
    });
    const again = await (await get('/api/config')).json<ConfigResponse>();
    expect(again.currentSeason.mlb).toBe(2026);
  });

  it(
    'runSecondary with ODDS_API_KEY set and a GAPPED scheduled MLB game makes no MLB request ' +
      'and emits no mlb entry in stats.secondary.sweeps',
    async () => {
      const now = DAY_START + 12 * HOUR; // noon ET
      const id = `mlb:s${String(seq)}`;
      await seedGame(env.DB, {
        id,
        league: 'mlb',
        week: null,
        kickoffAt: now + 7 * HOUR,
        lastSeenAt: now,
      });
      // Run line only: total and moneyline GAPPED — a football game in this
      // state is exactly what the secondary exists to fill.
      await seedLine(env.DB, {
        ...fullLine(id, now - 5 * MIN),
        spreadHomeTenths: -15,
        spreadAwayTenths: 15,
        totalTenths: null,
        totalOverPrice: null,
        totalUnderPrice: null,
        mlHomePrice: null,
        mlAwayPrice: null,
      });
      const stats = await runRefresh(env, now, 2, { forceSecondaryGameId: id });
      expect(stats.secondary.enabled).toBe(true);
      expect(stats.secondary.sweeps.map((s) => s.league)).toEqual(['nfl', 'ncaaf']);
      expect(stats.secondary.sweeps.every((s) => s.skipped === 'no-gap')).toBe(true);
      expect(odds.urls.filter((u) => u.includes('/odds?'))).toEqual([]);
      expect(odds.urls.some((u) => u.includes('baseball'))).toBe(false);
      const tried = await env.DB.prepare('SELECT secondary_tried_at AS t FROM games WHERE id = ?')
        .bind(id)
        .first<{ t: number | null }>();
      expect(tried?.t).toBeNull();
    },
  );
});

/* ------------------------------------------------------------------ *
 * M12b
 * ------------------------------------------------------------------ */

/** Tuesday 2026-09-22 (EDT) — the date of the committed rainout sample. */
const RAIN_DAY = etDayBounds(Date.parse('2026-09-22T16:00:00Z'));
/** An instant on the rain day at `h:m` ET (no DST change near this date). */
const onDay = (h: number, m = 0): number => RAIN_DAY.startAt + h * HOUR + m * MIN;
/** An instant on the NEXT ET day at `h:m` ET. */
const nextDay = (h: number, m = 0): number => RAIN_DAY.endAt + h * HOUR + m * MIN;
/** The evidence instant, 03:00 ET the morning after the rain day. */
const CONFIRM_AT = RAIN_DAY.endAt + MLB_POSTPONED_CONFIRM_MS;
/** Maintenance runs at `30 8 * * *` UTC — 04:30 EDT. */
const MAINTENANCE_AT = nextDay(4, 30);
const RAIN_TARGET = 'mlb:date:20260922';
const MLB_ML_HOME = -150;

interface Account {
  readonly cookie: string;
  readonly id: string;
}

async function registerAccount(): Promise<Account> {
  const res = await post('/api/auth/signup', {
    username: `mlbb${String(seq)}x${String(Date.now() % 1_000_000)}${String(accountSeq++)}`,
    dk: 'a'.repeat(64),
    inviteCode: INVITE,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json<UserResponse>();
  const cookie = /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
  return { cookie, id: body.user.id };
}
let accountSeq = 0;

function put(path: string, payload: unknown, cookie: string): Promise<Response> {
  return send(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-SBS-Client': '1', cookie },
    body: JSON.stringify(payload),
  });
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance_cents AS b FROM bankrolls WHERE id = ?1')
    .bind(await mainBankrollId(env.DB, userId))
    .first<{ b: number }>();
  return row?.b ?? -1;
}

async function gameRow(
  id: string,
): Promise<{ status: string; status_detail: string | null; period: number | null }> {
  const row = await env.DB.prepare('SELECT status, status_detail, period FROM games WHERE id = ?1')
    .bind(id)
    .first<{ status: string; status_detail: string | null; period: number | null }>();
  if (row === null) throw new Error(`game ${id} should exist`);
  return row;
}

interface BetRowLite {
  status: string;
  payout_cents: number | null;
  american_price: number;
  league: string;
  settle_attempts: number;
  settle_error: string | null;
}
async function betRow(id: string): Promise<BetRowLite> {
  const row = await env.DB.prepare(
    `SELECT status, payout_cents, american_price, league, settle_attempts, settle_error
       FROM bets WHERE id = ?1`,
  )
    .bind(id)
    .first<BetRowLite>();
  if (row === null) throw new Error(`bet ${id} should exist`);
  return row;
}
async function legResults(betId: string): Promise<(string | null)[]> {
  const res = await env.DB.prepare(
    'SELECT result FROM bet_legs WHERE bet_id = ?1 ORDER BY leg_index',
  )
    .bind(betId)
    .all<{ result: string | null }>();
  return res.results.map((r) => r.result);
}

/** The rain-day MLB target, read back as the planner stored it. */
async function readTarget(id: string): Promise<IngestTargetRow & { lastRunAt: number | null }> {
  const row = await env.DB.prepare(
    `SELECT id, league, kind, key, window_start_at, window_end_at, priority, next_run_at,
            consecutive_failures, last_run_at
       FROM ingest_targets WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      id: string;
      league: League;
      kind: 'week' | 'date';
      key: string;
      window_start_at: number;
      window_end_at: number;
      priority: number;
      next_run_at: number;
      consecutive_failures: number;
      last_run_at: number | null;
    }>();
  if (row === null) throw new Error(`target ${id} should exist`);
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
    lastRunAt: row.last_run_at,
  };
}

/** One fetch of the rain-day target at `now`, serving `events` (or a 500). */
async function fetchRainDay(now: number, events: readonly EventSpec[] | 'fail'): Promise<void> {
  if (events === 'fail') {
    espn.setResponder('20260922', () => new Response('upstream down', { status: 503 }), 'baseball');
  } else {
    espn.set('20260922', events);
  }
  const target = await readTarget(RAIN_TARGET);
  await ingestTarget(env, new EspnProvider(env, now), target, now);
}

/** A 19:05 ET TOR @ BAL on the rain day, event 401817035 as in the 09-22 capture. */
function rainGame(eventId: string, over: Partial<EventSpec> = {}): EventSpec {
  return {
    eventId,
    league: 'mlb',
    kickoffAt: onDay(19, 5),
    status: 'pre',
    homeAbbr: 'BAL',
    awayAbbr: 'TOR',
    period: 1,
    displayClock: '0:00',
    odds: { spreadHome: -1.5, total: 8.5, mlHome: MLB_ML_HOME, mlAway: 130 },
    ...over,
  };
}

/**
 * The rain day up to first pitch: plan the target, ingest the game with a
 * line at 15:00 ET, and place a 1000¢ straight moneyline-home bet on it.
 */
async function rainDaySetup(
  eventId: string,
): Promise<{ user: Account; betId: string; gameId: string }> {
  const gameId = `mlb:${eventId}`;
  await planTargets(env, onDay(15));
  await fetchRainDay(onDay(15), [rainGame(eventId)]);
  const user = await registerAccount();
  const req: PlaceBetRequest = {
    league: 'mlb',
    betType: 'straight',
    stakeCents: 1000,
    legs: [{ gameId, market: 'moneyline', side: 'home' }],
  };
  const { bet } = await placeBet(env, user.id, req, onDay(15, 1));
  expect(bet.americanPrice).toBe(MLB_ML_HOME);
  expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 1000);
  // 19:30 in progress; 22:40 a rain delay, which we store as `postponed`.
  await fetchRainDay(onDay(19, 30), [rainGame(eventId, { status: 'in', period: 1 })]);
  await fetchRainDay(onDay(22, 40), [
    rainGame(eventId, { status: 'postponed', period: 6, homeScore: 3, awayScore: 2 }),
  ]);
  expect((await gameRow(gameId)).status).toBe('postponed');
  return { user, betId: bet.id, gameId };
}

/** Seed a postponed game directly, plus (optionally) its date target's evidence. */
async function seedPostponed(
  id: string,
  league: League,
  evidence: { lastRunAt: number; lastStatus: 'ok' | 'error' } | null,
): Promise<void> {
  await seedGame(env.DB, {
    id,
    league,
    week: league === 'mlb' ? null : 3,
    kickoffAt: onDay(19, 5),
    status: 'postponed',
    lastSeenAt: onDay(22),
  });
  if (evidence === null) return;
  const tid = `${league}:date:20260922`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO ingest_targets
       (id, league, kind, key, window_start_at, window_end_at, priority, next_run_at,
        last_run_at, last_status, consecutive_failures, created_at, updated_at)
     VALUES (?1, ?2, 'date', '20260922', ?3, ?4, 0, ?5, ?6, ?7, 0, ?3, ?3)`,
  )
    .bind(
      tid,
      league,
      RAIN_DAY.startAt,
      RAIN_DAY.endAt,
      evidence.lastRunAt + HOUR,
      evidence.lastRunAt,
      evidence.lastStatus,
    )
    .run();
}

describe('M12b — the postponed void and the rain-delay race (maintenance)', () => {
  it(
    'postponed MLB game, its ET-date target last fetched OK at window_end + 3 h → canceled, ' +
      'named in stats.autoVoidedGames, status_detail says why',
    async () => {
      const id = `mlb:pv${String(seq)}`;
      await seedPostponed(id, 'mlb', { lastRunAt: CONFIRM_AT, lastStatus: 'ok' });
      const stats = await runMaintenance(env, MAINTENANCE_AT);
      expect(stats.autoVoidedGames).toContain(id);
      expect(await gameRow(id)).toMatchObject({
        status: 'canceled',
        status_detail: 'auto-void: MLB postponed, not played on its date',
      });
    },
  );

  it(
    'THE RACE: postponed (a delay) at 22:40 ET, target last fetched OK at 23:59 → NOT voided ' +
      'at 04:30; the 03:00 confirm fetch sees it final → never voided, bets grade normally',
    async () => {
      const eventId = `401817035${String(seq)}`;
      const { user, betId, gameId } = await rainDaySetup(eventId);
      // The planner's cap: the last unfinished game is postponed, so the tier
      // says +6 h (04:40, AFTER maintenance) — the cap pulls it to 03:00.
      expect((await readTarget(RAIN_TARGET)).nextRunAt).toBe(CONFIRM_AT);
      await fetchRainDay(onDay(23, 59), [
        rainGame(eventId, { status: 'postponed', period: 6, homeScore: 3, awayScore: 2 }),
      ]);
      expect((await readTarget(RAIN_TARGET)).nextRunAt).toBe(CONFIRM_AT);

      // Were the 03:00 fetch never made, 04:30 has no evidence: no void.
      expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(gameId);
      expect((await gameRow(gameId)).status).toBe('postponed');

      // Play resumed at 00:30 and ended 02:30; the 03:00 fetch sees the final.
      await fetchRainDay(CONFIRM_AT, [
        rainGame(eventId, { status: 'post', period: 9, homeScore: 5, awayScore: 3 }),
      ]);
      expect(await gameRow(gameId)).toMatchObject({ status: 'final', period: 9 });
      expect((await runMaintenance(env, MAINTENANCE_AT + 1)).autoVoidedGames).not.toContain(gameId);
      await runSettle(env, MAINTENANCE_AT + 5 * MIN, 200);
      const bet = await betRow(betId);
      expect(bet.status).toBe('won');
      // -150 at 1000¢ → 1666 (BigInt REPL: 1000 * 250 / 150, floored).
      expect(bet.payout_cents).toBe(1666);
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 1000 + 1666);
      expect(await bankrollDrift(env.DB)).toEqual([]);
    },
  );

  it('the confirm fetch STILL sees postponed → maintenance cancels → settle voids and refunds', async () => {
    const eventId = `401817035${String(seq)}`;
    const { user, betId, gameId } = await rainDaySetup(eventId);
    await fetchRainDay(CONFIRM_AT, [rainGame(eventId, { status: 'postponed', period: 1 })]);
    const stats = await runMaintenance(env, MAINTENANCE_AT);
    expect(stats.autoVoidedGames).toContain(gameId);
    expect((await gameRow(gameId)).status_detail).toBe(
      'auto-void: MLB postponed, not played on its date',
    );
    await runSettle(env, MAINTENANCE_AT + 5 * MIN, 200);
    expect(await betRow(betId)).toMatchObject({ status: 'void', payout_cents: 1000 });
    expect(await legResults(betId)).toEqual(['void']);
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('postponed, target last fetched at window_end + 3 h but last_status error → NOT voided', async () => {
    const id = `mlb:pe${String(seq)}`;
    await seedPostponed(id, 'mlb', { lastRunAt: CONFIRM_AT, lastStatus: 'error' });
    expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(id);
    expect((await gameRow(id)).status).toBe('postponed');
  });

  it('postponed, no ingest_targets row covers it → NOT voided (the 7-day rule still applies)', async () => {
    const id = `mlb:pn${String(seq)}`;
    await seedPostponed(id, 'mlb', null);
    expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(id);
    expect((await gameRow(id)).status).toBe('postponed');
    const week = await runMaintenance(env, onDay(19, 5) + VOID_AFTER_MS + 1);
    expect(week.autoVoidedGames).toContain(id);
    expect((await gameRow(id)).status_detail).toBe('auto-void: postponed >7d');
  });

  it('a postponed NFL / CFB game with the same evidence → NOT voided before 7 days (§7.5)', async () => {
    const nfl = `nfl:pf${String(seq)}`;
    const cfb = `ncaaf:pf${String(seq)}`;
    await seedPostponed(nfl, 'nfl', { lastRunAt: CONFIRM_AT, lastStatus: 'ok' });
    await seedPostponed(cfb, 'ncaaf', { lastRunAt: CONFIRM_AT, lastStatus: 'ok' });
    const stats = await runMaintenance(env, MAINTENANCE_AT);
    expect(stats.autoVoidedGames).not.toContain(nfl);
    expect(stats.autoVoidedGames).not.toContain(cfb);
    expect((await gameRow(nfl)).status).toBe('postponed');
    expect((await gameRow(cfb)).status).toBe('postponed');
  });

  it('the SQL instant equals postponedVoidConfirmAt("mlb", window_end_at) to the millisecond', async () => {
    const confirm = postponedVoidConfirmAt('mlb', RAIN_DAY.endAt);
    expect(confirm).toBe(CONFIRM_AT);
    const early = `mlb:ms${String(seq)}a`;
    await seedPostponed(early, 'mlb', { lastRunAt: CONFIRM_AT - 1, lastStatus: 'ok' });
    expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(early);
    // The same target, one millisecond later, is evidence.
    await env.DB.prepare('UPDATE ingest_targets SET last_run_at = ?1 WHERE id = ?2')
      .bind(CONFIRM_AT, RAIN_TARGET)
      .run();
    expect((await runMaintenance(env, MAINTENANCE_AT + 1)).autoVoidedGames).toContain(early);
  });

  it(
    'computeNextRunAt: a target whose day has ended holding a postponed game is due at ' +
      'window_end + 3 h (not +6 h), and one whose games are all final is unaffected',
    async () => {
      await planTargets(env, onDay(12));
      const target = await readTarget(RAIN_TARGET);
      const at = nextDay(0, 10); // 00:10 ET, the rain day is over
      const postponed = makeSlate([rainGame('cn1', { status: 'postponed', period: 6 })], 'mlb', at);
      expect(computeNextRunAt(target, postponed, false, at)).toBe(CONFIRM_AT);
      expect(CONFIRM_AT).toBeLessThan(at + 6 * HOUR);
      // Never sooner than the live cadence: at 02:55 the cap is +15 min, not 03:00.
      const late = CONFIRM_AT - 5 * MIN;
      expect(computeNextRunAt(target, postponed, false, late)).toBe(late + 15 * MIN);
      // Past the confirm instant the cap is spent: back to the +6 h tier.
      expect(computeNextRunAt(target, postponed, false, CONFIRM_AT)).toBe(CONFIRM_AT + 6 * HOUR);
      // All final: +24 h, uncapped.
      const done = makeSlate([rainGame('cn1', { status: 'post', period: 9 })], 'mlb', at);
      expect(computeNextRunAt(target, done, false, at)).toBe(at + 24 * HOUR);
      // Football: the same shape is uncapped (+6 h).
      const nflTarget = { ...target, id: 'nfl:date:20260922', league: 'nfl' as const };
      const nflSlate = makeSlate(
        [
          {
            ...rainGame('cn2', { status: 'postponed' }),
            league: 'nfl',
            homeAbbr: 'KC',
            awayAbbr: 'BUF',
          },
        ],
        'nfl',
        at,
      );
      expect(computeNextRunAt(nflTarget, nflSlate, false, at)).toBe(at + 6 * HOUR);
    },
  );

  it('the 7-day rule is unchanged for every league', async () => {
    const ids = (['nfl', 'ncaaf', 'mlb'] as const).map((l) => `${l}:sd${String(seq)}`);
    for (const [i, league] of (['nfl', 'ncaaf', 'mlb'] as const).entries()) {
      await seedPostponed(ids[i] ?? '', league, null);
    }
    const justUnder = await runMaintenance(env, onDay(19, 5) + VOID_AFTER_MS);
    for (const id of ids) expect(justUnder.autoVoidedGames).not.toContain(id);
    const over = await runMaintenance(env, onDay(19, 5) + VOID_AFTER_MS + 1);
    for (const id of ids) {
      expect(over.autoVoidedGames).toContain(id);
      expect((await gameRow(id)).status_detail).toBe('auto-void: postponed >7d');
    }
  });

  it(
    'A DAY LATE, NEVER WRONG (i): the confirm fetch at window_end + 3 h FAILS (last_status ' +
      'error) → not voided at that morning’s maintenance; a later OK fetch still saying ' +
      'postponed → voided at the NEXT maintenance run',
    async () => {
      const eventId = `401817035${String(seq)}`;
      const { user, betId, gameId } = await rainDaySetup(eventId);
      await fetchRainDay(CONFIRM_AT, 'fail');
      const failed = await env.DB.prepare(
        'SELECT last_status AS s, last_run_at AS r FROM ingest_targets WHERE id = ?1',
      )
        .bind(RAIN_TARGET)
        .first<{ s: string; r: number }>();
      expect(failed).toEqual({ s: 'error', r: CONFIRM_AT });
      expect((await runMaintenance(env, MAINTENANCE_AT)).autoVoidedGames).not.toContain(gameId);
      await runSettle(env, MAINTENANCE_AT + 5 * MIN, 200);
      expect((await betRow(betId)).status).toBe('pending');

      // Mid-morning an OK fetch still says postponed...
      await fetchRainDay(nextDay(10), [rainGame(eventId, { status: 'postponed', period: 1 })]);
      // ...so the NEXT morning's maintenance voids it: a day late, not wrong.
      const next = await runMaintenance(env, MAINTENANCE_AT + 24 * HOUR);
      expect(next.autoVoidedGames).toContain(gameId);
      await runSettle(env, MAINTENANCE_AT + 24 * HOUR + 5 * MIN, 200);
      expect((await betRow(betId)).status).toBe('void');
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
    },
  );

  it(
    'A DAY LATE, NEVER WRONG (ii): planTargets does NOT retire a past MLB target (window ended ' +
      '> 2 d ago) while it holds a postponed game, so the evidence can still arrive; once ' +
      'maintenance has made the game canceled, the next planTargets DOES retire it',
    async () => {
      const id = `mlb:rt${String(seq)}`;
      await seedPostponed(id, 'mlb', { lastRunAt: onDay(23), lastStatus: 'ok' });
      const later = RAIN_DAY.endAt + 3 * 24 * HOUR;
      await planTargets(env, later);
      expect(await targetIds('mlb')).toContain(RAIN_TARGET);
      // The evidence arrives late; maintenance cancels; the target is retired.
      await env.DB.prepare('UPDATE ingest_targets SET last_run_at = ?1 WHERE id = ?2')
        .bind(later - HOUR, RAIN_TARGET)
        .run();
      expect((await runMaintenance(env, later)).autoVoidedGames).toContain(id);
      await planTargets(env, later + 15 * MIN);
      expect(await targetIds('mlb')).not.toContain(RAIN_TARGET);
    },
  );

  it('stats.mlbRescheduled names an MLB game moved to another ET date under the same id', async () => {
    const moved = `mlb:rs${String(seq)}a`;
    const sameDay = `mlb:rs${String(seq)}b`;
    await seedGame(env.DB, {
      id: moved,
      league: 'mlb',
      week: null,
      originalKickoffAt: onDay(19, 5),
      kickoffAt: nextDay(13, 5),
    });
    await seedGame(env.DB, {
      id: sameDay,
      league: 'mlb',
      week: null,
      originalKickoffAt: onDay(19, 5),
      kickoffAt: onDay(23, 30), // later, but the same ET date
    });
    const stats = await runMaintenance(env, MAINTENANCE_AT);
    expect(stats.mlbRescheduled).toContainEqual({
      gameId: moved,
      status: 'scheduled',
      originalDate: '20260922',
      currentDate: '20260923',
    });
    expect(stats.mlbRescheduled.map((g) => g.gameId)).not.toContain(sameDay);
  });
});

describe('M12b — canceled is terminal in the ingest upsert', () => {
  it(
    'an auto-voided (canceled) game re-reported by ESPN as STATUS_POSTPONED stays canceled, ' +
      'keeps its auto-void status_detail, and writes 0 rows through (A) and (B)',
    async () => {
      const eventId = `ct${String(seq)}`;
      const gameId = `mlb:${eventId}`;
      const spec = rainGame(eventId, { status: 'postponed', period: 1 });
      delete (spec as { odds?: unknown }).odds;
      await upsertSlate(env, makeSlate([spec], 'mlb', onDay(20)), onDay(20));
      await env.DB.prepare(
        `UPDATE games SET status = 'canceled',
                status_detail = 'auto-void: MLB postponed, not played on its date' WHERE id = ?1`,
      )
        .bind(gameId)
        .run();
      const probe = probeBatchRows();
      let res;
      try {
        // Even past the L3 touch interval: canceled is not "seen again" either.
        const at = nextDay(12);
        res = await upsertSlate(env, makeSlate([spec], 'mlb', at), at);
      } finally {
        probe.restore();
      }
      expect(res.rowsWritten).toBe(0);
      expect(probe.rows).toBe(0);
      expect(await gameRow(gameId)).toMatchObject({
        status: 'canceled',
        status_detail: 'auto-void: MLB postponed, not played on its date',
      });
    },
  );

  it('a canceled game re-reported as final stays canceled (its bets were already voided)', async () => {
    const eventId = `cf${String(seq)}`;
    const gameId = `mlb:${eventId}`;
    await upsertSlate(env, makeSlate([rainGame(eventId)], 'mlb', onDay(15)), onDay(15));
    await env.DB.prepare(`UPDATE games SET status = 'canceled' WHERE id = ?1`).bind(gameId).run();
    const readRow = () =>
      env.DB.prepare('SELECT status, home_score AS h, period FROM games WHERE id = ?1')
        .bind(gameId)
        .first<{ status: string; h: number | null; period: number | null }>();
    const before = await readRow();
    expect(before?.status).toBe('canceled');
    const at = nextDay(3);
    const final = rainGame(eventId, { status: 'post', period: 9, homeScore: 5, awayScore: 3 });
    delete (final as { odds?: unknown }).odds;
    await upsertSlate(env, makeSlate([final], 'mlb', at), at);
    // Neither (A) nor (B) touched it: status, score and inning are as they were.
    expect(await readRow()).toEqual(before);
  });

  it('the §8.5 rows_written table is otherwise unchanged', async () => {
    // A postponed (NOT canceled) game re-reported identically: L1 skips it (0);
    // its later final still writes through (A) exactly as before.
    const eventId = `cu${String(seq)}`;
    const gameId = `mlb:${eventId}`;
    const pp = rainGame(eventId, { status: 'postponed', period: 1 });
    delete (pp as { odds?: unknown }).odds;
    await upsertSlate(env, makeSlate([pp], 'mlb', onDay(20)), onDay(20));
    const again = await upsertSlate(env, makeSlate([pp], 'mlb', onDay(20, 15)), onDay(20, 15));
    expect(again.rowsWritten).toBe(0);
    const fin = { ...pp, status: 'post' as const, period: 9, homeScore: 2, awayScore: 1 };
    const moved = await upsertSlate(env, makeSlate([fin], 'mlb', onDay(22)), onDay(22));
    expect(moved.rowsWritten).toBeGreaterThan(0);
    expect((await gameRow(gameId)).status).toBe('final');
  });
});

/* ------------------------------------------------------------------ *
 * M12b — settlement and placement. Seeded directly (not via ingest) at the
 * real clock, like settle.spec.ts: an MLB game with a run line, a total and a
 * moneyline at MLB-shaped prices.
 * ------------------------------------------------------------------ */

/** Run line home -1.5 @ +140 / away +1.5 @ -165; total `totalTenths`; ML -150 / +130. */
async function seedMlb(id: string, now: number, totalTenths = 85): Promise<string> {
  return seedGameWithLine(
    env.DB,
    { id, league: 'mlb', week: null, kickoffAt: now + 2 * HOUR, lastSeenAt: now },
    {
      spreadHomeTenths: -15,
      spreadHomePrice: 140,
      spreadAwayTenths: 15,
      spreadAwayPrice: -165,
      totalTenths,
      totalOverPrice: -105,
      totalUnderPrice: -115,
      mlHomePrice: -150,
      mlAwayPrice: 130,
      seenAt: now,
    },
  );
}

type Leg = PlaceBetRequest['legs'][number];
const ml = (gameId: string, side: 'home' | 'away' = 'home'): Leg => ({
  gameId,
  market: 'moneyline',
  side,
});
const rl = (gameId: string, side: 'home' | 'away' = 'home'): Leg => ({
  gameId,
  market: 'spread',
  side,
});
const tot = (gameId: string, side: 'over' | 'under'): Leg => ({ gameId, market: 'total', side });

async function placeAt(
  userId: string,
  legs: Leg[],
  now: number,
  stakeCents = 1000,
): Promise<string> {
  const req: PlaceBetRequest = {
    league: 'mlb',
    betType: legs.length === 1 ? 'straight' : 'parlay',
    stakeCents,
    legs,
  };
  const { bet } = await placeBet(env, userId, req, now);
  return bet.id;
}

describe('M12b — settlement', () => {
  beforeEach(async () => {
    // As in settle.spec.ts: take earlier tests' still-pending bets out of the
    // selection set without touching money (balances and ledger are unchanged).
    await env.DB.prepare(
      `UPDATE bets SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1
        WHERE status = 'pending'`,
    )
      .bind(Date.now())
      .run();
  });

  it('a 9-inning final settles every market as for football', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:f9${String(seq)}`, now);
    const a = await placeAt(user.id, [rl(gid)], now); // -1.5 @ +140
    const b = await placeAt(user.id, [tot(gid, 'under')], now); // u8.5 @ -115
    const c = await placeAt(user.id, [ml(gid, 'away')], now); // +130
    await updateGame(env.DB, gid, { status: 'final', homeScore: 5, awayScore: 3, period: 9 });
    await runSettle(env, now + 1, 200);
    expect((await betRow(a)).status).toBe('won');
    expect((await betRow(b)).status).toBe('won'); // 8 runs < 8.5
    expect((await betRow(c)).status).toBe('lost');
    // BigInt REPL: +140 → 2400; -115 → 1869.
    expect((await betRow(a)).payout_cents).toBe(2400);
    expect((await betRow(b)).payout_cents).toBe(1869);
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 3000 + 2400 + 1869);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('a Final/10 settles every market; extra-inning runs count toward the total', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:f10${String(seq)}`, now);
    const over = await placeAt(user.id, [tot(gid, 'over')], now);
    const runLine = await placeAt(user.id, [rl(gid)], now);
    // 4-4 after nine (8 runs, under 8.5); the home side scores 2 in the 10th.
    await updateGame(env.DB, gid, { status: 'final', homeScore: 6, awayScore: 4, period: 10 });
    await runSettle(env, now + 1, 200);
    expect(await betRow(over)).toMatchObject({ status: 'won', payout_cents: 1952 });
    expect(await betRow(runLine)).toMatchObject({ status: 'won', payout_cents: 2400 });
  });

  it('a postponed game auto-voided by maintenance → the next settle run voids its legs', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:pa${String(seq)}`, now);
    const bet = await placeAt(user.id, [ml(gid), tot(gid, 'over')], now);
    await updateGame(env.DB, gid, { status: 'postponed' });
    await runSettle(env, now + 1, 200);
    expect((await betRow(bet)).status).toBe('pending'); // postponed is not settleable
    // Evidence for the game's ET date, then maintenance.
    const day = etDayBounds(now + 2 * HOUR);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ingest_targets
         (id, league, kind, key, window_start_at, window_end_at, priority, next_run_at,
          last_run_at, last_status, consecutive_failures, created_at, updated_at)
       VALUES (?1, 'mlb', 'date', ?2, ?3, ?4, 0, ?5, ?5, 'ok', 0, ?3, ?3)`,
    )
      .bind(
        `mlb:date:${etDateKey(now + 2 * HOUR)}`,
        etDateKey(now + 2 * HOUR),
        day.startAt,
        day.endAt,
        day.endAt + MLB_POSTPONED_CONFIRM_MS,
      )
      .run();
    const at = day.endAt + MLB_POSTPONED_CONFIRM_MS + HOUR;
    expect((await runMaintenance(env, at)).autoVoidedGames).toContain(gid);
    await runSettle(env, at + 1, 200);
    expect(await betRow(bet)).toMatchObject({ status: 'void', payout_cents: 1000 });
    expect(await legResults(bet)).toEqual(['void', 'void']);
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
  });

  it(
    'a final MLB game with period NULL defers (settle_attempts + 1), never settles — the only ' +
      'undecidable case',
    async () => {
      const now = Date.now();
      const user = await registerAccount();
      const gid = await seedMlb(`mlb:nul${String(seq)}`, now);
      const bet = await placeAt(user.id, [ml(gid)], now);
      await updateGame(env.DB, gid, { status: 'final', homeScore: 5, awayScore: 3, period: null });
      const first = await runSettle(env, now + 1, 200);
      expect(first.deferred).toBeGreaterThanOrEqual(1);
      expect(first.settled).toBe(0);
      const row = await betRow(bet);
      expect(row).toMatchObject({ status: 'pending', settle_attempts: 1 });
      expect(row.settle_error).toContain(gid);
      expect(row.settle_error).toContain('undecidable');
      // After MAX_SETTLE_ATTEMPTS it is parked in stuck[] — money never forfeited.
      await env.DB.prepare('UPDATE bets SET settle_attempts = ?1 WHERE id = ?2')
        .bind(MAX_SETTLE_ATTEMPTS - 1, bet)
        .run();
      await runSettle(env, now + 2, 200);
      const parked = await runSettle(env, now + 3, 200);
      expect(parked.stuck).toContain(bet);
      expect((await betRow(bet)).status).toBe('pending');
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 1000);
    },
  );

  it(
    'the league for the action comes from bet_legs.league (the snapshot); §7.2 adds only ' +
      'g.period',
    async () => {
      const now = Date.now();
      const user = await registerAccount();
      const gid = await seedMlb(`mlb:lg${String(seq)}`, now);
      const bet = await placeAt(user.id, [rl(gid)], now);
      await updateGame(env.DB, gid, { status: 'final', homeScore: 5, awayScore: 1, period: 7 });
      const legs = await loadLegsForBets(env, [bet]);
      expect(legs[0]?.snapshot.league).toBe('mlb');
      expect(legs[0]?.game.action).toEqual(gameAction('mlb', { status: 'final', period: 7 }));
      // The same row labelled football in the SNAPSHOT would grade with full
      // action — proof the snapshot, not the game id, decides.
      await env.DB.prepare(`UPDATE bet_legs SET league = 'nfl' WHERE bet_id = ?1`).bind(bet).run();
      const relabelled = await loadLegsForBets(env, [bet]);
      expect(relabelled[0]?.game.action).toEqual(FULL_ACTION);
      await env.DB.prepare(`UPDATE bet_legs SET league = 'mlb' WHERE bet_id = ?1`).bind(bet).run();
    },
  );

  it('settle.ts still imports no game_lines accessor (rule 7)', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:r7${String(seq)}`, now);
    await placeAt(user.id, [rl(gid), tot(gid, 'over')], now);
    await updateGame(env.DB, gid, { status: 'final', homeScore: 5, awayScore: 4, period: 7 });
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: D1Database['prepare'] }).prepare = (sql: string) => {
      seen.push(sql);
      return real(sql);
    };
    try {
      await runSettle(env, now + 1, 200);
    } finally {
      (env.DB as { prepare: D1Database['prepare'] }).prepare = real;
    }
    expect(seen.filter((sql) => /game_lines/i.test(sql))).toEqual([]);
    const legSql = seen.find((sql) => sql.includes('g.status AS g_status'));
    expect(legSql).toBeDefined();
    // Every column read off `games` is a GAME fact: status, scores, period.
    const gameCols = [...(legSql ?? '').matchAll(/\bg\.(\w+)/g)].map((m) => m[1]).sort();
    expect([...new Set(gameCols)]).toEqual(['away_score', 'home_score', 'id', 'period', 'status']);
  });
});

describe('M12b — settlement of shortened games', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE bets SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1
        WHERE status = 'pending'`,
    )
      .bind(Date.now())
      .run();
  });

  it(
    'a Final/7: moneyline graded, run line void, under 8.5 with 6 runs void, over 5.5 won — ' +
      'five same-game bets settle and the ledger reconciles',
    async () => {
      const now = Date.now();
      const user = await registerAccount();
      const a = await seedMlb(`mlb:s7${String(seq)}a`, now, 85); // total 8.5
      const b = await seedMlb(`mlb:s7${String(seq)}b`, now, 55); // total 5.5
      // Potential payouts, BigInt REPL: 3181, 4581, 4490, 3135, 1869.
      const b1 = await placeAt(user.id, [ml(a), tot(a, 'under')], now); // -150 · -115
      const b2 = await placeAt(user.id, [rl(a), tot(a, 'over')], now); // +140 · -105
      const b3 = await placeAt(user.id, [ml(b, 'away'), tot(b, 'over')], now); // +130 · -105
      const b4 = await placeAt(user.id, [rl(b, 'away'), tot(b, 'over')], now); // -165 · -105
      const b5 = await placeAt(user.id, [tot(b, 'under')], now); // -115
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 5000);

      // Both games called after 7 innings, BAL 4 – TOR 2: 6 runs.
      for (const gid of [a, b]) {
        await updateGame(env.DB, gid, { status: 'final', homeScore: 4, awayScore: 2, period: 7 });
      }
      await runSettle(env, now + 1, 200);

      // b1: ML home won, under 8.5 NOT decided → void → won at -150 alone: 1666.
      expect(await legResults(b1)).toEqual(['win', 'void']);
      expect(await betRow(b1)).toMatchObject({
        status: 'won',
        payout_cents: 1666,
        american_price: -150,
      });
      // b2: run line void, over 8.5 not decided → void → every leg void: refund.
      expect(await legResults(b2)).toEqual(['void', 'void']);
      expect(await betRow(b2)).toMatchObject({ status: 'void', payout_cents: 1000 });
      // b3: ML away lost, over 5.5 decided (6 > 5.5) won → lost.
      expect(await legResults(b3)).toEqual(['loss', 'win']);
      expect(await betRow(b3)).toMatchObject({ status: 'lost', payout_cents: 0 });
      // b4: run line void, over 5.5 won → won at -105 alone: 1952.
      expect(await legResults(b4)).toEqual(['void', 'win']);
      expect(await betRow(b4)).toMatchObject({
        status: 'won',
        payout_cents: 1952,
        american_price: -105,
      });
      // b5: under 5.5 decided → lost.
      expect(await legResults(b5)).toEqual(['loss']);
      expect(await betRow(b5)).toMatchObject({ status: 'lost', payout_cents: 0 });

      // 100,000 − 5,000 staked + 1,666 + 1,000 + 1,952 = 99,618.
      expect(await balanceOf(user.id)).toBe(99_618);
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 5000 + 1666 + 1000 + 1952);
      expect(await ledgerSum(env.DB, await mainBankrollId(env.DB, user.id))).toBe(
        await balanceOf(user.id),
      );
      expect(await bankrollDrift(env.DB)).toEqual([]);
    },
  );

  it('a Final/7 total EQUAL to a whole-number line is not decided → void', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:s7w${String(seq)}`, now, 60);
    const over = await placeAt(user.id, [tot(gid, 'over')], now);
    const under = await placeAt(user.id, [tot(gid, 'under')], now);
    await updateGame(env.DB, gid, { status: 'final', homeScore: 4, awayScore: 2, period: 7 });
    await runSettle(env, now + 1, 200);
    expect((await betRow(over)).status).toBe('void');
    expect((await betRow(under)).status).toBe('void');
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
  });

  it(
    'a Final/4: EVERY leg void — moneyline, run line and total, even a total already over ' +
      'its line — bet void, stake refunded',
    async () => {
      const now = Date.now();
      const user = await registerAccount();
      const gid = await seedMlb(`mlb:s4${String(seq)}`, now, 55);
      const p1 = await placeAt(user.id, [ml(gid), tot(gid, 'over')], now);
      const p2 = await placeAt(user.id, [rl(gid)], now);
      // 11 runs in four innings: far over 5.5, but not an official game.
      await updateGame(env.DB, gid, { status: 'final', homeScore: 8, awayScore: 3, period: 4 });
      await runSettle(env, now + 1, 200);
      expect(await legResults(p1)).toEqual(['void', 'void']);
      expect(await betRow(p1)).toMatchObject({ status: 'void', payout_cents: 1000 });
      expect(await betRow(p2)).toMatchObject({ status: 'void', payout_cents: 1000 });
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
      expect(await bankrollDrift(env.DB)).toEqual([]);
    },
  );

  it('a Final/12 (401817038, MIA @ CHC) settles every market with the extras', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:401817038x${String(seq)}`, now, 75);
    const b = await placeAt(user.id, [rl(gid, 'away'), tot(gid, 'over')], now);
    // 3-3 through nine; CHC wins 4-3 in the 12th: away +1.5 covers, 7 < 7.5.
    await updateGame(env.DB, gid, { status: 'final', homeScore: 4, awayScore: 3, period: 12 });
    await runSettle(env, now + 1, 200);
    expect(await legResults(b)).toEqual(['win', 'loss']);
    expect((await betRow(b)).status).toBe('lost');
  });

  it(
    'cross-sport parlay: MLB total voided by a shortened game + NFL leg lost → lost; + NFL leg ' +
      'won → won at the NFL leg’s price, american_price written back',
    async () => {
      const now = Date.now();
      const user = await registerAccount();
      const m = await seedMlb(`mlb:xs${String(seq)}`, now, 85);
      const nflLose = await seedGameWithLine(env.DB, {
        id: `nfl:xs${String(seq)}a`,
        kickoffAt: now + 2 * HOUR,
        lastSeenAt: now,
      });
      const nflWin = await seedGameWithLine(env.DB, {
        id: `nfl:xs${String(seq)}b`,
        kickoffAt: now + 2 * HOUR,
        lastSeenAt: now,
      });
      const lost = await placeAt(user.id, [tot(m, 'over'), rl(nflLose)], now); // NFL -3.5 @ -110
      const won = await placeAt(user.id, [tot(m, 'over'), rl(nflWin)], now);
      expect((await betRow(lost)).league).toBe('mixed');
      await updateGame(env.DB, m, { status: 'final', homeScore: 4, awayScore: 2, period: 7 });
      await updateGame(env.DB, nflLose, { status: 'final', homeScore: 20, awayScore: 24 });
      await updateGame(env.DB, nflWin, { status: 'final', homeScore: 28, awayScore: 24 });
      await runSettle(env, now + 1, 200);
      expect(await legResults(lost)).toEqual(['void', 'loss']);
      expect(await betRow(lost)).toMatchObject({ status: 'lost', payout_cents: 0 });
      expect(await legResults(won)).toEqual(['void', 'win']);
      // One surviving -110 leg at 1000¢ → 1909 (canonical BigInt vector).
      expect(await betRow(won)).toMatchObject({
        status: 'won',
        payout_cents: 1909,
        american_price: -110,
      });
      expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 2000 + 1909);
      expect(await bankrollDrift(env.DB)).toEqual([]);
    },
  );

  it('an open bet’s projected leg shows void for a shortened final before settle runs', async () => {
    const now = Date.now();
    const user = await registerAccount();
    const gid = await seedMlb(`mlb:pj${String(seq)}`, now, 85);
    const id = await placeAt(user.id, [ml(gid), tot(gid, 'under')], now);
    const id2 = await placeAt(user.id, [rl(gid)], now);
    await updateGame(env.DB, gid, { status: 'final', homeScore: 4, awayScore: 2, period: 7 });
    const res = await get('/api/bets?status=open', user.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const bets = (await res.json<BetsResponse>()).bets;
    const view = bets.find((b) => b.id === id);
    expect(view?.legs.map((l) => l.projected)).toEqual(['win', 'void']);
    expect(bets.find((b) => b.id === id2)?.legs.map((l) => l.projected)).toEqual(['void']);
  });
});

describe('M12b — placement', () => {
  const nowGames = async (): Promise<{
    now: number;
    a: string;
    b: string;
    nfl: string;
    cfb: string;
  }> => {
    const now = Date.now();
    const a = await seedMlb(`mlb:pl${String(seq)}a`, now);
    const b = await seedMlb(`mlb:pl${String(seq)}b`, now);
    const nfl = await seedGameWithLine(env.DB, {
      id: `nfl:pl${String(seq)}`,
      kickoffAt: now + 2 * HOUR,
      lastSeenAt: now,
    });
    const cfb = await seedGameWithLine(env.DB, {
      id: `ncaaf:pl${String(seq)}`,
      league: 'ncaaf',
      kickoffAt: now + 3 * HOUR,
      lastSeenAt: now,
    });
    return { now, a, b, nfl, cfb };
  };
  const req = (
    betType: PlaceBetRequest['betType'],
    legs: Leg[],
    over: Partial<PlaceBetRequest> = {},
  ): PlaceBetRequest => ({ league: 'mlb', betType, stakeCents: 1000, legs, ...over });

  it('LEAGUE_BETTING_OPEN.mlb is true and an MLB card is bettable', async () => {
    expect(LEAGUE_BETTING_OPEN.mlb).toBe(true);
    const user = await registerAccount();
    const { a } = await nowGames();
    const res = await get(`/api/games/${encodeURIComponent(a)}`, user.cookie);
    expect((await res.json<{ game: GameCard }>()).game.bettable).toBe(true);
  });

  it('straight, parlay, same-game parlay (run line + total) and MLB + NFL parlay all place', async () => {
    const user = await registerAccount();
    const { a, b, nfl } = await nowGames();
    for (const body of [
      req('straight', [ml(a)]),
      req('parlay', [ml(a), rl(b, 'away')]),
      req('parlay', [rl(a), tot(a, 'over')]),
      req('parlay', [ml(a), rl(nfl)], { league: 'mixed' }),
    ]) {
      const res = await post('/api/bets', body, user.cookie);
      expect(res.status, await res.clone().text()).toBe(201);
    }
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS - 4000);
  });

  it('a same-game run line + moneyline → 400 VALIDATION, exactly as for football', async () => {
    const user = await registerAccount();
    const { a } = await nowGames();
    const res = await post('/api/bets', req('parlay', [rl(a), ml(a)]), user.cookie);
    expect(res.status).toBe(400);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details).toMatchObject({ field: 'legs[1].market' });
  });

  it('a teaser with one MLB leg → 400 TEASER_INVALID, no statement executed, no money moved', async () => {
    const user = await registerAccount();
    const { a, nfl } = await nowGames();
    const res = await post(
      '/api/bets',
      req('teaser', [rl(nfl), rl(a)], { teaserPoints: 60, league: 'mixed' }),
      user.cookie,
    );
    expect(res.status).toBe(400);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('TEASER_INVALID');
    expect(body.error.details).toMatchObject({ field: 'legs[1]' });
    expect(await balanceOf(user.id)).toBe(INITIAL_BANKROLL_CENTS);
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bets b JOIN bankrolls k ON k.id = b.bankroll_id
        WHERE k.user_id = ?1`,
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('an NFL + NCAAF teaser still places', async () => {
    const user = await registerAccount();
    const { nfl, cfb } = await nowGames();
    const res = await post(
      '/api/bets',
      req('teaser', [rl(nfl), tot(cfb, 'over')], { teaserPoints: 60, league: 'mixed' }),
      user.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json<BetResponse>()).bet.betType).toBe('teaser');
  });

  it('an edit (PUT) that adds an MLB leg to a football parlay succeeds', async () => {
    const user = await registerAccount();
    const { a, nfl, cfb } = await nowGames();
    const placed = await post(
      '/api/bets',
      req('parlay', [rl(nfl), rl(cfb)], { league: 'mixed' }),
      user.cookie,
    );
    expect(placed.status, await placed.clone().text()).toBe(201);
    const { bet } = await placed.json<BetResponse>();
    const edited = await put(
      `/api/bets/${bet.id}`,
      req('parlay', [rl(nfl), rl(cfb), ml(a)], { league: 'mixed' }),
      user.cookie,
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
    const out = await edited.json<BetResponse>();
    expect(out.replacedBetId).toBe(bet.id);
    expect(out.bet.legs.map((l) => l.league)).toEqual(['nfl', 'ncaaf', 'mlb']);
    expect(out.bet.league).toBe('mixed');
  });

  it('an edit that adds an MLB leg to a teaser → 400 TEASER_INVALID, the old bet untouched', async () => {
    const user = await registerAccount();
    const { a, nfl, cfb } = await nowGames();
    const placed = await post(
      '/api/bets',
      req('teaser', [rl(nfl), rl(cfb)], { teaserPoints: 60, league: 'mixed' }),
      user.cookie,
    );
    expect(placed.status, await placed.clone().text()).toBe(201);
    const { bet } = await placed.json<BetResponse>();
    const before = await balanceOf(user.id);
    const edited = await put(
      `/api/bets/${bet.id}`,
      req('teaser', [rl(nfl), rl(cfb), rl(a)], { teaserPoints: 60, league: 'mixed' }),
      user.cookie,
    );
    expect(edited.status).toBe(400);
    expect((await edited.json<ApiErrorBody>()).error.code).toBe('TEASER_INVALID');
    expect((await betRow(bet.id)).status).toBe('pending');
    expect(await legResults(bet.id)).toEqual([null, null]);
    expect(await balanceOf(user.id)).toBe(before);
  });

  it("an MLB-only parlay is labelled league 'mlb'; MLB + NFL is 'mixed'", async () => {
    const user = await registerAccount();
    const { now, a, b, nfl } = await nowGames();
    expect((await betRow(await placeAt(user.id, [ml(a), ml(b)], now))).league).toBe('mlb');
    expect((await betRow(await placeAt(user.id, [ml(a), rl(nfl)], now))).league).toBe('mixed');
  });
});
