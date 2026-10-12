/**
 * The All / NFL / NCAAF / MLB switch shared by My Bets, a player's page and
 * the leaderboard ("stats by sport", 2026-10-11).
 *
 * `'all'` is every bet. A league narrows BOTH the bet list and the statistics
 * (record, ROI, profit, settled count) to bets whose `bets.league` is exactly
 * that league, which is the one rule the server has (PLAN.md §11.5): a
 * cross-sport parlay is `'mixed'` and appears under All only. The money —
 * balance, exposure, equity, net — is the whole account under every scope,
 * because there is no such thing as an NFL balance.
 *
 * Pure and DOM-free (tests/web/scope.spec.ts).
 */
import { LEAGUE_LABEL } from './labels.js';
import type { League } from '../../shared/types.js';

export type Scope = League | 'all';

export interface ScopeOption {
  readonly value: Scope;
  readonly label: string;
}

/** All first, then the leagues in the order `/api/config` lists them. */
export function scopeOptions(leagues: readonly League[]): readonly ScopeOption[] {
  return [
    { value: 'all', label: 'All' },
    ...leagues.map((league) => ({ value: league, label: LEAGUE_LABEL[league] })),
  ];
}

/** The `?league=` value for a scope: absent for `'all'`. */
export function scopeLeague(scope: Scope): League | undefined {
  return scope === 'all' ? undefined : scope;
}

/** The noun for headings: "all sports" or the league's label. */
export function scopeLabel(scope: Scope): string {
  return scope === 'all' ? 'all sports' : LEAGUE_LABEL[scope];
}

/**
 * The empty-state title for a bet list. `who` is the player's display name on
 * another player's page, or null on My Bets.
 */
export function betsEmptyTitle(
  filter: 'open' | 'settled',
  scope: Scope,
  who: string | null,
): string {
  const sport = scope === 'all' ? '' : `${LEAGUE_LABEL[scope]} `;
  if (filter === 'open') {
    return who === null ? `No open ${sport}bets.` : `${who} has no open ${sport}bets.`;
  }
  if (scope === 'all') {
    return who === null ? 'Nothing settled yet.' : `${who} has nothing settled yet.`;
  }
  return who === null ? `No settled ${sport}bets yet.` : `${who} has no settled ${sport}bets yet.`;
}
