import { describe, expect, it } from 'vitest';
import { CBB_CONFERENCES, CFB_CONFERENCES } from '../../src/shared/constants.js';
import { LEAGUES } from '../../src/shared/types.js';
import {
  BOARD_FILTERS,
  OTHER_CONFERENCE,
  boardFilterOptions,
  defaultBoardFilter,
  filterGames,
  isBoardFilter,
} from '../../src/web/lib/board-filter.js';
import { gameCard } from './factories.js';
import type { GameCard } from '../../src/shared/api-types.js';

function cfb(
  id: string,
  home: { conf: string | null; rank?: number },
  away: { conf: string | null; rank?: number },
): GameCard {
  const base = gameCard({ id, league: 'ncaaf' });
  return {
    ...base,
    home: { ...base.home, conferenceId: home.conf, rank: home.rank ?? null },
    away: { ...base.away, conferenceId: away.conf, rank: away.rank ?? null },
  };
}

const SEC_V_BIGTEN = cfb('a', { conf: '8', rank: 2 }, { conf: '5' });
const B12_V_FCS = cfb('b', { conf: '4' }, { conf: '20' });
const ACC_V_INDY = cfb('c', { conf: '1' }, { conf: '18', rank: 3 });
const NO_CONF = cfb('d', { conf: null }, { conf: null });
const SLATE = [SEC_V_BIGTEN, B12_V_FCS, ACC_V_INDY, NO_CONF];

describe('filterGames', () => {
  it('"all" returns the slate untouched (same reference)', () => {
    expect(filterGames('ncaaf', SLATE, 'all')).toBe(SLATE);
  });

  it('"top25" keeps a game when EITHER team is ranked', () => {
    expect(filterGames('ncaaf', SLATE, 'top25').map((g) => g.id)).toEqual(['a', 'c']);
  });

  it('a conference keeps a game when EITHER team is in it', () => {
    expect(filterGames('ncaaf', SLATE, 'conf:5').map((g) => g.id)).toEqual(['a']);
    expect(filterGames('ncaaf', SLATE, 'conf:8').map((g) => g.id)).toEqual(['a']);
    expect(filterGames('ncaaf', SLATE, 'conf:18').map((g) => g.id)).toEqual(['c']);
    expect(filterGames('ncaaf', SLATE, 'conf:151')).toEqual([]);
  });

  it('"other" is any team whose id is not an FBS conference, including no id at all', () => {
    expect(filterGames('ncaaf', SLATE, OTHER_CONFERENCE).map((g) => g.id)).toEqual(['b', 'd']);
  });

  it('never matches on a prefix of the id ("conf:1" is the ACC, not the AAC)', () => {
    expect(filterGames('ncaaf', [cfb('x', { conf: '151' }, { conf: '15' })], 'conf:1')).toEqual([]);
  });
});

function specFor(league: 'ncaaf' | 'ncaab') {
  const spec = BOARD_FILTERS[league];
  if (spec === null) throw new Error(`${league} has no board filter`);
  return spec;
}

