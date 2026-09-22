/**
 * Turning an existing `BetView` back into slip legs for "Edit bet".
 *
 * A bet leg's stored price and line are a PLACEMENT-TIME snapshot. Seeding the
 * edit slip from them meant the sheet quoted odds that may be hours old and,
 * worse, resubmitted them as `expected` — so a stake-only edit was answered
 * `409 LINE_CHANGED` for any leg whose line had moved, on a screen still
 * showing the old number. The edit therefore re-reads each leg's game
 * (`GET /api/games/:id`, PLAN.md §11.3) and seeds from the CURRENT quote; the
 * snapshot is only the fallback for a market that is no longer posted, which
 * the server will reject on its own terms.
 *
 * Pure: the caller does the fetching and hands the games in. DOM-free and
 * React-free so `tests/web/edit-bet.spec.ts` runs in the node project.
 */

import { pickLabel } from '../lib/labels.js';
import { quoteFor } from '../lib/lines.js';
import type { SlipLeg } from './slip-reducer.js';
import type { BetView, GameCard } from '../../shared/api-types.js';
import { distinctGameIds } from '../../shared/validate.js';

export interface RefreshedEdit {
  readonly legs: readonly SlipLeg[];
  /**
   * Games whose current quote could not be read (not returned, or the market is
   * no longer posted). Those legs kept their placement snapshot, and the server
   * will answer `409 MARKET_UNAVAILABLE` if the edit is submitted as-is.
   */
  readonly unrefreshed: readonly string[];
}

/** Rebuild a bet's legs at today's prices. `games` is keyed by `gameId`. */
export function refreshSlipLegs(bet: BetView, games: ReadonlyMap<string, GameCard>): RefreshedEdit {
  const unrefreshed: string[] = [];

  const legs = bet.legs.map((leg): SlipLeg => {
    const game = games.get(leg.gameId);
    const quote = game === undefined ? null : quoteFor(game.lines, leg.market, leg.side);
    const homeAbbr = game?.home.abbr ?? leg.homeAbbr;
    const awayAbbr = game?.away.abbr ?? leg.awayAbbr;
    const kickoffAt = game?.kickoffAt ?? leg.game.kickoffAt;

    if (quote === null) {
      unrefreshed.push(leg.gameId);
      // THE BOOK LINE, NOT THE STORED ONE. On a teaser leg `lineTenths` is the
      // TEASED number; seeding the slip with it and letting the server tease it
      // again would move the line twice. `originalLineTenths` is exactly the
      // pre-tease value, and it is null on every other kind of leg.
      const bookLine =
        leg.market === 'moneyline' ? null : (leg.originalLineTenths ?? leg.lineTenths);
      return {
        gameId: leg.gameId,
        // The LEG's league, not the bet's: `bet.league` may be `'mixed'` since
        // M5b, and a slip leg is always in exactly one real league.
        league: leg.league,
        market: leg.market,
        side: leg.side,
        lineTenths: bookLine,
        americanPrice: leg.americanPrice,
        label: pickLabel(leg.market, leg.side, bookLine, homeAbbr, awayAbbr),
        kickoffAt,
        homeAbbr,
        awayAbbr,
      };
    }

    const lineTenths = leg.market === 'moneyline' ? null : quote.lineTenths;
    return {
      gameId: leg.gameId,
      league: leg.league,
      market: leg.market,
      side: leg.side,
      lineTenths,
      americanPrice: quote.americanPrice,
      label: pickLabel(leg.market, leg.side, lineTenths, homeAbbr, awayAbbr),
      kickoffAt,
      homeAbbr,
      awayAbbr,
    };
  });

  return { legs, unrefreshed };
}

/** The distinct game ids an edit has to re-read, in leg order. */
export function gameIdsToRefresh(bet: BetView): readonly string[] {
  return distinctGameIds(bet.legs);
}
