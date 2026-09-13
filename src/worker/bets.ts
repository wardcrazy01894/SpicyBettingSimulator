/**
 * Bet placement, cancellation and editing. PLAN.md §11.4 and §14.2.
 *
 * EVERY mutation here is exactly ONE `db.batch()`. There is no read-then-write
 * anywhere: the kickoff/status guard is a `WHERE` clause inside the same batch as
 * the INSERT, and insufficient funds is caught by
 * `CHECK (balance_cents >= 0)` firing inside the ledger trigger, which rolls the
 * whole batch back.
 *
 * The client NEVER sends the price it will be charged. The server reads the
 * current `game_lines` row and snapshots market, side, line, price, provider and
 * capture time into `bet_legs`. An optional `expected` block gives the user
 * line-change protection (409 LINE_CHANGED).
 *
 * `bets.season` is derived from the LEGS' games, never from a wall-clock guess,
 * and all legs must share one (league, season) so exactly one bankroll is
 * charged -- otherwise MIXED_LEAGUE_PARLAY / MIXED_SEASON_PARLAY.
 *
 * `bets` stores NO decimal-odds rational. `american_price` is display and
 * `potential_payout_cents` is capped at MAX_PAYOUT_CENTS; the exact price is
 * always recomputed from `bet_legs.american_price` (PLAN.md §5.2).
 */

import type { BetView, PlaceBetRequest } from '../shared/api-types.js';
import type { EpochMs, League } from '../shared/types.js';
import type { Env } from './env.js';

export interface PlaceBetResult {
  readonly bet: BetView;
}

/**
 * @throws AppError VALIDATION | GAME_NOT_FOUND | GAME_NOT_BETTABLE |
 *                  BETTING_CLOSED | MARKET_UNAVAILABLE | LINE_CHANGED |
 *                  INSUFFICIENT_FUNDS | MIXED_LEAGUE_PARLAY |
 *                  MIXED_SEASON_PARLAY | DUPLICATE_GAME_IN_PARLAY |
 *                  PAYOUT_LIMIT_EXCEEDED
 */
export function placeBet(
  _env: Env,
  _userId: string,
  _req: PlaceBetRequest,
  _now: EpochMs,
): Promise<PlaceBetResult> {
  throw new Error('not implemented: M5');
}

/**
 * Cancel with a full refund.
 *
 * THE LOCK GUARD IS NOT `earliest_kickoff_at` ALONE. That column is a
 * placement-time snapshot which ingestion never updates, so if ESPN moved a game
 * two hours earlier the user could watch it go badly and still cancel for a full
 * refund. The guard must ALSO require that every leg's CURRENT game row is still
 * scheduled and still in the future:
 *
 *   UPDATE bets SET status='cancelled', cancelled_at=:now, updated_at=:now
 *    WHERE id=:betId AND user_id=:userId AND status='pending'
 *      AND NOT EXISTS (
 *        SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
 *         WHERE l.bet_id = :betId
 *           AND (g.status <> 'scheduled' OR g.kickoff_at <= :nowPlusBuffer))
 *
 * The refund is then guarded on THIS call having won the transition, so a second
 * cancel is a clean no-op rather than a UNIQUE violation that aborts the batch:
 *
 *   INSERT INTO ledger (...)
 *   SELECT :ledgerId, b.bankroll_id, 'bet_refund', b.id, b.id, b.stake_cents, :now, :memo
 *     FROM bets b
 *    WHERE b.id = :betId AND b.status = 'cancelled' AND b.cancelled_at = :now
 *      AND NOT EXISTS (SELECT 1 FROM ledger
 *                       WHERE bankroll_id = b.bankroll_id
 *                         AND kind = 'bet_refund' AND ref_id = b.id)
 *
 * See PLAN.md §14.2.
 *
 * @throws AppError BET_NOT_FOUND | BET_LOCKED | BET_NOT_PENDING
 */
export function cancelBet(
  _env: Env,
  _userId: string,
  _betId: string,
  _now: EpochMs,
): Promise<PlaceBetResult> {
  throw new Error('not implemented: M5');
}

/**
 * Edit == atomic cancel + place in ONE batch. The new bet is priced from CURRENT
 * lines, never from the old snapshot. Neither half can land alone: the placement
 * statements are guarded on the cancel having applied, and any failure in the
 * placement half rolls the whole batch back leaving the old bet pending.
 *
 * The cancel half uses the SAME leg->game lock guard as `cancelBet` -- the
 * `earliest_kickoff_at` snapshot is never the sole authority.
 *
 * @throws every code `placeBet` throws, plus BET_LOCKED | BET_NOT_PENDING
 */
export function editBet(
  _env: Env,
  _userId: string,
  _betId: string,
  _req: PlaceBetRequest,
  _now: EpochMs,
): Promise<{ readonly bet: BetView; readonly replacedBetId: string }> {
  throw new Error('not implemented: M5');
}

export function getBet(
  _env: Env,
  _userId: string,
  _betId: string,
  _now: EpochMs,
): Promise<BetView | null> {
  throw new Error('not implemented: M5');
}

/**
 * List a user's bets. For OPEN bets each leg carries a live `projected` grade
 * computed from the current game row — computed on read, never persisted.
 */
export function listBets(
  _env: Env,
  _userId: string,
  _filter: {
    readonly status: 'open' | 'settled' | 'all';
    readonly league?: League;
    readonly season?: number;
    readonly limit: number;
    readonly cursor?: string;
  },
  _now: EpochMs,
): Promise<{ readonly bets: readonly BetView[]; readonly nextCursor: string | null }> {
  throw new Error('not implemented: M5');
}

/**
 * Read the current line for each requested leg and build the immutable snapshot.
 * Rejects a market that is absent or whose `seen_at` (NOT `captured_at`) is older
 * than LINE_STALE_MS, and compares against `expected` when supplied.
 * `line_captured_at` on the snapshot copies `game_lines.captured_at`, i.e. when
 * the book's price last actually changed.
 */
export function resolveLegSnapshots(
  _env: Env,
  _req: PlaceBetRequest,
  _now: EpochMs,
): Promise<unknown> {
  throw new Error('not implemented: M5');
}
