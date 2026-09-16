import { describe, expect, it } from 'vitest';

import {
  ESPN_MAX_WARNINGS_RECORDED,
  MAX_ABS_AMERICAN_PRICE,
  MAX_ABS_LINE_TENTHS,
  MIN_ABS_AMERICAN_PRICE,
} from '../../src/shared/constants.js';
import {
  makeGameId,
  mapEspnStatus,
  parseAmericanPrice,
  parseEvent,
  parseLineToTenths,
  parseRank,
  parseScore,
  parseScoreboard,
  selectOddsEntry,
} from '../../src/shared/espn.js';
import type { ParseWarning } from '../../src/shared/espn.js';
import { etDateKey } from '../../src/shared/time.js';
import type { Game, GameStatus } from '../../src/shared/types.js';
import {
  MALFORMED_BROKEN_EVENT_IDS,
  MALFORMED_GOOD_EVENT_ID,
  cfbScoreboard,
  makeScoreboard,
  makeStatus,
  malformedScoreboard,
  nflScoreboard,
} from './fixtures.js';

/** TDD contract for src/shared/espn.ts (PLAN.md §8.3, M2c). */

const FETCHED_AT = 1_789_300_000_000;

const byStatus = (games: readonly Game[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const g of games) out[g.status] = (out[g.status] ?? 0) + 1;
  return out;
};

