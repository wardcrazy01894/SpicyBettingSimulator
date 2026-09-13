/**
 * The ONE place that maps a `(market, side)` pair onto the matching cell of a
 * `GameLinesView`. PLAN.md §11.3.
 *
 * Two call sites need it and they must not disagree: the board renders six
 * buttons from it, and "Edit bet" re-reads the CURRENT quote from
 * `GET /api/games/:id` so a stake-only edit does not resubmit a price that has
 * since moved (which the server answers with `409 LINE_CHANGED`).
 *
 * DOM-free and React-free so `tests/web/lines.spec.ts` runs in the node project.
 */

import type { GameLinesView } from '../../shared/api-types.js';
import type { AmericanPrice, LineTenths, Market, Side } from '../../shared/types.js';

export interface MarketQuote {
  /** Always null for a moneyline; tenths of a point otherwise. */
  readonly lineTenths: LineTenths | null;
  readonly americanPrice: AmericanPrice;
}

/** The six board cells, in the column order spread / total / moneyline, away then home. */
export const MARKET_CELLS: readonly { readonly market: Market; readonly side: Side }[] = [
  { market: 'spread', side: 'away' },
  { market: 'total', side: 'over' },
  { market: 'moneyline', side: 'away' },
  { market: 'spread', side: 'home' },
  { market: 'total', side: 'under' },
  { market: 'moneyline', side: 'home' },
];

/**
 * The live quote for one market/side, or null when that market is not posted.
 *
 * A `(market, side)` pair that cannot exist — a spread "over", say — is null
 * rather than a throw: the pair comes off the wire, and a nonsense combination
 * is the server's problem to reject, not the board's to crash on.
 */
export function quoteFor(
  lines: GameLinesView | null,
  market: Market,
  side: Side,
): MarketQuote | null {
  if (lines === null) return null;
  if (market === 'spread') {
    const spread = lines.spread;
    if (spread === null) return null;
    if (side === 'home') return { lineTenths: spread.homeTenths, americanPrice: spread.homePrice };
    if (side === 'away') return { lineTenths: spread.awayTenths, americanPrice: spread.awayPrice };
    return null;
  }
  if (market === 'total') {
    const total = lines.total;
    if (total === null) return null;
    if (side === 'over') return { lineTenths: total.tenths, americanPrice: total.overPrice };
    if (side === 'under') return { lineTenths: total.tenths, americanPrice: total.underPrice };
    return null;
  }
  const moneyline = lines.moneyline;
  if (moneyline === null) return null;
  if (side === 'home') return { lineTenths: null, americanPrice: moneyline.homePrice };
  if (side === 'away') return { lineTenths: null, americanPrice: moneyline.awayPrice };
  return null;
}
