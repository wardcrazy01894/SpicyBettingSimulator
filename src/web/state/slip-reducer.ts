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
  /**
   * The two abbreviations `label` was built from, so the label can be REBUILT
   * when the line moves under the slip (accepting a 409 LINE_CHANGED rewrites
   * `lineTenths`, and "MIA -3.5" must not keep saying -3.5 afterwards).
   */
  readonly homeAbbr: string;
  readonly awayAbbr: string;
}

export type SlipMode = 'straight' | 'parlay' | 'teaser';

export interface LeagueSlip {
  readonly mode: SlipMode;
  readonly legs: readonly SlipLeg[];
  readonly stakeCents: number;
  /**
   * The teaser tier in TENTHS (60/65/70). Carried on every slip, not only a
   * teaser one, so switching Parlay → Teaser → Parlay remembers the selector
   * instead of snapping back to 6 points each time.
   */
  readonly teaserPointsTenths: number;
}

/** The draft slip that `START_EDIT` displaced, kept so `END_EDIT` can put it back. */
export interface EditBackup {
  readonly league: League;
  readonly slip: LeagueSlip;
}

export interface SlipState {
  readonly active: League;
  readonly byLeague: Readonly<Record<League, LeagueSlip>>;
  /** Set while editing an existing bet; `submit` then PUTs instead of POSTing. */
  readonly editingBetId: string | null;
  /**
   * Editing a bet used to OVERWRITE whatever the user was building. The edit now
   * borrows the league's slot and this holds the displaced draft; ending the
   * edit — cancelled or submitted — restores it. Nothing the user typed is lost.
   */
  readonly editBackup: EditBackup | null;
  /**
   * One line of transient feedback for an action that deliberately did nothing,
   * e.g. tapping a price when the parlay is already at `maxParlayLegs`. Cleared
   * by the next action.
   */
  readonly notice: string | null;
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
  | { readonly type: 'SET_TEASER_POINTS'; readonly pointsTenths: number }
  | { readonly type: 'SET_STAKE'; readonly stakeCents: number }
  /** Re-price the legs in place, e.g. after accepting a 409 LINE_CHANGED. */
  | { readonly type: 'SET_LEGS'; readonly league: League; readonly legs: readonly SlipLeg[] }
  | { readonly type: 'CLEAR' }
  | {
      readonly type: 'START_EDIT';
      readonly betId: string;
      readonly league: League;
      readonly mode: SlipMode;
      readonly legs: readonly SlipLeg[];
      readonly stakeCents: number;
      /** Present when the bet being edited is a teaser. */
      readonly teaserPointsTenths?: number;
    }
  /** Leave edit mode (cancelled OR submitted) and restore the displaced draft. */
  | { readonly type: 'END_EDIT' }
  | { readonly type: 'DISMISS_NOTICE' }
  | { readonly type: 'HYDRATE'; readonly league: League; readonly slip: LeagueSlip };

/** The default tier, in tenths: 6 points. Mirrors TEASER_POINTS_TENTHS[0]. */
export const DEFAULT_TEASER_POINTS_TENTHS = 60;

export const EMPTY_SLIP: LeagueSlip = {
  mode: 'straight',
  legs: [],
  stakeCents: 0,
  teaserPointsTenths: DEFAULT_TEASER_POINTS_TENTHS,
};

export function emptySlipState(active: League): SlipState {
  const byLeague = Object.fromEntries(LEAGUES.map((l) => [l, EMPTY_SLIP])) as Record<
    League,
    LeagueSlip
  >;
  return { active, byLeague, editingBetId: null, editBackup: null, notice: null };
}

/** The copy shown when a tap is refused because the parlay is full. */
export function parlayFullNotice(maxLegs: number): string {
  return `A parlay can hold at most ${String(maxLegs)} legs — remove one first.`;
}

export function legKey(leg: Pick<SlipLeg, 'gameId' | 'market' | 'side'>): string {
  return `${leg.gameId}|${leg.market}|${leg.side}`;
}

/**
 * `localStorage` key. Per league, so switching tabs does not lose the other slip.
 *
 * v2 because `SlipLeg` gained `homeAbbr`/`awayAbbr`; a v1 entry has no way to
 * relabel a leg after the line moves, so it is abandoned rather than migrated.
 */
export function slipStorageKey(league: League): string {
  return `sbs.slip.v2.${league}`;
}

/**
 * A slip with ≤1 leg IS a straight and one with 2+ legs is a MULTI — that is what
 * `validatePlaceBet` enforces — so the mode follows the leg count after any
 * structural change instead of letting the user hold an unsubmittable slip.
 *
 * Which multi it is stays the USER'S choice: adding a third leg to a teaser
 * leaves it a teaser. Only `straight` is overridden upward, because there is no
 * such thing as a two-leg straight; and everything is forced back to `straight`
 * below two legs, because there is no one-leg parlay OR teaser.
 */
function modeFor(legs: readonly SlipLeg[], current: SlipMode): SlipMode {
  if (legs.length <= 1) return 'straight';
  return current === 'straight' ? 'parlay' : current;
}

/** Every structural write also clears the transient notice. */
function withSlip(state: SlipState, league: League, slip: LeagueSlip): SlipState {
  return { ...state, notice: null, byLeague: { ...state.byLeague, [league]: slip } };
}

/** Put the displaced draft back and leave edit mode. A no-op when not editing. */
function endEdit(state: SlipState): SlipState {
  const backup = state.editBackup;
  if (backup === null) {
    return state.editingBetId === null ? state : { ...state, editingBetId: null, notice: null };
  }
  return {
    ...state,
    byLeague: { ...state.byLeague, [backup.league]: backup.slip },
    editingBetId: null,
    editBackup: null,
    notice: null,
  };
}

export function slipReducer(state: SlipState, action: SlipAction): SlipState {
  switch (action.type) {
    case 'SET_LEAGUE':
      return state.active === action.league
        ? state
        : { ...state, active: action.league, notice: null };

    case 'TOGGLE_LEG': {
      const league = action.leg.league;
      const slip = state.byLeague[league];
      const key = legKey(action.leg);
      if (slip.legs.some((l) => legKey(l) === key)) {
        const legs = slip.legs.filter((l) => legKey(l) !== key);
        return {
          ...withSlip(state, league, { ...slip, legs, mode: modeFor(legs, slip.mode) }),
          active: league,
        };
      }
      // A parlay may never carry two legs on the same game (correlated-parlay
      // guard; the DB also has UNIQUE(bet_id, game_id)), so picking a second
      // market on a game you already have REPLACES the existing pick.
      const others = slip.legs.filter((l) => l.gameId !== action.leg.gameId);
      if (others.length >= action.maxLegs) {
        // Full. Change NOTHING — no new arrays, no re-render churn — and say so
        // out loud; this used to be a silent no-op that looked like a dead tap.
        return { ...state, active: league, notice: parlayFullNotice(action.maxLegs) };
      }
      const legs = [...others, action.leg];
      return {
        ...withSlip(state, league, { ...slip, legs, mode: modeFor(legs, slip.mode) }),
        active: league,
      };
    }

    case 'REMOVE_LEG': {
      const slip = state.byLeague[state.active];
      const key = legKey(action);
      const legs = slip.legs.filter((l) => legKey(l) !== key);
      return withSlip(state, state.active, { ...slip, legs, mode: modeFor(legs, slip.mode) });
    }

    case 'SET_MODE': {
      const slip = state.byLeague[state.active];
      // A multi below two legs is not a bet anyone can place, and persisting one
      // resurrected an unsubmittable slip on the next reload.
      const mode = action.mode !== 'straight' && slip.legs.length < 2 ? 'straight' : action.mode;
      return withSlip(state, state.active, { ...slip, mode });
    }

    case 'SET_TEASER_POINTS': {
      const slip = state.byLeague[state.active];
      return withSlip(state, state.active, { ...slip, teaserPointsTenths: action.pointsTenths });
    }

    case 'SET_STAKE': {
      const slip = state.byLeague[state.active];
      return withSlip(state, state.active, { ...slip, stakeCents: action.stakeCents });
    }

    case 'SET_LEGS': {
      const slip = state.byLeague[action.league];
      return withSlip(state, action.league, {
        ...slip,
        legs: action.legs,
        mode: modeFor(action.legs, slip.mode),
      });
    }

    case 'CLEAR':
      return {
        ...withSlip(state, state.active, EMPTY_SLIP),
        editingBetId: null,
        editBackup: null,
      };

    case 'START_EDIT': {
      // Starting a second edit ends the first one first, so the backup always
      // holds the user's own draft rather than another bet's legs.
      const base = endEdit(state);
      return {
        ...withSlip(base, action.league, {
          mode: action.mode,
          legs: action.legs,
          stakeCents: action.stakeCents,
          // A non-teaser edit keeps whatever tier the displaced draft had, so
          // cancelling the edit restores a slip that looks exactly as it did.
          teaserPointsTenths:
            action.teaserPointsTenths ?? base.byLeague[action.league].teaserPointsTenths,
        }),
        active: action.league,
        editingBetId: action.betId,
        editBackup: { league: action.league, slip: base.byLeague[action.league] },
      };
    }

    case 'END_EDIT':
      return endEdit(state);

    case 'DISMISS_NOTICE':
      return state.notice === null ? state : { ...state, notice: null };

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
  const { gameId, market, side, lineTenths, americanPrice, label, kickoffAt, homeAbbr, awayAbbr } =
    raw;
  if (typeof gameId !== 'string' || gameId === '') return null;
  if (typeof homeAbbr !== 'string' || typeof awayAbbr !== 'string') return null;
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
    homeAbbr,
    awayAbbr,
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
  const points = parsed['teaserPointsTenths'];
  if (mode !== 'straight' && mode !== 'parlay' && mode !== 'teaser') return null;
  if (typeof stake !== 'number' || !Number.isSafeInteger(stake) || stake < 0) return null;
  if (!Array.isArray(rawLegs)) return null;
  // A v2 entry (pre-teaser) has no tier at all; that is not corruption, so it
  // takes the default rather than throwing the whole slip away.
  const teaserPointsTenths =
    points === undefined
      ? DEFAULT_TEASER_POINTS_TENTHS
      : points === 60 || points === 65 || points === 70
        ? points
        : null;
  if (teaserPointsTenths === null) return null;
  const legs: SlipLeg[] = [];
  for (const rawLeg of rawLegs) {
    const leg = parseLeg(rawLeg, league);
    if (leg === null) return null;
    legs.push(leg);
  }
  // Normalise on the way IN, not just on the way out: a slip persisted as a
  // one-leg "parlay" (the mode toggle used to allow it) is not placeable, and
  // rehydrating it put the user back in front of an unsubmittable slip. The
  // stored `mode` is still VALIDATED above; it is just not authoritative.
  return { mode: modeFor(legs, mode), legs, stakeCents: stake, teaserPointsTenths };
}

export function serialiseSlip(slip: LeagueSlip): string {
  return JSON.stringify({
    mode: slip.mode,
    stakeCents: slip.stakeCents,
    teaserPointsTenths: slip.teaserPointsTenths,
    legs: slip.legs.map((l) => ({
      gameId: l.gameId,
      market: l.market,
      side: l.side,
      lineTenths: l.lineTenths,
      americanPrice: l.americanPrice,
      label: l.label,
      kickoffAt: l.kickoffAt,
      homeAbbr: l.homeAbbr,
      awayAbbr: l.awayAbbr,
    })),
  });
}
