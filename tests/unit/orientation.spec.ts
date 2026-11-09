import { describe, expect, it } from 'vitest';

import {
  orientSlate,
  orientationOf,
  swapGameSides,
  swapLineSides,
} from '../../src/shared/orientation.js';
import type { Game, GameLines, GameTeam } from '../../src/shared/types.js';

/**
 * PLAN.md §8.5: a game's home/away orientation is fixed at first sight. The
 * 2026-11-08 case — ESPN re-published the Lake Tahoe Classic's "HOU @ CAL" as
 * "CAL @ HOU" on game day — is the shape every test here uses.
 */

const CAL: GameTeam = {
  teamId: '25',
  abbr: 'CAL',
  name: 'California Golden Bears',
  logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/25.png',
  rank: null,
  conferenceId: '2',
  score: 68,
};
const HOU: GameTeam = {
  teamId: '248',
  abbr: 'HOU',
  name: 'Houston Cougars',
  logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/248.png',
  rank: 10,
  conferenceId: '8',
  score: 86,
};

/** ESPN's game-day payload: Houston listed home. */
const AS_PUBLISHED: Game = {
  id: 'ncaab:401918053',
  league: 'ncaab',
  season: 2027,
  seasonType: 2,
  week: null,
  name: 'California Golden Bears at Houston Cougars',
  shortName: 'CAL VS HOU',
  kickoffAt: 1_794_187_800_000,
  originalKickoffAt: 1_794_187_800_000,
  status: 'final',
  statusDetail: 'Final',
  period: 2,
  displayClock: '0:00',
  neutralSite: true,
  home: HOU,
  away: CAL,
};

/** The row as first stored the evening before: Cal home, Houston away. */
const STORED = { homeTeamId: '25', awayTeamId: '248' };

const LINES: GameLines = {
  gameId: 'ncaab:401918053',
  provider: 'espn',
  capturedAt: 1_794_182_788_681,
  spread: { homeTenths: -195, homePrice: -115, awayTenths: 195, awayPrice: -105 },
  total: { tenths: 1435, overPrice: -105, underPrice: -115 },
  moneyline: { homePrice: -3200, awayPrice: 1400 },
};

describe('orientationOf', () => {
  it('a brand-new game (nothing stored) is written as parsed', () => {
    expect(orientationOf(AS_PUBLISHED, undefined)).toBe('same');
  });

  it('the same ids on the same sides is same', () => {
    expect(orientationOf(AS_PUBLISHED, { homeTeamId: '248', awayTeamId: '25' })).toBe('same');
  });

  it('the same two ids the other way round is swapped', () => {
    expect(orientationOf(AS_PUBLISHED, STORED)).toBe('swapped');
  });

  it('a different pair of ids is unknown — a different game, never swapped', () => {
    expect(orientationOf(AS_PUBLISHED, { homeTeamId: '25', awayTeamId: '30' })).toBe('unknown');
    expect(orientationOf(AS_PUBLISHED, { homeTeamId: '99', awayTeamId: '98' })).toBe('unknown');
  });
});

describe('swapGameSides', () => {
  it('exchanges the two teams whole — id, abbr, name, logo, rank, conference and SCORE together', () => {
    const swapped = swapGameSides(AS_PUBLISHED);
    expect(swapped.home).toBe(CAL);
    expect(swapped.away).toBe(HOU);
    expect(swapped.home.score).toBe(68);
    expect(swapped.away.score).toBe(86);
  });

  it('keeps everything else, including ESPN name text, as sent', () => {
    const swapped = swapGameSides(AS_PUBLISHED);
    const { home: _h, away: _a, ...rest } = AS_PUBLISHED;
    const { home: _sh, away: _sa, ...swappedRest } = swapped;
    expect(swappedRest).toEqual(rest);
    expect(swapped.shortName).toBe('CAL VS HOU');
  });

  it('is an involution', () => {
    expect(swapGameSides(swapGameSides(AS_PUBLISHED))).toEqual(AS_PUBLISHED);
  });
});

describe('swapLineSides', () => {
  it('exchanges the spread and moneyline sides and leaves the total alone', () => {
    const swapped = swapLineSides(LINES);
    expect(swapped.spread).toEqual({
      homeTenths: 195,
      homePrice: -105,
      awayTenths: -195,
      awayPrice: -115,
    });
    expect(swapped.moneyline).toEqual({ homePrice: 1400, awayPrice: -3200 });
    expect(swapped.total).toBe(LINES.total);
    expect(swapped.gameId).toBe(LINES.gameId);
    expect(swapped.capturedAt).toBe(LINES.capturedAt);
  });

  it('a market that is absent stays absent', () => {
    const swapped = swapLineSides({ ...LINES, spread: null, moneyline: null });
    expect(swapped.spread).toBeNull();
    expect(swapped.moneyline).toBeNull();
  });

  it('is an involution', () => {
    expect(swapLineSides(swapLineSides(LINES))).toEqual(LINES);
  });
});

describe('orientSlate', () => {
  it('swaps a game AND its line onto the stored orientation, and counts it', () => {
    const out = orientSlate([AS_PUBLISHED], [LINES], new Map([[AS_PUBLISHED.id, STORED]]));
    expect(out.swapped).toBe(1);
    expect(out.games[0]?.home.teamId).toBe('25');
    expect(out.games[0]?.home.score).toBe(68);
    expect(out.games[0]?.away.score).toBe(86);
    expect(out.lines[0]?.spread?.homeTenths).toBe(195);
    expect(out.lines[0]?.moneyline?.homePrice).toBe(1400);
  });

  it('a game whose stored sides match, or that is new, passes through untouched (same object)', () => {
    const other: Game = { ...AS_PUBLISHED, id: 'ncaab:1', home: CAL, away: HOU };
    const stored = new Map([
      [AS_PUBLISHED.id, { homeTeamId: '248', awayTeamId: '25' }],
      // 'ncaab:1' is absent: a brand-new game.
    ]);
    const out = orientSlate([AS_PUBLISHED, other], [LINES], stored);
    expect(out.swapped).toBe(0);
    expect(out.games[0]).toBe(AS_PUBLISHED);
    expect(out.games[1]).toBe(other);
    expect(out.lines[0]).toBe(LINES);
  });

  it('an unknown pair of ids is never swapped', () => {
    const out = orientSlate(
      [AS_PUBLISHED],
      [LINES],
      new Map([[AS_PUBLISHED.id, { homeTeamId: '25', awayTeamId: '30' }]]),
    );
    expect(out.swapped).toBe(0);
    expect(out.games[0]).toBe(AS_PUBLISHED);
  });

  it('a line is swapped only when ITS game is', () => {
    const otherLine: GameLines = { ...LINES, gameId: 'ncaab:1' };
    const out = orientSlate(
      [AS_PUBLISHED],
      [LINES, otherLine],
      new Map([[AS_PUBLISHED.id, STORED]]),
    );
    expect(out.lines[0]?.moneyline?.homePrice).toBe(1400);
    expect(out.lines[1]).toBe(otherLine);
  });
});
