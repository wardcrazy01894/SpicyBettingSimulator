import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ESPN_MAX_WARNINGS_RECORDED,
  GAME_SEEN_TOUCH_MS,
  INGEST_WINDOW_MS,
  LINE_SEEN_TOUCH_MS,
  RESERVED_DISCOVERY_SLOTS,
} from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { etDateKey, etDateKeyRange } from '../../src/shared/time.js';
import type { Game, GameLines, League } from '../../src/shared/types.js';
import { buildScoreboardUrl, EspnProvider } from '../../src/worker/espn.js';
import {
  claimDueTargets,
  computeNextRunAt,
  ingestTarget,
  lineRowsWorthWriting,
  planTargets,
  runRefresh,
  upsertSlate,
} from '../../src/worker/ingest.js';
import type { IngestTargetRow } from '../../src/worker/ingest.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import { runJob } from '../../src/worker/jobs.js';
import { buildScoreboard, stubEspn } from './fixtures.js';
import type { EspnStub, EventSpec, EventSpecOdds } from './fixtures.js';

/** TDD contract for M4. */

/** Sunday 2026-09-13, noon ET. `etDateKey(T0) === '20260913'`. */
const T0 = Date.parse('2026-09-13T16:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let espn: EspnStub;

beforeEach(async () => {
  espn = stubEspn({});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_lines'),
    env.DB.prepare('DELETE FROM games'),
    env.DB.prepare('DELETE FROM ingest_targets'),
    env.DB.prepare('DELETE FROM job_runs'),
    env.DB.prepare("UPDATE job_locks SET lease_until = 0, run_id = '', updated_at = 0"),
  ]);
});

