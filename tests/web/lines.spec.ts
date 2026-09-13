import { describe, expect, it } from 'vitest';

import { MARKET_CELLS, quoteFor } from '../../src/web/lib/lines.js';
import type { GameLinesView } from '../../src/shared/api-types.js';

const FULL: GameLinesView = {
  provider: 'DraftKings',
  capturedAt: 1_800_000_000_000,
  seenAt: 1_800_000_000_000,
  stale: false,
  spread: { homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -108 },
  total: { tenths: 475, overPrice: -105, underPrice: -115 },
  moneyline: { homePrice: -180, awayPrice: 155 },
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
