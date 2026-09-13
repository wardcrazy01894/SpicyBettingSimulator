/**
 * The bet slip's pure reducer, its storage key and its (de)serialisation.
 *
 * Pure and DOM-free so `tests/web/slip-reducer.spec.ts` can exercise it in the
 * node vitest project; `BetSlipProvider` owns the `localStorage` side effects.
 */

import { LEAGUES } from '../../shared/types.js';
import type { AmericanPrice, League, LineTenths, Market, Side } from '../../shared/types.js';

export interface SlipLeg {
  readonly gameId: string;
  readonly league: League;
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly americanPrice: AmericanPrice;
  /** Pre-rendered pick text, e.g. "MIA -3.5". Kept so the slip survives a reload. */
  readonly label: string;
  readonly kickoffAt: number;
}

export type SlipMode = 'straight' | 'parlay';

export interface LeagueSlip {
  readonly mode: SlipMode;
  readonly legs: readonly SlipLeg[];
  readonly stakeCents: number;
}

export interface SlipState {
  readonly active: League;
  readonly byLeague: Readonly<Record<League, LeagueSlip>>;
  /** Set while editing an existing bet; `submit` then PUTs instead of POSTing. */
  readonly editingBetId: string | null;
}

export type SlipAction =
  | { readonly type: 'SET_LEAGUE'; readonly league: League }
  | { readonly type: 'TOGGLE_LEG'; readonly leg: SlipLeg; readonly maxLegs: number }
  | {
      readonly type: 'REMOVE_LEG';
      readonly gameId: string;
      readonly market: Market;
      readonly side: Side;
    }
  | { readonly type: 'SET_MODE'; readonly mode: SlipMode }
  | { readonly type: 'SET_STAKE'; readonly stakeCents: number }
  | { readonly type: 'CLEAR' }
  | {
      readonly type: 'START_EDIT';
      readonly betId: string;
      readonly league: League;
      readonly mode: SlipMode;
      readonly legs: readonly SlipLeg[];
      readonly stakeCents: number;
    }
  | { readonly type: 'HYDRATE'; readonly league: League; readonly slip: LeagueSlip };

export const EMPTY_SLIP: LeagueSlip = { mode: 'straight', legs: [], stakeCents: 0 };

export function emptySlipState(active: League): SlipState {
  const byLeague = Object.fromEntries(LEAGUES.map((l) => [l, EMPTY_SLIP])) as Record<
    League,
    LeagueSlip
  >;
  return { active, byLeague, editingBetId: null };
}

export function legKey(leg: Pick<SlipLeg, 'gameId' | 'market' | 'side'>): string {
  return `${leg.gameId}|${leg.market}|${leg.side}`;
}

/** `localStorage` key. Per league, so switching tabs does not lose the other slip. */
export function slipStorageKey(league: League): string {
  return `sbs.slip.v1.${league}`;
}

/**
 * A slip with 2+ legs IS a parlay and one with ≤1 leg IS a straight — that is
 * what `validatePlaceBet` enforces — so the mode follows the leg count after any
 * structural change instead of letting the user hold an unsubmittable slip.
 */
function modeFor(legs: readonly SlipLeg[]): SlipMode {
  return legs.length > 1 ? 'parlay' : 'straight';
}

function withSlip(state: SlipState, league: League, slip: LeagueSlip): SlipState {
  return { ...state, byLeague: { ...state.byLeague, [league]: slip } };
}