afterEach(() => {
  espn.restore();
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

interface TargetDbRow {
  readonly id: string;
  readonly league: League;
  readonly kind: 'week' | 'date';
  readonly key: string;
  readonly window_start_at: number;
  readonly window_end_at: number;
  readonly priority: number;
  readonly next_run_at: number;
  readonly last_status: string | null;
  readonly last_error: string | null;
  readonly consecutive_failures: number;
  readonly games_seen: number;
}

function targetDbRow(id: string): Promise<TargetDbRow | null> {
  return env.DB.prepare('SELECT * FROM ingest_targets WHERE id = ?').bind(id).first<TargetDbRow>();
}

async function loadTarget(id: string): Promise<IngestTargetRow> {
  const row = await targetDbRow(id);
  if (row === null) throw new Error(`no ingest_targets row ${id}`);
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
  };
}

interface GameDbRow {
  readonly id: string;
  readonly status: string;
  readonly status_detail: string | null;
  readonly kickoff_at: number;
  readonly original_kickoff_at: number;
  readonly period: number | null;
  readonly display_clock: string | null;
  readonly home_score: number | null;
  readonly away_score: number | null;
  readonly week: number | null;
  readonly neutral_site: number;
  readonly home_rank: number | null;
  readonly away_rank: number | null;
  readonly home_logo: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly updated_at: number;
}

function gameRow(id: string): Promise<GameDbRow | null> {
  return env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first<GameDbRow>();
}

interface LineDbRow {
  readonly game_id: string;
  readonly provider: string;
  readonly spread_home_tenths: number | null;
  readonly spread_home_price: number | null;
  readonly spread_away_tenths: number | null;
  readonly spread_away_price: number | null;
  readonly total_tenths: number | null;
  readonly total_over_price: number | null;
  readonly total_under_price: number | null;
  readonly ml_home_price: number | null;
  readonly ml_away_price: number | null;
  readonly captured_at: number;
  readonly seen_at: number;
}

function lineRow(gameId: string): Promise<LineDbRow | null> {
  return env.DB.prepare('SELECT * FROM game_lines WHERE game_id = ?')
    .bind(gameId)
    .first<LineDbRow>();
}

/** Parse a synthesised slate exactly the way the provider would. */
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

/** Plan targets and hand back the NFL Sunday one, which every test drives. */
async function sundayNflTarget(now = T0): Promise<IngestTargetRow> {
  await planTargets(env, now);
  return loadTarget(`nfl:date:${etDateKey(now)}`);
}

const BASE_ODDS: EventSpecOdds = {
  spreadHome: -3.5,
  spreadHomePrice: -112,
  spreadAwayPrice: -108,
  total: 50.5,
  overPrice: -108,
  underPrice: -112,
  mlHome: -198,
  mlAway: 164,
};

const BASE_SPEC: EventSpec = {
  eventId: '401872925',
  league: 'nfl',
  kickoffAt: Date.parse('2026-09-13T17:00Z'),
  status: 'pre',
  homeAbbr: 'CIN',
  awayAbbr: 'TB',
  season: 2026,
  week: 1,
  odds: BASE_ODDS,
};

/**
 * `exactOptionalPropertyTypes` means `{ odds: undefined }` is not the same as an
 * absent key, so an override of `undefined` DELETES the property — which is what
 * "this game has no posted line" needs to mean.
 */
type SpecOverrides = { [K in keyof EventSpec]?: EventSpec[K] | undefined };

function spec(overrides: SpecOverrides): EventSpec {
  const merged: Record<string, unknown> = { ...BASE_SPEC, ...overrides };
  const kept = Object.entries(merged).filter(([, value]) => value !== undefined);
  return Object.fromEntries(kept) as unknown as EventSpec;
}

/** Drive one full fetch+parse+upsert cycle against the stubbed feed. */
async function ingestSlate(
  events: readonly EventSpec[],
  now: number,
  target?: IngestTargetRow,
): Promise<{
  gamesUpserted: number;
  linesUpserted: number;
  rowsSkipped: number;
  error: string | null;
}> {
  const t = target ?? (await sundayNflTarget());
  espn.set(t.key, events);
  const result = await ingestTarget(env, new EspnProvider(env), t, now);
  return {
    gamesUpserted: result.gamesUpserted,
    linesUpserted: result.linesUpserted,
    rowsSkipped: result.rowsSkipped,
    error: result.error,
  };
}

/* ------------------------------------------------------------------ *
 * fixture conformance (PLAN.md §13)
 * ------------------------------------------------------------------ */

describe('fixture conformance', () => {
  it('buildScoreboard -> parseScoreboard yields exactly the hand-written Game', () => {
    const fetchedAt = T0;
    const parsed = parseScoreboard(buildScoreboard([BASE_SPEC]), 'nfl', fetchedAt);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.games).toHaveLength(1);

    const expected: Game = {
      id: 'nfl:401872925',
      league: 'nfl',
      season: 2026,
      seasonType: 2,
      week: 1,
      name: 'TB Full Name at CIN Full Name',
      shortName: 'TB @ CIN',
      kickoffAt: Date.parse('2026-09-13T17:00Z'),
      originalKickoffAt: Date.parse('2026-09-13T17:00Z'),
      status: 'scheduled',
      statusDetail: 'Scheduled',
      period: 0,
      displayClock: '0:00',
      neutralSite: false,
      home: {
        teamId: parsed.games[0]?.home.teamId ?? '',
        abbr: 'CIN',
        name: 'CIN Full Name',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/cin.png',
        rank: null, // curatedRank.current 99 -> null
        score: 0, // the pre-game STRING "0" is 0, never null
      },
      away: {
        teamId: parsed.games[0]?.away.teamId ?? '',
        abbr: 'TB',
        name: 'TB Full Name',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/tb.png',
        rank: null,
        score: 0,
      },
    };
    expect(parsed.games[0]).toEqual(expected);
  });

  it('buildScoreboard -> parseScoreboard yields exactly the hand-written GameLines', () => {
    const parsed = parseScoreboard(buildScoreboard([BASE_SPEC]), 'nfl', T0);
    const expected: GameLines = {
      gameId: 'nfl:401872925',
      provider: 'DraftKings',
      capturedAt: T0,
      spread: { homeTenths: -35, homePrice: -112, awayTenths: 35, awayPrice: -108 },
      total: { tenths: 505, overPrice: -108, underPrice: -112 },
      moneyline: { homePrice: -198, awayPrice: 164 },
    };
    expect(parsed.lines).toEqual([expected]);
  });

  it('a ranked, neutral-site, in-progress CFB event round-trips field for field', () => {
    const parsed = parseScoreboard(
      buildScoreboard([
        spec({
          eventId: '401752000',
          league: 'ncaaf',
          status: 'in',
          neutralSite: true,
          homeAbbr: 'MICH',
          awayAbbr: 'OSU',
          homeScore: 17,
          awayScore: 21,
          homeRank: 4,
          awayRank: 99,
          period: 3,
          displayClock: '2:11',
          seasonType: 3,
          week: 16,
        }),
      ]),
      'ncaaf',
      T0,
    );
    const game = parsed.games[0];
    expect(game?.id).toBe('ncaaf:401752000');
    expect(game?.status).toBe('in_progress');
    expect(game?.neutralSite).toBe(true);
    expect(game?.seasonType).toBe(3);
    expect(game?.week).toBe(16);
    expect(game?.period).toBe(3);
    expect(game?.displayClock).toBe('2:11');
    expect(game?.home.rank).toBe(4);
    expect(game?.away.rank).toBeNull(); // 99 is ESPN's "unranked"
    expect(game?.home.score).toBe(17);
    expect(game?.away.score).toBe(21);
  });

  it('PARITY: the builder emits every field path docs/samples/*.json use', () => {
    const payload = buildScoreboard([BASE_SPEC]) as Record<string, unknown>;
    const at = (path: string): unknown => {
      let cur: unknown = payload;
      for (const seg of path.split('.')) {
        const key = /^\d+$/.test(seg) ? Number(seg) : seg;
        cur = (cur as Record<string | number, unknown>)[key];
      }
      return cur;
    };
    const ev = 'events.0';
    const comp = `${ev}.competitions.0`;
    const odds = `${comp}.odds.0`;

    // Event level.
    expect(at(`${ev}.date`)).toBe('2026-09-13T17:00Z');
    expect(at(`${ev}.season.year`)).toBe(2026);
    expect(at(`${ev}.season.type`)).toBe(2);
    expect(at(`${ev}.week.number`)).toBe(1);
    expect(at(`${ev}.name`)).toBeTypeOf('string');
    expect(at(`${ev}.shortName`)).toBeTypeOf('string');

    // Competition + status.
    expect(at(`${comp}.neutralSite`)).toBe(false);
    expect(at(`${comp}.status.type.name`)).toBe('STATUS_SCHEDULED');
    expect(at(`${comp}.status.type.state`)).toBe('pre');
    expect(at(`${comp}.status.type.completed`)).toBe(false);
    expect(at(`${comp}.status.period`)).toBe(0);
    expect(at(`${comp}.status.displayClock`)).toBe('0:00');

    // Competitors.
    for (const [i, side] of ['home', 'away'].entries()) {
      const c = `${comp}.competitors.${String(i)}`;
      expect(at(`${c}.homeAway`)).toBe(side);
      expect(at(`${c}.score`)).toBe('0'); // a STRING, and "0" before kickoff
      expect(at(`${c}.team.id`)).toBeTypeOf('string');
      expect(at(`${c}.team.abbreviation`)).toBeTypeOf('string');
      expect(at(`${c}.team.displayName`)).toBeTypeOf('string');
      expect(at(`${c}.team.logo`)).toBeTypeOf('string');
      expect(at(`${c}.curatedRank.current`)).toBe(99);
    }

    // Odds — the DraftKings block, `close` with an `open` fallback.
    expect(at(`${odds}.provider.id`)).toBe('100');
    expect(at(`${odds}.provider.name`)).toBe('DraftKings');
    expect(at(`${odds}.spread`)).toBe(-3.5);
    expect(at(`${odds}.overUnder`)).toBe(50.5);
    expect(at(`${odds}.pointSpread.home.close.line`)).toBe('-3.5');
    expect(at(`${odds}.pointSpread.home.close.odds`)).toBe('-112');
    expect(at(`${odds}.pointSpread.away.close.line`)).toBe('+3.5');
    expect(at(`${odds}.pointSpread.away.close.odds`)).toBe('-108');
    expect(at(`${odds}.total.over.close.line`)).toBe('o50.5');
    expect(at(`${odds}.total.over.close.odds`)).toBe('-108');
    expect(at(`${odds}.total.under.close.line`)).toBe('u50.5');
    expect(at(`${odds}.total.under.close.odds`)).toBe('-112');
    expect(at(`${odds}.moneyline.home.close.odds`)).toBe('-198');
    expect(at(`${odds}.moneyline.away.close.odds`)).toBe('+164');
    // `details` exists but must NEVER be parsed (PLAN.md §8.3).
    expect(at(`${odds}.details`)).toBeTypeOf('string');
  });
});

/* ------------------------------------------------------------------ *
 * planTargets
 * ------------------------------------------------------------------ */

