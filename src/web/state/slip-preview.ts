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
  americanToPrice,
  exceedsPayoutCap,
  formatDecimalOdds,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
  profitCents,
} from '../../shared/odds.js';
import { validatePlaceBet } from '../../shared/validate.js';
import { messageForCode } from '../api/messages.js';
import { pickLabel } from '../lib/labels.js';
import type { Slip, SlipLeg } from './slip-reducer.js';
import type { LineChangedDetails, PlaceBetRequest } from '../../shared/api-types.js';
import type { AmericanPrice, BetLeague, Cents, Price } from '../../shared/types.js';

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

/**
 * The league LABEL for a slip: the legs' one league, or `'mixed'` when they span
 * both. Mirrors the server's `betLeagueOf` so the advisory field the client
 * sends is the same value the server will derive and store.
 *
 * An empty slip reports `'nfl'` purely so the body is a legal shape; a slip with
 * no legs fails `validatePlaceBet` on `legs` long before `league` matters.
 */
export function slipLeague(legs: readonly SlipLeg[]): BetLeague {
  const first = legs[0]?.league;
  if (first === undefined) return 'nfl';
  return legs.every((leg) => leg.league === first) ? first : 'mixed';
}

/**
 * The wire body for the current slip. `expected` is the §11.4 optimistic check.
 *
 * `league` is ADVISORY (PLAN.md §11.4): the server derives the bet's league from
 * the legs' own game rows and never compares it. It is sent anyway, correctly
 * computed, so a reader of the request log sees what the client believed.
 */
export function buildPlaceBetRequest(slip: Slip, acceptLineChange: boolean): PlaceBetRequest {
  return {
    league: slipLeague(slip.legs),
    betType: slip.mode,
    stakeCents: slip.stakeCents,
    acceptLineChange,
    // Tenths, and only on a teaser — the server rejects it on anything else.
    // Sent AS STORED: the server is the authority on which tiers exist
    // (`isTeaserPoints`), and a client-side narrowing here once silently
    // turned every non-classic tier into a 6-point bet.
    ...(slip.mode === 'teaser' ? { teaserPoints: slip.teaserPointsTenths } : {}),
    legs: slip.legs.map((leg) => ({
      gameId: leg.gameId,
      market: leg.market,
      side: leg.side,
      // The BOOK's line and price, even in teaser mode. `expected` is an
      // optimistic check against what the BOARD showed; the tease is applied by
      // the server afterwards, so sending the teased number would make every
      // teaser a false LINE_CHANGED.
      expected: {
        americanPrice: leg.americanPrice,
        lineTenths: leg.market === 'moneyline' ? null : leg.lineTenths,
      },
    })),
  };
}

/**
 * The price a slip is quoting, as an exact rational.
 *
 * A TEASER IS PRICED FROM THE SERVER'S CARD, not from the legs: `config.
 * teaserPayouts` is echoed by `GET /api/config` precisely so the slip and the
 * server cannot disagree. A cell the server did not send yields `null`, which
 * renders as "—" rather than as a number this client invented.
 */
function slipPrice(slip: Slip, card: TeaserCard | null): Price | null {
  if (slip.mode !== 'teaser') return priceFromLegs(slip.legs.map((leg) => leg.americanPrice));
  const american = card?.[slip.teaserPointsTenths]?.[slip.legs.length];
  if (american === undefined) return null;
  try {
    return americanToPrice(american);
  } catch {
    return null;
  }
}

/** `ConfigResponse['teaserPayouts']`, named so the signatures stay readable. */
type TeaserCard = Readonly<Record<number, Readonly<Record<number, AmericanPrice>>>>;

/**
 * The price to SHOW, or null when there is nothing honest to show. `null` means
 * either "no price yet" or "past what an American integer can express" — the
 * latter only for an absurd parlay, which the payout cap rejects anyway.
 */
function displayAmerican(price: Price | null): AmericanPrice | null {
  if (price === null) return null;
  try {
    return priceToAmerican(price);
  } catch {
    return null;
  }
}

export function computePreview(
  slip: Slip,
  availableCents: Cents | null,
  teaserPayouts: TeaserCard | null = null,
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

  const price = slipPrice(slip, teaserPayouts);
  const decimalOdds = price === null ? null : formatDecimalOdds(price);
  const americanPrice = displayAmerican(price);

  const validation = validatePlaceBet(buildPlaceBetRequest(slip, false));
  if (!validation.ok) {
    return { americanPrice, decimalOdds, toWinCents: 0, payoutCents: 0, error: validation.message };
  }
  if (price === null) {
    return {
      americanPrice,
      decimalOdds,
      toWinCents: 0,
      payoutCents: 0,
      error: 'That teaser is not priced right now — reload and try again.',
    };
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

/**
 * Can "accept the new line" even be offered? Only if the server still quotes
 * EVERY changed leg. A `current: null` means the market was pulled, and
 * resubmitting with `acceptLineChange` would just earn a 409 MARKET_UNAVAILABLE.
 */
export function lineChangeIsAcceptable(details: LineChangedDetails): boolean {
  return details.legs.length > 0 && details.legs.every((leg) => leg.current !== null);
}

/**
 * Rewrite the slip's legs to the prices the server just quoted back in a 409
 * LINE_CHANGED.
 *
 * This is what makes "Accept new line & place" honest. Without it the retry
 * resubmitted the STALE `expected` alongside `acceptLineChange: true`: the bet
 * went through at a price the slip never showed, and the summary went on
 * quoting the old one. The legs are re-priced first — which re-prices the
 * preview the user is looking at — and the resubmitted `expected` is then the
 * value the server itself reported.
 */
export function applyLineChange(slip: Slip, details: LineChangedDetails): Slip {
  const byKey = new Map(
    details.legs.map((leg) => [`${leg.gameId}|${leg.market}|${leg.side}`, leg.current]),
  );
  const legs = slip.legs.map((leg) => {
    const current = byKey.get(`${leg.gameId}|${leg.market}|${leg.side}`);
    // `undefined`: the server did not flag this leg. `null`: the market is gone,
    // and there is no new price to move to — leave it for the user to remove.
    if (current === undefined || current === null) return leg;
    if (current.americanPrice === leg.americanPrice && current.lineTenths === leg.lineTenths) {
      return leg;
    }
    const lineTenths = leg.market === 'moneyline' ? null : current.lineTenths;
    return {
      ...leg,
      lineTenths,
      americanPrice: current.americanPrice,
      label: pickLabel(leg.market, leg.side, lineTenths, leg.homeAbbr, leg.awayAbbr),
    };
  });
  // Identity in, identity out when nothing moved: the preview is memoised on
  // the slip object, and a gratuitously new one would re-price for no reason.
  return legs.some((leg, index) => leg !== slip.legs[index]) ? { ...slip, legs } : slip;
}
