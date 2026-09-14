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
  /** The teaser tier in TENTHS (60/65/70). Meaningful only in teaser mode. */
  readonly teaserPointsTenths: number;
}

export interface BetSlipApi extends BetSlipState {
  /**
   * Which league the BOARD is showing. NOT a property of the slip: there is ONE
   * cross-league slip (M5b), and switching tabs to find a college game to add to
   * an NFL slip must never disturb it.
   */
  readonly boardLeague: League;
  readonly setBoardLeague: (league: League) => void;
  readonly toggleLeg: (leg: SlipLeg) => void;
  readonly removeLeg: (gameId: string, market: Market, side: Side) => void;
  readonly clear: () => void;
  readonly setMode: (mode: SlipMode) => void;
  readonly setTeaserPoints: (pointsTenths: number) => void;
  readonly setStakeCents: (cents: Cents) => void;
  readonly isSelected: (gameId: string, market: Market, side: Side) => boolean;
  readonly preview: SlipPreview;

  /** Transient feedback for an action that deliberately did nothing (parlay full). */
  readonly notice: string | null;
  readonly dismissNotice: () => void;

  /** Sheet visibility. The collapsed `BetSlipBar` opens it on mobile. */
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;

  /** The ACCOUNT balance the slip will be staked against; null while unknown. */
  readonly availableCents: Cents | null;

  readonly submitting: boolean;
  readonly lastError: unknown;
  /** Set by a 409 LINE_CHANGED; the sheet shows old vs new and an accept button. */
  readonly lineChange: LineChangedDetails | null;
  /** False when a changed leg is no longer quoted at all — accepting is pointless. */
  readonly canAcceptLineChange: boolean;
  readonly editingBetId: string | null;
  readonly startEdit: (
    betId: string,
    mode: SlipMode,
    legs: readonly SlipLeg[],
    stakeCents: Cents,
    /** Tenths, when the bet being edited is a teaser. */
    teaserPointsTenths?: number,
  ) => void;
  readonly cancelEdit: () => void;
  /** Place (or PUT) the slip exactly as it is shown. */
  readonly submit: () => Promise<void>;
  /**
   * Re-price the slip to the server's quoted `current` values and resubmit with
   * `acceptLineChange: true`. Never resubmits the stale `expected`.
   */
  readonly acceptLineChange: () => Promise<void>;
}

export const BetSlipContext = createContext<BetSlipApi | null>(null);

export function useBetSlip(): BetSlipApi {
  const value = useContext(BetSlipContext);
  if (value === null) throw new Error('useBetSlip must be used inside <BetSlipProvider>');
  return value;
}
