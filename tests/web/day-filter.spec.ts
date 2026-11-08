/**
 * The basketball boards' day filter (F4, PLAN.md §24.14). Every instant is an
 * explicit UTC ISO string, so the ET answers do not depend on the machine's
 * timezone: 2026-11-07 is a Saturday in EST (ET midnight = 05:00Z), and
 * 2026-11-01 is the 25 h fall-back day (EDT midnight 04:00Z, EST 05:00Z).
 */
import { describe, expect, it } from 'vitest';

import { LEAGUES } from '../../src/shared/types.js';
import { filterGames } from '../../src/web/lib/board-filter.js';
import {
  ALL_DAYS,
  DAY_FILTER_LEAGUES,
  dayFilterOptions,
  filterGamesByDay,
  resolveDayFilter,
} from '../../src/web/lib/day-filter.js';
import { boardEmptyCopy } from '../../src/web/lib/grouping.js';
import { gameCard } from './factories.js';
import type { GameCard } from '../../src/shared/api-types.js';
import type { League } from '../../src/shared/types.js';

const at = (iso: string): number => Date.parse(iso);

function game(id: string, league: League, iso: string, rank: number | null = null): GameCard {
  const base = gameCard({ id, league, week: null, kickoffAt: at(iso) });
  return { ...base, home: { ...base.home, rank } };
}

const SAT_NOON = at('2026-11-07T17:00:00Z');

// Saturday, a 9 PM EST Saturday tip (02:00Z Sunday), Sunday, Monday.
const CBB = [
  game('sat', 'ncaab', '2026-11-07T17:00:00Z', 5),
  game('satLate', 'ncaab', '2026-11-08T02:00:00Z'),
  game('sun', 'ncaab', '2026-11-08T18:00:00Z'),
  game('mon', 'ncaab', '2026-11-10T00:00:00Z', 12),
];

const labels = (league: League, games: readonly GameCard[], now: number) =>
  dayFilterOptions(league, games, now)?.map((o) => [o.key, o.label]);

describe('dayFilterOptions — shape', () => {
  it('only the two basketball boards have one; every other league gets null', () => {
    for (const league of LEAGUES) {
      expect(dayFilterOptions(league, [], SAT_NOON) !== null).toBe(DAY_FILTER_LEAGUES[league]);
    }
    expect(LEAGUES.filter((l) => DAY_FILTER_LEAGUES[l])).toEqual(['ncaab', 'nba']);
  });

  it('college: All + three days, the third by its weekday name', () => {
    expect(labels('ncaab', CBB, SAT_NOON)).toEqual([
      ['all', 'All'],
      ['20261107', 'Today'],
      ['20261108', 'Tomorrow'],
      ['20261109', 'Monday'],
    ]);
  });

  it('NBA: All + two days (its window is today + 1)', () => {
    const nba = [
      game('a', 'nba', '2026-11-08T00:30:00Z'),
      game('b', 'nba', '2026-11-08T23:00:00Z'),
      // Outside the NBA window: never offered even if the slate held it.
      game('c', 'nba', '2026-11-10T00:30:00Z'),
    ];
    expect(labels('nba', nba, SAT_NOON)).toEqual([
      ['all', 'All'],
      ['20261107', 'Today'],
      ['20261108', 'Tomorrow'],
    ]);
  });

  it('a day with no games is not offered, and the phrases read inside a sentence', () => {
    const options = dayFilterOptions('ncaab', [CBB[0] as GameCard, CBB[3] as GameCard], SAT_NOON);
    expect(options?.map((o) => o.phrase)).toEqual([null, 'today', 'on Monday']);
  });

  it("a game from the board's 12 h lookback (yesterday ET) offers no day", () => {
    const yesterday = game('fri', 'ncaab', '2026-11-07T03:00:00Z');
    expect(labels('ncaab', [yesterday], SAT_NOON)).toEqual([['all', 'All']]);
  });
});

