import { describe, expect, it } from 'vitest';

import {
  EMPTY_SLIP,
  emptySlipState,
  legKey,
  parseStoredSlip,
  serialiseSlip,
  slipReducer,
  slipStorageKey,
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
  };
}

function start(): SlipState {
  return emptySlipState('nfl');
}

function active(state: SlipState) {
  return state.byLeague[state.active];
}

describe('slipReducer', () => {
  it('starts empty for every league', () => {
    const state = start();
    expect(state.byLeague.nfl).toEqual(EMPTY_SLIP);
    expect(state.byLeague.ncaaf).toEqual(EMPTY_SLIP);
    expect(state.editingBetId).toBeNull();
  });

  it('adds a leg and toggles the SAME pick back off', () => {
    const one = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(active(one).legs).toHaveLength(1);
    const none = slipReducer(one, { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    expect(active(none).legs).toHaveLength(0);
  });

  it('REPLACES a pick on a game already in the slip — no same-game legs', () => {
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
    expect(active(state).legs).toHaveLength(1);
    expect(active(state).legs[0]?.market).toBe('total');
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

  it('keeps each league slip separate and follows the toggled leg to its league', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('nfl1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('cfb1', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    expect(state.active).toBe('ncaaf');
    expect(state.byLeague.nfl.legs).toHaveLength(1);
    expect(state.byLeague.ncaaf.legs).toHaveLength(1);
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

  it('CLEAR wipes the active league only and ends an edit', () => {
    let state = slipReducer(start(), { type: 'TOGGLE_LEG', leg: leg('g1'), maxLegs: MAX_LEGS });
    state = slipReducer(state, {
      type: 'TOGGLE_LEG',
      leg: leg('c1', 'spread', 'home', 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    state = slipReducer(state, { type: 'SET_LEAGUE', league: 'nfl' });
    state = slipReducer(state, { type: 'CLEAR' });
    expect(state.byLeague.nfl.legs).toHaveLength(0);
    expect(state.byLeague.ncaaf.legs).toHaveLength(1);
    expect(state.editingBetId).toBeNull();
  });

  it('START_EDIT loads the bet and switches to its league', () => {
    const state = slipReducer(start(), {
      type: 'START_EDIT',
      betId: 'bet-1',
      league: 'ncaaf',
      mode: 'parlay',
      legs: [leg('a', 'spread', 'home', 'ncaaf'), leg('b', 'total', 'over', 'ncaaf')],
      stakeCents: 2500,
    });
    expect(state.editingBetId).toBe('bet-1');
    expect(state.active).toBe('ncaaf');
    expect(active(state).stakeCents).toBe(2500);
    expect(active(state).legs).toHaveLength(2);
  });

  it('SET_STAKE and SET_MODE only touch the active league', () => {
    let state = slipReducer(start(), { type: 'SET_STAKE', stakeCents: 5000 });
    state = slipReducer(state, { type: 'SET_MODE', mode: 'parlay' });
    expect(state.byLeague.nfl).toMatchObject({ stakeCents: 5000, mode: 'parlay' });
    expect(state.byLeague.ncaaf).toEqual(EMPTY_SLIP);
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

describe('slipStorageKey', () => {
  it('is versioned and per league', () => {
    expect(slipStorageKey('nfl')).not.toBe(slipStorageKey('ncaaf'));
    expect(slipStorageKey('nfl')).toContain('v1');
  });
});

describe('persistence', () => {
  it('round-trips a slip', () => {
    const slip = {
      mode: 'parlay' as const,
      legs: [leg('g1'), leg('g2', 'total', 'over')],
      stakeCents: 1234,
    };
    const parsed = parseStoredSlip(serialiseSlip(slip), 'nfl');
    expect(parsed).toEqual(slip);
  });

  it('returns null for missing, malformed or foreign data instead of throwing', () => {
    expect(parseStoredSlip(null, 'nfl')).toBeNull();
    expect(parseStoredSlip('not json', 'nfl')).toBeNull();
    expect(parseStoredSlip('[]', 'nfl')).toBeNull();
    expect(parseStoredSlip('{"mode":"teaser","legs":[],"stakeCents":0}', 'nfl')).toBeNull();
    expect(parseStoredSlip('{"mode":"straight","legs":[],"stakeCents":-1}', 'nfl')).toBeNull();
    expect(
      parseStoredSlip('{"mode":"straight","legs":[{"gameId":""}],"stakeCents":0}', 'nfl'),
    ).toBeNull();
  });

  it('rejects a hand-edited price that is not a safe integer', () => {
    const raw = JSON.stringify({
      mode: 'straight',
      stakeCents: 100,
      legs: [{ ...leg('g1'), americanPrice: 1.5 }],
    });
    expect(parseStoredSlip(raw, 'nfl')).toBeNull();
  });

  it('re-stamps the league so a slip cannot be restored under the wrong one', () => {
    const raw = serialiseSlip({
      mode: 'straight',
      legs: [leg('g1', 'spread', 'home', 'nfl')],
      stakeCents: 100,
    });
    expect(parseStoredSlip(raw, 'ncaaf')?.legs[0]?.league).toBe('ncaaf');
  });
});
