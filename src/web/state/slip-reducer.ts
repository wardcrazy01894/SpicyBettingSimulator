/**
 * The bet slip's pure reducer, its storage key and its (de)serialisation.
 *
 * ONE SLIP, NOT ONE PER LEAGUE (M5b). The slip used to be a
 * `Record<League, LeagueSlip>` with the league tab selecting which one you were
 * looking at, because a bet belonged to exactly one `(league, season)` bankroll
 * and a cross-league parlay was a 409. Neither is true any more: there is one
 * account balance, and the server derives `bets.league` from the legs
 * (`'mixed'` when they span both). So there is ONE draft, legs may come from
 * either league, and **the league tabs move the BOARD only** — they never touch
 * the slip. Teasing Michigan and the Steelers together is the point.
 *
 * Pure and DOM-free so `tests/web/slip-reducer.spec.ts` can exercise it in the
 * node vitest project; `BetSlipProvider` owns the `localStorage` side effects.
 */

import { LEAGUES } from '../../shared/types.js';
import type { AmericanPrice, League, LineTenths, Market, Side } from '../../shared/types.js';

export interface SlipLeg {
  readonly gameId: string;
  /** The leg's OWN league. A slip may hold legs from both. */
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

export interface Slip {
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

export interface SlipState {
  /**
   * Which league the BOARD is showing. A view setting, NOT a property of the
   * slip: changing it must never add, remove or hide a leg.
   */
  readonly board: League;
  readonly slip: Slip;
  /** Set while editing an existing bet; `submit` then PUTs instead of POSTing. */
  readonly editingBetId: string | null;
  /**
   * Editing a bet would otherwise OVERWRITE whatever the user was building. The
   * edit takes over the one slip and this holds the displaced draft; ending the
   * edit — cancelled or submitted — restores it. Nothing the user typed is lost.
   */
  readonly editBackup: Slip | null;
  /**
   * One line of transient feedback for an action that deliberately did nothing,
   * e.g. tapping a price when the parlay is already at `maxParlayLegs`. Cleared
   * by the next action.
   */
  readonly notice: string | null;
}

export type SlipAction =
  /** Move the BOARD to another league. The slip is untouched. */
  | { readonly type: 'SET_BOARD'; readonly league: League }
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
  | { readonly type: 'SET_LEGS'; readonly legs: readonly SlipLeg[] }
  | { readonly type: 'CLEAR' }
  | {
      readonly type: 'START_EDIT';
      readonly betId: string;
      readonly mode: SlipMode;
      readonly legs: readonly SlipLeg[];
      readonly stakeCents: number;
      /** Present when the bet being edited is a teaser. */
      readonly teaserPointsTenths?: number;
    }
  /** Leave edit mode (cancelled OR submitted) and restore the displaced draft. */
  | { readonly type: 'END_EDIT' }
  | { readonly type: 'DISMISS_NOTICE' }
  | { readonly type: 'HYDRATE'; readonly slip: Slip };

/** The default tier, in tenths: 6 points. Mirrors TEASER_POINTS_TENTHS[0]. */
export const DEFAULT_TEASER_POINTS_TENTHS = 60;

export const EMPTY_SLIP: Slip = {
  mode: 'straight',
  legs: [],
  stakeCents: 0,
  teaserPointsTenths: DEFAULT_TEASER_POINTS_TENTHS,
};

export function emptySlipState(board: League): SlipState {
  return { board, slip: EMPTY_SLIP, editingBetId: null, editBackup: null, notice: null };
}

/** The copy shown when a tap is refused because the parlay is full. */
export function parlayFullNotice(maxLegs: number): string {
  return `A parlay can hold at most ${String(maxLegs)} legs — remove one first.`;
}

export function legKey(leg: Pick<SlipLeg, 'gameId' | 'market' | 'side'>): string {
  return `${leg.gameId}|${leg.market}|${leg.side}`;
}

/**
 * `localStorage` key. ONE slot, not one per league.
 *
 * v3 because the shape changed from per-league to a single cross-league draft.
 * A v2 entry cannot be migrated honestly — there were two of them and they may
 * hold conflicting modes, stakes and same-game picks — so `staleSlipKeys()`
 * lists the old keys for the provider to delete rather than leaving two dead
 * entries in every user's browser forever.
 */
export const SLIP_STORAGE_KEY = 'sbs.slip.v3';

/** The abandoned per-league v1/v2 keys, for one-time cleanup on hydrate. */
export function staleSlipKeys(): readonly string[] {
  return LEAGUES.flatMap((league) => [`sbs.slip.v1.${league}`, `sbs.slip.v2.${league}`]);
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
function withSlip(state: SlipState, slip: Slip): SlipState {
  return { ...state, notice: null, slip };
}

/** Put the displaced draft back and leave edit mode. A no-op when not editing. */
function endEdit(state: SlipState): SlipState {
  const backup = state.editBackup;
  if (backup === null) {
    return state.editingBetId === null ? state : { ...state, editingBetId: null, notice: null };
  }
  return { ...state, slip: backup, editingBetId: null, editBackup: null, notice: null };
}

export function slipReducer(state: SlipState, action: SlipAction): SlipState {
  switch (action.type) {
    case 'SET_BOARD':
      // Deliberately touches NOTHING but `board`. Switching tabs to find a
      // college game to add to an NFL slip is the whole cross-league flow.
      return state.board === action.league
        ? state
        : { ...state, board: action.league, notice: null };

    case 'TOGGLE_LEG': {
      const { slip } = state;
      const key = legKey(action.leg);
      if (slip.legs.some((l) => legKey(l) === key)) {
        const legs = slip.legs.filter((l) => legKey(l) !== key);
        return withSlip(state, { ...slip, legs, mode: modeFor(legs, slip.mode) });
      }
      // A parlay may never carry two legs on the same game (correlated-parlay
      // guard; the DB also has UNIQUE(bet_id, game_id)), so picking a second
      // market on a game you already have REPLACES the existing pick.
      const others = slip.legs.filter((l) => l.gameId !== action.leg.gameId);
      if (others.length >= action.maxLegs) {
        // Full. Change NOTHING — no new arrays, no re-render churn — and say so
        // out loud; this used to be a silent no-op that looked like a dead tap.
        return { ...state, notice: parlayFullNotice(action.maxLegs) };
      }
      const legs = [...others, action.leg];
      return withSlip(state, { ...slip, legs, mode: modeFor(legs, slip.mode) });
    }

    case 'REMOVE_LEG': {
      const { slip } = state;
      const key = legKey(action);
      const legs = slip.legs.filter((l) => legKey(l) !== key);
      return withSlip(state, { ...slip, legs, mode: modeFor(legs, slip.mode) });
    }

    case 'SET_MODE': {
      const { slip } = state;
      // A multi below two legs is not a bet anyone can place, and persisting one
      // resurrected an unsubmittable slip on the next reload.
      const mode = action.mode !== 'straight' && slip.legs.length < 2 ? 'straight' : action.mode;
      return withSlip(state, { ...slip, mode });
    }

    case 'SET_TEASER_POINTS':
      return withSlip(state, { ...state.slip, teaserPointsTenths: action.pointsTenths });

    case 'SET_STAKE':
      return withSlip(state, { ...state.slip, stakeCents: action.stakeCents });

    case 'SET_LEGS':
      return withSlip(state, {
        ...state.slip,
        legs: action.legs,
        mode: modeFor(action.legs, state.slip.mode),
      });

    case 'CLEAR':
      return { ...withSlip(state, EMPTY_SLIP), editingBetId: null, editBackup: null };

    case 'START_EDIT': {
      // Starting a second edit ends the first one first, so the backup always
      // holds the user's own draft rather than another bet's legs.
      const base = endEdit(state);
      return {
        ...withSlip(base, {
          mode: modeFor(action.legs, action.mode),
          legs: action.legs,
          stakeCents: action.stakeCents,
          // A non-teaser edit keeps whatever tier the displaced draft had, so
          // cancelling the edit restores a slip that looks exactly as it did.
          teaserPointsTenths: action.teaserPointsTenths ?? base.slip.teaserPointsTenths,
        }),
        editingBetId: action.betId,
        editBackup: base.slip,
      };
    }

    case 'END_EDIT':
      return endEdit(state);

    case 'DISMISS_NOTICE':
      return state.notice === null ? state : { ...state, notice: null };

    case 'HYDRATE':
      return withSlip(state, action.slip);
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

function isLeague(v: unknown): v is League {
  return typeof v === 'string' && (LEAGUES as readonly string[]).includes(v);
}

/**
 * A persisted leg. `league` is now PART OF THE ENTRY rather than supplied by the
 * caller: with one shared slot there is no per-league key to re-stamp it from,
 * and a leg whose league were guessed would send an NFL game to the CFB board.
 * An entry without a legal one is corrupt and the whole slip is abandoned.
 */
function parseLeg(raw: unknown): SlipLeg | null {
  if (!isRecord(raw)) return null;
  const {
    gameId,
    league,
    market,
    side,
    lineTenths,
    americanPrice,
    label,
    kickoffAt,
    homeAbbr,
    awayAbbr,
  } = raw;
  if (typeof gameId !== 'string' || gameId === '') return null;
  if (!isLeague(league)) return null;
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
 * Parse the persisted slip. Anything malformed (an old schema, a hand-edited
 * value) yields `null` and the caller starts empty — a corrupt localStorage
 * entry must never be able to crash the board.
 */
export function parseStoredSlip(raw: string | null): Slip | null {
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
  // An entry written before teasers existed has no tier at all; that is not
  // corruption, so it takes the default rather than losing the whole slip.
  const teaserPointsTenths =
    points === undefined
      ? DEFAULT_TEASER_POINTS_TENTHS
      : points === 60 || points === 65 || points === 70
        ? points
        : null;
  if (teaserPointsTenths === null) return null;
  const legs: SlipLeg[] = [];
  const seen = new Set<string>();
  for (const rawLeg of rawLegs) {
    const leg = parseLeg(rawLeg);
    if (leg === null) return null;
    // The no-two-legs-from-one-game rule is a slip INVARIANT, so a hand-edited
    // entry that breaks it is corrupt rather than something to submit and have
    // the server reject.
    if (seen.has(leg.gameId)) return null;
    seen.add(leg.gameId);
    legs.push(leg);
  }
  // Normalise on the way IN, not just on the way out: a slip persisted as a
  // one-leg "parlay" (the mode toggle used to allow it) is not placeable, and
  // rehydrating it put the user back in front of an unsubmittable slip. The
  // stored `mode` is still VALIDATED above; it is just not authoritative.
  return { mode: modeFor(legs, mode), legs, stakeCents: stake, teaserPointsTenths };
}

export function serialiseSlip(slip: Slip): string {
  return JSON.stringify({
    mode: slip.mode,
    stakeCents: slip.stakeCents,
    teaserPointsTenths: slip.teaserPointsTenths,
    legs: slip.legs.map((l) => ({
      gameId: l.gameId,
      league: l.league,
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
