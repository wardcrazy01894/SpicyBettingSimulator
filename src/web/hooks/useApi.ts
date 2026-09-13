/**
 * Thin `useResource` bindings, one per screen's data need.
 *
 * The cache KEY PREFIXES are the contract for `invalidate()` after a mutation:
 *   bets:…  bankroll:…  leaderboard:…  games:…  ledger:…  admin:…
 * A bet placement invalidates the first three; nothing else may share a prefix.
 */

import {
  getAdminJobs,
  getAdminUsers,
  getAllTimeLeaderboard,
  getBankroll,
  getBets,
  getGames,
  getHealth,
  getLeaderboard,
  getLedger,
} from '../api/client.js';
import { useResource } from './useResource.js';
import type { Resource } from './useResource.js';
import type {
  AdminUsersResponse,
  BankrollResponse,
  BetsResponse,
  GamesResponse,
  HealthResponse,
  JobRunsResponse,
  LeaderboardResponse,
  LedgerResponse,
} from '../../shared/api-types.js';
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

export function useBets(status: 'open' | 'settled' | 'all'): Resource<BetsResponse> {
  return useResource(`bets:${status}`, () => getBets({ status }));
}

export function useBankroll(league: League, season: number | null): Resource<BankrollResponse> {
  // A null season means the server has not opened this league's season yet;
  // there is no bankroll to ask for, so the hook stays idle rather than 400ing.
  const key = season === null ? null : `bankroll:${league}:${String(season)}`;
  return useResource(key, () => getBankroll(league, season));
}

export function useLedger(league: League, season: number | null): Resource<LedgerResponse> {
  const key = `ledger:${league}:${String(season ?? '')}`;
  return useResource(key, () => getLedger({ league, season, limit: 100 }));
}

export function useLeaderboard(
  scope: League | 'all',
  season: number | null,
): Resource<LeaderboardResponse> {
  const key = `leaderboard:${scope}:${String(season ?? '')}`;
  return useResource(key, () =>
    scope === 'all' ? getAllTimeLeaderboard() : getLeaderboard(scope, season),
  );
}

export function useAdminJobs(): Resource<JobRunsResponse> {
  return useResource('admin:jobs', getAdminJobs);
}

export function useAdminUsers(): Resource<AdminUsersResponse> {
  return useResource('admin:users', getAdminUsers);
}
