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
import { boardWindowEnd, etDateKey, etDateKeyRange } from '../../src/shared/time.js';
import type { Game, GameLines, League } from '../../src/shared/types.js';
import {
  buildScoreboardUrl,
  EspnProvider,
  ESPN_USER_AGENT,
  fetchScoreboard,
} from '../../src/worker/espn.js';
import {
  claimDueTargets,
  computeNextRunAt,
  GAME_LIVE_SQL,
  ingestTarget,
  lineGapsOf,
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
/**
 * Sunday 21:00 ET: BOTH leagues have rolled over (PLAN.md §22), so a plan at
 * this instant holds the widest queue — 9 dates per league, 18 targets — which
 * is what the slot-fairness tests need (they name dates up to the 18th).
 */
const SUN_NIGHT = Date.parse('2026-09-14T01:00:00Z');
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
  rowsWritten: number;
  rowsSkipped: number;
  error: string | null;
}> {
  const t = target ?? (await sundayNflTarget());
  espn.set(t.key, events);
  const result = await ingestTarget(env, new EspnProvider(env), t, now);
  return {
    gamesUpserted: result.gamesUpserted,
    linesUpserted: result.linesUpserted,
    rowsWritten: result.rowsWritten,
    rowsSkipped: result.rowsSkipped,
    error: result.error,
  };
}

/* ------------------------------------------------------------------ *
 * rows_written instrumentation
 *
 * `upsertSlate` reports rowsWritten itself, but the point of §8.6 is that the
 * PRODUCTION accounting must not be the only witness to its own correctness. So
 * these tests wrap `env.DB.batch` and total `meta.rows_written` independently,
 * and cross-check the two. `meta.rows_written` counts the TABLE row PLUS every
 * INDEX entry the statement rewrote, which is the unit D1's 100k/day cap counts.
 * ------------------------------------------------------------------ */

interface BatchProbe {
  /** Rows written by every batched statement since the last `reset()`. */
  readonly rows: number;
  reset(): void;
  restore(): void;
}

function probeBatchRows(): BatchProbe {
  const realBatch = env.DB.batch.bind(env.DB);
  let rows = 0;
  env.DB.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const results = await realBatch<T>(statements);
    for (const r of results) {
      const meta: { rows_written?: unknown; changes?: unknown } = r.meta;
      // Fall back to `changes` if a future runtime stops reporting the field —
      // an under-count is a visible test failure, a silent zero is not.
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
    reset() {
      rows = 0;
    },
    restore() {
      env.DB.batch = realBatch;
    },
  };
}

/* ------------------------------------------------------------------ *
 * fixture conformance (PLAN.md §13)
 * ------------------------------------------------------------------ */

