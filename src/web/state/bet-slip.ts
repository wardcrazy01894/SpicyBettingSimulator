/**
 * Bet slip context object and consumer hook. PLAN.md §12.2.
 *
 * Split from `BetSlipContext.tsx` so that file exports only a component
 * (`react-refresh/only-export-components`). The slip's ARITHMETIC lives one
 * level further out, in `slip-preview.ts`, so it can be unit-tested without
 * React or the DOM.
 */

import { createContext, useContext } from 'react';

import type { SlipPreview } from './slip-preview.js';
import type { SlipLeg, SlipMode } from './slip-reducer.js';
import type { LineChangedDetails } from '../../shared/api-types.js';
import type { Cents, League, Market, Side } from '../../shared/types.js';

export interface BetSlipState {
  readonly mode: SlipMode;
  readonly legs: readonly SlipLeg[];
  readonly stakeCents: Cents;
}

export interface BetSlipApi extends BetSlipState {
  readonly league: League;
  readonly setLeague: (league: League) => void;
  readonly toggleLeg: (leg: SlipLeg) => void;
  readonly removeLeg: (gameId: string, market: Market, side: Side) => void;
  readonly clear: () => void;
  readonly setMode: (mode: SlipMode) => void;
  readonly setStakeCents: (cents: Cents) => void;
  readonly isSelected: (gameId: string, market: Market, side: Side) => boolean;
  readonly preview: SlipPreview;

  /** Sheet visibility. The collapsed `BetSlipBar` opens it on mobile. */
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;

  /** Bankroll available for the active (league, season); null while unknown. */
  readonly availableCents: Cents | null;

  readonly submitting: boolean;
  readonly lastError: unknown;
  /** Set by a 409 LINE_CHANGED; the sheet shows old vs new and an accept button. */
  readonly lineChange: LineChangedDetails | null;
  readonly editingBetId: string | null;
  readonly startEdit: (
    betId: string,
    league: League,
    mode: SlipMode,
    legs: readonly SlipLeg[],
    stakeCents: Cents,
  ) => void;
  readonly cancelEdit: () => void;
  readonly submit: (acceptLineChange: boolean) => Promise<void>;
}

export const BetSlipContext = createContext<BetSlipApi | null>(null);

export function useBetSlip(): BetSlipApi {
  const value = useContext(BetSlipContext);
  if (value === null) throw new Error('useBetSlip must be used inside <BetSlipProvider>');
  return value;
}
