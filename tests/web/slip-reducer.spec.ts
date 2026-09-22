import { describe, expect, it } from 'vitest';
import { TEASER_POINTS_TENTHS } from '../../src/shared/constants.js';

import {
  DEFAULT_TEASER_POINTS_TENTHS,
  EMPTY_SLIP,
  emptySlipState,
  legKey,
  parseStoredSlip,
  serialiseSlip,
  SLIP_STORAGE_KEY,
  slipReducer,
  staleSlipKeys,
} from '../../src/web/state/slip-reducer.js';
import type { SlipLeg, SlipState } from '../../src/web/state/slip-reducer.js';
import type { League, Market, Side } from '../../src/shared/types.js';

const MAX_LEGS = 10;

function leg(
  gameId: string,
  market: Market = 'spread',
  side: Side = 'home',
  league: League = 'nfl',
): SlipLeg {
  return {
    gameId,
    league,
    market,
    side,
    lineTenths: market === 'moneyline' ? null : -35,
    americanPrice: -110,
    label: `${gameId} ${market} ${side}`,
    kickoffAt: 1_800_000_000_000,
    homeAbbr: 'HOME',
    awayAbbr: 'AWAY',
  };
}

function start(): SlipState {
  return emptySlipState('nfl');
}

/** The ONE slip (M5b). Kept as a helper so the assertions below stay short. */
function active(state: SlipState) {
  return state.slip;
}