describe('boardFilterOptions', () => {
  it('is all, top25, every FBS conference in order, then other', () => {
    const values = boardFilterOptions(specFor('ncaaf')).map((o) => o.value);
    expect(values).toEqual([
      'all',
      'top25',
      ...CFB_CONFERENCES.map((c) => `conf:${c.id}`),
      OTHER_CONFERENCE,
    ]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('every option value round-trips through isBoardFilter (the <select> handler)', () => {
    for (const league of ['ncaaf', 'ncaab'] as const) {
      for (const o of boardFilterOptions(specFor(league))) expect(isBoardFilter(o.value)).toBe(true);
    }
    expect(isBoardFilter('bogus')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M13d: the filter keyed by league (PLAN.md §24.14). College basketball gets
// its own conference list (BASKETBALL ids) and defaults to Top 25; the NBA, the
// NFL and MLB have no filter at all.
// ---------------------------------------------------------------------------

function cbb(
  id: string,
  home: { conf: string | null; rank?: number },
  away: { conf: string | null; rank?: number },
): GameCard {
  const base = gameCard({ id, league: 'ncaab', week: null });
  return {
    ...base,
    home: { ...base.home, conferenceId: home.conf, rank: home.rank ?? null },
    away: { ...base.away, conferenceId: away.conf, rank: away.rank ?? null },
  };
}

describe('BOARD_FILTERS (M13d)', () => {
  it('has a key for every league: CFB and CBB lists, null for the rest', () => {
    expect(Object.keys(BOARD_FILTERS).sort()).toEqual([...LEAGUES].sort());
    expect(BOARD_FILTERS.ncaaf).toEqual({ conferences: CFB_CONFERENCES, defaultFilter: 'all' });
    expect(BOARD_FILTERS.ncaab).toEqual({ conferences: CBB_CONFERENCES, defaultFilter: 'top25' });
    expect(BOARD_FILTERS.nfl).toBeNull();
    expect(BOARD_FILTERS.mlb).toBeNull();
    expect(BOARD_FILTERS.nba).toBeNull();
  });

  it('defaultBoardFilter: top25 for college basketball, all everywhere else', () => {
    expect(defaultBoardFilter('ncaab')).toBe('top25');
    for (const league of ['nfl', 'ncaaf', 'mlb', 'nba'] as const) {
      expect(defaultBoardFilter(league)).toBe('all');
    }
  });

  it('the ncaab dropdown is all, top25, the 32 basketball conferences in order, then other', () => {
    const values = boardFilterOptions(specFor('ncaab')).map((o) => o.value);
    expect(values).toEqual([
      'all',
      'top25',
      ...CBB_CONFERENCES.map((c) => `conf:${c.id}`),
      OTHER_CONFERENCE,
    ]);
    expect(values).toHaveLength(35);
    expect(new Set(values).size).toBe(values.length);
    const labels = boardFilterOptions(specFor('ncaab')).map((o) => o.label);
    expect(labels.slice(0, 2)).toEqual(['All games', 'Top 25']);
    expect(labels.at(-1)).toBe('Other');
  });
});

describe('filterGames by league (M13d)', () => {
  const SEC = cbb('sec', { conf: '23', rank: 1 }, { conf: '23' });
  const B12 = cbb('b12', { conf: '8' }, { conf: '62' });
  const INDY = cbb('indy', { conf: null }, { conf: '999' });
  const UNFILED = cbb('unfiled', { conf: null }, { conf: null });
  const CBB = [SEC, B12, INDY, UNFILED];

  it('reads BASKETBALL ids for ncaab: "conf:8" is the Big 12, "conf:23" the SEC', () => {
    expect(filterGames('ncaab', CBB, 'conf:8').map((g) => g.id)).toEqual(['b12']);
    expect(filterGames('ncaab', CBB, 'conf:23').map((g) => g.id)).toEqual(['sec']);
    expect(filterGames('ncaab', CBB, 'top25').map((g) => g.id)).toEqual(['sec']);
  });

  it('"other" for ncaab is not a basketball conference, or no id at all', () => {
    expect(filterGames('ncaab', CBB, OTHER_CONFERENCE).map((g) => g.id)).toEqual([
      'indy',
      'unfiled',
    ]);
    // '23' is a listed BASKETBALL conference but not an FBS one: the CFB list
    // must not leak into the basketball "Other" bucket, nor the reverse.
    const secFootball = cfb('secf', { conf: '23' }, { conf: '23' });
    expect(filterGames('ncaaf', [secFootball], OTHER_CONFERENCE)).toEqual([secFootball]);
    expect(filterGames('ncaab', [SEC], OTHER_CONFERENCE)).toEqual([]);
  });

  it('a league with no filter returns its slate untouched, whatever filter is held', () => {
    for (const league of ['nfl', 'mlb', 'nba'] as const) {
      const slate = [gameCard({ id: 'x', league })];
      expect(filterGames(league, slate, 'top25')).toBe(slate);
      expect(filterGames(league, slate, 'conf:8')).toBe(slate);
      expect(filterGames(league, slate, OTHER_CONFERENCE)).toBe(slate);
    }
  });
});
