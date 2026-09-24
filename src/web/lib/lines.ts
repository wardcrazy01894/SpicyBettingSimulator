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
import { MONEYLINE_NOT_OFFERED_SPREAD_TENTHS } from '../../shared/constants.js';
import type { AmericanPrice, League, LineTenths, Market, Side } from '../../shared/types.js';
import { isTeasableLeague } from '../../shared/validate.js';

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

/**
 * True when the moneyline is absent BECAUSE of the spread: at 30 points and
 * beyond no book posts one (`MONEYLINE_NOT_OFFERED_SPREAD_TENTHS`). The card
 * then says so instead of showing the same "n/a" a genuinely missing market
 * gets. Absent spread, or a posted moneyline, is never "not offered".
 */
export function moneylineNotOffered(lines: GameLinesView | null): boolean {
  const spread = lines?.spread ?? null;
  if (spread === null || lines?.moneyline !== null) return false;
  return Math.abs(spread.homeTenths) >= MONEYLINE_NOT_OFFERED_SPREAD_TENTHS;
}

/** Shown on a greyed cell while the slip is building a teaser. */
const MONEYLINE_UNTEASABLE = 'moneylines cannot be teased';
const LEAGUE_UNTEASABLE = 'MLB lines cannot be teased';

/**
 * Why a board cell cannot join a TEASER, or null when it can. A teaser moves a
 * line, so a moneyline has nothing to move; and teasers are football only
 * (PLAN.md §23.8), so every MLB cell is out. `isTeasableLeague` is the SAME
 * function the server's `applyTease` uses, so the grey-out and the
 * `TEASER_INVALID` refusal cannot disagree. The league reason wins over the
 * market one: on an MLB card it is the whole story.
 */
export function unteasableReason(league: League, market: Market): string | null {
  if (!isTeasableLeague(league)) return LEAGUE_UNTEASABLE;
  if (market === 'moneyline') return MONEYLINE_UNTEASABLE;
  return null;
}