describe('slipReducer', () => {
  it('starts with ONE empty slip and a board league', () => {
    const state = start();
    expect(state.slip).toEqual(EMPTY_SLIP);
    expect(state.board).toBe('nfl');
    expect(state.editingBetId).toBeNull();
  });

  it('adds a leg and toggles the SAME pick back off', () => {
    const one = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(active(one).legs).toHaveLength(1);
    const none = slipReducer(one, { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(active(none).legs).toHaveLength(0);
  });

  // Same-game parlays (M11): a game may hold ONE side pick (spread OR
  // moneyline) and ONE total. A tap on the OTHER slot adds; a tap on an
  // occupied slot replaces what was there, which is what the old
  // one-leg-per-game rule did for every tap.
  it('ADDS a total to a game whose spread is already in the slip — a same-game parlay', () => {
    let state = slipReducer(start(), {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'spread', 'home'),
      maxLegs: MAX_LEGS,
    });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'total', 'over'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs.map((l) => l.market)).toEqual(['spread', 'total']);
    expect(active(state).mode).toBe('parlay');
  });

  it('REPLACES the other side of the same market, and a moneyline with a spread', () => {
    let state = slipReducer(start(), {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'spread', 'home'),
      maxLegs: MAX_LEGS,
    });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'spread', 'away'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs).toHaveLength(1);
    expect(active(state).legs[0]?.side).toBe('away');
    // A spread and a moneyline on one game are the SAME slot: correlated.
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'moneyline', 'home'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs).toHaveLength(1);
    expect(active(state).legs[0]?.market).toBe('moneyline');
    // ...and the total slot is untouched by any of that.
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'total', 'under'),
      maxLegs: MAX_LEGS,
    });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'spread', 'home'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs.map((l) => `${l.market}:${l.side}`)).toEqual([
      'total:under',
      'spread:home',
    ]);
  });

  it('counts a replaced slot as free when the slip is full, and a new slot as not', () => {
    let state = start();
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g1', 'spread'), maxLegs: 2 });
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g2', 'spread'), maxLegs: 2 });
    // Full. The other side of g1's spread swaps in...
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'spread', 'away'),
      maxLegs: 2,
    });
    expect(active(state).legs).toHaveLength(2);
    expect(active(state).legs.find((l) => l.gameId === 'g1')?.side).toBe('away');
    expect(state.notice).toBeNull();
    // ...but g1's total would be a THIRD leg, and is refused with the notice.
    const refused = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('g1', 'total', 'over'),
      maxLegs: 2,
    });
    expect(active(refused).legs).toBe(active(state).legs);
    expect(refused.notice).not.toBeNull();
  });

  it('follows the leg count into and out of parlay mode', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(active(state).mode).toBe('straight');
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g2'), maxLegs: MAX_LEGS });
    expect(active(state).mode).toBe('parlay');
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g2'), maxLegs: MAX_LEGS });
    expect(active(state).mode).toBe('straight');
  });

  it('refuses to grow past maxLegs', () => {
    let state = start();
    for (let i = 0; i < 5; i += 1) {
      state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg(`g${String(i)}`), maxLegs: 3 });
    }
    expect(active(state).legs).toHaveLength(3);
  });

  it('holds NFL and NCAAF legs in the SAME slip — the point of M5b', () => {
    // "Tease Michigan and the Steelers together" is one slip with two leagues in
    // it, not two slips you have to choose between.
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('nfl1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('cfb1', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs.map((l) => l.league)).toEqual(['nfl', 'ncaaf']);
    expect(active(state).mode).toBe('parlay');
    // Adding a college leg did NOT drag the board to the college tab.
    expect(state.board).toBe('nfl');
  });

  it('SET_BOARD moves the board and touches NOTHING else', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('nfl1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'SET_STAKE', stakeCents: 2500 });
    const before = state.slip;
    const moved = slipReducer(state, { type: 'SET_BOARD', league: 'ncaaf' });
    expect(moved.board).toBe('ncaaf');
    // Identity, not just equality: switching tabs allocates no new slip at all.
    expect(moved.slip).toBe(before);
    expect(slipReducer(moved, { type: 'SET_BOARD', league: 'ncaaf' })).toBe(moved);
  });

  it('REMOVE_LEG drops exactly one pick', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g2'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'REMOVE_LEG',
      gameId: 'g1',
      market: 'spread',
      side: 'home',
    });
    expect(active(state).legs.map((l) => l.gameId)).toEqual(['g2']);
  });

  it('CLEAR wipes the whole slip, both leagues, and ends an edit', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('c1', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    expect(active(state).legs).toHaveLength(2);
    state = slipReducer(state, { type: 'CLEAR' });
    expect(active(state)).toEqual(EMPTY_SLIP);
    expect(state.editingBetId).toBeNull();
  });

  it('START_EDIT loads the bet without moving the board', () => {
    const state = slipReducer(start(), {
      type: 'START_EDIT',
      betId: 'bet-1',
      mode: 'parlay',
      legs: [leg('a', 'spread', 'home', 'ncaaf'), leg('b', 'total', 'over', 'ncaaf')],
      stakeCents: 2500,
    });
    expect(state.editingBetId).toBe('bet-1');
    expect(state.board).toBe('nfl');
    expect(active(state).stakeCents).toBe(2500);
    expect(active(state).legs).toHaveLength(2);
  });

  it('SET_STAKE and SET_MODE apply to the one slip', () => {
    // Two legs, because SET_MODE now refuses to call a slip with fewer than two
    // a "parlay" — that mode was unplaceable and used to be persisted anyway.
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('a'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('b'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'SET_STAKE', stakeCents: 5000 });
    state = slipReducer(state, { type: 'SET_MODE', mode: 'parlay' });
    expect(state.slip).toMatchObject({ stakeCents: 5000, mode: 'parlay' });
  });

  it('SET_MODE refuses "parlay" and "teaser" below two legs', () => {
    expect(slipReducer(start(), { type: 'SET_MODE', mode: 'parlay' }).slip.mode).toBe('straight');
    expect(slipReducer(start(), { type: 'SET_MODE', mode: 'teaser' }).slip.mode).toBe('straight');
  });

  it('a teaser STAYS a teaser as legs are added and removed', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('a'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('b'), maxLegs: MAX_LEGS });
    state = slipReducer(state, { type: 'SET_MODE', mode: 'teaser' });
    expect(state.slip.mode).toBe('teaser');
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('c', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    // A third leg, from the OTHER league, and it is still a teaser.
    expect(state.slip.mode).toBe('teaser');
    expect(state.slip.legs).toHaveLength(3);
    // ...but dropping to one leg forces `straight`, which is the only placeable
    // shape at that size.
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('b'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('c', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    expect(state.slip.mode).toBe('straight');
  });

  it('never mutates the state it is given', () => {
    const before = start();
    const snapshot = JSON.stringify(before);
    slipReducer(before, { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('legKey', () => {
  it('distinguishes market and side on the same game', () => {
    expect(legKey({ gameId: 'g', market: 'spread', side: 'home' })).not.toBe(
      legKey({ gameId: 'g', market: 'spread', side: 'away' }),
    );
    expect(legKey({ gameId: 'g', market: 'total', side: 'over' })).not.toBe(
      legKey({ gameId: 'g', market: 'moneyline', side: 'home' }),
    );
  });
});

describe('storage keys', () => {
  it('is ONE versioned slot, not one per league', () => {
    expect(SLIP_STORAGE_KEY).toMatch(/\.v\d+$/);
    expect(SLIP_STORAGE_KEY).toContain('v3');
    // v3: the shape went from two per-league drafts to one cross-league slip.
    expect(SLIP_STORAGE_KEY).not.toContain('nfl');
    expect(SLIP_STORAGE_KEY).not.toContain('ncaaf');
  });

  it('names the abandoned per-league keys so they can be swept up', () => {
    const stale = staleSlipKeys();
    // Both leagues, both old versions — and never the live key, or a hydrate
    // would delete the slip it just read.
    expect(stale).toContain('sbs.slip.v2.nfl');
    expect(stale).toContain('sbs.slip.v2.ncaaf');
    expect(stale).toContain('sbs.slip.v1.nfl');
    expect(stale).not.toContain(SLIP_STORAGE_KEY);
  });
});

describe('persistence', () => {
  it('round-trips a slip', () => {
    const slip = {
      mode: 'parlay' as const,
      legs: [leg('g1'), leg('g2', 'total', 'over')],
      stakeCents: 1234,
      teaserPointsTenths: DEFAULT_TEASER_POINTS_TENTHS,
    };
    const parsed = parseStoredSlip(serialiseSlip(slip));
    expect(parsed).toEqual(slip);
  });

  it('returns null for missing, malformed or foreign data instead of throwing', () => {
    expect(parseStoredSlip(null)).toBeNull();
    expect(parseStoredSlip('not json')).toBeNull();
    expect(parseStoredSlip('[]')).toBeNull();
    expect(parseStoredSlip('{"mode":"round-robin","legs":[],"stakeCents":0}')).toBeNull();
    expect(parseStoredSlip('{"mode":"straight","legs":[],"stakeCents":-1}')).toBeNull();
    expect(parseStoredSlip('{"mode":"straight","legs":[{"gameId":""}],"stakeCents":0}')).toBeNull();
    // A tier that is not on the card is NOT corruption of the draft: the legs
    // and stake survive and the tier takes the default (a card can shrink).
    expect(
      parseStoredSlip('{"mode":"straight","legs":[],"stakeCents":0,"teaserPointsTenths":61}')
        ?.teaserPointsTenths,
    ).toBe(DEFAULT_TEASER_POINTS_TENTHS);
  });

  it("'teaser' is a legal stored mode now, and a v2 entry without a tier gets the default", () => {
    // A pre-M5b entry has no `teaserPointsTenths` at all; throwing the whole
    // slip away for that would lose a draft for no reason.
    const legacy = parseStoredSlip('{"mode":"straight","legs":[],"stakeCents":250}');
    expect(legacy?.teaserPointsTenths).toBe(DEFAULT_TEASER_POINTS_TENTHS);
    expect(legacy?.stakeCents).toBe(250);
    // ...and every tier on the card round-trips.
    for (const tenths of TEASER_POINTS_TENTHS) {
      const raw = serialiseSlip({
        mode: 'teaser',
        legs: [leg('g1'), leg('g2', 'total', 'over')],
        stakeCents: 500,
        teaserPointsTenths: tenths,
      });
      const parsed = parseStoredSlip(raw);
      expect(parsed?.mode).toBe('teaser');
      expect(parsed?.teaserPointsTenths).toBe(tenths);
    }
    // A tier that is not on the card keeps the draft and takes the default.
    const offCard = parseStoredSlip(
      '{"mode":"teaser","legs":[],"stakeCents":250,"teaserPointsTenths":95}',
    );
    expect(offCard?.teaserPointsTenths).toBe(DEFAULT_TEASER_POINTS_TENTHS);
    expect(offCard?.stakeCents).toBe(250);
    // A ONE-leg "teaser" is not placeable and is normalised back to a straight,
    // exactly as a one-leg "parlay" already was.
    const single = serialiseSlip({
      mode: 'teaser',
      legs: [leg('g1')],
      stakeCents: 500,
      teaserPointsTenths: 60,
    });
    expect(parseStoredSlip(single)?.mode).toBe('straight');
  });

  it('round-trips a same-game slip, and rejects a stored slip with two legs in one slot', () => {
    const sgp = serialiseSlip({
      mode: 'parlay',
      stakeCents: 100,
      legs: [leg('g1', 'spread', 'home'), leg('g1', 'total', 'over')],
      teaserPointsTenths: 60,
    });
    expect(parseStoredSlip(sgp)?.legs).toHaveLength(2);
    // Two side picks on one game (here a spread and a moneyline) can only come
    // from a hand-edited entry, and would be refused by the server anyway.
    const corrupt = JSON.stringify({
      mode: 'parlay',
      stakeCents: 100,
      legs: [leg('g1', 'spread', 'home'), leg('g1', 'moneyline', 'away')],
      teaserPointsTenths: 60,
    });
    expect(parseStoredSlip(corrupt)).toBeNull();
  });

  it('rejects a hand-edited price that is not a safe integer', () => {
    const raw = JSON.stringify({
      mode: 'straight',
      stakeCents: 100,
      legs: [{ ...leg('g1'), americanPrice: 1.5 }],
    });
    expect(parseStoredSlip(raw)).toBeNull();
  });

  it("keeps each leg's OWN league across a round trip, both in one slip", () => {
    // The league used to be re-stamped from the per-league storage key. With one
    // shared slot there is no key to stamp from, so it is PART OF THE ENTRY —
    // and a cross-league draft has to survive a reload intact.
    const raw = serialiseSlip({
      mode: 'parlay',
      legs: [leg('g1', 'spread', 'home', 'nfl'), leg('g2', 'total', 'over', 'ncaaf')],
      stakeCents: 100,
      teaserPointsTenths: DEFAULT_TEASER_POINTS_TENTHS,
    });
    expect(parseStoredSlip(raw)?.legs.map((l) => l.league)).toEqual(['nfl', 'ncaaf']);
  });

  it('rejects a stored leg whose league is missing or not a real one', () => {
    const withLeague = (league: unknown): string =>
      JSON.stringify({
        mode: 'straight',
        stakeCents: 100,
        legs: [{ ...leg('g1'), league }],
      });
    expect(parseStoredSlip(withLeague(undefined))).toBeNull();
    expect(parseStoredSlip(withLeague('nba'))).toBeNull();
    expect(parseStoredSlip(withLeague(7))).toBeNull();
    expect(parseStoredSlip(withLeague('nfl'))?.legs[0]?.league).toBe('nfl');
  });
});
