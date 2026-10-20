/**
 * Thin `useResource` bindings, one per screen's data need.
 *
 * The cache KEY PREFIXES are the contract for `invalidate()` after a mutation:
 *   bets:…  bankroll:…  leaderboard:…  games:…  ledger:…  admin:…
 * A bet placement invalidates the first three; nothing else may share a prefix.
 * `leaderboard:busts:<userId>` is a DELIBERATE sub-key of `leaderboard:`: a
 * bust history changes only when a refill or a buyout changes the board, and
 * both already invalidate `leaderboard:`, so it rides along rather than
 * needing a fourth prefix every mutation has to remember.
 */

import {
  getAdminBugReports,
  getAdminInvite,
  getAdminJobs,
  getAdminUsers,
  getBalances,
  getBets,
  getGames,
  getHealth,
  getLeaderboard,
  getLedger,
  getPlayerBets,
  getPlayerBusts,
} from '../api/client.js';
import { useResource } from './useResource.js';
import type { Resource } from './useResource.js';
import type {
  AdminBugReportsResponse,
  AdminInviteResponse,
  AdminUsersResponse,
  BankrollsResponse,
  BetsResponse,
  GamesResponse,
  HealthResponse,
  JobRunsResponse,
  LeaderboardResponse,
  LedgerResponse,
  PlayerBetsResponse,
  PlayerBustsResponse,
} from '../../shared/api-types.js';
import { scopeLeague } from '../lib/scope.js';
import type { Scope } from '../lib/scope.js';
import type { League } from '../../shared/types.js';

export function useHealth(): Resource<HealthResponse> {
  return useResource('health', getHealth);
}

export function useGames(
  league: League,
  season: number | null,
  week: number | null,
): Resource<GamesResponse> {
  const key = `games:${league}:${String(season ?? '')}:${String(week ?? '')}`;
  return useResource(key, () => getGames({ league, season, week }));
}

/** `scope` narrows the list to one sport (`?league=`); `'all'` is every bet. */
export function useBets(status: 'open' | 'settled' | 'all', scope: Scope): Resource<BetsResponse> {
  const league = scopeLeague(scope) ?? null;
  return useResource(`bets:${status}:${scope}`, () => getBets({ status, league }));
}

/**
 * Another player's bets. Under the `bets:` prefix on purpose: when YOU place or
 * cancel a bet, `invalidate('bets')` drops this too, so looking at your own
 * page never shows a list one bet behind My Bets. Everyone else's changes
 * arrive by the page's poll.
 */
export function usePlayerBets(
  userId: string,
  status: 'open' | 'settled' | 'all',
  scope: Scope,
): Resource<PlayerBetsResponse> {
  const league = scopeLeague(scope) ?? null;
  return useResource(`bets:player:${userId}:${status}:${scope}`, () =>
    getPlayerBets(userId, { status, league }),
  );
}

/** A player's bust history, keyed beside the leaderboard so a buyout invalidates both. */
export function usePlayerBusts(userId: string): Resource<PlayerBustsResponse> {
  return useResource(`leaderboard:busts:${userId}`, () => getPlayerBusts(userId));
}

/**
 * Every account balance the caller owns. There is no league or season in the
 * key: a balance is account-level (M5b), so the header, the slip and the account
 * page all read the SAME cache entry and stay in agreement for free.
 *
 * `enabled` is how an anonymous visitor stops asking for one. The slip provider
 * sits ABOVE the router's auth gate (PLAN.md §12.1), so on `/login` it was
 * firing `GET /api/bankroll`, collecting a 401 and tripping the client's
 * SESSION_EXPIRED side-channel before the user had even typed a password.
 */
export function useBalances(enabled = true): Resource<BankrollsResponse> {
  return useResource(enabled ? 'bankroll:all' : null, () => getBalances());
}

/**
 * The same balances with `record`/`roi`/`profitCents`/`settledCount` narrowed
 * to one sport (`?league=`). `'all'` IS `useBalances()` — the same cache key,
 * so My Bets' strip and the header badge never disagree — and a league gets
 * its own entry under the `bankroll:` prefix, which the post-placement
 * `invalidate('bankroll:')` already covers.
 */
export function useBalanceStats(scope: Scope): Resource<BankrollsResponse> {
  const league = scopeLeague(scope);
  return useResource(league === undefined ? 'bankroll:all' : `bankroll:league:${league}`, () =>
    getBalances(league === undefined ? {} : { league }),
  );
}

/** Page size asked for by both the ledger's first page and every "Load more". */
export const LEDGER_PAGE_SIZE = 100;

/** `bankrollId` null means "the main balance", which is what the server defaults to. */
export function useLedger(bankrollId: string | null): Resource<LedgerResponse> {
  const key = `ledger:${bankrollId ?? 'main'}`;
  return useResource(key, () => getLedger({ bankrollId, limit: LEDGER_PAGE_SIZE }));
}

export function useLeaderboard(scope: Scope): Resource<LeaderboardResponse> {
  return useResource(`leaderboard:${scope}`, () => getLeaderboard(scope));
}

export function useAdminJobs(): Resource<JobRunsResponse> {
  return useResource('admin:jobs', getAdminJobs);
}

export function useAdminUsers(): Resource<AdminUsersResponse> {
  return useResource('admin:users', getAdminUsers);
}

export function useAdminBugReports(): Resource<AdminBugReportsResponse> {
  return useResource('admin:bugs', getAdminBugReports);
}

export function useAdminInvite(): Resource<AdminInviteResponse> {
  return useResource('admin:invite', getAdminInvite);
}
