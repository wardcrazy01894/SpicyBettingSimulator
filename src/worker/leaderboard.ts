/**
 * Leaderboard queries. PLAN.md §11.5.
 *
 * SEMANTICS, stated once so nobody has to guess:
 *   balanceCents      the user's MAIN account balance — settled cash, with
 *                     pending stakes ALREADY deducted. Never a subtotal, and
 *                     never touched by the filter (see below)
 *   pendingStakeCents Σ stake of pending bets STAKED AGAINST THAT SAME MAIN
 *                     BALANCE ("exposure"). Also unfiltered by `?league=`
 *   equityCents       balanceCents + pendingStakeCents
 *
 * BOTH HALVES OF EQUITY ARE SCOPED TO THE **MAIN** BALANCE, and they have to be.
 * `bankrolls` models balances as a list so side pots (`kind='custom'`) can exist
 * later; v1 never writes one, but `bets.bankroll_id` already points at whichever
 * balance was charged. An exposure figure summed over EVERY balance would add a
 * stake that was never deducted from `balanceCents`, so `equityCents` would
 * count that money twice and the ranked column would be wrong the day a second
 * pot exists. `record` and `roi` are deliberately NOT scoped that way: they are
 * performance statistics over everything the user bet, not a money column, and
 * no identity depends on them.
 *   record            settled bets only; cancelled bets are excluded entirely
 *   roi               (Σ payout − Σ stake) over bets with status ∈ {won, lost};
 *                     push and void are excluded from BOTH sides; null when the
 *                     denominator is 0
 *   RANKED BY equityCents DESC, then roi DESC, then username ASC
 *
 * THE FILTER IS `?league=all|nfl|ncaaf` AND NARROWS `record` AND `roi` ONLY
 * (M5b). Money is account-level now — there is one pot, not one per league per
 * season — so "NFL balance" is not a quantity that exists anywhere in the
 * ledger, and publishing one would mean ranking on a number no reconciliation
 * could check. The tabs answer "who is best at college football", and everyone's
 * money is the same column under all three of them.
 *
 * THERE IS NO SEASON FILTER (decided 2026-09-14, PLAN.md §19 Q5). A season is
 * not a thing the product has: balances never roll over, so "the 2026
 * leaderboard" would be a slice of a number that was never reset. `bets.season`
 * survives as an internal label for ingestion and the board's week default.
 *
 * `league` matches `bets.league` exactly, so a cross-league (`'mixed'`) bet
 * counts under `all` and under neither single league. A mixed bet is not an NFL
 * bet; splitting one across two records would double-count its stake in the ROI
 * denominator.
 *
 * WHO IS ON THE BOARD: enabled, non-deleted accounts only (`users.is_disabled = 0
 * AND users.deleted_at IS NULL`). The board is the scoreboard of people who are
 * PLAYING; a throwaway test account or a disabled one is neither competing nor
 * able to respond to being beaten, and leaving it ranked was the whole bug this
 * filter fixes. It is a JOIN condition on the row-producing query, so the
 * excluded user's bets never reach an accumulator either — their stakes and ROI
 * do not leak into anybody else's numbers. Nothing is deleted and no money moves:
 * re-enabling an account puts it straight back on the board with the same
 * balance. The admin list (`GET /api/admin/users`) still shows everyone.
 */