const bucketsOf = (games: readonly Game[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const g of games) {
    const key = etDateKey(g.kickoffAt);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

const gameById = (games: readonly Game[], id: string): Game => {
  const game = games.find((g) => g.id === id);
  if (game === undefined) throw new Error(`no game ${id}`);
  return game;
};

/** A `status.type` object, as ESPN shapes it. */
const statusType = (name: string, state: string, completed: boolean): unknown => ({
  id: '0',
  name,
  state,
  completed,
  description: name,
  detail: name,
  shortDetail: name,
});

describe('parseScoreboard — real NFL sample', () => {
  const parsed = parseScoreboard(nflScoreboard(), 'nfl', FETCHED_AT);

  it('parses 16 events with no warnings', () => {
    expect(parsed.games).toHaveLength(16);
    expect(parsed.warnings).toEqual([]);
  });

  it('14 are scheduled and ALL 14 carry a DraftKings line', () => {
    expect(byStatus(parsed.games)['scheduled']).toBe(14);
    expect(parsed.lines).toHaveLength(14);
    expect(new Set(parsed.lines.map((l) => l.provider))).toEqual(new Set(['DraftKings']));

    const scheduledIds = new Set(
      parsed.games.filter((g) => g.status === 'scheduled').map((g) => g.id),
    );
    expect(new Set(parsed.lines.map((l) => l.gameId))).toEqual(scheduledIds);
  });

  it('2 are final and NEITHER carries a line (odds vanish at kickoff)', () => {
    const finals = parsed.games.filter((g) => g.status === 'final');
    expect(finals).toHaveLength(2);
    const finalIds = new Set(finals.map((g) => g.id));
    expect(parsed.lines.filter((l) => finalIds.has(l.gameId))).toEqual([]);
  });

  it('season 2026, seasonType 2, week 1 on every event', () => {
    // NOTE: the original it.todo said "week 2". The committed NFL sample's
    // events (and its payload root) actually carry `week.number === 1`; the
    // measured value is asserted rather than the one in the stub comment.
    expect(new Set(parsed.games.map((g) => g.season))).toEqual(new Set([2026]));
    expect(new Set(parsed.games.map((g) => g.seasonType))).toEqual(new Set([2]));
    expect(new Set(parsed.games.map((g) => g.week))).toEqual(new Set([1]));
    expect(parsed.season).toBe(2026);
    expect(parsed.week).toBe(1);
  });

  it('maps home/away, abbreviations, logos and scores', () => {
    const game = gameById(parsed.games, 'nfl:401872925');
    expect(game).toMatchObject({
      league: 'nfl',
      name: 'Tampa Bay Buccaneers at Cincinnati Bengals',
      shortName: 'TB @ CIN',
      status: 'scheduled',
      neutralSite: false,
      kickoffAt: Date.parse('2026-09-13T17:00Z'),
      originalKickoffAt: Date.parse('2026-09-13T17:00Z'),
    });
    expect(game.home).toEqual({
      teamId: '4',
      abbr: 'CIN',
      name: 'Cincinnati Bengals',
      logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/cin.png',
      rank: null, // NFL curatedRank is always 99
      conferenceId: null, // NFL teams carry no conferenceId
      score: 0, // pre-game "0" parses to 0, NOT null
    });
    expect(game.away).toMatchObject({ teamId: '27', abbr: 'TB', name: 'Tampa Bay Buccaneers' });
  });

  it('a pre-game "0" is 0, not null (a 0-0 final must stay gradeable)', () => {
    for (const g of parsed.games.filter((x) => x.status === 'scheduled')) {
      expect(g.home.score).toBe(0);
      expect(g.away.score).toBe(0);
    }
  });

  it('keeps the final scores of the two completed games', () => {
    const game = gameById(parsed.games, 'nfl:401872656');
    expect(game.status).toBe('final');
    expect(game.shortName).toBe('NE @ SEA');
    expect(game.home.abbr).toBe('SEA');
    expect(game.home.score).toBe(13);
    expect(game.away.score).toBe(10);
    expect(game.statusDetail).toBe('Final');
  });

  it('carries neutralSite through', () => {
    expect(gameById(parsed.games, 'nfl:401872657').neutralSite).toBe(true);
    expect(gameById(parsed.games, 'nfl:401872925').neutralSite).toBe(false);
  });

  it('reproduces the measured ET date buckets (PLAN.md §8.2)', () => {
    expect(bucketsOf(parsed.games)).toEqual({
      '20260909': 1,
      '20260910': 1,
      '20260913': 13,
      '20260914': 1,
    });
  });

  it('parses the DraftKings markets of TB @ CIN exactly', () => {
    const line = parsed.lines.find((l) => l.gameId === 'nfl:401872925');
    expect(line).toBeDefined();
    expect(line).toEqual({
      gameId: 'nfl:401872925',
      provider: 'DraftKings',
      capturedAt: FETCHED_AT,
      spread: { homeTenths: -35, homePrice: -112, awayTenths: 35, awayPrice: -108 },
      total: { tenths: 505, overPrice: -108, underPrice: -112 },
      moneyline: { homePrice: -198, awayPrice: 164 },
    });
  });

  it('gives every game a `<league>:<espnEventId>` id', () => {
    for (const g of parsed.games) expect(g.id).toMatch(/^nfl:\d+$/);
  });
});

describe('parseScoreboard — real CFB sample', () => {
  const parsed = parseScoreboard(cfbScoreboard(), 'ncaaf', FETCHED_AT);

  it('parses 86 events', () => {
    expect(parsed.games).toHaveLength(86);
    expect(parsed.warnings).toEqual([]);
  });

  it('16 in progress + 3 halftime map to in_progress', () => {
    expect(byStatus(parsed.games)['in_progress']).toBe(19);
  });

  it('65 final map to final', () => {
    expect(byStatus(parsed.games)['final']).toBe(65);
  });

  it('only the 2 scheduled events produce a lines row', () => {
    expect(byStatus(parsed.games)['scheduled']).toBe(2);
    expect(parsed.lines).toHaveLength(2);
    expect(new Set(parsed.lines.map((l) => l.gameId))).toEqual(
      new Set(['ncaaf:401858445', 'ncaaf:401864578']),
    );
    // 0 of the 84 started/finished events carry odds (PLAN.md §8.5 lever L2).
    const started = parsed.games.filter((g) => g.status !== 'scheduled');
    expect(started).toHaveLength(84);
    const startedIds = new Set(started.map((g) => g.id));
    expect(parsed.lines.filter((l) => startedIds.has(l.gameId))).toEqual([]);
  });

  it('curatedRank 1-25 is kept, 99 becomes null', () => {
    const iu = gameById(parsed.games, 'ncaaf:401858439');
    expect(iu.home.rank).toBe(5);
    expect(iu.away.rank).toBeNull();
  });

  it('keeps team.conferenceId for CFB (IU is Big Ten, id 5) and every id is a numeric string', () => {
    const iu = gameById(parsed.games, 'ncaaf:401858439');

    expect(iu.home.conferenceId).toBe('5');
    const ids = parsed.games.flatMap((g) => [g.home.conferenceId, g.away.conferenceId]);
    expect(ids.every((id) => id === null || /^\d+$/.test(id))).toBe(true);
    // The sample is a full FBS Saturday: every Power-4 conference appears.
    for (const id of ['8', '5', '4', '1']) expect(ids).toContain(id);

    const ranks = parsed.games.flatMap((g) => [g.home.rank, g.away.rank]);
    const ranked = ranks.filter((r): r is number => r !== null);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r >= 1 && r <= 25)).toBe(true);
    expect(ranks.includes(99)).toBe(false);
  });

  it('an FBS-vs-FCS game is ingested normally', () => {
    // Howard (FCS, MEAC) at #5 Indiana (FBS, Big Ten) — no special-casing.
    const game = gameById(parsed.games, 'ncaaf:401858439');
    expect(game.name).toBe('Howard Bison at Indiana Hoosiers');
    expect(game.home.abbr).toBe('IU');
    expect(game.away.abbr).toBe('HOW');
    expect(game.home.score).toBe(55);
    expect(game.away.score).toBe(0);
    expect(game.status).toBe('final');
  });

  it('season 2026, week 2, seasonType 2', () => {
    expect(new Set(parsed.games.map((g) => g.season))).toEqual(new Set([2026]));
    expect(new Set(parsed.games.map((g) => g.seasonType))).toEqual(new Set([2]));
    expect(new Set(parsed.games.map((g) => g.week))).toEqual(new Set([2]));
    expect(parsed.season).toBe(2026);
    expect(parsed.week).toBe(2);
  });

  it('reproduces the measured ET date buckets (the Saturday is 93% of the week)', () => {
    expect(bucketsOf(parsed.games)).toEqual({
      '20260910': 1,
      '20260911': 5,
      '20260912': 80,
    });
  });

  it('keeps period and displayClock for a live game', () => {
    const live = parsed.games.filter((g) => g.status === 'in_progress');
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((g) => typeof g.period === 'number')).toBe(true);
    expect(live.some((g) => g.displayClock !== null && g.displayClock !== '')).toBe(true);
  });
});

