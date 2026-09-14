import { describe, expect, it } from 'vitest';
import { CFB_CONFERENCES } from '../../src/shared/constants.js';
import {
  OTHER_CONFERENCE,
  boardFilterOptions,
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
    expect(filterGames(SLATE, 'all')).toBe(SLATE);
  });

  it('"top25" keeps a game when EITHER team is ranked', () => {
    expect(filterGames(SLATE, 'top25').map((g) => g.id)).toEqual(['a', 'c']);
  });

  it('a conference keeps a game when EITHER team is in it', () => {
    expect(filterGames(SLATE, 'conf:5').map((g) => g.id)).toEqual(['a']);
    expect(filterGames(SLATE, 'conf:8').map((g) => g.id)).toEqual(['a']);
    expect(filterGames(SLATE, 'conf:18').map((g) => g.id)).toEqual(['c']);
    expect(filterGames(SLATE, 'conf:151')).toEqual([]);
  });

  it('"other" is any team whose id is not an FBS conference, including no id at all', () => {
    expect(filterGames(SLATE, OTHER_CONFERENCE).map((g) => g.id)).toEqual(['b', 'd']);
  });

  it('never matches on a prefix of the id ("conf:1" is the ACC, not the AAC)', () => {
    expect(filterGames([cfb('x', { conf: '151' }, { conf: '15' })], 'conf:1')).toEqual([]);
  });
});

describe('boardFilterOptions', () => {
  it('is all, top25, every FBS conference in order, then other', () => {
    const values = boardFilterOptions().map((o) => o.value);
    expect(values).toEqual([
      'all',
      'top25',
      ...CFB_CONFERENCES.map((c) => `conf:${c.id}`),
      OTHER_CONFERENCE,
    ]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('every option value round-trips through isBoardFilter (the <select> handler)', () => {
    for (const o of boardFilterOptions()) expect(isBoardFilter(o.value)).toBe(true);
    expect(isBoardFilter('bogus')).toBe(false);
  });
});