import type { BettingRecord, LeaderboardResponse, LeaderboardRow } from '../shared/api-types.js';
import type { League } from '../shared/types.js';
import type { Env } from './env.js';
import { statsFilterClauses } from './bankroll.js';
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
 * Ranked rows. Sorting: **EQUITY** DESC, then ROI DESC, then username ASC.
 *
 * EQUITY, NOT BALANCE (decided 2026-09-14, PLAN.md §19 Q2). `balanceCents`
 * excludes stakes that are still in flight, so ranking on it puts someone
 * holding $2,000 with $1,500 riding on tonight's game BELOW someone sitting on
 * $600 — which is not what "who is winning" means to anyone playing. Equity is
 * what the account is worth if every open bet were voided, so a bet neither
 * helps nor hurts your position until it settles. Both numbers are in the row;
 * only the sort key changed.
 *
 * A null ROI ("no settled action") sorts below every real ROI at the same
 * equity; with two nulls the username decides, so the order is total and
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
    if (a.equityCents !== b.equityCents) return b.equityCents - a.equityCents;
    const ra = a.roi ?? Number.NEGATIVE_INFINITY;
    const rb = b.roi ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
  });
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export interface LeaderboardFilter {
  /** `'all'` means "every bet"; a league narrows `record`/`roi` only. */
  readonly league: League | 'all';
}

/**
 * The one leaderboard query. `league: 'all'` is what used to be
 * `/api/leaderboard/all-time`, and it is now the DEFAULT view rather than a
 * separate endpoint — with one balance per account there is no "sum across
 * bankrolls" left to do, so the two shapes had collapsed into each other.
 */
export async function leaderboardFor(
  env: Env,
  filter: LeaderboardFilter,
): Promise<LeaderboardResponse> {
  const values: unknown[] = [];
  const extra = statsFilterClauses(
    filter.league === 'all' ? {} : { league: filter.league },
    values,
  );
  const [users, stats, pending] = await Promise.all([
    queryAll<BalanceRow>(
      env.DB.prepare(
        `SELECT bk.user_id AS user_id, u.username AS username, u.display_name AS display_name,
                bk.balance_cents AS balance_cents
           FROM bankrolls bk JOIN users u ON u.id = bk.user_id
          WHERE bk.kind = 'main' AND u.is_disabled = 0 AND u.deleted_at IS NULL`,
      ),
    ),
    queryAll<StatRow>(
      env.DB.prepare(
        `SELECT b.user_id AS user_id, b.status AS status, COUNT(*) AS n,
                COALESCE(SUM(b.stake_cents), 0) AS stake,
                COALESCE(SUM(b.payout_cents), 0) AS payout
           FROM bets b
          WHERE b.status IN ('won','lost','push','void')${extra}
          GROUP BY b.user_id, b.status`,
      ).bind(...values),
    ),
    // Exposure is deliberately NOT narrowed by `?league=`:
    // `equityCents = balanceCents + pendingStakeCents` has to stay true under
    // every tab, and `balanceCents` is never filtered.
    //
    // It IS narrowed to the MAIN balance, by the same join the balance row uses.
    // `balanceCents` above is `bk.kind = 'main'` only, so a stake charged to a
    // future `kind='custom'` side pot was never deducted from it — adding that
    // stake here would count the money twice and inflate the ranked column.
    queryAll<StatRow>(
      env.DB.prepare(
        `SELECT b.user_id AS user_id, 'pending' AS status, COUNT(*) AS n,
                COALESCE(SUM(b.stake_cents), 0) AS stake, 0 AS payout
           FROM bets b
           JOIN bankrolls bk ON bk.id = b.bankroll_id AND bk.kind = 'main'
          WHERE b.status = 'pending'
          GROUP BY b.user_id`,
      ),
    ),
  ]);
  return {
    league: filter.league,
    rows: rank(users, accumulate(users, [...stats, ...pending])),
  };
}

function accumulate(
  users: readonly BalanceRow[],
  stats: readonly StatRow[],
): ReadonlyMap<string, Accumulator> {
  const accumulators = new Map<string, Accumulator>();
  for (const user of users) accumulators.set(user.user_id, emptyAccumulator(user.balance_cents));
  for (const stat of stats) {
    const acc = accumulators.get(stat.user_id);
    // A bet whose user has no main balance is impossible (it is created at
    // signup and `bets.bankroll_id` is a FK), but skipping is the safe read.
    if (acc !== undefined) applyStat(acc, stat);
  }
  return accumulators;
}