describe('parseScoreboard — override fixtures', () => {
  it('a game rewound to FINAL 27-24 parses as a final with those scores', () => {
    const payload = makeScoreboard('nfl', [
      { eventId: '401872925', status: 'STATUS_FINAL', homeScore: '27', awayScore: '24' },
    ]);
    const parsed = parseScoreboard(payload, 'nfl', FETCHED_AT);
    const game = gameById(parsed.games, 'nfl:401872925');
    expect(game.status).toBe('final');
    expect(game.home.score).toBe(27);
    expect(game.away.score).toBe(24);
    expect(parsed.warnings).toEqual([]);
  });

  it('dropOdds removes exactly one lines row', () => {
    const parsed = parseScoreboard(
      makeScoreboard('nfl', [{ eventId: '401872925', dropOdds: true }]),
      'nfl',
      FETCHED_AT,
    );
    expect(parsed.lines).toHaveLength(13);
    expect(parsed.lines.some((l) => l.gameId === 'nfl:401872925')).toBe(false);
    expect(parsed.warnings).toEqual([]);
  });

  it('a moved kickoff moves the ET bucket', () => {
    const parsed = parseScoreboard(
      makeScoreboard('nfl', [{ eventId: '401872925', date: '2026-09-15T00:15Z' }]),
      'nfl',
      FETCHED_AT,
    );
    expect(etDateKey(gameById(parsed.games, 'nfl:401872925').kickoffAt)).toBe('20260914');
  });

  it('a 0-0 FINAL is still a final with scores 0, not null', () => {
    const parsed = parseScoreboard(
      makeScoreboard('nfl', [
        { eventId: '401872925', status: 'STATUS_FINAL', homeScore: '0', awayScore: '0' },
      ]),
      'nfl',
      FETCHED_AT,
    );
    const game = gameById(parsed.games, 'nfl:401872925');
    expect(game.status).toBe('final');
    expect(game.home.score).toBe(0);
    expect(game.away.score).toBe(0);
  });

  it('a canceled game is canceled, never final', () => {
    const parsed = parseScoreboard(
      makeScoreboard('nfl', [{ eventId: '401872925', status: 'STATUS_CANCELED' }]),
      'nfl',
      FETCHED_AT,
    );
    expect(gameById(parsed.games, 'nfl:401872925').status).toBe('canceled');
  });

  it('an unrecognised ESPN status becomes `unknown`, never bettable', () => {
    const parsed = parseScoreboard(
      makeScoreboard('nfl', [{ eventId: '401872925', status: 'STATUS_ALIEN_INVASION' }]),
      'nfl',
      FETCHED_AT,
    );
    expect(gameById(parsed.games, 'nfl:401872925').status).toBe('unknown');
  });
});

describe('parseScoreboard — the dev fixture server synthetic odds shape', () => {
  /** Byte-for-byte the shape scripts/fixture-server.mjs `syntheticOdds()` emits. */
  const syntheticOdds = (homeAbbr: string): unknown => ({
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    details: `${homeAbbr} -3.5`,
    overUnder: 44.5,
    spread: -3.5,
    awayTeamOdds: { favorite: false, underdog: true },
    homeTeamOdds: { favorite: true, underdog: false },
    moneyline: {
      home: { close: { odds: '-180' }, open: { odds: '-180' } },
      away: { close: { odds: '+150' }, open: { odds: '+150' } },
    },
    pointSpread: {
      home: { close: { line: '-3.5', odds: '-110' }, open: { line: '-3.5', odds: '-110' } },
      away: { close: { line: '+3.5', odds: '-110' }, open: { line: '+3.5', odds: '-110' } },
    },
    total: {
      over: { close: { line: 'o44.5', odds: '-110' }, open: { line: 'o44.5', odds: '-110' } },
      under: { close: { line: 'u44.5', odds: '-110' }, open: { line: 'u44.5', odds: '-110' } },
    },
  });

  it('parses into the same GameLines shape as the real payload', () => {
    const payload = nflScoreboard() as { events: { id: string; competitions: unknown[] }[] };
    const event = payload.events.find((e) => e.id === '401872925');
    expect(event).toBeDefined();
    (event!.competitions[0] as { odds: unknown[] }).odds = [syntheticOdds('CIN')];

    const parsed = parseScoreboard(payload, 'nfl', FETCHED_AT);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.lines.find((l) => l.gameId === 'nfl:401872925')).toEqual({
      gameId: 'nfl:401872925',
      provider: 'DraftKings',
      capturedAt: FETCHED_AT,
      spread: { homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -110 },
      total: { tenths: 445, overPrice: -110, underPrice: -110 },
      moneyline: { homePrice: -180, awayPrice: 150 },
    });
  });
});

