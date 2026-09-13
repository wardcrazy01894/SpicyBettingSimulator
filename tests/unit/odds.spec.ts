import { describe, expect, it } from 'vitest';
import {
  EVEN_MONEY_UNIT,
  MAX_PAYOUT_CENTS,
  PUSH_AMERICAN_PRICE,
  americanToPrice,
  exceedsPayoutCap,
  formatAmerican,
  formatDecimalOdds,
  impliedProbability,
  marketHold,
  multiplyPrices,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
  profitCents,
  reducePrice,
} from '../../src/shared/odds.js';
import { AppError } from '../../src/shared/errors.js';
import type { AmericanPrice, Cents, Price } from '../../src/shared/types.js';

/**
 * TDD contract for src/shared/odds.ts (PLAN.md §5, §13 M2a).
 *
 * EVERY numeric literal in this file was produced by a REPL, never by hand —
 * see PLAN.md §5.3 for why that rule exists. The oracles below are deliberately
 * re-derived from the spec rather than imported from the implementation, so a
 * bug in `odds.ts` cannot make its own tests agree with it.
 */

// ---------------------------------------------------------------------------
// Independent oracles (spec transcription, not implementation re-use)
// ---------------------------------------------------------------------------

/** PLAN §5.3: exact payout, BigInt only. */
function exactPayout(stakeCents: number, price: Price): bigint {
  return (BigInt(stakeCents) * price.num) / price.den;
}

/** Float formulation #1 of decimal odds: `1 + 100/|A|` (and `1 + A/100`). */
function floatDecimalA(american: AmericanPrice): number {
  return american >= 100 ? 1 + american / 100 : 1 + 100 / -american;
}

/** Float formulation #2 of decimal odds: `(|A|+100)/|A|`. */
function floatDecimalB(american: AmericanPrice): number {
  return american >= 100 ? (american + 100) / 100 : (-american + 100) / -american;
}

/**
 * What a naive float implementation would return. `Math.floor` is deliberate and
 * legal HERE — this is a test file, not `src/shared`, so the eslint money rules
 * do not apply. Reproducing the WRONG answer is the entire point.
 */
function floatPayout(
  stakeCents: number,
  legs: readonly AmericanPrice[],
  decimal: (a: AmericanPrice) => number,
): number {
  return Math.floor(stakeCents * legs.map(decimal).reduce((a, b) => a * b, 1));
}

