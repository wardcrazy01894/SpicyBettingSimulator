/**
 * Bet grading. PLAN.md §7.3.
 *
 * Pure: takes an immutable leg snapshot plus the game's score/status and returns
 * an outcome. It NEVER sees a live line — that is the whole point of the snapshot
 * (PLAN.md §14.3). `GameResult` carries exactly three fields (status + two
 * scores), so there is no line for this module to read even by accident.
 *
 * All comparisons are integer arithmetic in TENTHS of a point, so a half-point
 * push is an exact `=== 0`, not an epsilon compare. All MONEY leaves through
 * `payoutCents()` from `odds.ts`, which is BigInt end to end; nothing here
 * multiplies or divides a cent.
 *
 * ── The three readings of §7 this file commits to ────────────────────────────
 *
 * 1. **A losing leg does NOT short-circuit a pending one.** §7.3 orders the
 *    checks `pending` first, `loss` second, and the order is load-bearing: a
 *    parlay with one lost leg and one in-progress leg grades `pending`, not
 *    `lost`. That agrees with §7.1, whose selection query only picks up a bet
 *    when EVERY leg's game is already `final` or `canceled` — so in production
 *    this combination is only reachable when a "final" game's score is garbage,
 *    and the right answer there is to wait for ESPN to republish rather than to
 *    settle on data we distrust. It also keeps the invariant that a graded bet
 *    always writes a result for every leg. (Nothing is lost commercially: a dead
 *    parlay pays 0 whenever it does settle.)
 *
 * 2. **A `final` game with a null / non-integer / negative score is `pending`,
 *    not `loss` and not `void`.** §7.3 says "log + skip; never guess". §7.1
 *    calls this out explicitly as the head-of-line case: the bet increments
 *    `settle_attempts`, writes no money, and after 24 h of that lands in
 *    `job_runs.stats.stuck[]` for a human. Voiding would hand back a stake we
 *    might owe as a payout; grading it a loss would confiscate one.
 *
 * 3. **A straight push returns `status: 'push'`, `payoutCents: stake` and
 *    `effectivePrice: EVEN_MONEY_UNIT` (1/1).** The caller writes
 *    `american_price = 100` as a LITERAL (§7.4) — `priceToAmerican(1/1)` throws
 *    by design, because even money has no American form (§5.5). Use
 *    `effectiveAmericanPrice()` below and that trap is handled for you.
 */

import { AppError } from './errors.js';
import {
  EVEN_MONEY_UNIT,
  americanToPrice,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
} from './odds.js';
import type {
  AmericanPrice,
  BetLegSnapshot,
  BetStatus,
  Cents,
  GameResult,
  LegGrade,
  Price,
} from './types.js';

export interface GradedLeg {
  readonly legIndex: number;
  readonly grade: LegGrade;
  /**
   * Derived from the leg's snapshot `americanPrice` via `americanToPrice()`.
   * Nothing persists a rational; see PLAN.md §5.2.
   */
  readonly price: Price;
}

export interface BetOutcome {
  /** `pending` means NOTHING is written — not even partial leg results. */
  readonly status: BetStatus;
  /** Total return in cents (stake + profit). 0 for a loss, stake for push/void. */
  readonly payoutCents: Cents;
  /** Per-leg results, only meaningful when `status !== 'pending'`. */
  readonly legs: readonly GradedLeg[];
  /**
   * The effective price after pushed/voided legs are removed, i.e. what the bet
   * was actually PAID at. Per status:
   *   `won`     the product of the surviving (winning) legs only.
   *   `lost`    the full PLACEMENT price — §7.4: "a lost bet keeps its placement
   *             price: there are no surviving legs to re-price from, and the
   *             price it was offered is the honest thing to display."
   *   `push` /
   *   `void`    `EVEN_MONEY_UNIT` (1/1). The stake comes back; see note 3 above.
   *   `pending` `EVEN_MONEY_UNIT`, and meaningless — nothing is written.
   */
  readonly effectivePrice: Price;
}

/** Even money as an American integer. §7.4 writes this for a push/void. */
const EVEN_MONEY_AMERICAN: AmericanPrice = 100;

/**
 * A score we are willing to grade on. `null` (never parsed), a fraction, `NaN`,
 * `Infinity` and a negative are all ungradeable garbage — §7.3's "never guess".
 * `0` is NOT garbage: a 0-0 final is a real, gradeable result.
 */
