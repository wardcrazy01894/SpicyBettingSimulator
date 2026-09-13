/**
 * Grading and settlement. PLAN.md §7.
 *
 * THREE independent layers of idempotency, because paying a bet twice is the
 * worst bug this app could have:
 *   1. `UPDATE bets ... WHERE id = ? AND status = 'pending'` — a second run
 *      matches 0 rows.
 *   2. The leg-result and ledger statements are additionally guarded on
 *      `settle_run_id = :runId`, so a run that LOST the race writes nothing.
 *   3. `UNIQUE (bankroll_id, kind, ref_id)` on `ledger` — if 1 and 2 were both
 *      defeated, the INSERT aborts the batch and no money moves.
 *
 * NOTHING in this module reads `game_lines`. The line comes from the `bet_legs`
 * snapshot; only score and status come from `games`. That is asserted by a test
 * that mutates `game_lines` after placement and checks the payout is unchanged.
 *
 * A parlay with some legs final and some not does not match the selection query
 * at all, so it stays `pending` with zero writes.
 *
 * HEAD-OF-LINE BLOCKING: a bet CAN be selected (all games final) and still grade
 * `pending` -- e.g. a final game whose score never parsed. Such a bet increments
 * `bets.settle_attempts` and records `settle_error`; selection orders by
 * `settle_attempts ASC` and skips anything at MAX_SETTLE_ATTEMPTS, so a handful
 * of undecidable bets can never starve the queue. Those are the ONLY columns a
 * pending outcome writes, and they carry no money semantics.
 *
 * PRICE: `bets` stores no rational. The effective price is recomputed inside the
 * job from the SURVIVING (won) legs' `american_price` integers via
 * `priceFromLegs()`, and the resulting American integer is WRITTEN BACK to
 * `bets.american_price` in the same settlement UPDATE. Without that write-back a
 * push-repriced parlay would pay 3644c while still displaying the 3-leg +811 it
 * was placed at. The displayed price must match what was paid.
 *
 * Re-pricing can only ever DECREASE the payout: every legal American price has
 * decimal odds strictly greater than 1 (the minimum over the whole legal domain
 * is 1.001, at -100000), so dropping pushed/voided legs strictly shrinks the
 * product. Therefore `payout_cents <= potential_payout_cents <=
 * MAX_PAYOUT_CENTS` always holds and the CHECK constraint can never abort a
 * settlement batch. Stated explicitly so the CHECK does not look like a latent
 * batch-abort.
 */

import type { EpochMs } from '../shared/types.js';
import type { Env } from './env.js';

export interface SettleStats {
  readonly considered: number;
  readonly settled: number;
  /** Selected but undecidable; `settle_attempts` was incremented. */
  readonly deferred: number;
  /** Parked at MAX_SETTLE_ATTEMPTS and reported for a human. */
  readonly stuck: readonly string[];
  readonly won: number;
  readonly lost: number;
  readonly push: number;
  readonly void: number;
  readonly paidCents: number;
  readonly skippedAlreadySettled: number;
  readonly errors: readonly { readonly betId: string; readonly error: string }[];
}

/**
 * Pending bets whose EVERY leg's game is `final` or `canceled`.
 * `postponed` is deliberately excluded so a postponed game keeps its bet pending
 * until it is played or the maintenance job auto-voids it.
 *
 *   ... WHERE b.status='pending' AND b.settle_attempts < :maxAttempts
 *         AND NOT EXISTS (... g.status NOT IN ('final','canceled') ...)
 *       ORDER BY b.settle_attempts ASC, b.earliest_kickoff_at ASC
 *       LIMIT :chunk
 *
 * `settle_attempts ASC` is what defeats head-of-line blocking.
 */
export function selectSettleableBetIds(
  _env: Env,
  _limit: number,
  _maxAttempts: number,
): Promise<readonly string[]> {
  throw new Error('not implemented: M6');
}

/**
 * Records that a selected bet could not be graded. One UPDATE of
 * `settle_attempts` / `settle_attempted_at` / `settle_error`. No money, no status
 * change, no leg results. Called only for the anomalous
 * all-games-final-but-still-ungradeable case.
 */
export function deferBet(_env: Env, _betId: string, _reason: string, _now: EpochMs): Promise<void> {
  throw new Error('not implemented: M6');
}

/**
 * FIRST statement of every settle run. Gives a deferred bet a fresh attempt
 * budget as soon as the underlying data changes, so a transient ESPN glitch
 * cannot park a bet permanently:
 *
 *   UPDATE bets SET settle_attempts = 0, settle_error = NULL
 *    WHERE status = 'pending' AND settle_attempts > 0
 *      AND EXISTS (SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
 *                   WHERE l.bet_id = bets.id
 *                     AND g.updated_at > bets.settle_attempted_at);
 *
 * One statement per run, bounded by the number of deferred bets (normally zero).
 */
export function resetDeferredBets(_env: Env, _now: EpochMs): Promise<number> {
  throw new Error('not implemented: M6');
}

/** One query for all legs of the chunk, joined to games for score/status only. */
export function loadLegsForBets(_env: Env, _betIds: readonly string[]): Promise<unknown> {
  throw new Error('not implemented: M6');
}

/**
 * Settle exactly one bet in exactly one batch. Returns 'settled',
 * 'already-settled' (lost the race, or the ledger UNIQUE fired) or 'pending'.
 */
export function settleOneBet(
  _env: Env,
  _betId: string,
  _runId: string,
  _now: EpochMs,
): Promise<'settled' | 'already-settled' | 'pending'> {
  throw new Error('not implemented: M6');
}

/** Entry point for the `settle` job. Chunked at SETTLE_CHUNK bets per run. */
export function runSettle(_env: Env, _now: EpochMs, _chunk: number): Promise<SettleStats> {
  throw new Error('not implemented: M6');
}
