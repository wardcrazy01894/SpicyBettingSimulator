/**
 * Leaderboard queries. PLAN.md §11.5.
 *
 * SEMANTICS, stated once so nobody has to guess:
 *   balanceCents      settled cash; pending stakes are ALREADY deducted
 *   pendingStakeCents Σ stake of pending bets ("exposure")
 *   equityCents       balanceCents + pendingStakeCents
 *   record            settled bets only; cancelled bets are excluded entirely
 *   roi               (Σ payout − Σ stake) over bets with status ∈ {won, lost};
 *                     push and void are excluded from BOTH sides; null when the
 *                     denominator is 0
 *   RANKED BY balanceCents DESC, then roi DESC, then username ASC
 */

import type { LeaderboardResponse } from '../shared/api-types.js';
import type { League } from '../shared/types.js';
import type { Env } from './env.js';

export function leaderboardFor(
  _env: Env,
  _league: League,
  _season: number,
): Promise<LeaderboardResponse> {
  throw new Error('not implemented: M5');
}

/**
 * Combined view across every league and season. Balances and exposures are
 * summed; ROI is recomputed from the POOLED numerator and denominator (not an
 * average of per-bankroll ROIs).
 */
export function leaderboardAllTime(_env: Env): Promise<LeaderboardResponse> {
  throw new Error('not implemented: M5');
}