function isGradeableScore(score: number | null): score is number {
  return score !== null && Number.isSafeInteger(score) && score >= 0;
}

/** A line we are willing to grade on. `null` is legal only for a moneyline. */
function isGradeableLine(lineTenths: number | null): lineTenths is number {
  return lineTenths !== null && Number.isSafeInteger(lineTenths);
}

/**
 * Grade a single leg.
 *   canceled game                         -> 'void'
 *   status !== 'final'                    -> 'pending'
 *   a score is null / not a finite integer -> 'pending'  (log and skip; never guess)
 *   otherwise                             -> win/loss/push per market
 *
 * A malformed leg (spread/total with no line, or a market/side pairing that
 * cannot exist) also grades `pending`. It deliberately does NOT throw: a throw
 * inside the settle job would abort the whole chunk, whereas `pending` costs one
 * UPDATE and routes the bet to the `stuck[]` report (§7.1).
 */
export function gradeLeg(leg: BetLegSnapshot, game: GameResult): LegGrade {
  if (game.status === 'canceled') return 'void';
  if (game.status !== 'final') return 'pending';

  const { homeScore, awayScore } = game;
  if (!isGradeableScore(homeScore) || !isGradeableScore(awayScore)) return 'pending';

  switch (leg.market) {
    case 'moneyline':
      if (leg.side === 'home') return gradeMoneyline(homeScore, awayScore);
      if (leg.side === 'away') return gradeMoneyline(awayScore, homeScore);
      return 'pending';
    case 'spread': {
      const { lineTenths } = leg;
      if (!isGradeableLine(lineTenths)) return 'pending';
      if (leg.side === 'home') return gradeSpread(homeScore, awayScore, lineTenths);
      if (leg.side === 'away') return gradeSpread(awayScore, homeScore, lineTenths);
      return 'pending';
    }
    case 'total': {
      const { lineTenths, side } = leg;
      if (!isGradeableLine(lineTenths)) return 'pending';
      if (side === 'over' || side === 'under')
        return gradeTotal(homeScore, awayScore, lineTenths, side);
      return 'pending';
    }
  }
}

/**
 * Spread: `(sideScore*10 + lineTenths) - oppScore*10`, sign decides.
 *
 * `lineTenths` is ALREADY from the bettor's side (see `BetLegSnapshot`): a home
 * −3.5 leg carries −35, the away +3.5 side of the same game carries +35. So
 * there is no sign flip here — the caller passes its own score first and the
 * opponent's second, and the line adds to the bettor's side. Half-point lines
 * are exactly representable in tenths, so `=== 0` is a real, reachable compare
 * (PLAN §5.7) and no epsilon appears anywhere.
 */
export function gradeSpread(
  sideScore: number,
  oppScore: number,
  lineTenths: number,
): 'win' | 'loss' | 'push' {
  const margin10 = sideScore * 10 + lineTenths - oppScore * 10;
  if (margin10 > 0) return 'win';
  if (margin10 < 0) return 'loss';
  return 'push';
}

/** Total: `(home + away) * 10` vs `lineTenths`, direction decided by the side. */
export function gradeTotal(
  homeScore: number,
  awayScore: number,
  lineTenths: number,
  side: 'over' | 'under',
): 'win' | 'loss' | 'push' {
  const sum10 = (homeScore + awayScore) * 10;
  if (sum10 === lineTenths) return 'push';
  const wentOver = sum10 > lineTenths;
  if (side === 'over') return wentOver ? 'win' : 'loss';
  return wentOver ? 'loss' : 'win';
}

/** Moneyline: higher score wins, equal is a push (NFL games can tie, 0-0 included). */
export function gradeMoneyline(sideScore: number, oppScore: number): 'win' | 'loss' | 'push' {
  if (sideScore > oppScore) return 'win';
  if (sideScore < oppScore) return 'loss';
  return 'push';
}

/** The single shared "nothing happened" outcome. Frozen shape, no writes. */
function pendingOutcome(): BetOutcome {
  return { status: 'pending', payoutCents: 0, legs: [], effectivePrice: EVEN_MONEY_UNIT };
}

