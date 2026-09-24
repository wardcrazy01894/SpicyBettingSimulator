/**
 * MLB against a real D1 — ingest, the postponed-game void and its race,
 * settlement of shortened games, placement. PLAN.md §23.13.
 *
 * Written FIRST as `it.todo` contracts. M12a's describe (ingest, the board,
 * the betting gate, the secondary exclusion) is real from M12a — it needs
 * migration 0009's widened `league` CHECKs, which ship in the same PR. M12b's
 * stay `it.todo` until M12b. The file is the permanent home of these cases,
 * not a staging area.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ConfigResponse,
  GameCard,
  GamesResponse,
  PlaceBetRequest,
  UserResponse,
} from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { boardWindowEnd, etDateKey, etDateKeyRange, etDayBounds } from '../../src/shared/time.js';
import type { League } from '../../src/shared/types.js';
import { LEAGUE_BETTING_OPEN } from '../../src/worker/bets.js';
import { buildScoreboardUrl } from '../../src/worker/espn.js';
import { planTargets, runRefresh, upsertSlate } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import { buildScoreboard, stubEspn, stubOddsApi } from './fixtures.js';
import type { EspnStub, EventSpec, OddsApiStub } from './fixtures.js';
import { fullLine, seedGame, seedGameWithLine, seedLine } from './seed.js';

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
    expect(LEAGUE_BETTING_OPEN.mlb).toBe(false);
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
  });

  it('POST /api/bets with an MLB leg → 409 GAME_NOT_BETTABLE while the gate is closed', async () => {
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
  });

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

describe('M12b — the postponed void and the rain-delay race (maintenance)', () => {
  it.todo(
    'postponed MLB game, its ET-date target last fetched OK at window_end + 3 h → canceled, ' +
      'named in stats.autoVoidedGames, status_detail says why',
  );
  it.todo(
    'THE RACE: postponed (a delay) at 22:40 ET, target last fetched OK at 23:59 → NOT voided ' +
      'at 04:30; the 03:00 confirm fetch sees it final → never voided, bets grade normally',
  );
  it.todo('postponed, target last fetched at window_end + 3 h but last_status error → NOT voided');
  it.todo('postponed, no ingest_targets row covers it → NOT voided (the 7-day rule still applies)');
  it.todo('a postponed NFL / CFB game with the same evidence → NOT voided before 7 days (§7.5)');
  it.todo('the SQL instant equals postponedVoidConfirmAt("mlb", window_end_at) to the millisecond');
  it.todo(
    'computeNextRunAt: a target whose day has ended holding a postponed game is due at ' +
      'window_end + 3 h (not +6 h), and one whose games are all final is unaffected',
  );
  it.todo('the 7-day rule is unchanged for every league');
  it.todo(
    'A DAY LATE, NEVER WRONG (i): the confirm fetch at window_end + 3 h FAILS (last_status ' +
      'error) → not voided at that morning’s maintenance; a later OK fetch still saying ' +
      'postponed → voided at the NEXT maintenance run',
  );
  it.todo(
    'A DAY LATE, NEVER WRONG (ii): planTargets does NOT retire a past MLB target (window ended ' +
      '> 2 d ago) while it holds a postponed game, so the evidence can still arrive; once ' +
      'maintenance has made the game canceled, the next planTargets DOES retire it',
  );
});

describe('M12b — canceled is terminal in the ingest upsert', () => {
  it.todo(
    'an auto-voided (canceled) game re-reported by ESPN as STATUS_POSTPONED stays canceled, ' +
      'keeps its auto-void status_detail, and writes 0 rows through (A) and (B)',
  );
  it.todo('a canceled game re-reported as final stays canceled (its bets were already voided)');
  it.todo('the §8.5 rows_written table is otherwise unchanged');
});

describe('M12b — settlement', () => {
  it.todo('a 9-inning final settles every market as for football');
  it.todo('a Final/10 settles every market; extra-inning runs count toward the total');
  it.todo('a postponed game auto-voided by maintenance → the next settle run voids its legs');
  it.todo(
    'a final MLB game with period NULL defers (settle_attempts + 1), never settles — the only ' +
      'undecidable case',
  );
  it.todo(
    'the league for the action comes from bet_legs.league (the snapshot); §7.2 adds only ' +
      'g.period',
  );
  it.todo('settle.ts still imports no game_lines accessor (rule 7)');
});

describe('M12b — settlement of shortened games', () => {
  it.todo('a Final/7: moneyline graded, run line void, under 8.5 with 6 runs void, over 5.5 won');
  it.todo(
    'a Final/4: EVERY leg void — moneyline, run line and total, even a total already over ' +
      'its line — bet void, stake refunded',
  );
  it.todo(
    'cross-sport parlay: MLB total voided by a shortened game + NFL leg lost → lost; + NFL leg ' +
      'won → won at the NFL leg’s price, american_price written back',
  );
  it.todo('an open bet’s projected leg shows void for a shortened final before settle runs');
});

describe('M12b — placement', () => {
  it.todo('straight, parlay, same-game parlay (run line + total) and MLB + NFL parlay all place');
  it.todo('a same-game run line + moneyline → 409 DUPLICATE_GAME_IN_PARLAY, as for football');
  it.todo('a teaser with one MLB leg → 400 TEASER_INVALID, no statement executed, no money moved');
  it.todo('an NFL + NCAAF teaser still places');
  it.todo('an edit that adds an MLB leg to a teaser → 400 TEASER_INVALID, the old bet untouched');
  it.todo("an MLB-only parlay is labelled league 'mlb'; MLB + NFL is 'mixed'");
});
