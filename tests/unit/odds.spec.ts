import { describe, it } from 'vitest';

/**
 * TDD contract for src/shared/odds.ts. Every `it.todo` below must become a real
 * test BEFORE the implementation is written (PLAN.md §13, M2a).
 */
describe('americanToPrice', () => {
  it.todo('-110 -> { num: 210n, den: 110n }');
  it.todo('+164 -> { num: 264n, den: 100n }');
  it.todo('+100 -> { num: 200n, den: 100n }');
  it.todo('-100 -> { num: 200n, den: 100n }');
  it.todo('rejects |price| < 100');
  it.todo('rejects non-integers and NaN');
});

describe('priceToAmerican (display only)', () => {
  it.todo('210/110 -> -110 (round trip)');
  it.todo('11025000/1210000 -> +811');
  it.todo('44100/12100 -> +264');
  it.todo('200/100 -> +100 at the +/- boundary');
  it.todo('rounds half-up on the magnitude, in BigInt');
});

describe('multiplyPrices', () => {
  it.todo('empty -> EVEN_MONEY_UNIT (1/1)');
  it.todo('-110 x -110 x +150 -> 11025000/1210000');
  it.todo('10 legs of -110 stays exact (24-digit numerator, no Number coercion)');
});

describe('payoutCents', () => {
  it.todo('2500 at -110 -> 4772');
  it.todo('5000 at +164 -> 13200');
  it.todo('1000 on the 3-leg parlay -> 9111');
  it.todo('1000 on the same parlay with leg 3 pushed -> 3644');
  it.todo('1000 at 1/1 (all legs pushed) -> 1000 exactly');
  it.todo('3333 at -110 -> 6363 (exact, no float drift)');
  // HEADLINE REGRESSION. All values below are REPL-computed; do not edit them by
  // hand. The -110/+120/-105 parlay has exact rational 9471000/1155000 = 41/5 =
  // 8.2 decimal, +720 American. It must fail against BOTH float formulations of
  // decimal odds, otherwise a naive implementation passes it by luck:
  //   1 + 100/|A|      -> 819
  //   (|A| + 100)/|A|  -> 819
  //   exact BigInt     -> 820
  it.todo('REGRESSION: 100 on the -110/+120/-105 parlay -> 820, never 819');
  it.todo('REGRESSION: 100000 on the same parlay -> 820000, never 819999');
  // Divergence is STAKE-DEPENDENT: at 1000 the float path happens to be right.
  // This case is here so nobody "simplifies" the suite down to one stake.
  it.todo('CONTROL: 1000 on the same parlay -> 8200, which floats also produce');
  it.todo('REGRESSION: 1500 on the same parlay -> 12300, never 12299');
  it.todo('REGRESSION: 100 on the -110/+164/-112 parlay -> 954, never 953');
  it.todo('REGRESSION (straight, long price): 185 at -370 -> 235, never 234');
  it.todo('REGRESSION (straight, very long price): 746 at -2984 -> 771, never 770');
  it.todo('SINGLE-FORMULATION trap: 5000 at +164 -> 13200 (1+164/100 gives 13199)');
  it.todo(
    'the two float formulations of decimal odds disagree with each other, ' +
      'which is itself the argument for exact arithmetic',
  );
  it.todo('property: matches a BigInt oracle for every stake in [100, 200000] over a price set');
  it.todo('never returns a non-integer or a negative');
});

describe('MAX_PAYOUT_CENTS', () => {
  it.todo('a payout of exactly MAX_PAYOUT_CENTS is allowed');
  it.todo('one cent over throws PAYOUT_LIMIT_EXCEEDED');
  it.todo('a 10-leg +2000 parlay at a 100000 stake is rejected, not truncated');
  it.todo('the cap is compared in BigInt BEFORE any Number conversion');
  it.todo('exceedsPayoutCap agrees with payoutCents but does not throw');
});

describe('impliedProbability / marketHold (display only)', () => {
  it.todo('-198 -> 0.66443');
  it.todo('+164 -> 0.37879');
  it.todo('hold of [-198, +164] -> ~0.0432');
});

describe('reducePrice / priceFromLegs', () => {
  it.todo('reducePrice reduces 44100/12100 by its GCD');
  it.todo('priceFromLegs([-110]) equals americanToPrice(-110)');
  it.todo('priceFromLegs([-110, 120, -105]) equals multiplyPrices of the three');
  it.todo('priceFromLegs([]) is EVEN_MONEY_UNIT');
  it.todo(
    'a 10-leg parlay recomputed from stored american integers is bit-identical ' +
      'to the price used at placement (no rational is ever persisted)',
  );
});
