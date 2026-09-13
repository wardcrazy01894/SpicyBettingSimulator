/**
 * Bet grading. PLAN.md §7.3.
 *
 * Pure: takes an immutable leg snapshot plus the game's score/status and returns
 * an outcome. It NEVER sees a live line — that is the whole point of the snapshot
 * (PLAN.md §14.3).
 *
 * All comparisons are integer arithmetic in TENTHS of a point, so a half-point
 * push is an exact `=== 0`, not an epsilon compare.
 */

import type { BetLegSnapshot, BetStatus, Cents, GameResult, LegGrade, Price } from './types.js';

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
  /** The effective price after pushed/voided legs are removed. */
  readonly effectivePrice: Price;
}

/**
 * Grade a single leg.
 *   canceled game                         -> 'void'
 *   status !== 'final'                    -> 'pending'
 *   a score is null / not a finite integer -> 'pending'  (log and skip; never guess)
 *   otherwise                             -> win/loss/push per market
 */
export function gradeLeg(_leg: BetLegSnapshot, _game: GameResult): LegGrade {
  throw new Error('not implemented: M2b');
}

/** Spread: `(sideScore*10 + lineTenths) - oppScore*10`, sign decides. */
export function gradeSpread(
  _sideScore: number,
  _oppScore: number,
  _lineTenths: number,
): 'win' | 'loss' | 'push' {
  throw new Error('not implemented: M2b');
}

/** Total: `(home + away) * 10` vs `lineTenths`, direction decided by the side. */
export function gradeTotal(
  _homeScore: number,
  _awayScore: number,
  _lineTenths: number,
  _side: 'over' | 'under',
): 'win' | 'loss' | 'push' {
  throw new Error('not implemented: M2b');
}

/** Moneyline: higher score wins, equal is a push (NFL games can tie). */
export function gradeMoneyline(_sideScore: number, _oppScore: number): 'win' | 'loss' | 'push' {
  throw new Error('not implemented: M2b');
}

/**
 * Grade a whole bet (a straight is the 1-leg case; there is no separate path).
 *
 * Order matters and is tested:
 *   1. ANY leg still 'pending'  -> the bet stays pending, nothing is written.
 *   2. ANY leg 'loss'           -> 'lost', payout 0. A loss beats every push.
 *   3. No surviving 'win' legs  -> 'void' if all legs voided, else 'push';
 *                                  payout = stake.
 *   4. Otherwise                -> 'won', payout = floor(stake * Π winningPrices).
 */
export function gradeBet(
  _stakeCents: Cents,
  _legs: readonly BetLegSnapshot[],
  _games: ReadonlyMap<string, GameResult>,
): BetOutcome {
  throw new Error('not implemented: M2b');
}

/**
 * The live, unpersisted projection shown next to an OPEN bet's legs in the UI.
 * Identical logic to `gradeLeg` but callers must not write the result.
 */
export function projectLeg(_leg: BetLegSnapshot, _game: GameResult): LegGrade {
  throw new Error('not implemented: M2b');
}
