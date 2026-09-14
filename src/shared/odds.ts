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

import { MAX_PAYOUT_CENTS, TEASER_PAYOUTS, isTeaserPoints } from './constants.js';
import { AppError } from './errors.js';
import type { AmericanPrice, Cents, Price } from './types.js';

/** Decimal odds of 1.0 — the identity for parlay multiplication ("all legs pushed"). */
export const EVEN_MONEY_UNIT: Price = Object.freeze({ num: 1n, den: 1n });

/**
 * The American price SETTLEMENT WRITES for a bet whose every leg pushed or was
 * voided (PLAN §7.4: `american_price = 100`, `payout = stake`). It is a literal,
 * not `priceToAmerican(EVEN_MONEY_UNIT)` — that call THROWS, because even money
 * has no American representation. M6 must use this constant.
 */
export const PUSH_AMERICAN_PRICE: AmericanPrice = 100;

/**
 * Largest |American| the schema accepts (`bets.american_price CHECK
 * abs(...) <= 100000000`). `priceToAmerican` refuses to return anything larger,
 * so a display price can never be bound as Infinity or a non-safe integer.
 *
 * INVARIANT (pinned by a test): every price a PLACEABLE bet can carry fits.
 * The largest placeable decimal is MAX_PAYOUT_CENTS / MIN_STAKE_CENTS = 1e6,
 * whose American is +99,999,900 — inside this bound by 100 points. That margin
 * exists ONLY because MIN_STAKE_CENTS is 100; lowering the minimum stake would
 * require raising this bound AND the schema CHECK together, or settlement of a
 * total-loss bet (which re-renders the full placement price) would throw.
 */
const MAX_ABS_AMERICAN_OUTPUT = 100_000_000n;

/**
 * Re-exported from constants.ts, which is the single home for anything the UI and
 * the server must agree on (CLAUDE.md / PLAN.md §16). Kept visible here because
 * `payoutCents` and `exceedsPayoutCap` enforce it.
 */
export { MAX_PAYOUT_CENTS } from './constants.js';

/** The cap as a BigInt, so the comparison never touches a `number`. */
const MAX_PAYOUT_CENTS_BIG = BigInt(MAX_PAYOUT_CENTS);

/** Smallest legal American magnitude. |A| < 100 is not an American price at all. */
const MIN_AMERICAN_MAGNITUDE = 100;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * `NaN`, `Infinity` and `1.5` all have to die here rather than silently becoming
 * a BigInt conversion error three frames down.
 */
function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION', `${label} must be a safe integer, got ${String(value)}.`);
  }
}

/**
 * Round a non-negative rational `p/q` half-up, in BigInt.
 *
 * PLAN §5.5 writes this as `(10x + 5) / 10` for a value already scaled by ten;
 * the general form is `(2p + q) / (2q)`, and BigInt `/` truncating toward zero
 * is exactly floor for non-negative operands. Never `Math.round` — that would be
 * a float, and it rounds .5 toward +Infinity only for positive values anyway.
 */
function roundHalfUp(p: bigint, q: bigint): bigint {
  return (2n * p + q) / (2n * q);
}

/** Euclid, in BigInt. Used only by `reducePrice`. */
function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * A price usable as a payout multiplier: both parts strictly positive. 1/1 (all
 * legs pushed) IS usable here — it is the multiplicative identity.
 */
function assertUsablePrice(price: Price): void {
  if (price.num <= 0n || price.den <= 0n) {
    throw new AppError(
      'VALIDATION',
      `Price ${price.num.toString()}/${price.den.toString()} is not a positive rational.`,
    );
  }
}

/**
 * The whole payout computation, in BigInt, with NO cap check and NO `Number`
 * conversion. `payoutCents` and `exceedsPayoutCap` are both thin wrappers, which
 * is what makes them provably agree.
 */