describe('mapEspnStatus', () => {
  it("state 'pre' -> scheduled", () => {
    expect(mapEspnStatus(statusType('STATUS_SCHEDULED', 'pre', false))).toBe('scheduled');
  });

  it("state 'in' -> in_progress", () => {
    expect(mapEspnStatus(statusType('STATUS_IN_PROGRESS', 'in', false))).toBe('in_progress');
  });

  it('STATUS_HALFTIME -> in_progress', () => {
    expect(mapEspnStatus(statusType('STATUS_HALFTIME', 'in', false))).toBe('in_progress');
    expect(mapEspnStatus(statusType('STATUS_END_PERIOD', 'in', false))).toBe('in_progress');
    // Documented extras: a delay is a (probably temporary) postponement; the
    // British spelling of canceled is canceled.
    expect(mapEspnStatus(statusType('STATUS_DELAYED', 'in', false))).toBe('postponed');
    expect(mapEspnStatus(statusType('STATUS_CANCELLED', 'post', true))).toBe('canceled');
  });

  it("state 'post' + completed -> final", () => {
    expect(mapEspnStatus(statusType('STATUS_FINAL', 'post', true))).toBe('final');
    // Unknown OT/variant names still map to final on state+completed alone.
    expect(mapEspnStatus(statusType('STATUS_FINAL_OT', 'post', true))).toBe('final');
  });

  it("state 'post' WITHOUT completed is not final", () => {
    expect(mapEspnStatus(statusType('STATUS_SOMETHING', 'post', false))).toBe('unknown');
  });

  it('STATUS_POSTPONED -> postponed', () => {
    expect(mapEspnStatus(statusType('STATUS_POSTPONED', 'post', false))).toBe('postponed');
  });

  it('STATUS_CANCELED -> canceled', () => {
    expect(mapEspnStatus(statusType('STATUS_CANCELED', 'post', false))).toBe('canceled');
  });

  it('STATUS_FORFEIT -> canceled', () => {
    expect(mapEspnStatus(statusType('STATUS_FORFEIT', 'post', false))).toBe('canceled');
  });

  it('a canceled/postponed game is never final, even if ESPN sets completed', () => {
    // Safety-first ordering: name-based cancellation wins over state+completed,
    // because grading a canceled game as `final` would settle real bets on a
    // game that was never played. PLAN.md §8.3 lists `final` first; we check the
    // two terminal-but-not-played names ahead of it and document the deviation.
    expect(mapEspnStatus(statusType('STATUS_CANCELED', 'post', true))).toBe('canceled');
    expect(mapEspnStatus(statusType('STATUS_POSTPONED', 'post', true))).toBe('postponed');
  });

  it('an unrecognised name -> unknown (never bettable, never graded)', () => {
    expect(mapEspnStatus(statusType('STATUS_WHO_KNOWS', 'quantum', false))).toBe('unknown');
    expect(mapEspnStatus(undefined)).toBe('unknown');
    expect(mapEspnStatus(null)).toBe('unknown');
    expect(mapEspnStatus('STATUS_FINAL')).toBe('unknown');
    expect(mapEspnStatus({})).toBe('unknown');
  });

  it('only ever returns a GameStatus', () => {
    const allowed: readonly GameStatus[] = [
      'scheduled',
      'in_progress',
      'final',
      'postponed',
      'canceled',
      'unknown',
    ];
    expect(allowed).toContain(mapEspnStatus(statusType('STATUS_ANYTHING', 'nope', false)));
  });
});