describe('planTargets', () => {
  it('creates one DATE target per ET calendar day in the window, for BOTH leagues', async () => {
    await planTargets(env, T0);
    const rows = await env.DB.prepare(
      'SELECT league, kind, key FROM ingest_targets ORDER BY key, league',
    ).all<{ league: string; kind: string; key: string }>();
    const keys = etDateKeyRange(T0, T0 + INGEST_WINDOW_MS);
    expect(new Set(rows.results.map((r) => r.key))).toEqual(new Set(keys));
    expect(rows.results.every((r) => r.kind === 'date')).toBe(true);
    for (const key of keys) {
      expect(
        rows.results
          .filter((r) => r.key === key)
          .map((r) => r.league)
          .sort(),
      ).toEqual(['ncaaf', 'nfl']);
    }
  });

  it('a 10-day window yields 11 dates x 2 leagues = 22 targets', async () => {
    const created = await planTargets(env, T0);
    expect(created).toBe(22);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_targets').first<{
      n: number;
    }>();
    expect(row?.n).toBe(22);
  });

  it('a Sunday-night 00:20Z kickoff is planned under the SUNDAY ET date key', async () => {
    // Measured against live ESPN 2026-09-13 (Spike S4): SNF DAL@NYG at
    // 2026-09-14T00:20Z comes back from dates=20260913.
    const snf = Date.parse('2026-09-14T00:20Z');
    expect(etDateKey(snf)).toBe('20260913');
    await planTargets(env, T0);
    const t = await targetDbRow('nfl:date:20260913');
    expect(t).not.toBeNull();
    expect(snf).toBeGreaterThanOrEqual(t?.window_start_at ?? 0);
    expect(snf).toBeLessThan(t?.window_end_at ?? 0);
  });

  it('a Monday-night 00:15Z kickoff is planned under the MONDAY ET date key', async () => {
    const mnf = Date.parse('2026-09-15T00:15Z');
    expect(etDateKey(mnf)).toBe('20260914');
    await planTargets(env, T0);
    const t = await targetDbRow('nfl:date:20260914');
    expect(t).not.toBeNull();
    expect(mnf).toBeGreaterThanOrEqual(t?.window_start_at ?? 0);
    expect(mnf).toBeLessThan(t?.window_end_at ?? 0);
  });

  it('target ids are <league>:date:YYYYMMDD and never collide', async () => {
    await planTargets(env, T0);
    const rows = await env.DB.prepare('SELECT id FROM ingest_targets').all<{ id: string }>();
    expect(rows.results).toHaveLength(22);
    expect(new Set(rows.results.map((r) => r.id)).size).toBe(22);
    for (const { id } of rows.results) expect(id).toMatch(/^(nfl|ncaaf):date:\d{8}$/);
  });

  it('needs no league calendar — NFL postseason dates are planned like any other day', async () => {
    // Wild Card weekend 2027. The planner walks dates; it never learns what a
    // "week" is, which is exactly why postseason is free (PLAN.md §8.2).
    const jan = Date.parse('2027-01-09T17:00:00Z');
    await planTargets(env, jan);
    expect(await targetDbRow('nfl:date:20270109')).not.toBeNull();
    expect(await targetDbRow('ncaaf:date:20270109')).not.toBeNull();
  });

  it('a January bowl date is planned without any seasontype knowledge', async () => {
    const jan = Date.parse('2027-01-01T17:00:00Z');
    await planTargets(env, jan);
    const t = await loadTarget('ncaaf:date:20270101');
    const url = buildScoreboardUrl('https://espn.test', 'ncaaf', {
      kind: 'date',
      dateKey: t.key,
    });
    expect(url).not.toContain('seasontype');
  });

  it('is idempotent — a second run creates nothing new', async () => {
    expect(await planTargets(env, T0)).toBe(22);
    expect(await planTargets(env, T0 + MIN)).toBe(0);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_targets').first<{
      n: number;
    }>();
    expect(row?.n).toBe(22);
  });

  it('a rerun a day later adds exactly the one new trailing date, per league', async () => {
    await planTargets(env, T0);
    expect(await planTargets(env, T0 + DAY)).toBe(2);
  });

  it('retires targets whose window ended > 2 days ago with no non-final games', async () => {
    await planTargets(env, T0);
    const stale = await loadTarget('nfl:date:20260913');
    // Move "now" three days past the window end.
    const later = stale.windowEndAt + 3 * DAY;
    await planTargets(env, later);
    expect(await targetDbRow('nfl:date:20260913')).toBeNull();
  });

  it('does NOT retire a past target that still has a non-final game', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ status: 'postponed' })], T0, t);
    await planTargets(env, t.windowEndAt + 3 * DAY);
    expect(await targetDbRow('nfl:date:20260913')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * request shape
 * ------------------------------------------------------------------ */

describe('request budget', () => {
  it('builds ...nfl/scoreboard?dates=YYYYMMDD&limit=100', () => {
    expect(
      buildScoreboardUrl('https://espn.test', 'nfl', { kind: 'date', dateKey: '20260913' }),
    ).toBe(
      'https://espn.test/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913&limit=100',
    );
  });

  it('builds ...college-football/scoreboard?groups=80&limit=300&dates=YYYYMMDD', () => {
    expect(
      buildScoreboardUrl('https://espn.test', 'ncaaf', { kind: 'date', dateKey: '20260912' }),
    ).toBe(
      'https://espn.test/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates=20260912',
    );
  });

  it('NEVER sends seasontype — that would hide postseason games on a given date', () => {
    for (const league of ['nfl', 'ncaaf'] as const) {
      const url = buildScoreboardUrl('https://espn.test', league, {
        kind: 'date',
        dateKey: '20270109',
      });
      expect(url.toLowerCase()).not.toContain('seasontype');
    }
  });

  it('a trailing slash on the base URL does not produce a double slash', () => {
    expect(
      buildScoreboardUrl('https://espn.test/', 'nfl', { kind: 'date', dateKey: '20260913' }),
    ).toContain('https://espn.test/apis/');
  });

  it('a refresh run makes at most REFRESH_TARGETS_PER_RUN upstream calls', async () => {
    await planTargets(env, T0);
    // Every target is due immediately after planning.
    await runRefresh(env, T0, 2);
    expect(espn.callCount).toBe(2);
    expect(new Set(espn.urls).size).toBe(2); // never the same URL twice
  });

  it('20 discovery targets at +6h need 80 slot-uses/day against a supply of 96', () => {
    // The §8.4 budget check, as arithmetic rather than prose.
    const targets = etDateKeyRange(T0, T0 + INGEST_WINDOW_MS).length * 2;
    expect(targets).toBe(22);
    const discovery = targets - 2; // worst case: two live targets hold slot 1
    const slotUsesPerDay = discovery * (DAY / (6 * HOUR));
    const supply = (DAY / (15 * MIN)) * RESERVED_DISCOVERY_SLOTS;
    expect(slotUsesPerDay).toBe(80);
    expect(supply).toBe(96);
    expect(slotUsesPerDay).toBeLessThan(supply);
  });
});

/* ------------------------------------------------------------------ *
 * ingestTarget
 * ------------------------------------------------------------------ */

describe('ingestTarget', () => {
  it('upserts games and one game_lines row per game that has odds', async () => {
    const res = await ingestSlate(
      [BASE_SPEC, spec({ eventId: '2', homeAbbr: 'SEA', awayAbbr: 'NE', odds: undefined })],
      T0,
    );
    expect(res.error).toBeNull();
    expect(res.gamesUpserted).toBe(2);
    expect(res.linesUpserted).toBe(1);

    const g = await gameRow('nfl:401872925');
    expect(g?.status).toBe('scheduled');
    expect(g?.first_seen_at).toBe(T0);
    expect(g?.last_seen_at).toBe(T0);
    expect(g?.updated_at).toBe(T0);

    const l = await lineRow('nfl:401872925');
    expect(l?.provider).toBe('DraftKings');
    expect(l?.spread_home_tenths).toBe(-35);
    expect(l?.spread_home_price).toBe(-112);
    expect(l?.spread_away_tenths).toBe(35);
    expect(l?.total_tenths).toBe(505);
    expect(l?.ml_home_price).toBe(-198);
    expect(l?.ml_away_price).toBe(164);
    expect(l?.captured_at).toBe(T0);
    expect(l?.seen_at).toBe(T0);

    expect(await lineRow('nfl:2')).toBeNull();
  });

  it('a second run with an IDENTICAL slate changes nothing at all', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);
    const before = await gameRow('nfl:401872925');
    const beforeLine = await lineRow('nfl:401872925');

    const again = await ingestSlate([BASE_SPEC], T0 + 15 * MIN, t);
    expect(again.gamesUpserted).toBe(0);
    expect(again.linesUpserted).toBe(0);
    expect(again.rowsSkipped).toBe(2);
    expect(await gameRow('nfl:401872925')).toEqual(before);
    expect(await lineRow('nfl:401872925')).toEqual(beforeLine);
  });

  it('a line that disappears leaves the game_lines row in place, going stale', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);
    // Kickoff: ESPN removes the odds block entirely (0 of 84 started events
    // carried odds in the committed samples).
    await ingestSlate([spec({ status: 'in', odds: undefined })], T0 + HOUR, t);
    const l = await lineRow('nfl:401872925');
    expect(l).not.toBeNull();
    expect(l?.spread_home_tenths).toBe(-35);
    expect(l?.seen_at).toBe(T0); // stops advancing — that is the staleness signal
    expect(l?.captured_at).toBe(T0);
  });

  it('NEVER regresses a final game back to scheduled', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ status: 'post', homeScore: 27, awayScore: 24 })], T0, t);
    expect((await gameRow('nfl:401872925'))?.status).toBe('final');

    // ESPN glitches and reports the played game as scheduled again.
    const res = await ingestSlate(
      [spec({ status: 'pre', homeScore: 0, awayScore: 0 })],
      T0 + HOUR,
      t,
    );
    expect(res.gamesUpserted).toBe(0);
    const g = await gameRow('nfl:401872925');
    expect(g?.status).toBe('final');
    expect(g?.home_score).toBe(27);
    expect(g?.away_score).toBe(24);
  });

  it('applies a SCORE CORRECTION on a final game (clause (a) allows final -> final)', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ status: 'post', homeScore: 27, awayScore: 24 })], T0, t);
    const res = await ingestSlate(
      [spec({ status: 'post', homeScore: 28, awayScore: 24 })],
      T0 + HOUR,
      t,
    );
    expect(res.gamesUpserted).toBe(1);
    const g = await gameRow('nfl:401872925');
    expect(g?.home_score).toBe(28);
    expect(g?.updated_at).toBe(T0 + HOUR);
  });

  it('NEVER nulls out an existing score when the payload omits it', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ status: 'in', homeScore: 14, awayScore: 10 })], T0, t);
    await ingestSlate([spec({ status: 'in', omitScores: true })], T0 + 15 * MIN, t);
    const g = await gameRow('nfl:401872925');
    expect(g?.home_score).toBe(14);
    expect(g?.away_score).toBe(10);
  });

  it('writes original_kickoff_at once and never updates it; kickoff_at follows ESPN', async () => {
    const t = await sundayNflTarget();
    const original = Date.parse('2026-09-13T17:00Z');
    await ingestSlate([BASE_SPEC], T0, t);
    expect((await gameRow('nfl:401872925'))?.original_kickoff_at).toBe(original);

    const moved = Date.parse('2026-09-13T20:05Z');
    const res = await ingestSlate([spec({ kickoffAt: moved })], T0 + HOUR, t);
    expect(res.gamesUpserted).toBe(1);
    const g = await gameRow('nfl:401872925');
    expect(g?.kickoff_at).toBe(moved);
    expect(g?.original_kickoff_at).toBe(original);
    expect(g?.updated_at).toBe(T0 + HOUR);
  });

  it('a game that VANISHES from the feed is left untouched, never deleted', async () => {
    const t = await sundayNflTarget();
    await ingestSlate(
      [BASE_SPEC, spec({ eventId: '999', homeAbbr: 'GB', awayAbbr: 'CHI' })],
      T0,
      t,
    );
    const vanished = await gameRow('nfl:999');
    expect(vanished).not.toBeNull();

    await ingestSlate([BASE_SPEC], T0 + HOUR, t);
    const after = await gameRow('nfl:999');
    expect(after).toEqual(vanished); // same row, same last_seen_at
  });

  it('a malformed event is skipped and recorded as a warning; good events still land', async () => {
    const t = await sundayNflTarget();
    espn.setResponder(t.key, () => {
      const good = (buildScoreboard([BASE_SPEC]) as { events: unknown[] }).events;
      return new Response(
        JSON.stringify({ events: [...good, { id: 'broken-1' }, null, 'garbage'] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await ingestTarget(env, new EspnProvider(env), t, T0);
    expect(res.error).toBeNull();
    expect(res.gamesUpserted).toBe(1);
    expect(res.warnings.length).toBeGreaterThanOrEqual(3);
    expect(await gameRow('nfl:401872925')).not.toBeNull();
  });

  it('a pre-game score of the STRING "0" is stored as 0, not nulled', async () => {
    await ingestSlate([spec({ homeScoreRaw: '0', awayScoreRaw: '0' })], T0);
    const g = await gameRow('nfl:401872925');
    expect(g?.home_score).toBe(0);
    expect(g?.away_score).toBe(0);
  });

  it('a missing score field is stored as NULL', async () => {
    await ingestSlate([spec({ omitScores: true })], T0);
    const g = await gameRow('nfl:401872925');
    expect(g?.home_score).toBeNull();
    expect(g?.away_score).toBeNull();
  });

  it('a non-numeric score string is stored as NULL', async () => {
    await ingestSlate([spec({ homeScoreRaw: 'TBD', awayScoreRaw: '' })], T0);
    const g = await gameRow('nfl:401872925');
    expect(g?.home_score).toBeNull();
    expect(g?.away_score).toBeNull();
  });

  it('neutralSite true/false/absent all map correctly', async () => {
    // `neutral_site` is INSERT-only: it is not in §8.5's DO UPDATE SET list, so
    // each case needs its own event rather than a second pass over one.
    const t = await sundayNflTarget();
    await ingestSlate(
      [
        spec({ eventId: '1', neutralSite: true }),
        spec({ eventId: '2', neutralSite: false, homeAbbr: 'GB', awayAbbr: 'CHI' }),
      ],
      T0,
      t,
    );
    expect((await gameRow('nfl:1'))?.neutral_site).toBe(1);
    expect((await gameRow('nfl:2'))?.neutral_site).toBe(0);

    // Absent => false (PLAN.md §8.3).
    espn.setResponder(t.key, () => {
      const payload = buildScoreboard([spec({ eventId: '777' })]) as {
        events: { competitions: Record<string, unknown>[] }[];
      };
      delete payload.events[0]?.competitions[0]?.['neutralSite'];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await ingestTarget(env, new EspnProvider(env), t, T0 + 2 * HOUR);
    expect((await gameRow('nfl:777'))?.neutral_site).toBe(0);
  });

  it('a team missing abbreviation or displayName skips the event with a warning', async () => {
    const t = await sundayNflTarget();
    espn.setResponder(t.key, () => {
      const payload = buildScoreboard([BASE_SPEC]) as {
        events: { competitions: { competitors: { team: Record<string, unknown> }[] }[] }[];
      };
      const team = payload.events[0]?.competitions[0]?.competitors[0]?.team;
      if (team !== undefined) delete team['abbreviation'];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await ingestTarget(env, new EspnProvider(env), t, T0);
    expect(res.gamesUpserted).toBe(0);
    expect(res.warnings.length).toBe(1);
    expect(await gameRow('nfl:401872925')).toBeNull();
  });

  it('records games_seen and clears the failure counters on success', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC, spec({ eventId: '2' })], T0, t);
    const row = await targetDbRow(t.id);
    expect(row?.games_seen).toBe(2);
    expect(row?.last_status).toBe('ok');
    expect(row?.last_error).toBeNull();
    expect(row?.consecutive_failures).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * upstream failures (PLAN.md §14.8)
 * ------------------------------------------------------------------ */

describe('upstream failures leave the database untouched', () => {
  const failures: readonly [string, () => Response | Promise<Response>][] = [
    ['a non-200 response', () => new Response('upstream is sad', { status: 503 })],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
    [
      'garbage JSON',
      () =>
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ];

  for (const [label, responder] of failures) {
    it(`${label} leaves the database completely untouched`, async () => {
      const t = await sundayNflTarget();
      await ingestSlate([BASE_SPEC], T0, t);
      const before = await gameRow('nfl:401872925');
      const beforeLine = await lineRow('nfl:401872925');

      espn.setResponder(t.key, responder);
      const res = await ingestTarget(env, new EspnProvider(env), t, T0 + HOUR);
      expect(res.error).not.toBeNull();
      expect(res.gamesUpserted).toBe(0);
      expect(res.linesUpserted).toBe(0);
      expect(await gameRow('nfl:401872925')).toEqual(before);
      expect(await lineRow('nfl:401872925')).toEqual(beforeLine);

      const row = await targetDbRow(t.id);
      expect(row?.last_status).toBe('error');
      expect(row?.consecutive_failures).toBe(1);
      expect(row?.next_run_at).toBe(T0 + HOUR + 15 * MIN);
    });
  }

  it('a failing target is reported in job_runs.stats, and the run itself stays ok', async () => {
    await planTargets(env, T0);
    const key = etDateKey(T0);
    espn.setResponder(key, () => new Response('nope', { status: 500 }));
    const run = await runJob(env, 'refresh', 'cron', T0);
    expect(run.status).toBe('ok');
    const failuresStat = run.stats?.['failures'] as readonly { targetId: string }[] | undefined;
    expect(failuresStat?.length).toBeGreaterThanOrEqual(1);
  });

  it('parser warnings land in job_runs.stats, capped at ESPN_MAX_WARNINGS_RECORDED', async () => {
    await planTargets(env, T0);
    const broken = Array.from({ length: 40 }, (_, i) => ({ id: `bad-${String(i)}` }));
    for (const key of etDateKeyRange(T0, T0 + INGEST_WINDOW_MS)) {
      espn.setResponder(
        key,
        () =>
          new Response(JSON.stringify({ events: broken }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
    }
    const run = await runJob(env, 'refresh', 'cron', T0);
    const warnings = run.stats?.['warnings'] as readonly string[] | undefined;
    expect(warnings?.length).toBeGreaterThan(0);
    expect(warnings?.length).toBeLessThanOrEqual(ESPN_MAX_WARNINGS_RECORDED);
  });
});

/* ------------------------------------------------------------------ *
 * write-budget levers (PLAN.md §8.6)
 * ------------------------------------------------------------------ */

describe('write budget levers (PLAN.md §8.6)', () => {
  it('L1: re-ingesting an UNCHANGED slate writes ZERO rows (meta.changes === 0)', async () => {
    const slate = makeSlate([BASE_SPEC], 'nfl', T0);
    const first = await upsertSlate(env, slate, T0);
    expect(first.games).toBe(1);
    expect(first.lines).toBe(1);

    // Identical payload, 15 minutes later: the touch intervals have not elapsed.
    const again = await upsertSlate(
      env,
      makeSlate([BASE_SPEC], 'nfl', T0 + 15 * MIN),
      T0 + 15 * MIN,
    );
    expect(again.games).toBe(0);
    expect(again.lines).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it('L1: only the games whose score/status/kickoff actually changed are written', async () => {
    const before = [
      spec({ eventId: '1', status: 'in', homeScore: 7, awayScore: 0, odds: undefined }),
      spec({ eventId: '2', status: 'in', homeScore: 3, awayScore: 3, odds: undefined }),
      spec({ eventId: '3', status: 'in', homeScore: 0, awayScore: 0, odds: undefined }),
    ];
    await upsertSlate(env, makeSlate(before, 'nfl', T0), T0);

    const after = [
      before[0]!,
      spec({ eventId: '2', status: 'in', homeScore: 10, awayScore: 3, odds: undefined }),
      before[2]!,
    ];
    const res = await upsertSlate(env, makeSlate(after, 'nfl', T0 + 15 * MIN), T0 + 15 * MIN);
    expect(res.games).toBe(1);
    expect((await gameRow('nfl:2'))?.home_score).toBe(10);
    expect((await gameRow('nfl:1'))?.last_seen_at).toBe(T0);
  });

  it('L1: status_detail alone is deliberately NOT enough to trigger a write', async () => {
    // PLAN.md §8.5: `status_detail` is in the SET list but not the comparison
    // tuple — it is cosmetic, and including it would cost writes for no gain.
    const t = await sundayNflTarget();
    await ingestSlate([spec({ status: 'post', homeScore: 27, awayScore: 24 })], T0, t);
    espn.setResponder(t.key, () => {
      const payload = buildScoreboard([spec({ status: 'post', homeScore: 27, awayScore: 24 })]) as {
        events: { competitions: { status: { type: Record<string, unknown> } }[] }[];
      };
      const type = payload.events[0]?.competitions[0]?.status.type;
      if (type !== undefined) type['detail'] = 'Final/OT';
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await ingestTarget(env, new EspnProvider(env), t, T0 + 15 * MIN);
    expect(res.gamesUpserted).toBe(0);
    expect((await gameRow('nfl:401872925'))?.status_detail).toBe('Final');
  });

  it('L2: a slate of in_progress/final games writes ZERO game_lines rows', async () => {
    const live = [
      spec({ eventId: '1', status: 'in', homeScore: 7, awayScore: 3 }),
      spec({ eventId: '2', status: 'post', homeScore: 21, awayScore: 20 }),
    ];
    // The builder still attaches an odds block; the MAPPER is what must drop it.
    const slate = makeSlate(live, 'nfl', T0);
    expect(slate.lines).toHaveLength(2);
    expect(lineRowsWorthWriting(slate)).toHaveLength(0);

    const res = await upsertSlate(env, slate, T0);
    expect(res.games).toBe(2);
    expect(res.lines).toBe(0);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM game_lines').first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it('L2: only `scheduled` games keep their line rows', () => {
    const slate = makeSlate(
      [
        spec({ eventId: '1', status: 'pre' }),
        spec({ eventId: '2', status: 'in' }),
        spec({ eventId: '3', status: 'post' }),
        spec({ eventId: '4', status: 'postponed' }),
        spec({ eventId: '5', status: 'canceled' }),
      ],
      'nfl',
      T0,
    );
    expect(lineRowsWorthWriting(slate).map((l) => l.gameId)).toEqual(['nfl:1']);
  });

  it('L3: last_seen_at is only bumped when older than GAME_SEEN_TOUCH_MS', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ odds: undefined })], T0, t);

    // One ms short of the interval: nothing is written.
    const early = await ingestSlate([spec({ odds: undefined })], T0 + GAME_SEEN_TOUCH_MS - 1, t);
    expect(early.gamesUpserted).toBe(0);
    expect((await gameRow('nfl:401872925'))?.last_seen_at).toBe(T0);

    // Past the interval: exactly one write, and it is a TOUCH.
    const late = await ingestSlate([spec({ odds: undefined })], T0 + GAME_SEEN_TOUCH_MS + 1, t);
    expect(late.gamesUpserted).toBe(1);
    expect((await gameRow('nfl:401872925'))?.last_seen_at).toBe(T0 + GAME_SEEN_TOUCH_MS + 1);
  });

  it('L3: an L3 touch moves last_seen_at but NOT updated_at', async () => {
    // §8.5: `updated_at` means "data changed", not "seen again". Without this,
    // §7.1's resetDeferredBets would hand a permanently-ungradeable bet a fresh
    // 24 h budget every 6 hours and MAX_SETTLE_ATTEMPTS could never fire.
    const t = await sundayNflTarget();
    await ingestSlate([spec({ odds: undefined })], T0, t);
    const touchAt = T0 + GAME_SEEN_TOUCH_MS + 1;
    await ingestSlate([spec({ odds: undefined })], touchAt, t);
    const g = await gameRow('nfl:401872925');
    expect(g?.last_seen_at).toBe(touchAt);
    expect(g?.updated_at).toBe(T0);
  });

  it('L3: game_lines.seen_at is only bumped when older than LINE_SEEN_TOUCH_MS', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);

    const early = await ingestSlate([BASE_SPEC], T0 + LINE_SEEN_TOUCH_MS - 1, t);
    expect(early.linesUpserted).toBe(0);
    expect((await lineRow('nfl:401872925'))?.seen_at).toBe(T0);

    const late = await ingestSlate([BASE_SPEC], T0 + LINE_SEEN_TOUCH_MS + 1, t);
    expect(late.linesUpserted).toBe(1);
    expect((await lineRow('nfl:401872925'))?.seen_at).toBe(T0 + LINE_SEEN_TOUCH_MS + 1);
  });

  it('captured_at moves ONLY when a price changed; seen_at moves on confirmation', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);

    // A pure confirmation past the touch interval: seen_at moves, captured_at not.
    const touchAt = T0 + LINE_SEEN_TOUCH_MS + 1;
    await ingestSlate([BASE_SPEC], touchAt, t);
    let l = await lineRow('nfl:401872925');
    expect(l?.seen_at).toBe(touchAt);
    expect(l?.captured_at).toBe(T0);

    // A real price move: both advance.
    const moveAt = touchAt + MIN;
    const moved = spec({
      odds: { ...BASE_ODDS, spreadHome: -4.5 },
    });
    const res = await ingestSlate([moved], moveAt, t);
    expect(res.linesUpserted).toBe(1);
    l = await lineRow('nfl:401872925');
    expect(l?.spread_home_tenths).toBe(-45);
    expect(l?.spread_away_tenths).toBe(45);
    expect(l?.captured_at).toBe(moveAt);
    expect(l?.seen_at).toBe(moveAt);
  });

  it('a stale seen_at makes the market unbettable even though captured_at is old', async () => {
    // Bettability is `now - seen_at > LINE_STALE_MS`, which is why the
    // compare-and-skip upsert must still touch seen_at every 45 minutes.
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);
    const l = await lineRow('nfl:401872925');
    const staleAt = T0 + 3 * HOUR + MIN;
    expect(staleAt - (l?.seen_at ?? 0)).toBeGreaterThan(3 * HOUR);
    // ...and a confirmation inside the window keeps it fresh.
    await ingestSlate([BASE_SPEC], T0 + LINE_SEEN_TOUCH_MS + 1, t);
    const fresh = await lineRow('nfl:401872925');
    expect(staleAt - (fresh?.seen_at ?? 0)).toBeLessThan(3 * HOUR);
  });

  it('BUDGET: 96 live refreshes of an 86-game CFB Saturday write < 5,000 rows', async () => {
    // The regression guard §8.6 promises. Without L1/L2/L3 this is ~45,000
    // meta.changes; with them it is the ~30 genuine per-game transitions.
    const GAMES = 86;
    const base: EventSpec[] = Array.from({ length: GAMES }, (_, i) => ({
      eventId: `cfb-${String(i)}`,
      league: 'ncaaf' as const,
      kickoffAt: T0 - HOUR,
      status: 'in' as const,
      homeAbbr: `H${String(i)}`,
      awayAbbr: `A${String(i)}`,
      homeScore: 0,
      awayScore: 0,
      period: 1,
      displayClock: '15:00',
      // ESPN strips odds at kickoff, but keep them attached to prove L2 drops
      // them at the mapper rather than relying on the feed.
      odds: { spreadHome: -3.5, total: 50.5, mlHome: -180, mlAway: 150 },
    }));

    let games = 0;
    let lines = 0;
    // The slate is a pure function of `step`, so two consecutive runs inside the
    // same step are byte-identical and MUST write nothing. A real score/clock
    // transition lands every third refresh — the §8.6 model of "~30 genuine
    // transitions per game across a live Saturday".
    const step = (run: number): number => (run - (run % 3)) / 3;
    const transitions = step(95); // 31 transitions after the initial insert
    for (let run = 0; run < 96; run += 1) {
      const now = T0 + run * 15 * MIN;
      const s = step(run);
      const slate = makeSlate(
        base.map((e) => ({
          ...e,
          homeScore: s,
          displayClock: `${String(15 - (s % 15))}:00`,
        })),
        'ncaaf',
        now,
      );
      const res = await upsertSlate(env, slate, now);
      games += res.games;
      lines += res.lines;
    }

    expect(lines).toBe(0); // L2: not one line row for a live slate
    expect(games).toBeLessThan(5_000);
    // ...and it is not trivially small either: the real transitions DO land.
    expect(games).toBe(GAMES * (1 + transitions));
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * computeNextRunAt (PLAN.md §8.4)
 * ------------------------------------------------------------------ */

describe('computeNextRunAt', () => {
  const target: IngestTargetRow = {
    id: 'nfl:date:20260913',
    league: 'nfl',
    kind: 'date',
    key: '20260913',
    windowStartAt: T0 - 12 * HOUR,
    windowEndAt: T0 + 12 * HOUR,
    priority: 100,
    nextRunAt: T0,
    consecutiveFailures: 0,
  };

  it('live or < 3h out -> +15 min', () => {
    const live = makeSlate([spec({ status: 'in', kickoffAt: T0 - HOUR })], 'nfl', T0);
    expect(computeNextRunAt(target, live, false, T0)).toBe(T0 + 15 * MIN);

    const soon = makeSlate([spec({ status: 'pre', kickoffAt: T0 + 2 * HOUR })], 'nfl', T0);
    expect(computeNextRunAt(target, soon, false, T0)).toBe(T0 + 15 * MIN);
  });

  it('< 48h out -> +60 min', () => {
    const slate = makeSlate([spec({ status: 'pre', kickoffAt: T0 + 30 * HOUR })], 'nfl', T0);
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 60 * MIN);
  });

  it('far out -> +6h', () => {
    const slate = makeSlate([spec({ status: 'pre', kickoffAt: T0 + 8 * DAY })], 'nfl', T0);
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 6 * HOUR);
  });

  it('an EMPTY slate (no lines posted yet) is line discovery -> +6h', () => {
    expect(computeNextRunAt(target, makeSlate([], 'nfl', T0), false, T0)).toBe(T0 + 6 * HOUR);
  });

  it('all final -> +24h', () => {
    const slate = makeSlate(
      [
        spec({ eventId: '1', status: 'post', kickoffAt: T0 - 4 * HOUR }),
        spec({ eventId: '2', status: 'canceled', kickoffAt: T0 - HOUR }),
      ],
      'nfl',
      T0,
    );
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 24 * HOUR);
  });

  it('a finished slate with ONE straggler still refreshes fast', () => {
    const slate = makeSlate(
      [
        spec({ eventId: '1', status: 'post', kickoffAt: T0 - 4 * HOUR }),
        spec({ eventId: '2', status: 'in', kickoffAt: T0 - HOUR }),
      ],
      'nfl',
      T0,
    );
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 15 * MIN);
  });

  it('failure -> exponential backoff capped at 6h', () => {
    const branches: readonly [number, number][] = [
      [0, 15 * MIN],
      [1, 30 * MIN],
      [2, 60 * MIN],
      [3, 120 * MIN],
      [4, 240 * MIN],
      [5, 6 * HOUR], // 480 min, capped
      [8, 6 * HOUR],
      [40, 6 * HOUR], // no overflow to Infinity
    ];
    for (const [failures, delay] of branches) {
      const t = { ...target, consecutiveFailures: failures };
      expect(computeNextRunAt(t, null, true, T0), `after ${String(failures)} failures`).toBe(
        T0 + delay,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * slot fairness (PLAN.md §8.4)
 * ------------------------------------------------------------------ */

/** Insert a minimal game row directly, to control a target's liveness. */
async function insertGame(
  id: string,
  league: League,
  kickoffAt: number,
  status: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO games (id, provider, provider_event_id, league, season, season_type, week,
       name, short_name, kickoff_at, original_kickoff_at, status, neutral_site,
       home_team_id, home_abbr, home_name, away_team_id, away_abbr, away_name,
       first_seen_at, last_seen_at, updated_at)
     VALUES (?, 'espn', ?, ?, 2026, 2, 1, 'n', 's', ?, ?, ?, 0,
       '1', 'HOM', 'Home', '2', 'AWY', 'Away', ?, ?, ?)`,
  )
    .bind(id, id, league, kickoffAt, kickoffAt, status, T0, T0, T0)
    .run();
}

describe('slot fairness (PLAN.md §8.4)', () => {
  it('slot 1 takes the most-due target overall', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
      .bind(T0 - HOUR, 'ncaaf:date:20260915')
      .run();
    const picked = await claimDueTargets(env, T0, 2, RESERVED_DISCOVERY_SLOTS);
    expect(picked[0]?.id).toBe('ncaaf:date:20260915');
  });

  it('slot 2 is RESERVED for the most-overdue target with no in-progress game', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    // Two live targets are the most due; a quiet one is due but less overdue.
    const live1 = await loadTarget('nfl:date:20260913');
    const live2 = await loadTarget('ncaaf:date:20260913');
    await insertGame('nfl:live1', 'nfl', live1.windowStartAt + HOUR, 'in_progress');
    await insertGame('ncaaf:live2', 'ncaaf', live2.windowStartAt + HOUR, 'in_progress');
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id IN (?, ?)')
      .bind(T0 - 2 * HOUR, live1.id, live2.id)
      .run();
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
      .bind(T0 - MIN, 'nfl:date:20260918')
      .run();

    const picked = await claimDueTargets(env, T0, 2, RESERVED_DISCOVERY_SLOTS);
    expect(picked).toHaveLength(2);
    // Slot 1: a live one. Slot 2: the discovery target, NOT the other live one.
    expect([live1.id, live2.id]).toContain(picked[0]?.id);
    expect(picked[1]?.id).toBe('nfl:date:20260918');
  });

  it('the reserved slot never re-picks slot 1s target (AND id <> :slot1Id)', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    // Exactly ONE due target, and it is not live — so it satisfies BOTH queries.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
      .bind(T0 - HOUR, 'nfl:date:20260916')
      .run();
    const picked = await claimDueTargets(env, T0, 2, RESERVED_DISCOVERY_SLOTS);
    expect(picked.map((t) => t.id)).toEqual(['nfl:date:20260916']);
  });

  it('the reserved slot falls through to the general queue when no non-live target is due', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    const live1 = await loadTarget('nfl:date:20260913');
    const live2 = await loadTarget('ncaaf:date:20260913');
    await insertGame('nfl:live1', 'nfl', live1.windowStartAt + HOUR, 'in_progress');
    await insertGame('ncaaf:live2', 'ncaaf', live2.windowStartAt + HOUR, 'in_progress');
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id IN (?, ?)')
      .bind(T0 - HOUR, live1.id, live2.id)
      .run();

    const picked = await claimDueTargets(env, T0, 2, RESERVED_DISCOVERY_SLOTS);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((t) => t.id))).toEqual(new Set([live1.id, live2.id]));
  });

  it('SLOT 1 IS NEVER RESERVED: a one-slot run still takes the most-due target', async () => {
    // `REFRESH_TARGETS_PER_RUN` is forced to 1 for an admin trigger (§9.3). If
    // the reservation ate that single slot, a live Saturday target would sit
    // unrefreshed for as long as any discovery target was due.
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    const live = await loadTarget('nfl:date:20260913');
    await insertGame('nfl:live1', 'nfl', live.windowStartAt + HOUR, 'in_progress');
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
      .bind(T0 - 2 * HOUR, live.id)
      .run();
    // A quiet discovery target is also due, just less overdue.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
      .bind(T0 - MIN, 'nfl:date:20260918')
      .run();

    const picked = await claimDueTargets(env, T0, 1, RESERVED_DISCOVERY_SLOTS);
    expect(picked.map((t) => t.id)).toEqual([live.id]);
  });

  it('with a live CFB AND a live NFL target, discovery targets are not starved', async () => {
    await planTargets(env, T0);
    const live1 = await loadTarget('nfl:date:20260913');
    const live2 = await loadTarget('ncaaf:date:20260913');
    await insertGame('nfl:live1', 'nfl', live1.windowStartAt + HOUR, 'in_progress');
    await insertGame('ncaaf:live2', 'ncaaf', live2.windowStartAt + HOUR, 'in_progress');

    // Simulate a full day of runs: the two live targets stay perpetually due,
    // every other target reschedules itself to +6h after it is picked.
    const seen = new Set<string>();
    for (let run = 0; run < 96; run += 1) {
      const now = T0 + run * 15 * MIN;
      await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id IN (?, ?)')
        .bind(now, live1.id, live2.id)
        .run();
      const picked = await claimDueTargets(env, now, 2, RESERVED_DISCOVERY_SLOTS);
      for (const t of picked) {
        seen.add(t.id);
        await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
          .bind(now + 6 * HOUR, t.id)
          .run();
      }
    }
    // Every one of the 22 targets got at least one slot during the day.
    expect(seen.size).toBe(22);
  }, 120_000);

  it('two simultaneously-live targets alternate in slot 1 (30-minute cadence each)', async () => {
    await planTargets(env, T0);
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + DAY)
      .run();
    const live1 = await loadTarget('nfl:date:20260913');
    const live2 = await loadTarget('ncaaf:date:20260913');
    await insertGame('nfl:live1', 'nfl', live1.windowStartAt + HOUR, 'in_progress');
    await insertGame('ncaaf:live2', 'ncaaf', live2.windowStartAt + HOUR, 'in_progress');
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id IN (?, ?)')
      .bind(T0, live1.id, live2.id)
      .run();

    const slot1: string[] = [];
    for (let run = 0; run < 4; run += 1) {
      const now = T0 + run * 15 * MIN;
      const picked = await claimDueTargets(env, now, 2, RESERVED_DISCOVERY_SLOTS);
      const first = picked[0];
      if (first === undefined) break;
      slot1.push(first.id);
      await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ? WHERE id = ?')
        .bind(now + 15 * MIN, first.id)
        .run();
    }
    // Each live target appears every other run => a 30-minute cadence each.
    expect(new Set(slot1)).toEqual(new Set([live1.id, live2.id]));
    expect(slot1[0]).toBe(slot1[2]);
    expect(slot1[1]).toBe(slot1[3]);
  });
});

/* ------------------------------------------------------------------ *
 * runRefresh
 * ------------------------------------------------------------------ */

describe('runRefresh', () => {
  it('plans, fetches and upserts in one pass and reports its stats', async () => {
    const key = etDateKey(T0);
    espn.set(key, [BASE_SPEC]);
    const stats = await runRefresh(env, T0, 2);
    expect(stats.targetsProcessed).toBe(2);
    expect(stats.failures).toEqual([]);
    expect(stats.gamesUpserted).toBeGreaterThanOrEqual(1);
    // Which of the 22 equally-due targets slot 1 draws is decided by the
    // deterministic `priority, next_run_at, id` order, so assert the event
    // landed rather than pinning which league's target fetched it.
    const row = await env.DB.prepare('SELECT id FROM games').first<{ id: string }>();
    expect(row?.id).toMatch(/^(nfl|ncaaf):401872925$/);
  });

  it('honours REFRESH_TARGETS_PER_RUN', async () => {
    await planTargets(env, T0);
    const stats = await runRefresh(env, T0, 1);
    expect(stats.targetsProcessed).toBe(1);
    expect(espn.callCount).toBe(1);
  });

  it('reschedules every processed target so the next run picks different ones', async () => {
    await planTargets(env, T0);
    await runRefresh(env, T0, 2);
    const due = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM ingest_targets WHERE next_run_at <= ?',
    )
      .bind(T0)
      .first<{ n: number }>();
    expect(due?.n).toBe(20);
  });

  it('the whole refresh is idempotent: a second identical run writes zero rows', async () => {
    const key = etDateKey(T0);
    espn.set(key, [BASE_SPEC]);
    await runRefresh(env, T0, 2);
    // Force the same two targets to be due again, unchanged upstream.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + MIN)
      .run();
    const again = await runRefresh(env, T0 + MIN, 2);
    expect(again.gamesUpserted).toBe(0);
    expect(again.linesUpserted).toBe(0);
  });
});
