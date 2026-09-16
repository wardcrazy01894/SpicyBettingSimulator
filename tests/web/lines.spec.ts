import { describe, expect, it } from 'vitest';

import { MARKET_CELLS, moneylineNotOffered, quoteFor } from '../../src/web/lib/lines.js';
import type { GameLinesView } from '../../src/shared/api-types.js';

const FULL: GameLinesView = {
  provider: 'DraftKings',
  capturedAt: 1_800_000_000_000,
  seenAt: 1_800_000_000_000,
  stale: false,
  spread: {
    homeTenths: -35,
    homePrice: -110,
    awayTenths: 35,
    awayPrice: -108,
    provider: 'DraftKings',
  },
  total: { tenths: 475, overPrice: -105, underPrice: -115, provider: 'DraftKings' },
  moneyline: { homePrice: -180, awayPrice: 155, provider: 'DraftKings' },
};

describe('quoteFor', () => {
  it('reads each of the six real cells', () => {
    expect(quoteFor(FULL, 'spread', 'home')).toEqual({ lineTenths: -35, americanPrice: -110 });
    expect(quoteFor(FULL, 'spread', 'away')).toEqual({ lineTenths: 35, americanPrice: -108 });
    expect(quoteFor(FULL, 'total', 'over')).toEqual({ lineTenths: 475, americanPrice: -105 });
    expect(quoteFor(FULL, 'total', 'under')).toEqual({ lineTenths: 475, americanPrice: -115 });
    expect(quoteFor(FULL, 'moneyline', 'home')).toEqual({ lineTenths: null, americanPrice: -180 });
    expect(quoteFor(FULL, 'moneyline', 'away')).toEqual({ lineTenths: null, americanPrice: 155 });
  });

  it('is null when no line is posted at all', () => {
    expect(quoteFor(null, 'spread', 'home')).toBeNull();
  });

  it('is null for a market this game does not have', () => {
    const noTotal: GameLinesView = { ...FULL, total: null };
    expect(quoteFor(noTotal, 'total', 'over')).toBeNull();
    expect(quoteFor({ ...FULL, spread: null }, 'spread', 'home')).toBeNull();
    expect(quoteFor({ ...FULL, moneyline: null }, 'moneyline', 'home')).toBeNull();
  });

  it('is null — never a throw — for a market/side pair that cannot exist', () => {
    expect(quoteFor(FULL, 'spread', 'over')).toBeNull();
    expect(quoteFor(FULL, 'total', 'home')).toBeNull();
    expect(quoteFor(FULL, 'moneyline', 'under')).toBeNull();
  });

  it('never reports a price of 0 for an unposted market', () => {
    // The board used to build a leg with `americanPrice: cell.price ?? 0` for
    // every cell of every card; 0 is not a legal American price.
    for (const cell of MARKET_CELLS) {
      expect(quoteFor(null, cell.market, cell.side)).toBeNull();
    }
  });
});

describe('MARKET_CELLS', () => {
  it('is the six board cells, spread / total / moneyline, away row then home row', () => {
    expect(MARKET_CELLS).toHaveLength(6);
    expect(MARKET_CELLS.map((c) => `${c.market}:${c.side}`)).toEqual([
      'spread:away',
      'total:over',
      'moneyline:away',
      'spread:home',
      'total:under',
      'moneyline:home',
    ]);
  });
});

describe('moneylineNotOffered', () => {
  const at = (homeTenths: number): GameLinesView => ({
    ...FULL,
    spread: {
      homeTenths,
      homePrice: -110,
      awayTenths: -homeTenths,
      awayPrice: -110,
      provider: 'DraftKings',
    },
    moneyline: null,
  });

  it('is true when the moneyline is absent and the spread is 30 points or more', () => {
    expect(moneylineNotOffered(at(-300))).toBe(true);
    expect(moneylineNotOffered(at(335))).toBe(true);
    expect(moneylineNotOffered(at(-575))).toBe(true);
  });

  it('is false under 30 points — that is a gap, not a book policy', () => {
    expect(moneylineNotOffered(at(-295))).toBe(false);
    expect(moneylineNotOffered(at(-35))).toBe(false);
  });

  it('is false when a moneyline IS posted, whatever the spread', () => {
    expect(
      moneylineNotOffered({
        ...at(-400),
        moneyline: { homePrice: -20000, awayPrice: 5000, provider: 'DraftKings' },
      }),
    ).toBe(false);
  });

  it('is false with no spread to judge by, or no line at all', () => {
    expect(moneylineNotOffered({ ...FULL, spread: null, moneyline: null })).toBe(false);
    expect(moneylineNotOffered(null)).toBe(false);
  });
});