describe('parseLineToTenths', () => {
  it('"-3.5" -> -35', () => {
    expect(parseLineToTenths('-3.5')).toBe(-35);
  });

  it('"+3.5" -> 35', () => {
    expect(parseLineToTenths('+3.5')).toBe(35);
    expect(parseLineToTenths('3.5')).toBe(35);
  });

  it('"o50.5" -> 505', () => {
    expect(parseLineToTenths('o50.5')).toBe(505);
    expect(parseLineToTenths('O50.5')).toBe(505);
  });

  it('"u50.5" -> 505', () => {
    expect(parseLineToTenths('u50.5')).toBe(505);
    expect(parseLineToTenths('U50.5')).toBe(505);
  });

  it('"PK" / "pk" / "EVEN" -> 0', () => {
    expect(parseLineToTenths('PK')).toBe(0);
    expect(parseLineToTenths('pk')).toBe(0);
    expect(parseLineToTenths('EVEN')).toBe(0);
    expect(parseLineToTenths('even')).toBe(0);
    expect(parseLineToTenths(' PK ')).toBe(0);
  });

  it('numbers pass through', () => {
    expect(parseLineToTenths(-3.5)).toBe(-35);
    expect(parseLineToTenths(50.5)).toBe(505);
    expect(parseLineToTenths(7)).toBe(70);
    expect(parseLineToTenths(0)).toBe(0);
    expect(parseLineToTenths(-0)).toBe(0);
  });

  it('yields an exact integer for every one-decimal line', () => {
    // Derived from the digits, not from `Number(raw) * 10`. (Measured: for every
    // i/10 with 0 <= i <= 2000, `v * 10` happens to be exactly integral in V8,
    // so this is a structural guarantee rather than a reproduction of a bug.)
    expect(parseLineToTenths('2.1')).toBe(21);
    expect(parseLineToTenths('-2.1')).toBe(-21);
    expect(parseLineToTenths('58.7')).toBe(587);
    expect(parseLineToTenths('-0.1')).toBe(-1);
    expect(Number.isInteger(parseLineToTenths('2.1'))).toBe(true);
  });

  it('accepts an explicit trailing zero but not sub-tenth precision', () => {
    expect(parseLineToTenths('3.50')).toBe(35);
    expect(parseLineToTenths('3.500')).toBe(35);
    expect(parseLineToTenths('3.55')).toBeNull();
  });

  it('rejects |tenths| > MAX_ABS_LINE_TENTHS', () => {
    expect(MAX_ABS_LINE_TENTHS).toBe(1000);
    expect(parseLineToTenths('100')).toBe(1000);
    expect(parseLineToTenths('-100')).toBe(-1000);
    expect(parseLineToTenths('100.1')).toBeNull();
    expect(parseLineToTenths('-100.1')).toBeNull();
    expect(parseLineToTenths('o999')).toBeNull();
  });

  it('returns null on garbage instead of throwing', () => {
    expect(parseLineToTenths(undefined)).toBeNull();
    expect(parseLineToTenths(null)).toBeNull();
    expect(parseLineToTenths('')).toBeNull();
    expect(parseLineToTenths('   ')).toBeNull();
    expect(parseLineToTenths('CIN -3.5')).toBeNull();
    expect(parseLineToTenths('off')).toBeNull();
    expect(parseLineToTenths({})).toBeNull();
    expect(parseLineToTenths([])).toBeNull();
    expect(parseLineToTenths(Number.NaN)).toBeNull();
    expect(parseLineToTenths(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseLineToTenths(true)).toBeNull();
  });
});

describe('parseAmericanPrice', () => {
  it('"-110" -> -110, "+164" -> 164', () => {
    expect(parseAmericanPrice('-110')).toBe(-110);
    expect(parseAmericanPrice('+164')).toBe(164);
    expect(parseAmericanPrice('164')).toBe(164);
    expect(parseAmericanPrice(' -198 ')).toBe(-198);
  });

  it('numbers pass through', () => {
    expect(parseAmericanPrice(-110)).toBe(-110);
    expect(parseAmericanPrice(164)).toBe(164);
  });

  it('"EVEN" -> 100', () => {
    // Documented convention: an even-money quote is +100 (risk 100 to win 100).
    expect(parseAmericanPrice('EVEN')).toBe(100);
    expect(parseAmericanPrice('even')).toBe(100);
    expect(parseAmericanPrice('EV')).toBe(100);
  });

  it('"PK" is a LINE token, never a price', () => {
    // "pick'em" describes a 0 spread, not an even-money price, so it must not
    // silently become +100 in a price slot.
    expect(parseAmericanPrice('PK')).toBeNull();
  });

  it('rejects |price| < 100 and > 100000', () => {
    expect(MIN_ABS_AMERICAN_PRICE).toBe(100);
    expect(MAX_ABS_AMERICAN_PRICE).toBe(100_000);
    expect(parseAmericanPrice('-99')).toBeNull();
    expect(parseAmericanPrice('99')).toBeNull();
    expect(parseAmericanPrice('0')).toBeNull();
    expect(parseAmericanPrice('-100')).toBe(-100);
    expect(parseAmericanPrice('100000')).toBe(100_000);
    expect(parseAmericanPrice('100001')).toBeNull();
    expect(parseAmericanPrice('-100001')).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(parseAmericanPrice(undefined)).toBeNull();
    expect(parseAmericanPrice(null)).toBeNull();
    expect(parseAmericanPrice('')).toBeNull();
    expect(parseAmericanPrice('-110.5')).toBeNull();
    expect(parseAmericanPrice('off')).toBeNull();
    expect(parseAmericanPrice(-110.5)).toBeNull();
    expect(parseAmericanPrice({})).toBeNull();
    expect(parseAmericanPrice(Number.NaN)).toBeNull();
  });
});

describe('parseScore', () => {
  it('parses the STRING scores ESPN actually emits', () => {
    expect(parseScore('70')).toBe(70);
    expect(parseScore('13')).toBe(13);
    expect(parseScore(' 7 ')).toBe(7);
    expect(parseScore(21)).toBe(21);
  });

  it('a pre-game "0" is 0, NOT null', () => {
    // `Number(x) || null` would map a real 0-0 scoreline to null and make a
    // 0-0 final permanently ungradeable. PLAN.md §8.3.
    expect(parseScore('0')).toBe(0);
    expect(parseScore(0)).toBe(0);
  });

  it('returns null for absent, empty or non-integer input', () => {
    expect(parseScore(undefined)).toBeNull();
    expect(parseScore(null)).toBeNull();
    expect(parseScore('')).toBeNull();
    expect(parseScore('   ')).toBeNull();
    expect(parseScore('TBD')).toBeNull();
    expect(parseScore('13.5')).toBeNull();
    expect(parseScore(13.5)).toBeNull();
    expect(parseScore(Number.NaN)).toBeNull();
    expect(parseScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseScore({})).toBeNull();
    expect(parseScore([])).toBeNull();
    expect(parseScore(true)).toBeNull();
  });
});

describe('parseRank', () => {
  it('keeps 1..25', () => {
    expect(parseRank(1)).toBe(1);
    expect(parseRank(25)).toBe(25);
    expect(parseRank('5')).toBe(5);
  });

  it('99 and anything outside 1..25 becomes null', () => {
    expect(parseRank(99)).toBeNull();
    expect(parseRank(0)).toBeNull();
    expect(parseRank(26)).toBeNull();
    expect(parseRank(-1)).toBeNull();
    expect(parseRank(1.5)).toBeNull();
    expect(parseRank(undefined)).toBeNull();
    expect(parseRank(null)).toBeNull();
    expect(parseRank('unranked')).toBeNull();
  });

  it('also accepts the whole curatedRank object', () => {
    // ESPN nests it as competitors[].curatedRank.current; accepting both the
    // wrapper and the bare value keeps the call sites honest either way.
    expect(parseRank({ current: 5 })).toBe(5);
    expect(parseRank({ current: 99 })).toBeNull();
    expect(parseRank({})).toBeNull();
  });
});

describe('makeGameId', () => {
  it('is `<league>:<espnEventId>`', () => {
    expect(makeGameId('nfl', '401872925')).toBe('nfl:401872925');
    expect(makeGameId('ncaaf', '401858439')).toBe('ncaaf:401858439');
  });
});

describe('selectOddsEntry', () => {
  const dk = { provider: { id: '100', name: 'DraftKings', priority: 3 } };
  const espnBet = { provider: { id: '58', name: 'ESPN BET', priority: 1 } };
  const other = { provider: { id: '9', name: 'Other', priority: 2 } };

  it('prefers provider id 100, else the lowest priority', () => {
    expect(selectOddsEntry([espnBet, other, dk])).toBe(dk);
    expect(selectOddsEntry([other, espnBet])).toBe(espnBet);
    expect(selectOddsEntry([other])).toBe(other);
  });

  it('tolerates a numeric provider id', () => {
    const numeric = { provider: { id: 100, name: 'DraftKings' } };
    expect(selectOddsEntry([espnBet, numeric])).toBe(numeric);
  });

  it('falls back to the first entry when no priority is usable', () => {
    const a = { provider: { name: 'A' } };
    const b = { provider: { name: 'B' } };
    expect(selectOddsEntry([a, b])).toBe(a);
  });

  it('returns null when there is nothing to pick', () => {
    expect(selectOddsEntry([])).toBeNull();
    expect(selectOddsEntry(undefined)).toBeNull();
    expect(selectOddsEntry(null)).toBeNull();
    expect(selectOddsEntry('nope')).toBeNull();
    expect(selectOddsEntry([null, 'x', 3])).toBeNull();
  });
});

describe('defensive behaviour', () => {
  const scheduled = makeStatus('STATUS_SCHEDULED');

  /** A minimal well-formed event, so a test can break exactly one thing. */
  const baseEvent = (odds?: unknown): unknown => ({
    id: '1',
    date: '2026-09-13T17:00Z',
    name: 'Away at Home',
    shortName: 'AWY @ HOM',
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    competitions: [
      {
        neutralSite: false,
        status: scheduled,
        competitors: [
          {
            homeAway: 'home',
            score: '0',
            team: { id: '1', abbreviation: 'HOM', displayName: 'Home Team', logo: null },
          },
          {
            homeAway: 'away',
            score: '0',
            team: { id: '2', abbreviation: 'AWY', displayName: 'Away Team' },
          },
        ],
        ...(odds === undefined ? {} : { odds: [odds] }),
      },
    ],
  });

  const parseOne = (odds?: unknown): ReturnType<typeof parseEvent> =>
    parseEvent(baseEvent(odds), 'nfl', FETCHED_AT);

  it('an event missing competitions is skipped with a warning, not thrown', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    expect(parsed.games).toHaveLength(1);
    expect(parsed.games[0]?.id).toBe(`nfl:${MALFORMED_GOOD_EVENT_ID}`);
    expect(parsed.warnings.some((w) => w.eventId === 'no-competitions')).toBe(true);
  });

  it('an event with one competitor is skipped with a warning', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    for (const id of ['one-competitor', 'three-competitors', 'two-home-teams']) {
      expect(parsed.warnings.some((w) => w.eventId === id)).toBe(true);
    }
  });

  it('skips an event whose team is missing a required field', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    expect(parsed.warnings.some((w) => w.eventId === 'no-abbreviation')).toBe(true);
  });

  it('skips an event whose date is unparseable rather than storing NaN', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    expect(parsed.warnings.some((w) => w.eventId === 'bad-date')).toBe(true);
    expect(parsed.games.every((g) => Number.isFinite(g.kickoffAt))).toBe(true);
  });

  it('skips an event with no season block (season is NOT nullable on Game)', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    expect(parsed.warnings.some((w) => w.eventId === 'no-season')).toBe(true);
  });

  it('skips non-object entries in events[] without throwing', () => {
    const parsed = parseScoreboard(malformedScoreboard(), 'nfl', FETCHED_AT);
    // Every named broken event, plus the three non-object entries (null, a
    // string and a number) — and nothing else.
    expect(MALFORMED_BROKEN_EVENT_IDS).toHaveLength(7);
    for (const id of MALFORMED_BROKEN_EVENT_IDS) {
      expect(parsed.warnings.filter((w) => w.eventId === id)).toHaveLength(1);
    }
    expect(parsed.warnings.filter((w) => w.eventId === null)).toHaveLength(3);
    expect(parsed.warnings).toHaveLength(MALFORMED_BROKEN_EVENT_IDS.length + 3);
    expect(parsed.warnings.every((w) => w.reason !== '')).toBe(true);
  });

  it('a totally unexpected payload shape returns empty games + a warning', () => {
    for (const payload of [null, undefined, 42, 'nope', [], {}, { events: 'nope' }]) {
      const parsed = parseScoreboard(payload, 'nfl', FETCHED_AT);
      expect(parsed.games).toEqual([]);
      expect(parsed.lines).toEqual([]);
      expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
      expect(parsed.season).toBeNull();
      expect(parsed.week).toBeNull();
    }
  });

  it('caps warnings at ESPN_MAX_WARNINGS_RECORDED', () => {
    const events = Array.from({ length: ESPN_MAX_WARNINGS_RECORDED + 15 }, (_, i) => ({
      id: `broken-${String(i)}`,
      date: '2026-09-13T17:00Z',
    }));
    const parsed = parseScoreboard({ events }, 'nfl', FETCHED_AT);
    expect(parsed.games).toEqual([]);
    expect(parsed.warnings).toHaveLength(ESPN_MAX_WARNINGS_RECORDED);
  });

  it('a missing odds block yields lines: null, and no warning', () => {
    const warnings: ParseWarning[] = [];
    const result = parseEvent(baseEvent(), 'nfl', FETCHED_AT, warnings);
    expect(result?.lines).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('a game with a spread but no moneyline yields a lines row with moneyline: null', () => {
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-3.5', odds: '-110' } },
        away: { close: { line: '+3.5', odds: '-110' } },
      },
    });
    expect(result?.lines).toEqual({
      gameId: 'nfl:1',
      provider: 'DraftKings',
      capturedAt: FETCHED_AT,
      spread: { homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -110 },
      total: null,
      moneyline: null,
    });
  });

  it('falls back to .open when .close is missing', () => {
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { open: { line: '-7', odds: '-105' } },
        away: { open: { line: '+7', odds: '-115' } },
      },
      total: {
        over: { open: { line: 'o41', odds: '-110' } },
        under: { open: { line: 'u41', odds: '-110' } },
      },
      moneyline: { home: { open: { odds: '-300' } }, away: { open: { odds: '+240' } } },
    });
    expect(result?.lines).toMatchObject({
      spread: { homeTenths: -70, homePrice: -105, awayTenths: 70, awayPrice: -115 },
      total: { tenths: 410, overPrice: -110, underPrice: -110 },
      moneyline: { homePrice: -300, awayPrice: 240 },
    });
  });

  it('prefers .close over .open when both are present', () => {
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-3.5', odds: '-112' }, open: { line: '-2.5', odds: '-110' } },
        away: { close: { line: '+3.5', odds: '-108' }, open: { line: '+2.5', odds: '-110' } },
      },
    });
    expect(result?.lines?.spread).toEqual({
      homeTenths: -35,
      homePrice: -112,
      awayTenths: 35,
      awayPrice: -108,
    });
  });

  it('never parses the `details` display string ("CIN -3.5")', () => {
    // `details` is abbreviation-dependent display text. With no pointSpread and
    // no top-level `spread`, the spread market must be null.
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      details: 'CIN -3.5',
      moneyline: { home: { close: { odds: '-198' } }, away: { close: { odds: '+164' } } },
    });
    expect(result?.lines?.spread).toBeNull();
    expect(result?.lines?.moneyline).toEqual({ homePrice: -198, awayPrice: 164 });
  });

  it('falls back to the top-level `spread` number when the line is missing', () => {
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      details: 'HOM -3.5',
      spread: -3.5,
      pointSpread: {
        home: { close: { odds: '-110' } },
        away: { close: { odds: '-110' } },
      },
    });
    expect(result?.lines?.spread).toEqual({
      homeTenths: -35,
      homePrice: -110,
      awayTenths: 35,
      awayPrice: -110,
    });
  });

  it('falls back to the top-level `overUnder` number when the total line is missing', () => {
    const result = parseOne({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      overUnder: 44.5,
      total: { over: { close: { odds: '-110' } }, under: { close: { odds: '-110' } } },
    });
    expect(result?.lines?.total).toEqual({ tenths: 445, overPrice: -110, underPrice: -110 });
  });

  it('drops an out-of-range line and warns, keeping the other markets', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-9999', odds: '-110' } },
        away: { close: { line: '+9999', odds: '-110' } },
      },
      moneyline: { home: { close: { odds: '-198' } }, away: { close: { odds: '+164' } } },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines?.spread).toBeNull();
    expect(result?.lines?.moneyline).toEqual({ homePrice: -198, awayPrice: 164 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.eventId).toBe('1');
    expect(warnings[0]?.reason).toMatch(/spread/i);
  });

  it('mirrors an unusable away spread line from home, but says so in the warning', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-3.5', odds: '-110' } },
        away: { close: { line: '-9999', odds: '-110' } },
      },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines?.spread).toEqual({
      homeTenths: -35,
      homePrice: -110,
      awayTenths: 35,
      awayPrice: -110,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toMatch(/away line -9999.*mirrored/);
  });

  it('drops a spread whose sides do not mirror (favourite number on both sides)', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-3.5', odds: '-110' } },
        away: { close: { line: '-3.5', odds: '-110' } },
      },
      moneyline: { home: { close: { odds: '-198' } }, away: { close: { odds: '+164' } } },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines?.spread).toBeNull();
    expect(result?.lines?.moneyline).toEqual({ homePrice: -198, awayPrice: 164 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toMatch(/do not mirror.*home -3\.5.*away -3\.5/);
  });

  it('drops an unusable total and names the offending value in the warning', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      total: {
        over: { close: { line: 'o−50.5', odds: '-110' } },
        under: { close: { line: 'u−50.5', odds: '-110' } },
      },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toMatch(/total: unusable line o−50\.5/);
  });

  it('drops a total whose over and under lines disagree', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      total: {
        over: { close: { line: 'o50.5', odds: '-110' } },
        under: { close: { line: 'u44.5', odds: '-110' } },
      },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines).toBeNull();
    expect(warnings[0]?.reason).toMatch(/total: sides disagree \(over o50\.5, under u44\.5\)/);
  });

  it("reports a silently-dropped market alongside another market's diagnostic", () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '−3.5', odds: '-110' } },
        away: { close: { line: '+3.5', odds: '-110' } },
      },
      moneyline: {},
    });
    parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toMatch(/spread: unusable home line −3\.5/);
    expect(warnings[0]?.reason).toMatch(/dropped unusable moneyline/);
  });

  it('never throws on values JSON.stringify cannot serialise', () => {
    const warnings: ParseWarning[] = [];
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: 10n, odds: '-110' } },
        away: { close: { line: circular, odds: { toJSON: () => undefined } } },
      },
    });
    expect(() => parseEvent(event, 'nfl', FETCHED_AT, warnings)).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it('names the failing side when only the under/overUnder line is unusable', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      total: {
        over: { close: { odds: '-110' } },
        under: { close: { line: 'u−44.5', odds: '-110' } },
      },
    });
    parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(warnings[0]?.reason).toMatch(/total: unusable line u−44\.5/);
  });

  it('a market DraftKings has pulled ("OFF") is reported as off the board, not as a parse failure', () => {
    // Verbatim shape ESPN served for CFB event 401856811 on 2026-09-16: the
    // spread was up, the total and moneyline were the literal string "OFF".
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      pointSpread: {
        home: { close: { line: '-7.5', odds: '-105' }, open: { line: '-12.5', odds: '-110' } },
        away: { close: { line: '+7.5', odds: '-115' }, open: { line: '+12.5', odds: '-110' } },
      },
      total: {
        over: { close: { line: 'OFF', odds: 'OFF' }, open: { line: 'OFF', odds: 'OFF' } },
        under: { close: { line: 'OFF', odds: 'OFF' }, open: { line: 'OFF', odds: 'OFF' } },
      },
      moneyline: {
        home: { close: { odds: 'OFF' }, open: { odds: 'OFF' } },
        away: { close: { odds: 'OFF' }, open: { odds: 'OFF' } },
      },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines?.spread).toEqual({
      homeTenths: -75,
      homePrice: -105,
      awayTenths: 75,
      awayPrice: -115,
    });
    expect(result?.lines?.total).toBeNull();
    expect(result?.lines?.moneyline).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toBe('DraftKings: total: off the board; moneyline: off the board');
    expect(warnings[0]?.reason).not.toMatch(/unusable/);
  });

  it('an OFF spread is dropped without falling back to the top-level `spread` number', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      spread: -3.5,
      pointSpread: {
        home: { close: { line: 'OFF', odds: 'OFF' } },
        away: { close: { line: 'OFF', odds: 'OFF' } },
      },
      moneyline: { home: { close: { odds: '-198' } }, away: { close: { odds: '+164' } } },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines?.spread).toBeNull();
    expect(result?.lines?.moneyline).toEqual({ homePrice: -198, awayPrice: 164 });
    expect(warnings[0]?.reason).toBe('DraftKings: spread: off the board');
  });

  it('OFF is recognised case- and whitespace-insensitively, and on the price alone', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      total: {
        over: { close: { line: 'o50.5', odds: ' off ' } },
        under: { close: { line: 'u50.5', odds: '-110' } },
      },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines).toBeNull();
    expect(warnings[0]?.reason).toBe('DraftKings: total: off the board');
  });

  it('a market warning carries the matchup label so the admin view can name the game', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      moneyline: { home: { close: { odds: 'OFF' } }, away: { close: { odds: 'OFF' } } },
    });
    parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(warnings).toEqual([
      { eventId: '1', label: 'AWY @ HOM', reason: 'DraftKings: moneyline: off the board' },
    ]);
  });

  it('a structural warning raised before the teams are known has a null label', () => {
    const warnings: ParseWarning[] = [];
    parseEvent({ id: 'x' }, 'nfl', FETCHED_AT, warnings);
    expect(warnings[0]?.label).toBeNull();
  });

  it('drops an out-of-range price and warns', () => {
    const warnings: ParseWarning[] = [];
    const event = baseEvent({
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      moneyline: { home: { close: { odds: '-5' } }, away: { close: { odds: '+3' } } },
    });
    const result = parseEvent(event, 'nfl', FETCHED_AT, warnings);
    expect(result?.lines).toBeNull();
    expect(warnings.some((w) => /moneyline/i.test(w.reason))).toBe(true);
  });

  it('an odds block that yields no usable market at all yields lines: null', () => {
    const result = parseOne({ provider: { id: '100', name: 'DraftKings', priority: 1 } });
    expect(result?.game).toBeDefined();
    expect(result?.lines).toBeNull();
  });

  it('records the provider NAME on the lines row, not its id', () => {
    const result = parseOne({
      provider: { id: '58', name: 'ESPN BET', priority: 1 },
      moneyline: { home: { close: { odds: '-198' } }, away: { close: { odds: '+164' } } },
    });
    expect(result?.lines?.provider).toBe('ESPN BET');
  });

  it('parseEvent returns null for an unusable event and records why', () => {
    const warnings: ParseWarning[] = [];
    expect(parseEvent({ id: 'x' }, 'nfl', FETCHED_AT, warnings)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.eventId).toBe('x');
  });

  it('parseEvent never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 0, '', [], {}, { competitions: [{}] }]) {
      expect(() => parseEvent(junk, 'nfl', FETCHED_AT)).not.toThrow();
      expect(parseEvent(junk, 'nfl', FETCHED_AT)).toBeNull();
    }
  });

  it('reads season/week from the EVENT, not the payload root', () => {
    // A date query can span two weeks (and, in January, two season types).
    const payload = {
      season: { year: 2025, type: 1 },
      week: { number: 99 },
      events: [baseEvent()],
    };
    const parsed = parseScoreboard(payload, 'nfl', FETCHED_AT);
    expect(parsed.games[0]?.season).toBe(2026);
    expect(parsed.games[0]?.seasonType).toBe(2);
    expect(parsed.games[0]?.week).toBe(2);
    // The root values are still reported, for the planner.
    expect(parsed.season).toBe(2025);
    expect(parsed.week).toBe(99);
  });

  it('a missing event.week.number is null, not a guess', () => {
    const event = baseEvent() as { week?: unknown };
    delete event.week;
    const parsed = parseScoreboard({ events: [event] }, 'nfl', FETCHED_AT);
    expect(parsed.games).toHaveLength(1);
    expect(parsed.games[0]?.week).toBeNull();
  });

  it('a null logo stays null', () => {
    const result = parseOne();
    expect(result?.game.home.logo).toBeNull();
    expect(result?.game.away.logo).toBeNull();
  });
});