function payoutCentsExact(stakeCents: Cents, price: Price): bigint {
  assertInteger(stakeCents, 'Stake');
  if (stakeCents < 0) {
    throw new AppError('VALIDATION', `Stake must be non-negative, got ${String(stakeCents)}.`);
  }
  assertUsablePrice(price);
  // BigInt `/` truncates toward zero; both operands are non-negative, so this IS
  // floor. PLAN §5.3.
  return (BigInt(stakeCents) * price.num) / price.den;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * American price -> exact decimal-odds rational.
 *   A >= +100 : { A + 100, 100 }
 *   A <= -100 : { |A| + 100, |A| }
 * @throws AppError('VALIDATION') when |price| < 100 or it is not an integer.
 */
export function americanToPrice(american: AmericanPrice): Price {
  assertInteger(american, 'American price');
  if (american >= MIN_AMERICAN_MAGNITUDE) {
    return { num: BigInt(american) + 100n, den: 100n };
  }
  if (american <= -MIN_AMERICAN_MAGNITUDE) {
    const magnitude = BigInt(-american);
    return { num: magnitude + 100n, den: magnitude };
  }
  throw new AppError(
    'VALIDATION',
    `American price magnitude must be at least ${String(MIN_AMERICAN_MAGNITUDE)}, got ${String(american)}.`,
  );
}

/**
 * Exact rational -> American price, rounded half-up on the magnitude.
 * DISPLAY ONLY — never an input to a payout.
 *
 * `num >= 2*den` (decimal odds >= 2.0) is the positive branch; the boundary
 * itself belongs to it, so 200/100 renders as +100, not -100. That makes -100
 * and +100 — which are the SAME odds — canonicalise to +100, the one and only
 * place where `priceToAmerican(americanToPrice(a)) !== a`.
 *
 * @throws AppError('VALIDATION') for a price with no American equivalent, i.e.
 *   decimal odds <= 1.0. EVEN_MONEY_UNIT is the real-world case (every leg
 *   pushed) and the UI renders it as "—" (PLAN §5.4), never as a price.
 *   SETTLEMENT (PLAN §7.4) must therefore NOT call this on the empty product of
 *   surviving legs; it writes `PUSH_AMERICAN_PRICE` (100) directly.
 * @throws AppError('VALIDATION') when |result| would exceed the schema's
 *   `abs(american_price) <= 100000000` CHECK — such a price is only reachable
 *   from a parlay that already exceeds MAX_PAYOUT_CENTS, and returning an
 *   Infinity/non-safe `number` here would let a caller bind it into D1.
 */
export function priceToAmerican(price: Price): AmericanPrice {
  const { num, den } = price;
  if (den <= 0n || num <= den) {
    throw new AppError(
      'VALIDATION',
      `Price ${num.toString()}/${den.toString()} has no American equivalent (decimal odds must exceed 1.0).`,
    );
  }
  const positive = num >= 2n * den;
  const magnitude = positive
    ? roundHalfUp(100n * (num - den), den)
    : roundHalfUp(100n * den, num - den);
  if (magnitude > MAX_ABS_AMERICAN_OUTPUT) {
    // The value itself is deliberately omitted: it can be hundreds of digits.
    throw new AppError('VALIDATION', 'Price is too long to express as an American price.');
  }
  return positive ? Number(magnitude) : -Number(magnitude);
}

/**
 * Move one line `pointsTenths` in the BETTOR'S favour. Integer tenths in,
 * integer tenths out — no float, no rounding, and exactly representable because
 * the tiers (60/65/70) and football lines are both multiples of 5 tenths.
 *
 * The direction is the whole content of the function, so it is spelled out:
 *   spread  `lineTenths + points`  — the line is ALREADY from the bettor's side
 *           (home −7.5 is −75, away +3.5 is +35, PLAN.md §3.2), so adding always
 *           helps: −75 → −15 at 6 points, +35 → +95. There is no sign flip and
 *           there must not be one; a `side`-dependent version would tease the
 *           away side the wrong way.
 *   over    `lineTenths − points`  — a lower total is easier to go over.
 *   under   `lineTenths + points`  — a higher total is easier to stay under.
 *
 * A moneyline has no line to move and is rejected upstream by `validatePlaceBet`;
 * passing one here throws rather than inventing a number.
 *
 * THE (market, side) PAIR IS CHECKED FIRST, before either branch. `spread` owns
 * `home`/`away` and `total` owns `over`/`under` — the schema says so
 * (`CHECK ((market = 'total') = (side IN ('over','under')))`) and so does the
 * docblock above. Branching on `market` first would quietly accept
 * `('spread', 'over')` and return `lineTenths + points`, which is a real number
 * for a leg that cannot exist; an incoherent pair is a caller bug and must
 * throw, exactly as this function documents.
 *
 * @throws AppError('VALIDATION') for a moneyline, an incoherent market/side
 *   pair, a non-integer line, or a tier that is not on the card.
 */
export function teasedLineTenths(
  market: 'spread' | 'total',
  side: 'home' | 'away' | 'over' | 'under',
  lineTenths: number,
  pointsTenths: number,
): number {
  assertInteger(lineTenths, 'Line tenths');
  if (!isTeaserPoints(pointsTenths)) {
    throw new AppError(
      'VALIDATION',
      `Teaser points must be 60, 65 or 70 tenths, got ${String(pointsTenths)}.`,
    );
  }
  // Coherence BEFORE the market branch, so an impossible pair can never take a
  // branch that would answer it with a plausible number.
  // `market` is typed `'spread' | 'total'`, so the else branch IS total — and an
  // untyped caller that smuggled in `'moneyline'` lands there too and fails the
  // over/under test, which is the answer that function documents.
  const coherent =
    market === 'spread' ? side === 'home' || side === 'away' : side === 'over' || side === 'under';
  if (!coherent) {
    throw new AppError('VALIDATION', `Cannot tease a ${market}/${side} leg.`);
  }
  if (market === 'spread') return lineTenths + pointsTenths;
  return side === 'over' ? lineTenths - pointsTenths : lineTenths + pointsTenths;
}

/**
 * The CARD price of a teaser: a lookup, not a computation.
 *
 * A teaser's price has nothing to do with its legs' prices — moving every line
 * six points in the bettor's favour invalidates them — so this is a total
 * function of (tier, leg count) and of nothing else. It is the ONLY way a teaser
 * price is obtained, at placement and at settlement alike, which is what makes
 * "the price a pushed-down teaser is paid at" a table read rather than a second
 * pricing rule that could drift from the first.
 *
 * @param pointsTenths 60 | 65 | 70 (6 / 6.5 / 7 points).
 * @param legCount     2..10 — the SURVIVING leg count at settlement, which is
 *                     why a 1-leg lookup must throw rather than return a
 *                     straight-bet price: there is no such thing as a one-team
 *                     teaser, and a caller that reaches here with 1 has skipped
 *                     the no-action rule (PLAN.md §5.8).
 * @throws AppError('VALIDATION') for a tier or leg count off the card.
 */
export function teaserPrice(pointsTenths: number, legCount: number): AmericanPrice {
  if (!isTeaserPoints(pointsTenths)) {
    throw new AppError(
      'VALIDATION',
      `Teaser points must be 60, 65 or 70 tenths, got ${String(pointsTenths)}.`,
    );
  }
  const row: Readonly<Record<number, AmericanPrice>> = TEASER_PAYOUTS[pointsTenths];
  const price = row[legCount];
  if (price === undefined) {
    throw new AppError('VALIDATION', `A teaser has 2-10 legs, got ${String(legCount)}.`);
  }
  return price;
}

/** Product of leg prices. Empty input returns EVEN_MONEY_UNIT. */
export function multiplyPrices(prices: readonly Price[]): Price {
  let num = 1n;
  let den = 1n;
  for (const price of prices) {
    num *= price.num;
    den *= price.den;
  }
  return { num, den };
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
 * @throws AppError('VALIDATION') for a negative or non-integer stake — BigInt
 *   `/` truncates toward ZERO, so a negative stake would ceil rather than floor.
 */
export function payoutCents(stakeCents: Cents, price: Price): Cents {
  const payout = payoutCentsExact(stakeCents, price);
  if (payout > MAX_PAYOUT_CENTS_BIG) {
    throw new AppError(
      'PAYOUT_LIMIT_EXCEEDED',
      `Payout would exceed the ${String(MAX_PAYOUT_CENTS)} cent cap.`,
      { maxPayoutCents: MAX_PAYOUT_CENTS },
    );
  }
  return Number(payout);
}

/**
 * Cap check for pre-flight validation of a bet slip: returns true/false instead
 * of throwing PAYOUT_LIMIT_EXCEEDED. PLACEMENT ORDER (M5): check the cap
 * BEFORE calling `priceToAmerican` for the display price, so an over-cap parlay
 * fails with 409 PAYOUT_LIMIT_EXCEEDED rather than priceToAmerican's 400. It still throws VALIDATION for a stake or
 * price that is not a legal input (negative, non-integer, degenerate price).
 */
export function exceedsPayoutCap(stakeCents: Cents, price: Price): boolean {
  return payoutCentsExact(stakeCents, price) > MAX_PAYOUT_CENTS_BIG;
}

/** `payoutCents - stakeCents`. Non-negative for every price `americanToPrice` can produce (decimal > 1). */
export function profitCents(stakeCents: Cents, price: Price): Cents {
  return payoutCents(stakeCents, price) - stakeCents;
}

/**
 * Implied probability, `den/num`. Float, DISPLAY ONLY. Pass a single MARKET
 * price (from `americanToPrice`), never a parlay product — the BigInt→Number
 * conversion is only meaningful on that bounded domain.
 */
export function impliedProbability(price: Price): number {
  return Number(price.den) / Number(price.num);
}

/** Book hold for a two-sided market: `sum(impliedProbability) - 1`. Display only. */
export function marketHold(prices: readonly Price[]): number {
  let sum = 0;
  for (const price of prices) {
    sum += impliedProbability(price);
  }
  return sum - 1;
}

/**
 * Decimal odds as a fixed-precision display string, e.g. "1.909".
 *
 * Rounded half-up in BigInt, which is what makes it agree with PLAN §5.4's
 * decimal column (210/110 -> "1.909091", not the truncated "1.909090"; the
 * 10-leg -110 parlay -> "643.081618", not "643.081617").
 */
export function formatDecimalOdds(price: Price, places = 3): string {
  if (!Number.isSafeInteger(places) || places < 0 || places > 20) {
    throw new AppError('VALIDATION', `places must be an integer in 0..20, got ${String(places)}.`);
  }
  assertUsablePrice(price);
  const scale = 10n ** BigInt(places);
  const scaled = roundHalfUp(price.num * scale, price.den);
  const whole = scaled / scale;
  if (places === 0) return whole.toString();
  const fraction = scaled % scale;
  return `${whole.toString()}.${fraction.toString().padStart(places, '0')}`;
}

/** "+164" / "-110". */
export function formatAmerican(american: AmericanPrice): string {
  return american >= 0 ? `+${String(american)}` : String(american);
}

/** Reduce a rational by its GCD. Purely a hygiene helper; nothing depends on it. */
export function reducePrice(price: Price): Price {
  assertUsablePrice(price);
  const divisor = gcd(price.num, price.den);
  return { num: price.num / divisor, den: price.den / divisor };
}

/**
 * Recompute a bet's price from its legs' stored American integers. This is the
 * ONLY way a bet price is ever obtained after placement -- `bets` stores no
 * rational, because a 10-leg parlay numerator can reach 20+ digits and SQLite
 * would coerce it to REAL. `bet_legs.american_price` is the single source of
 * truth (PLAN.md §5.2).
 */
export function priceFromLegs(americanPrices: readonly AmericanPrice[]): Price {
  return multiplyPrices(americanPrices.map(americanToPrice));
}
