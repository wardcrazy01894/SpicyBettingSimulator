/**
 * Provider adapter boundary. PLAN.md §2.4.
 *
 * `ingest.ts` talks ONLY to these interfaces, never to ESPN directly, so a paid
 * odds feed (The Odds API) can be dropped in later as a new implementation.
 * v1 ships exactly one implementation: `EspnProvider` in ./espn.ts.
 */

import type { Game, GameLines, League } from '../shared/types.js';
import type { ParseWarning } from '../shared/espn.js';

/**
 * One unit of work == one upstream HTTP request. Mirrors `ingest_targets`.
 *
 * v1 uses `date` for BOTH leagues. A week-keyed target cannot distinguish
 * regular-season week 1 from Wild Card week 1 without also carrying seasontype,
 * and a date target needs no knowledge of the league calendar at all -- which is
 * what makes bowls and the NFL postseason reachable for free. See PLAN.md §8.2.
 *
 * `week` is kept in the union (and in the DB CHECK) so a later optimisation does
 * not need a schema migration; nothing constructs one in v1.
 */
export type SlateTarget =
  | {
      readonly kind: 'week';
      readonly season: number;
      readonly seasonType: number;
      readonly week: number;
    }
  | { readonly kind: 'date'; readonly dateKey: string };

export interface ProviderSlate {
  readonly games: readonly Game[];
  readonly lines: readonly GameLines[];
  readonly warnings: readonly ParseWarning[];
  readonly fetchedAt: number;
  readonly season: number | null;
  readonly week: number | null;
}

/** Scores + schedule + status. */
export interface ScoreProvider {
  readonly name: string;
  fetchSlate(league: League, target: SlateTarget): Promise<ProviderSlate>;
}

/**
 * Current betting lines. ESPN satisfies both interfaces from one response; a
 * dedicated odds feed would implement only this one and be composed with a
 * ScoreProvider.
 */
export interface OddsProvider {
  readonly name: string;
  fetchLines(
    league: League,
    target: SlateTarget,
  ): Promise<{
    readonly lines: readonly GameLines[];
    readonly warnings: readonly ParseWarning[];
    readonly fetchedAt: number;
  }>;
}

/** Thrown by a provider on a non-2xx, a timeout, or unparseable JSON. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, retryable: boolean, status: number | null) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.status = status;
  }
}