function expectAppError(fn: () => unknown, code: string): void {
  expect(fn).toThrow(AppError);
  try {
    fn();
    expect.unreachable('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

/** The headline regression parlay, PLAN §5.3. */
const REGRESSION_LEGS: readonly AmericanPrice[] = [-110, 120, -105];

// ---------------------------------------------------------------------------

describe('americanToPrice', () => {
  it('-110 -> { num: 210n, den: 110n }', () => {
    expect(americanToPrice(-110)).toEqual<Price>({ num: 210n, den: 110n });
  });

  it('+164 -> { num: 264n, den: 100n }', () => {
    expect(americanToPrice(164)).toEqual<Price>({ num: 264n, den: 100n });
  });

  it('+100 -> { num: 200n, den: 100n }', () => {
    expect(americanToPrice(100)).toEqual<Price>({ num: 200n, den: 100n });
  });

  it('-100 -> { num: 200n, den: 100n }', () => {
    expect(americanToPrice(-100)).toEqual<Price>({ num: 200n, den: 100n });
  });

  it('covers the rest of the PLAN §5.4 vectors exactly', () => {
    expect(americanToPrice(120)).toEqual<Price>({ num: 220n, den: 100n });
    expect(americanToPrice(-105)).toEqual<Price>({ num: 205n, den: 105n });
    expect(americanToPrice(-112)).toEqual<Price>({ num: 212n, den: 112n });
    expect(americanToPrice(150)).toEqual<Price>({ num: 250n, den: 100n });
    expect(americanToPrice(-198)).toEqual<Price>({ num: 298n, den: 198n });
    expect(americanToPrice(-370)).toEqual<Price>({ num: 470n, den: 370n });
    expect(americanToPrice(-2984)).toEqual<Price>({ num: 3084n, den: 2984n });
    expect(americanToPrice(2000)).toEqual<Price>({ num: 2100n, den: 100n });
  });

  it('is total on the CHECK-bounded domain |A| in [100, 100000]', () => {
    // bet_legs.american_price is CHECK (abs(...) BETWEEN 100 AND 100000).
    expect(americanToPrice(100000)).toEqual<Price>({ num: 100100n, den: 100n });
    expect(americanToPrice(-100000)).toEqual<Price>({ num: 100100n, den: 100000n });
    for (let a = 100; a <= 100000; a += 1) {
      for (const signed of [a, -a]) {
        const p = americanToPrice(signed);
        expect(p.den).toBeGreaterThan(0n);
        // Decimal odds are strictly greater than 1.0 everywhere on the domain.
        expect(p.num).toBeGreaterThan(p.den);
      }
    }
  });

  it('rejects |price| < 100', () => {
    for (const bad of [0, 99, -99, 1, -1, 50, -50]) {
      expectAppError(() => americanToPrice(bad), 'VALIDATION');
    }
  });

  it('rejects non-integers and NaN', () => {
    for (const bad of [110.5, -110.5, Number.NaN, Number.POSITIVE_INFINITY, -Infinity, 1e300]) {
      expectAppError(() => americanToPrice(bad), 'VALIDATION');
    }
  });
});

describe('priceToAmerican (display only)', () => {
  it('210/110 -> -110 (round trip)', () => {
    expect(priceToAmerican({ num: 210n, den: 110n })).toBe(-110);
  });

  it('11025000/1210000 -> +811', () => {
    expect(priceToAmerican({ num: 11025000n, den: 1210000n })).toBe(811);
  });

  it('44100/12100 -> +264', () => {
    expect(priceToAmerican({ num: 44100n, den: 12100n })).toBe(264);
  });

  it('200/100 -> +100 at the +/- boundary', () => {
    // num === 2*den is the boundary and belongs to the POSITIVE branch.
    expect(priceToAmerican({ num: 200n, den: 100n })).toBe(100);
  });

  it('rounds half-up on the magnitude, in BigInt', () => {
    // 11025000/1210000: 100*(num-den)/den = 981500000/1210000 = 811.157… -> 811
    expect(priceToAmerican({ num: 11025000n, den: 1210000n })).toBe(811);
    // 44100/12100: 3200000/12100 = 264.462… -> 264
    expect(priceToAmerican({ num: 44100n, den: 12100n })).toBe(264);
    // Exact .5 on the positive branch: 100*(num-den)/den = 205/2 = 102.5 -> 103
    expect(priceToAmerican({ num: 405n, den: 200n })).toBe(103);
    // Exact .5 on the negative branch: 100*den/(num-den) = 100*205/2 = 10250
    // is an integer, so build a genuine half: den=41, num-den=8 -> 4100/8 = 512.5
    expect(priceToAmerican({ num: 49n, den: 41n })).toBe(-513);
    // The rounding is BigInt, so it must hold at magnitudes past 2^53.
    expect(priceToAmerican({ num: 10n ** 30n * 3n, den: 10n ** 30n })).toBe(200);
  });

  it('matches the other PLAN §5.4 display values', () => {
    expect(priceToAmerican({ num: 9471000n, den: 1155000n })).toBe(720);
    expect(priceToAmerican({ num: 11753280n, den: 1232000n })).toBe(854);
    expect(priceToAmerican({ num: 470n, den: 370n })).toBe(-370);
    expect(priceToAmerican({ num: 3084n, den: 2984n })).toBe(-2984);
    expect(priceToAmerican(priceFromLegs(Array<AmericanPrice>(10).fill(-110)))).toBe(64208);
  });

  it('inverse round-trips over the whole CHECK-bounded domain', () => {
    // Property sweep, ~200k values. -100 and +100 are THE SAME decimal odds
    // (2.0), so the pair canonicalises to +100 — the single documented
    // non-identity, pinned by the "+/- boundary" test above.
    const mismatches: number[] = [];
    for (let a = 100; a <= 100000; a += 1) {
      for (const signed of [a, -a]) {
        const back = priceToAmerican(americanToPrice(signed));
        if (back !== signed) mismatches.push(signed);
      }
    }
    expect(mismatches).toEqual([-100]);
    expect(priceToAmerican(americanToPrice(-100))).toBe(100);
  });

  it('rejects a price with no American equivalent', () => {
    // Decimal odds of exactly 1.0 (every leg pushed) render as "—", not as an
    // American price: 100*den/(num-den) would divide by zero.
    expectAppError(() => priceToAmerican(EVEN_MONEY_UNIT), 'VALIDATION');
    expectAppError(() => priceToAmerican({ num: 1n, den: 2n }), 'VALIDATION');
    expectAppError(() => priceToAmerican({ num: 2n, den: 0n }), 'VALIDATION');
    expectAppError(() => priceToAmerican({ num: -210n, den: -110n }), 'VALIDATION');
  });
});

describe('multiplyPrices', () => {
  it('empty -> EVEN_MONEY_UNIT (1/1)', () => {
    expect(multiplyPrices([])).toEqual<Price>(EVEN_MONEY_UNIT);
    expect(EVEN_MONEY_UNIT).toEqual<Price>({ num: 1n, den: 1n });
  });

  it('-110 x -110 x +150 -> 11025000/1210000', () => {
    const p = multiplyPrices([-110, -110, 150].map(americanToPrice));
    expect(p).toEqual<Price>({ num: 11025000n, den: 1210000n });
  });

  it('a single price is returned unchanged', () => {
    expect(multiplyPrices([americanToPrice(-110)])).toEqual<Price>({ num: 210n, den: 110n });
  });

  it('10 legs of -110 stays exact (24-digit numerator, no Number coercion)', () => {
    const p = multiplyPrices(Array<AmericanPrice>(10).fill(-110).map(americanToPrice));
    expect(p.num).toBe(166798809782010000000000n);
    expect(p.den).toBe(259374246010000000000n);
    expect(p.num.toString()).toHaveLength(24);
    // The point of the exercise: a Number round-trip would NOT survive this.
    expect(BigInt(Number(p.num))).not.toBe(p.num);
    expect(p.num).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe('payoutCents', () => {
  it('2500 at -110 -> 4772', () => {
    expect(payoutCents(2500, americanToPrice(-110))).toBe(4772);
  });

  it('5000 at +164 -> 13200', () => {
    expect(payoutCents(5000, americanToPrice(164))).toBe(13200);
  });

  it('1000 on the 3-leg parlay -> 9111', () => {
    expect(payoutCents(1000, priceFromLegs([-110, -110, 150]))).toBe(9111);
  });

  it('1000 on the same parlay with leg 3 pushed -> 3644', () => {
    expect(payoutCents(1000, priceFromLegs([-110, -110]))).toBe(3644);
  });

  it('1000 at 1/1 (all legs pushed) -> 1000 exactly', () => {
    expect(payoutCents(1000, EVEN_MONEY_UNIT)).toBe(1000);
    expect(payoutCents(1000, priceFromLegs([]))).toBe(1000);
  });

  it('3333 at -110 -> 6363 (exact, no float drift)', () => {
    expect(payoutCents(3333, americanToPrice(-110))).toBe(6363);
  });

  it('10 legs of -110 at the full 100000 bankroll -> 64308161', () => {
    expect(payoutCents(100000, priceFromLegs(Array<AmericanPrice>(10).fill(-110)))).toBe(64308161);
  });

  // HEADLINE REGRESSION. All values below are REPL-computed; do not edit them by
  // hand. The -110/+120/-105 parlay has exact rational 9471000/1155000 = 41/5 =
  // 8.2 decimal, +720 American. It must fail against BOTH float formulations of
  // decimal odds, otherwise a naive implementation passes it by luck:
  //   1 + 100/|A|      -> 819
  //   (|A| + 100)/|A|  -> 819
  //   exact BigInt     -> 820
  it('REGRESSION: 100 on the -110/+120/-105 parlay -> 820, never 819', () => {
    const price = priceFromLegs(REGRESSION_LEGS);
    expect(price).toEqual<Price>({ num: 9471000n, den: 1155000n });
    expect(reducePrice(price)).toEqual<Price>({ num: 41n, den: 5n });
    expect(payoutCents(100, price)).toBe(820);
    expect(floatPayout(100, REGRESSION_LEGS, floatDecimalA)).toBe(819);
    expect(floatPayout(100, REGRESSION_LEGS, floatDecimalB)).toBe(819);
  });

  it('REGRESSION: 100000 on the same parlay -> 820000, never 819999', () => {
    expect(payoutCents(100000, priceFromLegs(REGRESSION_LEGS))).toBe(820000);
    expect(floatPayout(100000, REGRESSION_LEGS, floatDecimalA)).toBe(819999);
    expect(floatPayout(100000, REGRESSION_LEGS, floatDecimalB)).toBe(819999);
  });

  // Divergence is STAKE-DEPENDENT: at 1000 the float path happens to be right.
  // This case is here so nobody "simplifies" the suite down to one stake.
  it('CONTROL: 1000 on the same parlay -> 8200, which floats also produce', () => {
    expect(payoutCents(1000, priceFromLegs(REGRESSION_LEGS))).toBe(8200);
    expect(floatPayout(1000, REGRESSION_LEGS, floatDecimalA)).toBe(8200);
    expect(floatPayout(1000, REGRESSION_LEGS, floatDecimalB)).toBe(8200);
  });

  it('REGRESSION: 1500 on the same parlay -> 12300, never 12299', () => {
    expect(payoutCents(1500, priceFromLegs(REGRESSION_LEGS))).toBe(12300);
    expect(floatPayout(1500, REGRESSION_LEGS, floatDecimalA)).toBe(12299);
    expect(floatPayout(1500, REGRESSION_LEGS, floatDecimalB)).toBe(12299);
  });

  it('REGRESSION: the rest of the PLAN §5.3 stake table (25000 / 50000)', () => {
    const price = priceFromLegs(REGRESSION_LEGS);
    expect(payoutCents(25000, price)).toBe(205000);
    expect(floatPayout(25000, REGRESSION_LEGS, floatDecimalA)).toBe(204999);
    expect(floatPayout(25000, REGRESSION_LEGS, floatDecimalB)).toBe(204999);
    expect(payoutCents(50000, price)).toBe(410000);
    expect(floatPayout(50000, REGRESSION_LEGS, floatDecimalA)).toBe(409999);
    expect(floatPayout(50000, REGRESSION_LEGS, floatDecimalB)).toBe(409999);
  });

  it('REGRESSION: 100 on the -110/+164/-112 parlay -> 954, never 953', () => {
    const legs: readonly AmericanPrice[] = [-110, 164, -112];
    const price = priceFromLegs(legs);
    expect(price).toEqual<Price>({ num: 11753280n, den: 1232000n });
    expect(payoutCents(100, price)).toBe(954);
    expect(floatPayout(100, legs, floatDecimalA)).toBe(953);
    expect(floatPayout(100, legs, floatDecimalB)).toBe(953);
  });

  it('REGRESSION (straight, long price): 185 at -370 -> 235, never 234', () => {
    expect(payoutCents(185, americanToPrice(-370))).toBe(235);
    expect(floatPayout(185, [-370], floatDecimalA)).toBe(234);
    expect(floatPayout(185, [-370], floatDecimalB)).toBe(234);
  });

  it('REGRESSION (straight, very long price): 746 at -2984 -> 771, never 770', () => {
    expect(payoutCents(746, americanToPrice(-2984))).toBe(771);
    expect(floatPayout(746, [-2984], floatDecimalA)).toBe(770);
    expect(floatPayout(746, [-2984], floatDecimalB)).toBe(770);
  });

  it('SINGLE-FORMULATION trap: 5000 at +164 -> 13200 (1+164/100 gives 13199)', () => {
    expect(payoutCents(5000, americanToPrice(164))).toBe(13200);
    expect(floatPayout(5000, [164], floatDecimalA)).toBe(13199);
    expect(floatPayout(5000, [164], floatDecimalB)).toBe(13200); // agrees by luck
  });

  it(
    'the two float formulations of decimal odds disagree with each other, ' +
      'which is itself the argument for exact arithmetic',
    () => {
      // If these two ever became identical doubles, a vector that broke only one
      // of them would be indistinguishable from a real regression. They are not.
      expect(floatDecimalA(164)).not.toBe(floatDecimalB(164));
      expect(floatPayout(5000, [164], floatDecimalA)).not.toBe(
        floatPayout(5000, [164], floatDecimalB),
      );
      // PLAN §5.3's named trap: 460¢ @ -115 breaks formulation A only, so it is
      // useless as a regression vector. Exact answer is 860.
      expect(payoutCents(460, americanToPrice(-115))).toBe(860);
      expect(floatPayout(460, [-115], floatDecimalA)).toBe(859);
      expect(floatPayout(460, [-115], floatDecimalB)).toBe(860);
      // And at least one listed vector must break BOTH — that is what proves
      // this suite would catch a float implementation written either way.
      const bothBreak = [
        { stake: 100, legs: REGRESSION_LEGS },
        { stake: 100000, legs: REGRESSION_LEGS },
        { stake: 1500, legs: REGRESSION_LEGS },
        { stake: 100, legs: [-110, 164, -112] as readonly AmericanPrice[] },
        { stake: 185, legs: [-370] as readonly AmericanPrice[] },
        { stake: 746, legs: [-2984] as readonly AmericanPrice[] },
      ].filter(({ stake, legs }) => {
        const exact = payoutCents(stake, priceFromLegs(legs));
        return (
          floatPayout(stake, legs, floatDecimalA) !== exact &&
          floatPayout(stake, legs, floatDecimalB) !== exact
        );
      });
      expect(bothBreak).toHaveLength(6);
    },
  );

  it('property: matches a BigInt oracle for every stake in [100, 200000] over a price set', () => {
    const prices: readonly Price[] = [
      americanToPrice(-110),
      americanToPrice(164),
      americanToPrice(-100),
      EVEN_MONEY_UNIT,
      priceFromLegs(REGRESSION_LEGS),
    ];
    for (const price of prices) {
      for (let stake = 100; stake <= 200000; stake += 1) {
        const expected = exactPayout(stake, price);
        if (expected > BigInt(MAX_PAYOUT_CENTS)) continue;
        const actual = payoutCents(stake, price);
        if (actual !== Number(expected)) {
          // Report rather than assert in the hot loop: 1M expect() calls is slow.
          expect({ stake, price, actual }).toEqual({ stake, price, actual: Number(expected) });
        }
      }
    }
    expect(payoutCents(200000, americanToPrice(-110))).toBe(381818);
  }, 60_000);

  it('never returns a non-integer or a negative', () => {
    const prices = [-110, 164, -100, 100, -2984, 100000, -100000].map(americanToPrice);
    for (const price of prices) {
      for (const stake of [0, 100, 101, 999, 1000, 33333, 100000]) {
        // 100000¢ at +100000 is 100,100,000¢ — over the cap, and therefore a
        // throw rather than a return value. Everything else must be a clean int.
        if (exceedsPayoutCap(stake, price)) {
          expectAppError(() => payoutCents(stake, price), 'PAYOUT_LIMIT_EXCEEDED');
          continue;
        }
        const v = payoutCents(stake, price);
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeGreaterThanOrEqual(stake); // decimal odds are always > 1
      }
    }
  });

  it('rejects a negative or non-integer stake rather than ceiling toward zero', () => {
    // BigInt `/` truncates TOWARD ZERO, which is floor only for non-negative
    // operands (PLAN §5.3). A negative stake must never reach the division.
    expectAppError(() => payoutCents(-100, americanToPrice(-110)), 'VALIDATION');
    expectAppError(() => payoutCents(100.5, americanToPrice(-110)), 'VALIDATION');
    expectAppError(() => payoutCents(Number.NaN, americanToPrice(-110)), 'VALIDATION');
  });

  it('rejects a degenerate price', () => {
    expectAppError(() => payoutCents(100, { num: 0n, den: 1n }), 'VALIDATION');
    expectAppError(() => payoutCents(100, { num: 210n, den: 0n }), 'VALIDATION');
  });
});

describe('MAX_PAYOUT_CENTS', () => {
  it('is re-exported from constants.ts at its documented value', () => {
    expect(MAX_PAYOUT_CENTS).toBe(100_000_000);
  });

  it('a payout of exactly MAX_PAYOUT_CENTS is allowed', () => {
    expect(payoutCents(MAX_PAYOUT_CENTS, EVEN_MONEY_UNIT)).toBe(MAX_PAYOUT_CENTS);
    expect(exceedsPayoutCap(MAX_PAYOUT_CENTS, EVEN_MONEY_UNIT)).toBe(false);
    // …and via a real price: 50000000¢ at +100 is exactly 100000000¢.
    expect(payoutCents(50_000_000, americanToPrice(100))).toBe(MAX_PAYOUT_CENTS);
  });

  it('one cent over throws PAYOUT_LIMIT_EXCEEDED', () => {
    expectAppError(
      () => payoutCents(MAX_PAYOUT_CENTS + 1, EVEN_MONEY_UNIT),
      'PAYOUT_LIMIT_EXCEEDED',
    );
    expect(exceedsPayoutCap(MAX_PAYOUT_CENTS + 1, EVEN_MONEY_UNIT)).toBe(true);
  });

  it('a 10-leg +2000 parlay at a 100000 stake is rejected, not truncated', () => {
    const price = priceFromLegs(Array<AmericanPrice>(10).fill(2000));
    expect(price.num).toBe(1667988097820100000000000000000000n);
    expect(price.den).toBe(100000000000000000000n);
    expectAppError(() => payoutCents(100000, price), 'PAYOUT_LIMIT_EXCEEDED');
    expect(exceedsPayoutCap(100000, price)).toBe(true);
    // The realistic worst case, by contrast, sits comfortably under the cap.
    const tenAt110 = priceFromLegs(Array<AmericanPrice>(10).fill(-110));
    expect(exceedsPayoutCap(100000, tenAt110)).toBe(false);
    expect(payoutCents(100000, tenAt110)).toBe(64308161);
  });

  it('a payout past 2^53, or of Infinity magnitude, is rejected rather than truncated', () => {
    const price = priceFromLegs(Array<AmericanPrice>(10).fill(2000));
    // The true payout is 1667988097820100000¢ — past 2^53, so a `number` could
    // not represent it. (That the comparison happens in BigInt is a property of
    // the source, not something a test can observe: any value a double would
    // lose is already far beyond the cap.)
    expect(exactPayout(100000, price)).toBe(1667988097820100000n);
    expect(exactPayout(100000, price)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expectAppError(() => payoutCents(100000, price), 'PAYOUT_LIMIT_EXCEEDED');
    // And at a magnitude where Number() would not even be finite.
    const absurd: Price = { num: 10n ** 400n, den: 1n };
    expect(Number(absurd.num)).toBe(Number.POSITIVE_INFINITY);
    expectAppError(() => payoutCents(100, absurd), 'PAYOUT_LIMIT_EXCEEDED');
    expect(exceedsPayoutCap(100, absurd)).toBe(true);
  });

  it('priceToAmerican refuses an output beyond the schema CHECK instead of returning Infinity', () => {
    // 10 legs at +100000: exact American is 101004512021025221012004501000000.
    const huge = priceFromLegs(Array<AmericanPrice>(10).fill(100000));
    expectAppError(() => priceToAmerican(huge), 'VALIDATION');
    expectAppError(() => priceToAmerican({ num: 10n ** 400n, den: 1n }), 'VALIDATION');
    // Exactly at the CHECK bound is still allowed: +100000000 <-> (1000002/1)... use the inverse.
    expect(priceToAmerican({ num: 1_000_001n, den: 1n })).toBe(100_000_000);
    expectAppError(() => priceToAmerican({ num: 1_000_002n, den: 1n }), 'VALIDATION');
  });

  it('PUSH_AMERICAN_PRICE is the literal settlement writes for an all-push bet', () => {
    expect(PUSH_AMERICAN_PRICE).toBe(100);
    expectAppError(() => priceToAmerican(EVEN_MONEY_UNIT), 'VALIDATION');
    expect(Object.isFrozen(EVEN_MONEY_UNIT)).toBe(true);
  });

  it('formatDecimalOdds caps places at 20', () => {
    expect(formatDecimalOdds(americanToPrice(-110), 20)).toBe('1.90909090909090909091');
    expectAppError(() => formatDecimalOdds(americanToPrice(-110), 21), 'VALIDATION');
  });

  it('exceedsPayoutCap agrees with payoutCents but does not throw', () => {
    const cases: readonly (readonly [Cents, Price])[] = [
      [100, priceFromLegs(REGRESSION_LEGS)],
      [100000, priceFromLegs(Array<AmericanPrice>(10).fill(-110))],
      [100000, priceFromLegs(Array<AmericanPrice>(10).fill(2000))],
      [MAX_PAYOUT_CENTS, EVEN_MONEY_UNIT],
      [MAX_PAYOUT_CENTS + 1, EVEN_MONEY_UNIT],
      [100000, americanToPrice(100000)],
    ];
    for (const [stake, price] of cases) {
      const over = exceedsPayoutCap(stake, price);
      expect(over).toBe(exactPayout(stake, price) > BigInt(MAX_PAYOUT_CENTS));
      if (over) {
        expectAppError(() => payoutCents(stake, price), 'PAYOUT_LIMIT_EXCEEDED');
      } else {
        expect(payoutCents(stake, price)).toBe(Number(exactPayout(stake, price)));
      }
    }
  });
});

describe('profitCents', () => {
  it('is payoutCents - stakeCents on every PLAN §5.4 row', () => {
    expect(profitCents(2500, americanToPrice(-110))).toBe(2272);
    expect(profitCents(5000, americanToPrice(164))).toBe(8200);
    expect(profitCents(1000, priceFromLegs([-110, -110, 150]))).toBe(8111);
    expect(profitCents(1000, priceFromLegs([-110, -110]))).toBe(2644);
    expect(profitCents(1000, EVEN_MONEY_UNIT)).toBe(0);
    expect(profitCents(100000, priceFromLegs(Array<AmericanPrice>(10).fill(-110)))).toBe(64208161);
    expect(profitCents(100, priceFromLegs(REGRESSION_LEGS))).toBe(720);
    expect(profitCents(100000, priceFromLegs(REGRESSION_LEGS))).toBe(720000);
    expect(profitCents(185, americanToPrice(-370))).toBe(50);
    expect(profitCents(746, americanToPrice(-2984))).toBe(25);
  });

  it('is never negative on the valid domain (a winning bet always returns the stake)', () => {
    for (let a = 100; a <= 3000; a += 7) {
      for (const signed of [a, -a]) {
        expect(profitCents(100, americanToPrice(signed))).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('propagates the payout cap', () => {
    expectAppError(
      () => profitCents(100000, priceFromLegs(Array<AmericanPrice>(10).fill(2000))),
      'PAYOUT_LIMIT_EXCEEDED',
    );
  });
});

describe('impliedProbability / marketHold (display only)', () => {
  it('-198 -> 0.66443', () => {
    expect(impliedProbability(americanToPrice(-198))).toBeCloseTo(0.66443, 5);
  });

  it('+164 -> 0.37879', () => {
    expect(impliedProbability(americanToPrice(164))).toBeCloseTo(0.37879, 5);
  });

  it('hold of [-198, +164] -> ~0.0432', () => {
    const hold = marketHold([americanToPrice(-198), americanToPrice(164)]);
    expect(hold).toBeCloseTo(0.043217, 6);
  });

  it('+100 is exactly 0.5 and -110 is 11/21', () => {
    expect(impliedProbability(americanToPrice(100))).toBe(0.5);
    expect(impliedProbability(americanToPrice(-110))).toBeCloseTo(0.5238095238, 10);
    // A fair (hold-free) two-way market sums to 1.
    expect(marketHold([americanToPrice(100), americanToPrice(100)])).toBeCloseTo(0, 12);
  });

  it('survives a parlay-sized rational without becoming NaN', () => {
    const p = priceFromLegs(Array<AmericanPrice>(10).fill(-110));
    const prob = impliedProbability(p);
    expect(Number.isFinite(prob)).toBe(true);
    expect(prob).toBeCloseTo(1 / 643.081618, 6);
  });

  it('an empty market has a hold of -1 (the literal spec: sum([]) - 1)', () => {
    expect(marketHold([])).toBe(-1);
  });
});

describe('formatDecimalOdds / formatAmerican', () => {
  it('defaults to 3 places', () => {
    expect(formatDecimalOdds(americanToPrice(-110))).toBe('1.909');
    expect(formatDecimalOdds(americanToPrice(164))).toBe('2.640');
    expect(formatDecimalOdds(americanToPrice(100))).toBe('2.000');
  });

  it('reproduces the PLAN §5.4 decimal column at 6 places (round half-up)', () => {
    expect(formatDecimalOdds(americanToPrice(-110), 6)).toBe('1.909091');
    expect(formatDecimalOdds(priceFromLegs([-110, -110, 150]), 6)).toBe('9.111570');
    expect(formatDecimalOdds(priceFromLegs([-110, -110]), 6)).toBe('3.644628');
    expect(formatDecimalOdds(EVEN_MONEY_UNIT, 6)).toBe('1.000000');
    expect(formatDecimalOdds(priceFromLegs(Array<AmericanPrice>(10).fill(-110)), 6)).toBe(
      '643.081618',
    );
    expect(formatDecimalOdds(priceFromLegs(REGRESSION_LEGS), 6)).toBe('8.200000');
    expect(formatDecimalOdds(americanToPrice(-370), 6)).toBe('1.270270');
    expect(formatDecimalOdds(americanToPrice(-2984), 6)).toBe('1.033512');
  });

  it('handles 0 places and pads the fraction', () => {
    expect(formatDecimalOdds(americanToPrice(-110), 0)).toBe('2');
    expect(formatDecimalOdds(americanToPrice(164), 0)).toBe('3');
    expect(formatDecimalOdds(americanToPrice(-110), 1)).toBe('1.9');
    expect(formatDecimalOdds(americanToPrice(-110), 2)).toBe('1.91');
    expect(formatDecimalOdds({ num: 2000000001n, den: 1000000000n }, 6)).toBe('2.000000');
  });

  it('rejects a nonsensical precision or price', () => {
    expectAppError(() => formatDecimalOdds(americanToPrice(-110), -1), 'VALIDATION');
    expectAppError(() => formatDecimalOdds(americanToPrice(-110), 2.5), 'VALIDATION');
    expectAppError(() => formatDecimalOdds({ num: 1n, den: 0n }, 3), 'VALIDATION');
  });

  it('formatAmerican: "+164" / "-110"', () => {
    expect(formatAmerican(164)).toBe('+164');
    expect(formatAmerican(-110)).toBe('-110');
    expect(formatAmerican(100)).toBe('+100');
    expect(formatAmerican(-100)).toBe('-100');
    expect(formatAmerican(64208)).toBe('+64208');
  });
});

describe('reducePrice / priceFromLegs', () => {
  it('reducePrice reduces 44100/12100 by its GCD', () => {
    // gcd(44100, 12100) = 100
    expect(reducePrice({ num: 44100n, den: 12100n })).toEqual<Price>({ num: 441n, den: 121n });
    expect(reducePrice(americanToPrice(-110))).toEqual<Price>({ num: 21n, den: 11n });
    expect(reducePrice(EVEN_MONEY_UNIT)).toEqual<Price>({ num: 1n, den: 1n });
  });

  it('reducePrice never changes the value of a payout', () => {
    const price = priceFromLegs(REGRESSION_LEGS);
    expect(reducePrice(price)).toEqual<Price>({ num: 41n, den: 5n });
    for (const stake of [100, 1000, 1500, 25000, 100000]) {
      expect(payoutCents(stake, reducePrice(price))).toBe(payoutCents(stake, price));
    }
    // GCD reduction is NOT a fix for the 20-digit problem (PLAN §5.2): ten -101
    // legs have nothing to cancel.
    const ten101 = reducePrice(priceFromLegs(Array<AmericanPrice>(10).fill(-101)));
    expect(ten101.den).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('priceFromLegs([-110]) equals americanToPrice(-110)', () => {
    expect(priceFromLegs([-110])).toEqual<Price>(americanToPrice(-110));
  });

  it('priceFromLegs([-110, 120, -105]) equals multiplyPrices of the three', () => {
    expect(priceFromLegs([-110, 120, -105])).toEqual<Price>(
      multiplyPrices([-110, 120, -105].map(americanToPrice)),
    );
  });

  it('priceFromLegs([]) is EVEN_MONEY_UNIT', () => {
    expect(priceFromLegs([])).toEqual<Price>(EVEN_MONEY_UNIT);
  });

  it('priceFromLegs validates its legs', () => {
    expectAppError(() => priceFromLegs([-110, 99]), 'VALIDATION');
  });

  it(
    'a 10-leg parlay recomputed from stored american integers is bit-identical ' +
      'to the price used at placement (no rational is ever persisted)',
    () => {
      // Exactly what the DB round-trip does: bets stores NO rational, only
      // bet_legs.american_price integers, and the price is recomputed.
      const legs: readonly AmericanPrice[] = [
        -110, 120, -105, 164, -112, 150, -370, 2000, -2984, 100,
      ];
      const atPlacement = priceFromLegs(legs);
      expect(atPlacement.num).toBe(80674661306131200000000000n);
      expect(atPlacement.den).toBe(14282378880000000000000n);
      expect(atPlacement.num.toString()).toHaveLength(26);

      // Persist: only the integers survive (JSON round-trip stands in for D1).
      const stored = JSON.parse(JSON.stringify(legs)) as AmericanPrice[];
      const recomputed = priceFromLegs(stored);
      expect(recomputed.num).toBe(atPlacement.num);
      expect(recomputed.den).toBe(atPlacement.den);
      expect(recomputed).toEqual<Price>(atPlacement);

      // And it is bit-identical for every leg ordering, since multiplication is
      // commutative in BigInt (no float reassociation error).
      const reversed = priceFromLegs([...legs].reverse());
      expect(reversed).toEqual<Price>(atPlacement);

      // This one is over the cap, which is itself the demonstration that a
      // 26-digit numerator never has to become a number.
      expect(exceedsPayoutCap(100000, atPlacement)).toBe(true);
      expect(payoutCents(100, atPlacement)).toBe(564854);
    },
  );

  it('is lossless across the whole CHECK-bounded leg domain', () => {
    for (let a = 100; a <= 100000; a += 997) {
      for (const signed of [a, -a]) {
        const single = priceFromLegs([signed]);
        expect(single).toEqual<Price>(americanToPrice(signed));
        expect(priceFromLegs([signed, -110])).toEqual<Price>({
          num: single.num * 210n,
          den: single.den * 110n,
        });
      }
    }
  });
});
