/**
 * Exact odds arithmetic. PLAN.md §5.
 *
 * INVARIANT: no `number` division, no `Math.round`/`Math.floor`, and no float
 * multiplication appears in any code path that produces a cent. Prices are
 * carried as exact BigInt rationals; payouts are BigInt division (which
 * truncates toward zero and, with non-negative operands, IS floor).
 *
 * HEADLINE REGRESSION VECTOR (tests/unit/odds.spec.ts) -- an ordinary 3-leg
 * football parlay, -110 / +120 / -105, at the MINIMUM stake of 100 cents:
 *     rational : 9471000/1155000, which reduces to exactly 41/5 = 8.2
 *     exact    : floor(100n * 9471000n / 1155000n)          = 820
 *     float    : Math.floor(100 * 8.2)                      = 819
 * It is off by a cent under BOTH common float formulations of decimal odds
 * (`1 + 100/|A|` and `(|A|+100)/|A|`), which is what makes it usable -- many
 * candidate vectors break only one of the two, so a naive implementation written
 * the other way would pass them by luck.
 *
 * DIVERGENCE IS STAKE-DEPENDENT, and that is the real lesson. On this same
 * parlay (all values computed, not estimated):
 *     stake    100 -> exact    820, float    819   DIVERGES
 *     stake   1000 -> exact   8200, float   8200   agrees
 *     stake   1500 -> exact  12300, float  12299   DIVERGES
 *     stake  25000 -> exact 205000, float 204999   DIVERGES
 *     stake  50000 -> exact 410000, float 409999   DIVERGES
 *     stake 100000 -> exact 820000, float 819999   DIVERGES
 * So "I spot-checked a few stakes and floats were fine" proves nothing. Other
 * dual-breaking vectors: -110/+164/-112 at 100c (exact 954, float 953);
 * 185c @ -370 (exact 235, float 234); 746c @ -2984 (exact 771, float 770).
 *
 * At typical straight-bet prices floats often happen to agree; the value of
 * exact arithmetic is the guarantee, not the empirical hit rate.
 */

import type { AmericanPrice, Cents, Price } from './types.js';

/** Decimal odds of 1.0 — the identity for parlay multiplication ("all legs pushed"). */
export const EVEN_MONEY_UNIT: Price = { num: 1n, den: 1n };

/**
 * Re-exported from constants.ts, which is the single home for anything the UI and
 * the server must agree on (CLAUDE.md / PLAN.md §16). Kept visible here because
 * `payoutCents` and `exceedsPayoutCap` enforce it.
 */
export { MAX_PAYOUT_CENTS } from './constants.js';

/**
 * American price -> exact decimal-odds rational.
 *   A >= +100 : { A + 100, 100 }
 *   A <= -100 : { |A| + 100, |A| }
 * @throws AppError('VALIDATION') when |price| < 100 or it is not an integer.
 */
export function americanToPrice(_american: AmericanPrice): Price {
  throw new Error('not implemented: M2a');
}

/**
 * Exact rational -> American price, rounded half-up on the magnitude.
 * DISPLAY ONLY — never an input to a payout.
 */
export function priceToAmerican(_price: Price): AmericanPrice {
  throw new Error('not implemented: M2a');
}

/** Product of leg prices. Empty input returns EVEN_MONEY_UNIT. */
export function multiplyPrices(_prices: readonly Price[]): Price {
  throw new Error('not implemented: M2a');
}

/**
 * Total return (stake + profit) in cents, floored.
 * `floor(stake * price.num / price.den)`, computed entirely in BigInt and
 * converted to `number` only at the end.
 *
 * @throws AppError('PAYOUT_LIMIT_EXCEEDED') when the result would exceed
 *   MAX_PAYOUT_CENTS. The comparison is done in BigInt BEFORE the Number
 *   conversion, so an astronomically priced parlay can never produce a lossy
 *   `number` even transiently.
 */
export function payoutCents(_stakeCents: Cents, _price: Price): Cents {
  throw new Error('not implemented: M2a');
}

/** Non-throwing form, for pre-flight validation of a bet slip. */
export function exceedsPayoutCap(_stakeCents: Cents, _price: Price): boolean {
  throw new Error('not implemented: M2a');
}

/** `payoutCents - stakeCents`. */
export function profitCents(_stakeCents: Cents, _price: Price): Cents {
  throw new Error('not implemented: M2a');
}

/** Implied probability, `den/num`. Float, DISPLAY ONLY. */
export function impliedProbability(_price: Price): number {
  throw new Error('not implemented: M2a');
}

/** Book hold for a two-sided market: `sum(impliedProbability) - 1`. Display only. */
export function marketHold(_prices: readonly Price[]): number {
  throw new Error('not implemented: M2a');
}

/** Decimal odds as a fixed-precision display string, e.g. "1.909". */
export function formatDecimalOdds(_price: Price, _places?: number): string {
  throw new Error('not implemented: M2a');
}

/** "+164" / "-110". */
export function formatAmerican(_american: AmericanPrice): string {
  throw new Error('not implemented: M2a');
}

/** Reduce a rational by its GCD. Purely a hygiene helper; nothing depends on it. */
export function reducePrice(_price: Price): Price {
  throw new Error('not implemented: M2a');
}

/**
 * Recompute a bet's price from its legs' stored American integers. This is the
 * ONLY way a bet price is ever obtained after placement -- `bets` stores no
 * rational, because a 10-leg parlay numerator can reach 20+ digits and SQLite
 * would coerce it to REAL. `bet_legs.american_price` is the single source of
 * truth (PLAN.md §5.2).
 */
export function priceFromLegs(_americanPrices: readonly AmericanPrice[]): Price {
  throw new Error('not implemented: M2a');
}
