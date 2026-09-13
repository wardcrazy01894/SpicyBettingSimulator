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

import type { BettingRecord, LeaderboardResponse, LeaderboardRow } from '../shared/api-types.js';
import type { League } from '../shared/types.js';
import type { Env } from './env.js';
import { queryAll } from './db.js';

/** One `(user, status)` aggregate over the bets inside the requested scope. */
interface StatRow {
  user_id: string;
  status: string;
  n: number;
  stake: number;
  payout: number;
}

interface BalanceRow {
  user_id: string;
  username: string;
  display_name: string;
  balance_cents: number;
}

/**
 * Per-user totals, accumulated across however many bankrolls are in scope.
 *
 * ROI is pooled, NOT averaged: the all-time view sums the numerator and the
 * denominator across every league+season before dividing, so a $10 season and a
 * $10,000 season do not count equally (PLAN.md §11.5).
 */
/** A mutable mirror of the readonly wire `BettingRecord`. */
type MutableRecord = { -readonly [K in keyof BettingRecord]: BettingRecord[K] };

interface Accumulator {
  balanceCents: number;
  pendingStakeCents: number;
  record: MutableRecord;
  roiNumerator: number;
  roiDenominator: number;
}

function emptyAccumulator(balanceCents: number): Accumulator {
  return {
    balanceCents,
    pendingStakeCents: 0,
    record: { won: 0, lost: 0, push: 0, void: 0 },
    roiNumerator: 0,
    roiDenominator: 0,
  };
}

function applyStat(acc: Accumulator, row: StatRow): void {
  switch (row.status) {
    case 'pending':
      acc.pendingStakeCents += row.stake;
      return;
    case 'won':
      acc.record.won += row.n;
      break;
    case 'lost':
      acc.record.lost += row.n;
      break;
    case 'push':
      acc.record.push += row.n;
      break;
    case 'void':
      acc.record.void += row.n;
      break;
    default:
      // `cancelled` is excluded from every statistic.
      return;
  }
  if (row.status === 'won' || row.status === 'lost') {
    acc.roiNumerator += row.payout - row.stake;
    acc.roiDenominator += row.stake;
  }
}

/**
 * Ranked rows. Sorting: balance DESC, then ROI DESC, then username ASC.
 * A null ROI ("no settled action") sorts below every real ROI at the same
 * balance; with two nulls the username decides, so the order is total and
 * deterministic.
 */
function rank(
  users: readonly BalanceRow[],
  accumulators: ReadonlyMap<string, Accumulator>,
): readonly LeaderboardRow[] {
  const rows = users.map((user) => {
    const acc = accumulators.get(user.user_id) ?? emptyAccumulator(user.balance_cents);
    const roi = acc.roiDenominator === 0 ? null : acc.roiNumerator / acc.roiDenominator;
    return {
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      balanceCents: acc.balanceCents,
      pendingStakeCents: acc.pendingStakeCents,
      equityCents: acc.balanceCents + acc.pendingStakeCents,
      record: acc.record,
      roi,
    };
  });
  rows.sort((a, b) => {
    if (a.balanceCents !== b.balanceCents) return b.balanceCents - a.balanceCents;
    const ra = a.roi ?? Number.NEGATIVE_INFINITY;
    const rb = b.roi ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
  });
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function leaderboardFor(
  env: Env,
  league: League,
  season: number,
): Promise<LeaderboardResponse> {
  const [users, stats] = await Promise.all([
    queryAll<BalanceRow>(
      env.DB.prepare(
        `SELECT bk.user_id AS user_id, u.username AS username, u.display_name AS display_name,
                bk.balance_cents AS balance_cents
           FROM bankrolls bk JOIN users u ON u.id = bk.user_id
          WHERE bk.league = ?1 AND bk.season = ?2`,
      ).bind(league, season),
    ),
    queryAll<StatRow>(
      env.DB.prepare(
        `SELECT b.user_id AS user_id, b.status AS status, COUNT(*) AS n,
                COALESCE(SUM(b.stake_cents), 0) AS stake,
                COALESCE(SUM(b.payout_cents), 0) AS payout
           FROM bets b
          WHERE b.league = ?1 AND b.season = ?2
          GROUP BY b.user_id, b.status`,
      ).bind(league, season),
    ),
  ]);
  return { league, season, rows: rank(users, accumulate(users, stats)) };
}

/**
 * Combined view across every league and season. Balances and exposures are
 * summed; ROI is recomputed from the POOLED numerator and denominator (not an
 * average of per-bankroll ROIs).
 */
export async function leaderboardAllTime(env: Env): Promise<LeaderboardResponse> {
  const [users, stats] = await Promise.all([
    queryAll<BalanceRow>(
      env.DB.prepare(
        `SELECT bk.user_id AS user_id, u.username AS username, u.display_name AS display_name,
                COALESCE(SUM(bk.balance_cents), 0) AS balance_cents
           FROM bankrolls bk JOIN users u ON u.id = bk.user_id
          GROUP BY bk.user_id, u.username, u.display_name`,
      ),
    ),
    queryAll<StatRow>(
      env.DB.prepare(
        `SELECT b.user_id AS user_id, b.status AS status, COUNT(*) AS n,
                COALESCE(SUM(b.stake_cents), 0) AS stake,
                COALESCE(SUM(b.payout_cents), 0) AS payout
           FROM bets b
          GROUP BY b.user_id, b.status`,
      ),
    ),
  ]);
  return { league: 'all', season: null, rows: rank(users, accumulate(users, stats)) };
}

function accumulate(
  users: readonly BalanceRow[],
  stats: readonly StatRow[],
): ReadonlyMap<string, Accumulator> {
  const accumulators = new Map<string, Accumulator>();
  for (const user of users) accumulators.set(user.user_id, emptyAccumulator(user.balance_cents));
  for (const stat of stats) {
    const acc = accumulators.get(stat.user_id);
    // A bet whose user has no bankroll in scope is impossible (bets.bankroll_id
    // is a FK), but skipping is the safe read.
    if (acc !== undefined) applyStat(acc, stat);
  }
  return accumulators;
}