/**
 * Grade a whole bet (a straight is the 1-leg case; there is no separate path).
 *
 * `legs` MUST be in `leg_index` order — §7.2's query is
 * `ORDER BY l.bet_id, l.leg_index` — because `GradedLeg.legIndex` is the array
 * position and is what the per-leg UPDATE in §7.4 binds.
 *
 * `games` is keyed by `gameId`. A leg whose game is absent grades `pending`:
 * a missing row is exactly as unknowable as an unfinished one.
 *
 * Order matters and is tested:
 *   1. ANY leg still 'pending'  -> the bet stays pending, nothing is written.
 *   2. ANY leg 'loss'           -> 'lost', payout 0. A loss beats every push.
 *   3. No surviving 'win' legs  -> 'void' if all legs voided, else 'push';
 *                                  payout = stake.
 *   4. Otherwise                -> 'won', payout = floor(stake * Π winningPrices).
 *
 * @throws AppError('VALIDATION') for a bet with no legs, or a negative /
 *   non-integer stake (the latter from `payoutCents`).
 * @throws AppError('PAYOUT_LIMIT_EXCEEDED') if the payout would breach the cap.
 *   §7.4 proves this is unreachable for a legally placed bet — dropping pushed
 *   legs strictly shrinks the product — so it is left to propagate rather than
 *   be clamped, which would silently underpay.
 */
export function gradeBet(
  stakeCents: Cents,
  legs: readonly BetLegSnapshot[],
  games: ReadonlyMap<string, GameResult>,
): BetOutcome {
  if (legs.length === 0) {
    throw new AppError('VALIDATION', 'A bet must have at least one leg to grade.');
  }

  const graded: GradedLeg[] = legs.map((leg, legIndex) => {
    const game = games.get(leg.gameId);
    return {
      legIndex,
      grade: game === undefined ? 'pending' : gradeLeg(leg, game),
      price: americanToPrice(leg.americanPrice),
    };
  });

  // 1. Pending beats everything, INCLUDING a loss. See note 1 in the header.
  if (graded.some((l) => l.grade === 'pending')) return pendingOutcome();

  // 2. A losing leg beats every push, and is evaluated BEFORE push removal.
  if (graded.some((l) => l.grade === 'loss')) {
    return {
      status: 'lost',
      payoutCents: 0,
      legs: graded,
      // §7.4: a lost bet keeps the price it was offered at.
      effectivePrice: priceFromLegs(legs.map((leg) => leg.americanPrice)),
    };
  }

  // 3. No survivors: the stake comes back at even money. `void` only when EVERY
  //    leg voided, so one push among voids still reads as a push (§7.3).
  const survivors = legs.filter((_leg, i) => graded[i]?.grade === 'win');
  if (survivors.length === 0) {
    const status: BetStatus = graded.every((l) => l.grade === 'void') ? 'void' : 'push';
    return {
      status,
      // Through the BigInt helper, not `stakeCents` raw: floor(stake * 1/1) is
      // the stake, and this way a bad stake is rejected on a push too.
      payoutCents: payoutCents(stakeCents, EVEN_MONEY_UNIT),
      legs: graded,
      effectivePrice: EVEN_MONEY_UNIT,
    };
  }

  // 4. Re-price from the surviving legs' stored American integers (§7.4).
  const effectivePrice = priceFromLegs(survivors.map((leg) => leg.americanPrice));
  return {
    status: 'won',
    payoutCents: payoutCents(stakeCents, effectivePrice),
    legs: graded,
    effectivePrice,
  };
}

/**
 * The value §7.4 binds as `:effectiveAmerican` in the settlement UPDATE.
 *
 * This exists so no caller has to remember that `priceToAmerican(1/1)` THROWS:
 * even money has no American equivalent (§5.5), and a push/void outcome's
 * effective price is exactly 1/1. Those two statuses return the literal 100.
 *
 * @throws AppError('VALIDATION') for a `pending` (or otherwise unsettled) bet —
 *   nothing is written, so there is nothing to price.
 */
export function effectiveAmericanPrice(outcome: BetOutcome): AmericanPrice {
  switch (outcome.status) {
    case 'push':
    case 'void':
      return EVEN_MONEY_AMERICAN;
    case 'won':
    case 'lost':
      return priceToAmerican(outcome.effectivePrice);
    default:
      throw new AppError(
        'VALIDATION',
        `A ${outcome.status} bet has no effective price; only a settled bet does.`,
      );
  }
}

/**
 * The live, unpersisted projection shown next to an OPEN bet's legs in the UI.
 * Identical logic to `gradeLeg` but callers must not write the result. An
 * in-progress game therefore projects as `pending`, never as whoever is ahead.
 */
export function projectLeg(leg: BetLegSnapshot, game: GameResult): LegGrade {
  return gradeLeg(leg, game);
}
