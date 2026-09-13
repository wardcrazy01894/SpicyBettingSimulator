/**
 * Bet slip state. Persisted to localStorage per league so a refresh does not
 * lose the slip.
 *
 * Validation reuses the SAME pure functions as the Worker
 * (src/shared/validate.ts) — the client copy exists only to grey out an invalid
 * slip; the server always re-validates and is the only authority.
 */

import type { ReactElement, ReactNode } from 'react';

import type { AmericanPrice, League, LineTenths, Market, Side } from '../../shared/types.js';

export interface SlipLeg {
  readonly gameId: string;
  readonly league: League;
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly americanPrice: AmericanPrice;
  readonly label: string;
  readonly kickoffAt: number;
}

export interface BetSlipState {
  readonly mode: 'straight' | 'parlay';
  readonly legs: readonly SlipLeg[];
  readonly stakeCents: number;
}

export interface BetSlipApi extends BetSlipState {
  toggleLeg(leg: SlipLeg): void;
  removeLeg(gameId: string, market: Market, side: Side): void;
  clear(): void;
  setMode(mode: 'straight' | 'parlay'): void;
  setStakeCents(cents: number): void;
  /** Local-only preview; the server recomputes from its own snapshot. */
  readonly preview: {
    readonly americanPrice: AmericanPrice | null;
    readonly toWinCents: number;
    readonly payoutCents: number;
    readonly error: string | null;
  };
  submit(acceptLineChange: boolean): Promise<void>;
}

export function BetSlipProvider(_props: { children: ReactNode }): ReactElement {
  throw new Error('not implemented: M7b');
}

export function useBetSlip(): BetSlipApi {
  throw new Error('not implemented: M7b');
}
