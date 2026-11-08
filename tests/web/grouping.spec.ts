import { describe, expect, it } from 'vitest';

import {
  BOARD_HAS_WEEKS,
  boardEmptyCopy,
  groupBoardGames,
  groupBetsByWeek,
  groupGamesByLocalDate,
  weeksFromGames,
} from '../../src/web/lib/grouping.js';
import { betView, gameCard, localMs } from './factories.js';
import type { GameCard } from '../../src/shared/api-types.js';

describe('groupGamesByLocalDate', () => {
  it('returns one group per local calendar day, ascending', () => {
    const groups = groupGamesByLocalDate([
      gameCard({ id: 'sun', kickoffAt: localMs(2026, 9, 13, 13) }),
      gameCard({ id: 'thu', kickoffAt: localMs(2026, 9, 10, 20) }),
      gameCard({ id: 'sun2', kickoffAt: localMs(2026, 9, 13, 16, 25) }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-10', '2026-09-13']);
    expect(groups[1]?.games.map((g) => g.id)).toEqual(['sun', 'sun2']);
  });

  it('sorts games inside a day by kickoff', () => {
    const groups = groupGamesByLocalDate([
      gameCard({ id: 'late', kickoffAt: localMs(2026, 9, 13, 20, 20) }),
      gameCard({ id: 'early', kickoffAt: localMs(2026, 9, 13, 13) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.games.map((g) => g.id)).toEqual(['early', 'late']);
  });

  it('returns nothing for an empty slate rather than a phantom group', () => {
    expect(groupGamesByLocalDate([])).toEqual([]);
  });

  it('does not mutate the input array order', () => {
    const games = [
      gameCard({ id: 'b', kickoffAt: localMs(2026, 9, 13, 13) }),
      gameCard({ id: 'a', kickoffAt: localMs(2026, 9, 10, 20) }),
    ];
    groupGamesByLocalDate(games);
    expect(games.map((g) => g.id)).toEqual(['b', 'a']);
  });
});

describe('weeksFromGames', () => {
  it('is the distinct weeks present, ascending, plus anything asked for', () => {
    const games = [
      gameCard({ id: '1', week: 3 }),
      gameCard({ id: '2', week: 2 }),
      gameCard({ id: '3', week: 3 }),
      gameCard({ id: '4', week: null }),
    ];
    expect(weeksFromGames(games, 5, null)).toEqual([2, 3, 5]);
  });

  it('is empty when nothing carries a week', () => {
    expect(weeksFromGames([gameCard({ id: '1', week: null })], null)).toEqual([]);
  });
});

describe('groupBetsByWeek', () => {
  it('puts Thursday, Sunday and Monday bets of one week in one group', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'thu', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
      betView({ id: 'sun', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 13, 13) }] }),
      betView({ id: 'mon', legs: [{ gameId: 'g3', kickoffAt: localMs(2026, 9, 14, 20) }] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bets).toHaveLength(3);
  });

  it('splits the next week into its own group, newest first', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'w2', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 13, 13) }] }),
      betView({ id: 'w3', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 20, 13) }] }),
    ]);
    expect(groups.map((g) => g.bets[0]?.id)).toEqual(['w3', 'w2']);
  });

  it('never mixes leagues inside the same week, and treats mixed as its own', () => {
    const kickoff = localMs(2026, 9, 12, 15);
    const groups = groupBetsByWeek([
      betView({ id: 'nfl', league: 'nfl', legs: [{ gameId: 'g1', kickoffAt: kickoff }] }),
      betView({ id: 'ncaaf', league: 'ncaaf', legs: [{ gameId: 'g2', kickoffAt: kickoff }] }),
      betView({ id: 'mixed', league: 'mixed', legs: [{ gameId: 'g3', kickoffAt: kickoff }] }),
    ]);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
    expect(groups.map((g) => g.league).sort()).toEqual(['mixed', 'ncaaf', 'nfl']);
  });

  it('does NOT split a week by season — the product has no seasons', () => {
    // The bucket is keyed on an absolute week anchor, so two bets in the same
    // week could never have been a year apart anyway; carrying `bets.season`
    // in the key only ever split a week that ESPN happened to label oddly.
    const kickoff = localMs(2026, 9, 12, 15);
    const groups = groupBetsByWeek([
      betView({ id: 'a', season: 2026, legs: [{ gameId: 'g1', kickoffAt: kickoff }] }),
      betView({ id: 'b', season: 2025, legs: [{ gameId: 'g2', kickoffAt: kickoff }] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bets).toHaveLength(2);
    expect(groups[0]?.label).not.toMatch(/20\d\d/);
  });

  it('buckets a parlay by its EARLIEST leg', () => {
    const groups = groupBetsByWeek([
      betView({
        id: 'parlay',
        legs: [
          { gameId: 'late', kickoffAt: localMs(2026, 9, 14, 20) },
          { gameId: 'early', kickoffAt: localMs(2026, 9, 10, 20) },
        ],
      }),
      betView({ id: 'thu', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('labels the group with the league and the local date span, with no year', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'a', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
      betView({ id: 'b', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 14, 20) }] }),
    ]);
    expect(groups[0]?.label).toContain('NFL');
    expect(groups[0]?.label).toContain('–');
    expect(groups[0]?.label).not.toMatch(/20\d\d/);
  });

  it("labels a cross-league group 'Mixed' (M12a: 'NFL + NCAAF' would be false for MLB + NFL)", () => {
    const groups = groupBetsByWeek([
      betView({
        id: 'mix',
        league: 'mixed',
        legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }],
      }),
    ]);
    expect(groups[0]?.label).toContain('Mixed');
    expect(groups[0]?.label).not.toContain('NFL + NCAAF');
  });

  it('returns nothing for no bets', () => {
    expect(groupBetsByWeek([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M12c: the week-less MLB board (PLAN.md §23.12). MLB's board is "today, US
// Eastern" (§23.5), so its day groups are ET calendar dates — computed by the
// shared `etDateKey` (Intl + America/New_York), never an offset. The epochs
// below are UTC literals ON PURPOSE: the point is that the answer does not
// depend on the machine's timezone.
// ---------------------------------------------------------------------------

describe('BOARD_HAS_WEEKS (M12c)', () => {
  it('football has weeks; MLB and basketball (M13c) do not', () => {
    expect(BOARD_HAS_WEEKS).toEqual({
      nfl: true,
      ncaaf: true,
      mlb: false,
      ncaab: false,
      nba: false,
    });
  });
});

describe('groupBoardGames — MLB by ET date (M12c)', () => {
  const at = (iso: string): number => Date.parse(iso);

  it('puts a 02:15Z first pitch on the PREVIOUS ET date (22:15 EDT)', () => {
    const groups = groupBoardGames('mlb', [
      gameCard({ id: 'late', league: 'mlb', week: null, kickoffAt: at('2026-09-25T02:15:00Z') }),
      gameCard({ id: 'noon', league: 'mlb', week: null, kickoffAt: at('2026-09-24T16:05:00Z') }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-24']);
    expect(groups[0]?.games.map((g) => g.id)).toEqual(['noon', 'late']);
    expect(groups[0]?.label).toMatch(/24/);
  });

  it("splits last night's final from today's slate at ET midnight (04:00Z in EDT)", () => {
    const groups = groupBoardGames('mlb', [
      gameCard({ id: 'today', league: 'mlb', week: null, kickoffAt: at('2026-09-24T04:00:00Z') }),
      gameCard({ id: 'last', league: 'mlb', week: null, kickoffAt: at('2026-09-24T03:59:00Z') }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-23', '2026-09-24']);
    expect(groups.map((g) => g.label)).not.toContain(undefined);
    expect(groups[0]?.label).toMatch(/23/);
  });

  it('uses the EST midnight after DST ends (05:00Z on 2026-11-02)', () => {
    const groups = groupBoardGames('mlb', [
      gameCard({ id: 'a', league: 'mlb', week: null, kickoffAt: at('2026-11-02T04:30:00Z') }),
      gameCard({ id: 'b', league: 'mlb', week: null, kickoffAt: at('2026-11-02T05:00:00Z') }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('football still groups by the viewer-local date, byte-identically', () => {
    const games = [
      gameCard({ id: 'sun', kickoffAt: localMs(2026, 9, 13, 13) }),
      gameCard({ id: 'thu', kickoffAt: localMs(2026, 9, 10, 20) }),
    ];
    expect(groupBoardGames('nfl', games)).toEqual(groupGamesByLocalDate(games));
    expect(groupBoardGames('ncaaf', games)).toEqual(groupGamesByLocalDate(games));
  });
});

describe('boardEmptyCopy (M12c)', () => {
  it('never tells an MLB user to try another week, and says lines post on game day', () => {
    const copy = boardEmptyCopy('mlb', false);
    expect(copy.title).toMatch(/MLB/);
    expect(`${copy.title} ${copy.hint}`).not.toMatch(/week/i);
    expect(copy.hint).toMatch(/game day/);
  });

  it('keeps the football copy exactly as it was', () => {
    for (const league of ['nfl', 'ncaaf'] as const) {
      expect(boardEmptyCopy(league, false)).toEqual({
        title: 'No games in this window.',
        hint: 'Try another week, or check back once the schedule is ingested.',
      });
    }
    expect(boardEmptyCopy('ncaaf', true)).toEqual({
      title: 'No games match that filter this week.',
      hint: 'Pick another conference, or All games.',
    });
  });
});

// ---------------------------------------------------------------------------
// M13d: the basketball boards (PLAN.md §24.14). Both group by ET date across
// their windows — the MLB path — and their empty copy names the league and
// never tells anyone to try another week.
// ---------------------------------------------------------------------------

describe('groupBoardGames — basketball by ET date across the window (M13d)', () => {
  const at = (iso: string): number => Date.parse(iso);
  const cbb = (id: string, iso: string): GameCard =>
    gameCard({ id, league: 'ncaab', week: null, kickoffAt: at(iso) });

  it('ncaab: a three-date window is three ET day groups; a 9 PM ET tip stays on its date', () => {
    const groups = groupBoardGames('ncaab', [
      cbb('mon', '2026-11-10T00:00:00Z'),
      cbb('satLate', '2026-11-08T02:00:00Z'),
      cbb('sat', '2026-11-07T17:00:00Z'),
      cbb('sun', '2026-11-08T18:00:00Z'),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-11-07', '2026-11-08', '2026-11-09']);
    expect(groups[0]?.games.map((g) => g.id)).toEqual(['sat', 'satLate']);
    expect(groups[2]?.games.map((g) => g.id)).toEqual(['mon']);
  });

  it('nba: today and tomorrow, split at ET midnight (05:00Z in EST)', () => {
    const groups = groupBoardGames('nba', [
      gameCard({ id: 'b', league: 'nba', week: null, kickoffAt: at('2026-11-08T05:00:00Z') }),
      gameCard({ id: 'a', league: 'nba', week: null, kickoffAt: at('2026-11-08T04:59:00Z') }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-11-07', '2026-11-08']);
  });
});

describe('boardEmptyCopy — basketball (M13d)', () => {
  it('ncaab: the Top 25 default emptying the board says so and points at All games', () => {
    const copy = boardEmptyCopy('ncaab', true, 'top25');
    expect(copy.title).toBe('No Top 25 games in the next three days.');
    expect(copy.hint).toMatch(/All games/);
  });

  it('ncaab: a conference that empties the board says "next three days", not "this week"', () => {
    const copy = boardEmptyCopy('ncaab', true, 'conf:23');
    expect(copy.title).toBe('No games match that filter in the next three days.');
    expect(copy.hint).toBe('Pick another conference, or All games.');
  });

  it('ncaab and nba with nothing on the board name the league; neither mentions a week', () => {
    const cbb = boardEmptyCopy('ncaab', false);
    const nba = boardEmptyCopy('nba', false);
    expect(cbb.title).toMatch(/college basketball/i);
    expect(nba.title).toMatch(/NBA/);
    expect(nba.hint).toBe("Tomorrow's games appear with their lines a day ahead.");
    for (const copy of [cbb, nba]) {
      expect(`${copy.title} ${copy.hint}`).not.toMatch(/week|MLB/i);
    }
  });

  it('football and MLB copy is unchanged by the optional filter argument', () => {
    expect(boardEmptyCopy('ncaaf', true, 'top25')).toEqual(boardEmptyCopy('ncaaf', true));
    expect(boardEmptyCopy('mlb', false, 'all')).toEqual(boardEmptyCopy('mlb', false));
  });
});