export function slipReducer(state: SlipState, action: SlipAction): SlipState {
  switch (action.type) {
    case 'SET_LEAGUE':
      return state.active === action.league ? state : { ...state, active: action.league };

    case 'TOGGLE_LEG': {
      const league = action.leg.league;
      const slip = state.byLeague[league];
      const key = legKey(action.leg);
      const already = slip.legs.some((l) => legKey(l) === key);
      let legs: readonly SlipLeg[];
      if (already) {
        legs = slip.legs.filter((l) => legKey(l) !== key);
      } else {
        // A parlay may never carry two legs on the same game (correlated-parlay
        // guard; the DB also has UNIQUE(bet_id, game_id)), so picking a second
        // market on a game you already have REPLACES the existing pick.
        const others = slip.legs.filter((l) => l.gameId !== action.leg.gameId);
        legs = others.length >= action.maxLegs ? [...others] : [...others, action.leg];
      }
      const next = { ...slip, legs, mode: modeFor(legs) };
      return { ...withSlip(state, league, next), active: league };
    }

    case 'REMOVE_LEG': {
      const slip = state.byLeague[state.active];
      const key = legKey(action);
      const legs = slip.legs.filter((l) => legKey(l) !== key);
      return withSlip(state, state.active, { ...slip, legs, mode: modeFor(legs) });
    }

    case 'SET_MODE': {
      const slip = state.byLeague[state.active];
      return withSlip(state, state.active, { ...slip, mode: action.mode });
    }

    case 'SET_STAKE': {
      const slip = state.byLeague[state.active];
      return withSlip(state, state.active, { ...slip, stakeCents: action.stakeCents });
    }

    case 'CLEAR':
      return { ...withSlip(state, state.active, EMPTY_SLIP), editingBetId: null };

    case 'START_EDIT':
      return {
        ...withSlip(state, action.league, {
          mode: action.mode,
          legs: action.legs,
          stakeCents: action.stakeCents,
        }),
        active: action.league,
        editingBetId: action.betId,
      };

    case 'HYDRATE':
      return withSlip(state, action.league, action.slip);
  }
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const MARKETS: readonly Market[] = ['moneyline', 'spread', 'total'];
const SIDES: readonly Side[] = ['home', 'away', 'over', 'under'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseLeg(raw: unknown, league: League): SlipLeg | null {
  if (!isRecord(raw)) return null;
  const { gameId, market, side, lineTenths, americanPrice, label, kickoffAt } = raw;
  if (typeof gameId !== 'string' || gameId === '') return null;
  if (typeof market !== 'string' || !(MARKETS as readonly string[]).includes(market)) return null;
  if (typeof side !== 'string' || !(SIDES as readonly string[]).includes(side)) return null;
  if (typeof americanPrice !== 'number' || !Number.isSafeInteger(americanPrice)) return null;
  if (
    lineTenths !== null &&
    (typeof lineTenths !== 'number' || !Number.isSafeInteger(lineTenths))
  ) {
    return null;
  }
  if (typeof label !== 'string') return null;
  if (typeof kickoffAt !== 'number' || !Number.isFinite(kickoffAt)) return null;
  return {
    gameId,
    league,
    market: market as Market,
    side: side as Side,
    lineTenths,
    americanPrice,
    label,
    kickoffAt,
  };
}

/**
 * Parse a persisted slip. Anything malformed (an old schema, a hand-edited
 * value) yields `null` and the caller starts empty — a corrupt localStorage
 * entry must never be able to crash the board.
 */
export function parseStoredSlip(raw: string | null, league: League): LeagueSlip | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const mode = parsed['mode'];
  const stake = parsed['stakeCents'];
  const rawLegs = parsed['legs'];
  if (mode !== 'straight' && mode !== 'parlay') return null;
  if (typeof stake !== 'number' || !Number.isSafeInteger(stake) || stake < 0) return null;
  if (!Array.isArray(rawLegs)) return null;
  const legs: SlipLeg[] = [];
  for (const rawLeg of rawLegs) {
    const leg = parseLeg(rawLeg, league);
    if (leg === null) return null;
    legs.push(leg);
  }
  return { mode: modeFor(legs) === 'parlay' ? 'parlay' : mode, legs, stakeCents: stake };
}

export function serialiseSlip(slip: LeagueSlip): string {
  return JSON.stringify({
    mode: slip.mode,
    stakeCents: slip.stakeCents,
    legs: slip.legs.map((l) => ({
      gameId: l.gameId,
      market: l.market,
      side: l.side,
      lineTenths: l.lineTenths,
      americanPrice: l.americanPrice,
      label: l.label,
      kickoffAt: l.kickoffAt,
    })),
  });
}