describe('dayFilterOptions — labels follow `now` across ET midnight and DST', () => {
  it('rolls over at ET midnight (05:00Z in EST), not at UTC or local midnight', () => {
    const before = at('2026-11-08T04:59:59Z'); // Sat 23:59:59 EST
    const after = at('2026-11-08T05:00:00Z'); // Sun 00:00 EST
    const slate = [...CBB, game('tue', 'ncaab', '2026-11-11T00:00:00Z')];
    expect(labels('ncaab', slate, before)?.slice(1)).toEqual([
      ['20261107', 'Today'],
      ['20261108', 'Tomorrow'],
      ['20261109', 'Monday'],
    ]);
    expect(labels('ncaab', slate, after)?.slice(1)).toEqual([
      ['20261108', 'Today'],
      ['20261109', 'Tomorrow'],
      ['20261110', 'Tuesday'],
    ]);
  });

  it('across the 25 h fall-back day (2026-11-01) a late Sunday tip stays on Sunday', () => {
    const satNoonEdt = at('2026-10-31T16:00:00Z');
    const slate = [
      game('sat', 'ncaab', '2026-10-31T20:00:00Z'),
      // Sun 23:30 EST — Monday by UTC date, and by any "+ 24 h" day walk.
      game('sunLate', 'ncaab', '2026-11-02T04:30:00Z'),
      // Mon 23:30 EST.
      game('monLate', 'ncaab', '2026-11-03T04:30:00Z'),
    ];
    expect(labels('ncaab', slate, satNoonEdt)).toEqual([
      ['all', 'All'],
      ['20261031', 'Today'],
      ['20261101', 'Tomorrow'],
      ['20261102', 'Monday'],
    ]);
    expect(filterGamesByDay(slate, '20261101').map((g) => g.id)).toEqual(['sunLate']);
    expect(filterGamesByDay(slate, '20261102').map((g) => g.id)).toEqual(['monLate']);
  });

  it('the fall-back day runs 25 h: 04:00Z (EDT midnight) to 05:00Z the next day (EST)', () => {
    expect(
      labels('nba', [game('x', 'nba', '2026-11-02T04:59:00Z')], at('2026-11-01T04:00:00Z')),
    ).toEqual([
      ['all', 'All'],
      ['20261101', 'Today'],
    ]);
    expect(
      labels('nba', [game('x', 'nba', '2026-11-02T04:59:00Z')], at('2026-11-02T05:00:00Z')),
    ).toEqual([['all', 'All']]);
  });
});

describe('filterGamesByDay and resolveDayFilter', () => {
  it('"all" is the slate itself; a day keeps only that ET date', () => {
    expect(filterGamesByDay(CBB, ALL_DAYS)).toBe(CBB);
    expect(filterGamesByDay(CBB, '20261107').map((g) => g.id)).toEqual(['sat', 'satLate']);
    expect(filterGamesByDay(CBB, '20261109').map((g) => g.id)).toEqual(['mon']);
  });

  it('a pick still in the options applies; a stale or absent one falls back to All', () => {
    const options = dayFilterOptions('ncaab', CBB, SAT_NOON);
    expect(resolveDayFilter('20261108', options)?.label).toBe('Tomorrow');
    expect(resolveDayFilter(null, options)?.key).toBe(ALL_DAYS);
    // Yesterday's "Today" after ET midnight.
    expect(resolveDayFilter('20261106', options)?.key).toBe(ALL_DAYS);
    expect(resolveDayFilter('20261108', null)).toBeNull();
  });

  it('composes with the Top 25 filter: both apply, in either order', () => {
    const top25 = filterGames('ncaab', CBB, 'top25');
    expect(filterGamesByDay(top25, '20261107').map((g) => g.id)).toEqual(['sat']);
    expect(filterGamesByDay(top25, '20261108')).toEqual([]);
    expect(filterGames('ncaab', filterGamesByDay(CBB, '20261109'), 'top25')).toEqual(
      filterGamesByDay(top25, '20261109'),
    );
  });
});

describe('boardEmptyCopy — a picked day is named (F4)', () => {
  it('Top 25 + a weekday', () => {
    expect(boardEmptyCopy('ncaab', true, 'top25', 'on Monday')).toEqual({
      title: 'No Top 25 games on Monday.',
      hint: 'Pick another day, or switch Show to All games.',
    });
  });

  it('a conference + tomorrow; the NBA + today', () => {
    expect(boardEmptyCopy('ncaab', true, 'conf:23', 'tomorrow').title).toBe(
      'No games match that filter tomorrow.',
    );
    expect(boardEmptyCopy('nba', true, 'all', 'today')).toEqual({
      title: 'No NBA games today.',
      hint: 'Pick another day, or All.',
    });
  });

  it('without a day the M13d copy is unchanged, and other leagues ignore the argument', () => {
    expect(boardEmptyCopy('ncaab', true, 'top25', null)).toEqual(
      boardEmptyCopy('ncaab', true, 'top25'),
    );
    expect(boardEmptyCopy('ncaaf', true, 'top25', 'today')).toEqual(
      boardEmptyCopy('ncaaf', true, 'top25'),
    );
    expect(boardEmptyCopy('nba', false, 'all', 'today')).toEqual(boardEmptyCopy('nba', false));
  });
});