describe('ESPN request headers', () => {
  it('sends the exact ESPN_USER_AGENT and an application/json accept on every upstream call', async () => {
    // ESPN's edge returns 403 for an empty User-Agent and for several other
    // shapes (see src/worker/espn.ts); this pins that the constant reaches fetch.
    const espn = stubEspn({ '20260913': [] });
    try {
      await fetchScoreboard(
        'https://espn.test',
        'nfl',
        { kind: 'date', dateKey: '20260913' },
        1_789_300_000_000,
      );
      expect(espn.requestHeaders).toHaveLength(1);
      expect(espn.requestHeaders[0]?.['user-agent']).toBe(ESPN_USER_AGENT);
      expect(espn.requestHeaders[0]?.['accept']).toBe('application/json');
      expect(ESPN_USER_AGENT).toMatch(
        /^SpicyBettingSimulator\/\d+\.\d+ \(\+https:\/\/github\.com\//,
      );
    } finally {
      espn.restore();
    }
  });
});

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
        conferenceId: null, // no team.conferenceId in the NFL shape
        score: 0, // the pre-game STRING "0" is 0, never null
      },
      away: {
        teamId: parsed.games[0]?.away.teamId ?? '',
        abbr: 'TB',
        name: 'TB Full Name',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/tb.png',
        rank: null,
        conferenceId: null,
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
  it("creates one DATE target per ET calendar day of EACH league's own window (PLAN.md §22)", async () => {
    await planTargets(env, T0);
    const rows = await env.DB.prepare(
      'SELECT league, kind, key FROM ingest_targets ORDER BY key, league',
    ).all<{ league: string; kind: string; key: string }>();
    expect(rows.results.every((r) => r.kind === 'date')).toBe(true);
    for (const league of ['nfl', 'ncaaf'] as const) {
      const keys = etDateKeyRange(T0, boardWindowEnd(league, T0));
      expect(rows.results.filter((r) => r.league === league).map((r) => r.key)).toEqual(keys);
    }
  });

  it('T0 is a Sunday at noon ET: 2 NFL dates + 9 CFB dates = 11 targets — the leagues are planned SEPARATELY', async () => {
    // CFB rolled over at Sunday 00:00 ET, so its window already reaches the
    // Monday after next; the NFL rolls at 20:00 ET, so it still ends tomorrow.
    expect(etDateKeyRange(T0, boardWindowEnd('nfl', T0))).toEqual(['20260913', '20260914']);
    expect(etDateKeyRange(T0, boardWindowEnd('ncaaf', T0))).toHaveLength(9);
    const created = await planTargets(env, T0);
    expect(created).toBe(11);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_targets').first<{
      n: number;
    }>();
    expect(row?.n).toBe(11);
  });

  it('a Tuesday plans 7 dates x 2 leagues = 14 targets, and is idempotent', async () => {
    const tue = Date.parse('2026-09-15T16:00:00Z'); // Tue 12:00 ET
    expect(await planTargets(env, tue)).toBe(14);
    expect(await planTargets(env, tue + MIN)).toBe(0);
  });

  it('a Monday plans 8 dates per league, creates none it did not create on Sunday night, and deletes nothing', async () => {
    const sunNight = Date.parse('2026-09-14T01:00:00Z'); // Sun 21:00 ET, both leagues rolled over
    expect(await planTargets(env, sunNight)).toBe(18); // 9 + 9
    const mon = Date.parse('2026-09-14T16:00:00Z'); // Mon 12:00 ET
    expect(etDateKeyRange(mon, boardWindowEnd('nfl', mon))).toHaveLength(8);
    expect(await planTargets(env, mon)).toBe(0);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_targets').first<{
      n: number;
    }>();
    expect(row?.n).toBe(18);
  });

  it('never plans past INGEST_WINDOW_MS, the hard ceiling', async () => {
    await planTargets(env, T0);
    const row = await env.DB.prepare('SELECT MAX(window_end_at) AS m FROM ingest_targets').first<{
      m: number;
    }>();
    expect(row?.m).toBeLessThanOrEqual(T0 + INGEST_WINDOW_MS + DAY);
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
    expect(rows.results).toHaveLength(11);
    expect(new Set(rows.results.map((r) => r.id)).size).toBe(11);
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
    expect(await planTargets(env, T0)).toBe(11);
    expect(await planTargets(env, T0 + MIN)).toBe(0);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_targets').first<{
      n: number;
    }>();
    expect(row?.n).toBe(11);
  });

  it("a rerun on Monday adds the NFL's seven new dates and nothing for CFB, which rolled on Sunday", async () => {
    await planTargets(env, T0);
    // Monday noon ET: the NFL window is now the following Monday (0914…0921);
    // CFB already had 0913…0921 since Sunday 00:00 ET.
    expect(await planTargets(env, T0 + DAY)).toBe(7);
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

  it('at most 16 discovery targets at +6h need 64 slot-uses/day against a supply of 96 (PLAN.md §8.4/§22)', () => {
    // The §8.4 budget check, as arithmetic rather than prose. The widest window
    // is 9 ET dates per league, on a Sunday after both rollovers.
    const sunNight = Date.parse('2026-09-14T01:00:00Z');
    const targets =
      etDateKeyRange(sunNight, boardWindowEnd('nfl', sunNight)).length +
      etDateKeyRange(sunNight, boardWindowEnd('ncaaf', sunNight)).length;
    expect(targets).toBe(18);
    const discovery = targets - 2; // worst case: two live targets hold slot 1
    const slotUsesPerDay = discovery * (DAY / (6 * HOUR));
    const supply = (DAY / (15 * MIN)) * RESERVED_DISCOVERY_SLOTS;
    expect(slotUsesPerDay).toBe(64);
    expect(supply).toBe(96);
    expect(slotUsesPerDay).toBeLessThan(supply);
  });

  it('ROLLOVER BURST: the seven new CFB dates are created at once and drained a run at a time (PLAN.md §22.6)', async () => {
    const satNight = Date.parse('2026-09-13T03:30:00Z'); // Sat 23:30 ET
    await planTargets(env, satNight);
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ingest_targets WHERE league = 'ncaaf'",
    ).first<{ n: number }>();
    expect(before?.n).toBe(3); // 0912, 0913, 0914

    const sunEarly = Date.parse('2026-09-13T04:15:00Z'); // Sun 00:15 ET — rolled over
    expect(await planTargets(env, sunEarly)).toBe(7); // 0915…0921, CFB only
    for (const key of etDateKeyRange(sunEarly, boardWindowEnd('ncaaf', sunEarly)))
      espn.set(key, []);
    for (const key of etDateKeyRange(sunEarly, boardWindowEnd('nfl', sunEarly))) espn.set(key, []);

    const newIds = etDateKeyRange(
      Date.parse('2026-09-15T16:00:00Z'),
      boardWindowEnd('ncaaf', sunEarly),
    ).map((k) => `ncaaf:date:${k}`);
    expect(newIds).toHaveLength(7);
    let claimedSoFar = 0;
    for (let run = 1; run <= 7; run += 1) {
      const now = sunEarly + run * 15 * MIN;
      const stats = await runRefresh(env, now, 2);
      expect(stats.targetsProcessed).toBeLessThanOrEqual(2);
      const done = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ingest_targets WHERE id IN (${newIds.map(() => '?').join(',')}) AND last_run_at IS NOT NULL`,
      )
        .bind(...newIds)
        .first<{ n: number }>();
      expect((done?.n ?? 0) - claimedSoFar).toBeLessThanOrEqual(2);
      claimedSoFar = done?.n ?? 0;
    }
    expect(claimedSoFar).toBe(7);
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
 * line gaps — the board-coverage measurement (PLAN.md §8.3)
 * ------------------------------------------------------------------ */

describe('line gaps', () => {
  const gaps = (specs: readonly EventSpec[]): ReturnType<typeof lineGapsOf> =>
    lineGapsOf(makeSlate(specs, 'nfl', T0), T0);

  it('counts upcoming games with no line or a missing market, per market, naming each', () => {
    expect(
      gaps([
        BASE_SPEC,
        spec({ eventId: '2', homeAbbr: 'BUF', awayAbbr: 'NYJ', odds: undefined }),
        spec({ eventId: '3', homeAbbr: 'DAL', awayAbbr: 'PHI', odds: { spreadHome: -3.5 } }),
        spec({
          eventId: '4',
          homeAbbr: 'SEA',
          awayAbbr: 'LAR',
          odds: { mlHome: -150, mlAway: 130 },
        }),
      ]),
    ).toEqual({
      upcomingGames: 4,
      lineGaps: 3,
      noLine: 1,
      noSpread: 1,
      noTotal: 2,
      noMoneyline: 1,
      lineGapDetails: [
        'NYJ @ BUF: no line',
        'PHI @ DAL: no total, no moneyline',
        'LAR @ SEA: no spread, no total',
      ],
    });
  });

  it('only SCHEDULED games are on the board: live and final games are neither counted nor gaps', () => {
    expect(
      gaps([
        spec({ eventId: '5', status: 'post', homeScore: 27, awayScore: 24, odds: undefined }),
        spec({ eventId: '6', status: 'in', homeScore: 7, awayScore: 3, odds: undefined }),
      ]),
    ).toMatchObject({ upcomingGames: 0, lineGaps: 0, lineGapDetails: [] });
  });

  it('a game ESPN still calls "pre" after its kickoff has passed is not counted (status lag)', () => {
    const lagging = spec({ eventId: '7', kickoffAt: T0 - MIN, odds: undefined });
    expect(gaps([lagging])).toMatchObject({ upcomingGames: 0, lineGaps: 0 });
  });

  it('an event listed twice is counted once', () => {
    const twice = spec({ eventId: '8', homeAbbr: 'BUF', awayAbbr: 'NYJ', odds: undefined });
    expect(gaps([twice, twice])).toMatchObject({
      upcomingGames: 1,
      lineGaps: 1,
      lineGapDetails: ['NYJ @ BUF: no line'],
    });
  });

  it('a pulled ("OFF") market is a gap, and its warning names the matchup', async () => {
    const t = await sundayNflTarget();
    espn.set(t.key, [spec({ odds: { ...BASE_ODDS, totalOff: true, moneylineOff: true } })]);
    const res = await ingestTarget(env, new EspnProvider(env), t, T0);
    expect(res.error).toBeNull();
    expect(res.linesUpserted).toBe(1); // the spread still lands
    expect(res.warnings).toEqual([
      '401872925 (TB @ CIN): DraftKings: total: off the board; moneyline: off the board',
    ]);
    expect(res).toMatchObject({
      upcomingGames: 1,
      lineGaps: 1,
      noTotal: 1,
      noMoneyline: 1,
      lineGapDetails: ['TB @ CIN: no total, no moneyline'],
    });
  });

  it('a line the book withdraws ENTIRELY is nulled on the next refresh, not left bettable', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([BASE_SPEC], T0, t);
    const before = await lineRow('nfl:401872925');
    expect(before?.spread_home_tenths).toBe(-35);

    espn.set(t.key, [spec({ odds: { spreadOff: true, totalOff: true, moneylineOff: true } })]);
    const res = await ingestTarget(env, new EspnProvider(env), t, T0 + MIN);
    expect(res.error).toBeNull();
    expect(res.linesUpserted).toBe(1);
    const after = await lineRow('nfl:401872925');
    expect(after).toMatchObject({
      spread_home_tenths: null,
      spread_home_price: null,
      total_tenths: null,
      ml_home_price: null,
      seen_at: T0 + MIN,
    });
    expect(res.lineGapDetails).toEqual(['TB @ CIN: no spread, no total, no moneyline']);
  });

  it('a fetch failure reports no board at all, not a board of zero gaps', async () => {
    const t = await sundayNflTarget();
    espn.setResponder(t.key, () => new Response('nope', { status: 503 }));
    const res = await ingestTarget(env, new EspnProvider(env), t, T0);
    expect(res.error).not.toBeNull();
    expect(res).toMatchObject({ upcomingGames: 0, lineGaps: 0, lineGapDetails: [] });
  });

  it('runRefresh sums them, breaks them down per target, and caps only the details', async () => {
    const key = etDateKey(T0);
    const many = Array.from({ length: ESPN_MAX_WARNINGS_RECORDED + 10 }, (_, i) =>
      spec({ eventId: `g${String(i)}`, homeAbbr: `H${String(i)}`, odds: undefined }),
    );
    espn.set(key, [BASE_SPEC, ...many]);
    const stats = await runRefresh(env, T0, 2);
    // One row per target processed. Which two of the 22 equally-due targets are
    // claimed is decided by the deterministic `priority, next_run_at, id` order
    // and only some of them fetch `key`, so assert on the rows, not on which.
    expect(stats.coverage).toHaveLength(2);
    const hit = stats.coverage.filter((c) => c.upcomingGames > 0);
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const c of hit) {
      expect(c.targetId).toMatch(/^(nfl|ncaaf):date:/);
      expect(c.upcomingGames).toBe(ESPN_MAX_WARNINGS_RECORDED + 11);
      expect(c.lineGaps).toBe(ESPN_MAX_WARNINGS_RECORDED + 10);
    }
    expect(stats.upcomingGames).toBe(hit.length * (ESPN_MAX_WARNINGS_RECORDED + 11));
    expect(stats.lineGaps).toBe(hit.length * (ESPN_MAX_WARNINGS_RECORDED + 10));
    expect(stats.noLine).toBe(stats.lineGaps);
    // The per-target count is uncapped; the run's details list is capped once.
    expect(stats.lineGapDetails).toHaveLength(ESPN_MAX_WARNINGS_RECORDED);

    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + MIN)
      .run();
    const run = await runJob(env, 'refresh', 'cron', T0 + MIN);
    expect(run.status).toBe('ok');
    expect(run.stats?.['lineGaps']).toBeTypeOf('number');
    expect(Array.isArray(run.stats?.['coverage'])).toBe(true);
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

  it('BUDGET: 96 refreshes of an 86-game CFB Saturday write < 5,000 rows', async () => {
    // THE REGRESSION GUARD §8.6 PROMISES — and the one the round-2 review found
    // to be measuring the wrong thing. Three things it has to get right:
    //
    //   1. It asserts ROWS WRITTEN (`meta.rows_written`: the table row plus
    //      every index entry the statement rewrote), not `meta.changes`.
    //      `changes` is 0-or-1 per row matched and under-reports the real cost
    //      by up to 4x, so a guard on `changes` cannot see the failure mode it
    //      exists to catch.
    //   2. THE CLOCK MOVES ON EVERY SINGLE REFRESH for every live game — which
    //      is what actually happens. The old guard moved it every third run,
    //      which hid the fact that L1 compare-and-skip buys NOTHING for a live
    //      game: `display_clock` differs every time, so the upsert always fired.
    //   3. The statuses transition the way a real Saturday does: four waves of
    //      kickoffs, each game scheduled -> in_progress (3.5 h) -> final.
    //
    // MEASURED on this exact fixture (miniflare D1, summed `meta.rows_written`):
    //     A/B split (this code)         2,979 rows   (1,569 changed games, 466 line rows)
    //     single-statement upsert       6,978 rows   ( 2,035 meta.changes)
    // and on the theoretical worst case of all 86 games live for all 96
    // refreshes, which the four-wave model deliberately does NOT assert because
    // it cannot physically happen:
    //     A/B split                     8,686 rows
    //     single-statement upsert      33,196 rows   ( 8,256 meta.changes)
    // 33,196 is §8.6's "without the levers" figure, reproduced.
    const GAMES = 86;
    const REFRESHES = 96;
    /** Four kickoff waves: noon, 3:30, 7:00, 10:30 — and 3.5 h of football. */
    const WAVE_MS = 3.5 * HOUR;
    const kickoffOf = (i: number): number => T0 + (i % 4) * WAVE_MS;

    const base: EventSpec[] = Array.from({ length: GAMES }, (_, i) => ({
      eventId: `cfb-${String(i)}`,
      league: 'ncaaf' as const,
      kickoffAt: kickoffOf(i),
      status: 'pre' as const,
      homeAbbr: `H${String(i)}`,
      awayAbbr: `A${String(i)}`,
      homeScore: 0,
      awayScore: 0,
      // ESPN strips odds at kickoff, but keep them attached to prove L2 drops
      // them at the mapper rather than relying on the feed.
      odds: { spreadHome: -3.5, total: 50.5, mlHome: -180, mlAway: 150 },
    }));

    /**
     * One game's day. Exactly TWO indexed transitions (pre -> in, in -> post);
     * everything else is clock and score churn on non-indexed columns.
     */
    const at = (run: number, i: number): EventSpec => {
      const e = base[i]!;
      const elapsed = T0 + run * 15 * MIN - e.kickoffAt;
      if (elapsed < 0) return e;
      if (elapsed >= WAVE_MS) {
        return {
          ...e,
          status: 'post',
          period: 4,
          displayClock: '0:00',
          homeScore: 28,
          awayScore: 24,
        };
      }
      const quarters = (elapsed - (elapsed % (45 * MIN))) / (45 * MIN);
      return {
        ...e,
        status: 'in',
        period: quarters + 1,
        // THE CLOCK MOVES EVERY REFRESH. This is the whole point.
        displayClock: `${String(15 - (run % 15))}:0${String(run % 10)}`,
        homeScore: 7 * quarters,
        awayScore: 6 * quarters,
      };
    };

    const probe = probeBatchRows();
    let games = 0;
    let lines = 0;
    let lineRowsForStartedGames = 0;
    let rowsWritten = 0;
    try {
      for (let run = 0; run < REFRESHES; run += 1) {
        const now = T0 + run * 15 * MIN;
        const specs = base.map((_, i) => at(run, i));
        const res = await upsertSlate(env, makeSlate(specs, 'ncaaf', now), now);
        games += res.games;
        lines += res.lines;
        // L2 is a MAPPER guarantee: once every game in the slate has started,
        // not one line row may be written however much the feed still carries.
        if (specs.every((e) => e.status !== 'pre')) lineRowsForStartedGames += res.lines;
        rowsWritten += res.rowsWritten;
      }
    } finally {
      probe.restore();
    }

    // The independent witness and the production accounting must agree exactly.
    expect(rowsWritten).toBe(probe.rows);

    // THE GUARD.
    expect(rowsWritten).toBeLessThan(5_000);

    // L2, stated as a measurement rather than prose.
    expect(lines).toBeGreaterThan(0);
    expect(lineRowsForStartedGames).toBe(0);

    // ...and it is not trivially small either — every real change DID land.
    expect(games).toBeGreaterThan(GAMES * 10);
    expect(rowsWritten).toBeGreaterThan(GAMES * 20);

    // The final state is the last payload, not a half-applied one.
    const g = await gameRow('ncaaf:cfb-0');
    expect(g?.status).toBe('final');
    expect(g?.home_score).toBe(28);
    expect(g?.away_score).toBe(24);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * the A/B split — per-statement row costs (PLAN.md §8.5)
 * ------------------------------------------------------------------ */

describe('A/B split: rows written per kind of change (PLAN.md §8.5)', () => {
  let probe: BatchProbe;

  beforeEach(() => {
    probe = probeBatchRows();
  });
  afterEach(() => {
    probe.restore();
  });

  /** Upsert one slate and return what it cost, measured two independent ways. */
  async function cost(
    events: readonly EventSpec[],
    now: number,
  ): Promise<{ reported: number; measured: number; games: number }> {
    probe.reset();
    const res = await upsertSlate(env, makeSlate(events, 'nfl', now), now);
    return { reported: res.rowsWritten, measured: probe.rows, games: res.games };
  }

  const LIVE = spec({ status: 'in', homeScore: 7, awayScore: 3, odds: undefined, period: 2 });

  it('a first insert costs 4 rows per game (table + three indexes)', async () => {
    const c = await cost([LIVE], T0);
    expect(c.reported).toBe(6);
    expect(c.measured).toBe(6);
    expect(c.games).toBe(1);
  });

  it('an UNCHANGED re-ingest costs ZERO rows', async () => {
    await cost([LIVE], T0);
    const c = await cost([LIVE], T0 + 15 * MIN);
    expect(c.reported).toBe(0);
    expect(c.measured).toBe(0);
    expect(c.games).toBe(0);
  });

  it('a CLOCK-ONLY change costs 1 row, not 4 — this is the whole fix', async () => {
    await cost([LIVE], T0);
    const c = await cost([{ ...LIVE, displayClock: '3:47' }], T0 + 15 * MIN);
    expect(c.reported).toBe(1);
    expect(c.measured).toBe(1);
    expect((await gameRow('nfl:401872925'))?.display_clock).toBe('3:47');
  });

  it('a SCORE-ONLY change costs 1 row', async () => {
    await cost([LIVE], T0);
    const c = await cost([{ ...LIVE, homeScore: 14 }], T0 + 15 * MIN);
    expect(c.reported).toBe(1);
    expect(c.measured).toBe(1);
    expect((await gameRow('nfl:401872925'))?.home_score).toBe(14);
  });

  it('a RANK-ONLY change costs 1 row', async () => {
    await cost([{ ...LIVE, homeRank: 12 }], T0);
    const c = await cost([{ ...LIVE, homeRank: 9 }], T0 + 15 * MIN);
    expect(c.reported).toBe(1);
    expect(c.measured).toBe(1);
    expect((await gameRow('nfl:401872925'))?.home_rank).toBe(9);
  });

  it('an L3 "still here" touch costs 1 row', async () => {
    await cost([LIVE], T0);
    const c = await cost([LIVE], T0 + GAME_SEEN_TOUCH_MS + 1);
    expect(c.reported).toBe(1);
    expect(c.measured).toBe(1);
    const g = await gameRow('nfl:401872925');
    expect(g?.last_seen_at).toBe(T0 + GAME_SEEN_TOUCH_MS + 1);
    expect(g?.updated_at).toBe(T0); // a touch is not a change
  });

  it('a STATUS transition costs 4 rows (the indexed write, paid once)', async () => {
    await cost([spec({ status: 'pre', odds: undefined })], T0);
    const c = await cost(
      [spec({ status: 'in', homeScore: 7, awayScore: 0, odds: undefined, period: 1 })],
      T0 + 15 * MIN,
    );
    // (A) applies and carries period/clock/scores with it, so (B) finds nothing.
    expect(c.reported).toBe(4);
    expect(c.measured).toBe(4);
    expect(c.games).toBe(1); // ...and it is still ONE changed game, not two
  });

  it('a STATUS transition that ALSO moves a rank costs 4 + 1', async () => {
    await cost([spec({ status: 'pre', odds: undefined, homeRank: 12 })], T0);
    const c = await cost(
      [spec({ status: 'in', odds: undefined, homeRank: 9, period: 1 })],
      T0 + 15 * MIN,
    );
    expect(c.reported).toBe(5);
    expect(c.measured).toBe(5);
    expect(c.games).toBe(1);
    expect((await gameRow('nfl:401872925'))?.home_rank).toBe(9);
  });

  it('a KICKOFF reschedule costs 4 rows (kickoff_at is in two indexes)', async () => {
    await cost([spec({ odds: undefined })], T0);
    const c = await cost([spec({ odds: undefined, kickoffAt: T0 + 6 * HOUR })], T0 + 15 * MIN);
    expect(c.reported).toBe(4);
    expect(c.measured).toBe(4);
  });

  it('a final game glitching back to scheduled costs ZERO rows', async () => {
    await cost([spec({ status: 'post', homeScore: 27, awayScore: 24, odds: undefined })], T0);
    const c = await cost(
      [spec({ status: 'pre', homeScore: 0, awayScore: 0, odds: undefined })],
      T0 + HOUR,
    );
    // Neither (A) nor (B) may apply: the never-regress guard is in BOTH.
    expect(c.reported).toBe(0);
    expect(c.measured).toBe(0);
    const g = await gameRow('nfl:401872925');
    expect(g?.status).toBe('final');
    expect(g?.home_score).toBe(27);
    expect(g?.display_clock).toBe('0:00'); // (B) did not move the clock either
  });

  it('rowsWritten also covers the game_lines rows and the target reschedule', async () => {
    const t = await sundayNflTarget();
    probe.reset();
    const res = await ingestSlate([BASE_SPEC], T0, t);
    // 6 (game INSERT: table + PK autoindex + UNIQUE autoindex + the three
    // explicit indexes) + 2 (line INSERT: table + the composite-PK autoindex).
    // The ingest_targets reschedule is a bare `.run()`, so the batch probe does
    // not see it — hence the >= on the reported figure.
    expect(probe.rows).toBe(8);
    expect(res.rowsWritten).toBe(10); // ...+ 2 for the reschedule
  });

  it('SET LIST GUARD: (B) contains no indexed column', () => {
    // A static assertion, because the failure mode is silent: adding `status`,
    // `kickoff_at` or `week` to the live UPDATE's SET list quadruples every live
    // refresh and no functional test would notice.
    const setList = GAME_LIVE_SQL.slice(
      GAME_LIVE_SQL.indexOf('SET'),
      GAME_LIVE_SQL.indexOf('WHERE id = ?'),
    );
    const assigned = new Set(
      [...setList.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/gm)].map((m) => m[1] ?? ''),
    );
    // The three mutable columns covered by idx_games_board / _status / _week.
    for (const column of ['status', 'kickoff_at', 'week']) {
      expect(assigned.has(column), `${column} must not be SET by the live update`).toBe(false);
    }
    // ...and it MUST still carry the columns that used to be INSERT-only.
    for (const column of [
      'home_rank',
      'away_rank',
      'home_conference_id',
      'away_conference_id',
      'home_logo',
      'away_logo',
      'name',
    ]) {
      expect(assigned.has(column), `${column} must be SET by the live update`).toBe(true);
    }
  });

  it("GAME_LIVE_SQL stays under D1's 100 bound parameters per statement", () => {
    // Every column added to (B) costs THREE placeholders (SET + two tuple
    // splices); this turns the platform wall into a test failure.
    expect((GAME_LIVE_SQL.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
  });
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

  it('a POSTPONED game does NOT pin the target to the 15-minute live tier', () => {
    // `TERMINAL_STATUSES` is only {final, canceled}, so a postponed game stays
    // "unfinished" indefinitely. With a one-sided `kickoffAt - now <= 3h` test
    // its nominal kickoff, five hours in the past, still read as "live" — 96
    // pointless refreshes a day, forever. It belongs in the discovery tier.
    const slate = makeSlate([spec({ status: 'postponed', kickoffAt: T0 - 5 * HOUR })], 'nfl', T0);
    expect(slate.games[0]?.status).toBe('postponed');
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 6 * HOUR);
  });

  it('an UNKNOWN-status game with a long-past kickoff also falls to discovery', () => {
    const slate = makeSlate([spec({ status: 'pre', kickoffAt: T0 - 5 * HOUR })], 'nfl', T0);
    // Force the parsed status to `unknown`, the other non-terminal straggler.
    const unknown: ProviderSlate = {
      ...slate,
      games: slate.games.map((g) => ({ ...g, status: 'unknown' as const })),
    };
    expect(computeNextRunAt(target, unknown, false, T0)).toBe(T0 + 6 * HOUR);
  });

  it('a postponed game whose NEW kickoff is 2h out is live again', () => {
    // The clamp is on the horizon, not on the status: once ESPN republishes a
    // real upcoming kickoff the target goes back to the 15-minute tier.
    const slate = makeSlate([spec({ status: 'postponed', kickoffAt: T0 + 2 * HOUR })], 'nfl', T0);
    expect(computeNextRunAt(target, slate, false, T0)).toBe(T0 + 15 * MIN);
  });

  it('a SCHEDULED game just past kickoff (ESPN slow to flip) stays live for a bounded grace', () => {
    // 20 minutes past kickoff, still 'pre' in the feed: must NOT fall to +6h or
    // settlement waits hours for a game that has genuinely started.
    const late = makeSlate([spec({ status: 'pre', kickoffAt: T0 - 20 * MIN })], 'nfl', T0);
    expect(computeNextRunAt(target, late, false, T0)).toBe(T0 + 15 * MIN);
    // Inside the 4h grace: still live.
    const edge = makeSlate([spec({ status: 'pre', kickoffAt: T0 - 4 * HOUR })], 'nfl', T0);
    expect(computeNextRunAt(target, edge, false, T0)).toBe(T0 + 15 * MIN);
    // Past the grace: a silently-postponed game drops to discovery.
    const stale = makeSlate([spec({ status: 'pre', kickoffAt: T0 - 4 * HOUR - 1 })], 'nfl', T0);
    expect(computeNextRunAt(target, stale, false, T0)).toBe(T0 + 6 * HOUR);
    // No grace for postponed: 20 minutes past its nominal kickoff is discovery.
    const post = makeSlate([spec({ status: 'postponed', kickoffAt: T0 - 20 * MIN })], 'nfl', T0);
    expect(computeNextRunAt(target, post, false, T0)).toBe(T0 + 6 * HOUR);
  });

  it('an IN_PROGRESS game is live no matter how long ago it kicked off', () => {
    // The in_progress arm has no horizon at all — a game in a weather delay is
    // still the thing we most need fresh scores for.
    const slate = makeSlate([spec({ status: 'in', kickoffAt: T0 - 9 * HOUR })], 'nfl', T0);
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
    await planTargets(env, SUN_NIGHT);
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
    await planTargets(env, SUN_NIGHT);
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
    await planTargets(env, SUN_NIGHT);
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
    await planTargets(env, SUN_NIGHT);
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
    await planTargets(env, SUN_NIGHT);
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
    await planTargets(env, SUN_NIGHT);
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
    // Every one of the 18 targets got at least one slot during the day.
    expect(seen.size).toBe(18);
  }, 120_000);

  it('two simultaneously-live targets alternate in slot 1 (30-minute cadence each)', async () => {
    await planTargets(env, SUN_NIGHT);
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
    expect(due?.n).toBe(9); // 11 planned at a Sunday noon, 2 just processed
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
    // ...except for the two target reschedules, which are unavoidable: this is
    // the ONLY floor a quiet run has, and it is what §8.6 budgets at 192/day.
    expect(again.rowsWritten).toBe(4); // 2 targets x (row + idx_ingest_targets_due)
  });

  it('reports rowsWritten, and job_runs.stats carries it (PLAN.md §8.6)', async () => {
    const key = etDateKey(T0);
    espn.set(key, [BASE_SPEC]);
    const stats = await runRefresh(env, T0, 2);
    // 6 (game INSERT) + 2 (line INSERT) + 2 x 2 (target reschedules).
    expect(stats.rowsWritten).toBe(12);
    expect(stats.gamesUpserted).toBe(1);

    // ...and it survives the trip through job_runs.stats as a number.
    await env.DB.prepare('UPDATE ingest_targets SET next_run_at = ?')
      .bind(T0 + MIN)
      .run();
    const run = await runJob(env, 'refresh', 'cron', T0 + MIN);
    expect(run.status).toBe('ok');
    expect(run.stats?.['rowsWritten']).toBeTypeOf('number');
    expect(run.stats?.['rowsSkipped']).toBeTypeOf('number');
  });
});

/* ------------------------------------------------------------------ *
 * fields that used to be INSERT-only (PLAN.md §8.5)
 * ------------------------------------------------------------------ */

describe('the live update refreshes fields that used to go stale', () => {
  it('a CFB rank moves during the week instead of being frozen at first sight', async () => {
    // The bug: `home_rank`/`away_rank` were in the INSERT column list only, so a
    // game first seen on Monday wore Monday's rank all week — and the ranks are
    // the single most visible thing on a CFB board.
    const t = await sundayNflTarget();
    await ingestSlate([spec({ homeRank: 12, awayRank: 4, odds: undefined })], T0, t);
    let g = await gameRow('nfl:401872925');
    expect(g?.home_rank).toBe(12);
    expect(g?.away_rank).toBe(4);

    const res = await ingestSlate(
      [spec({ homeRank: 9, awayRank: 5, odds: undefined })],
      T0 + DAY,
      t,
    );
    expect(res.gamesUpserted).toBe(1);
    g = await gameRow('nfl:401872925');
    expect(g?.home_rank).toBe(9);
    expect(g?.away_rank).toBe(5);
    // A rank move IS a data change, so updated_at advances.
    expect(g?.updated_at).toBe(T0 + DAY);
  });

  it('a team dropping out of the rankings clears the rank rather than keeping it', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ homeRank: 25, odds: undefined })], T0, t);
    expect((await gameRow('nfl:401872925'))?.home_rank).toBe(25);
    // 99 is ESPN's "unranked" sentinel; the parser maps it to null.
    await ingestSlate([spec({ homeRank: 99, odds: undefined })], T0 + DAY, t);
    expect((await gameRow('nfl:401872925'))?.home_rank).toBeNull();
  });

  it('a logo URL change lands', async () => {
    const t = await sundayNflTarget();
    await ingestSlate([spec({ odds: undefined })], T0, t);
    const before = (await gameRow('nfl:401872925'))?.home_logo;
    expect(before).toContain('/cin.png');

    espn.setResponder(t.key, () => {
      const payload = buildScoreboard([spec({ odds: undefined })]) as {
        events: { competitions: { competitors: { team: Record<string, unknown> }[] }[] }[];
      };
      const team = payload.events[0]?.competitions[0]?.competitors[0]?.team;
      if (team !== undefined) team['logo'] = 'https://a.espncdn.com/i/teamlogos/nfl/500/new.png';
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await ingestTarget(env, new EspnProvider(env), t, T0 + DAY);
    expect((await gameRow('nfl:401872925'))?.home_logo).toContain('/new.png');
  });

  it('neutral_site stays INSERT-only — a documented decision, not an oversight', async () => {
    // PLAN.md §8.5: ESPN sets it when the event is created, grading reads the
    // `bet_legs` snapshot rather than this column, and putting it in the compare
    // tuple would add a column that never moves. If that ever stops being true,
    // it goes in the LIVE update (1 row), never in the indexed one.
    const t = await sundayNflTarget();
    await ingestSlate([spec({ neutralSite: false, odds: undefined })], T0, t);
    expect((await gameRow('nfl:401872925'))?.neutral_site).toBe(0);
    await ingestSlate([spec({ neutralSite: true, odds: undefined })], T0 + DAY, t);
    expect((await gameRow('nfl:401872925'))?.neutral_site).toBe(0);
  });
});

describe('conference id (migration 0004)', () => {
  it('is inserted from team.conferenceId, NULL for the NFL, and updated by (B) on change', async () => {
    await planTargets(env, T0);
    const cfb = await loadTarget(`ncaaf:date:${etDateKey(T0)}`);
    const game = (awayConferenceId: string): EventSpec =>
      spec({
        eventId: '990001',
        league: 'ncaaf',
        homeAbbr: 'UGA',
        awayAbbr: 'KENT',
        homeConferenceId: '8',
        awayConferenceId,
      });
    const read = (id: string) =>
      env.DB.prepare(
        'SELECT home_conference_id, away_conference_id, updated_at FROM games WHERE id = ?1',
      )
        .bind(id)
        .first<{
          home_conference_id: string | null;
          away_conference_id: string | null;
          updated_at: number;
        }>();

    await ingestSlate([game('15')], T0, cfb);
    const first = await read('ncaaf:990001');
    expect(first).toMatchObject({ home_conference_id: '8', away_conference_id: '15' });

    // Realignment: the away team moves to the American. (B) must write it AND
    // count it as a data change (updated_at advances) — not an L3 touch.
    await ingestSlate([game('151')], T0 + MIN, cfb);
    const second = await read('ncaaf:990001');
    expect(second).toMatchObject({ home_conference_id: '8', away_conference_id: '151' });
    expect(second?.updated_at ?? 0).toBeGreaterThan(first?.updated_at ?? 0);

    // Seen again, unchanged: no data change.
    await ingestSlate([game('151')], T0 + 2 * MIN, cfb);
    expect((await read('ncaaf:990001'))?.updated_at).toBe(second?.updated_at);

    // A payload that OMITS the id is an absence, not a change: the stored
    // value sticks and updated_at does not move.
    await ingestSlate(
      [spec({ eventId: '990001', league: 'ncaaf', homeAbbr: 'UGA', awayAbbr: 'KENT' })],
      T0 + 3 * MIN,
      cfb,
    );
    const third = await read('ncaaf:990001');
    expect(third).toMatchObject({ home_conference_id: '8', away_conference_id: '151' });
    expect(third?.updated_at).toBe(second?.updated_at);

    // The NFL shape carries no conferenceId at all.
    await ingestSlate([spec({ eventId: '990002' })], T0 + 4 * MIN);
    expect(await read('nfl:990002')).toMatchObject({
      home_conference_id: null,
      away_conference_id: null,
    });
  });
});
