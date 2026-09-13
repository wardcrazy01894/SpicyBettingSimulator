/**
 * The slip's pure arithmetic: the wire body it would send, the live
 * price/to-win/payout, and the single reason the submit button is disabled.
 *
 * THE PREVIEW IS ADVISORY. It is computed with the SAME pure functions the
 * Worker uses (`validatePlaceBet`, `priceFromLegs`, `exceedsPayoutCap`,
 * `payoutCents`, `profitCents`) so the two agree to the cent, but the server
 * re-reads the line, re-prices the bet and is the only authority (CLAUDE.md §8).
 *
 * Kept free of React AND of `api/client.ts` (which touches `fetch`/`Response`)
 * so `tests/web/slip-preview.spec.ts` can run in the DOM-free node project.
 */

import {
  exceedsPayoutCap,
  formatDecimalOdds,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
  profitCents,
} from '../../shared/odds.js';
import { validatePlaceBet } from '../../shared/validate.js';
import { messageForCode } from '../api/messages.js';
import type { LeagueSlip } from './slip-reducer.js';
import type { LineChangedDetails, PlaceBetRequest } from '../../shared/api-types.js';
import type { AmericanPrice, Cents, League } from '../../shared/types.js';

export interface SlipPreview {
  /** null when there are no legs, or the parlay is too long to express. */
  readonly americanPrice: AmericanPrice | null;
  /** Exact decimal odds as a display string, e.g. "9.112". */
  readonly decimalOdds: string | null;
  readonly toWinCents: Cents;
  readonly payoutCents: Cents;
  /** Why the slip cannot be submitted, or null when it can. */
  readonly error: string | null;
}

/** The wire body for the current slip. `expected` is the §11.4 optimistic check. */
export function buildPlaceBetRequest(
  league: League,
  slip: LeagueSlip,
  acceptLineChange: boolean,
): PlaceBetRequest {
  return {
    league,
    betType: slip.mode,
    stakeCents: slip.stakeCents,
    acceptLineChange,
    legs: slip.legs.map((leg) => ({
      gameId: leg.gameId,
      market: leg.market,
      side: leg.side,
      expected: {
        americanPrice: leg.americanPrice,
        lineTenths: leg.market === 'moneyline' ? null : leg.lineTenths,
      },
    })),
  };
}

export function computePreview(
  league: League,
  slip: LeagueSlip,
  availableCents: Cents | null,
): SlipPreview {
  if (slip.legs.length === 0) {
    return {
      americanPrice: null,
      decimalOdds: null,
      toWinCents: 0,
      payoutCents: 0,
      error: 'Tap a price to start a bet.',
    };
  }

  const price = priceFromLegs(slip.legs.map((leg) => leg.americanPrice));
  const decimalOdds = formatDecimalOdds(price);
  let americanPrice: AmericanPrice | null;
  try {
    americanPrice = priceToAmerican(price);
  } catch {
    // Only reachable for an absurd parlay, which the cap check below rejects too.
    americanPrice = null;
  }

  const validation = validatePlaceBet(buildPlaceBetRequest(league, slip, false));
  if (!validation.ok) {
    return { americanPrice, decimalOdds, toWinCents: 0, payoutCents: 0, error: validation.message };
  }

  // Cap FIRST, in BigInt, before any Number conversion (PLAN.md §5.2b).
  if (exceedsPayoutCap(slip.stakeCents, price)) {
    return {
      americanPrice,
      decimalOdds,
      toWinCents: 0,
      payoutCents: 0,
      error: messageForCode('PAYOUT_LIMIT_EXCEEDED'),
    };
  }

  const payout = payoutCents(slip.stakeCents, price);
  const toWin = profitCents(slip.stakeCents, price);
  const insufficient = availableCents !== null && slip.stakeCents > availableCents;
  return {
    americanPrice,
    decimalOdds,
    toWinCents: toWin,
    payoutCents: payout,
    error: insufficient ? messageForCode('INSUFFICIENT_FUNDS') : null,
  };
}

/** Narrow a 409's `details` to `LineChangedDetails` without trusting the server blindly. */
export function asLineChangedDetails(details: unknown): LineChangedDetails | null {
  if (typeof details !== 'object' || details === null) return null;
  const legs: unknown = (details as { legs?: unknown }).legs;
  return Array.isArray(legs) ? (details as LineChangedDetails) : null;
}
