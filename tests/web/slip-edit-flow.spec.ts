/**
 * The slip behaviours the M7 review flagged, exercised on the pure reducer and
 * the pure preview so they need neither React nor a DOM:
 *
 *  - editing a bet must not destroy a draft slip;
 *  - accepting a moved line must RE-PRICE the slip, not resubmit the stale one;
 *  - a full parlay must refuse a tap loudly and allocate nothing;
 *  - a one-leg "parlay" must not survive a reload;
 *  - the churn that broke the focus trap is real, and is confined to the slip.
 */

import { describe, expect, it } from 'vitest';

import {
  applyLineChange,
  buildPlaceBetRequest,
  computePreview,
  lineChangeIsAcceptable,
} from '../../src/web/state/slip-preview.js';
import {
  EMPTY_SLIP,
  emptySlipState,
  parlayFullNotice,
  parseStoredSlip,
  serialiseSlip,
  slipReducer,
} from '../../src/web/state/slip-reducer.js';
import type { LeagueSlip, SlipLeg, SlipState } from '../../src/web/state/slip-reducer.js';
import type { LineChangedDetails } from '../../src/shared/api-types.js';
import type { League, Market, Side } from '../../src/shared/types.js';

const MAX_LEGS = 10;

function leg(gameId: string, overrides: Partial<SlipLeg> = {}, league: League = 'nfl'): SlipLeg {
  const market: Market = overrides.market ?? 'spread';
  return {
    gameId,
    league,
    market,
    side: overrides.side ?? 'home',
    lineTenths: market === 'moneyline' ? null : (overrides.lineTenths ?? -35),
    americanPrice: overrides.americanPrice ?? -110,
    label: overrides.label ?? 'HOME -3.5',
    kickoffAt: 1_800_000_000_000,
    homeAbbr: 'HOME',
    awayAbbr: 'AWAY',
  };
}

function active(state: SlipState): LeagueSlip {
  return state.byLeague[state.active];
}

function detail(
  gameId: string,
  market: Market,
  side: Side,
  expectedPrice: number,
  expectedLine: number | null,
  current: { americanPrice: number; lineTenths: number | null } | null,
): LineChangedDetails['legs'][number] {
  return {
    gameId,
    market,
    side,
    expected: { americanPrice: expectedPrice, lineTenths: expectedLine },
    current,
  };
}

// ---------------------------------------------------------------------------
// START_EDIT must not eat the draft slip
// ---------------------------------------------------------------------------

describe('editing a bet borrows the slip; it does not overwrite it', () => {
  function draftThenEdit(): SlipState {
    const drafted = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('draft-game'),
      maxLegs: MAX_LEGS,
    });
    const staked = slipReducer(drafted, { type: 'SET_STAKE', stakeCents: 2500 });
    return slipReducer(staked, {
      type: 'START_EDIT',
      betId: 'bet-1',
      league: 'nfl',
      mode: 'straight',
      legs: [leg('bet-game')],
      stakeCents: 1000,
    });
  }

  it('shows the bet being edited while the edit is open', () => {
    const state = draftThenEdit();
    expect(state.editingBetId).toBe('bet-1');
    expect(active(state).legs.map((l) => l.gameId)).toEqual(['bet-game']);
    expect(active(state).stakeCents).toBe(1000);
  });

  it('RESTORES the draft, stake and all, when the edit is cancelled', () => {
    const restored = slipReducer(draftThenEdit(), { type: 'END_EDIT' });
    expect(restored.editingBetId).toBeNull();
    expect(restored.editBackup).toBeNull();
    expect(active(restored).legs.map((l) => l.gameId)).toEqual(['draft-game']);
    expect(active(restored).stakeCents).toBe(2500);
  });

  it('restores the draft after a SUCCESSFUL edit too — it was never submitted', () => {
    const edited = slipReducer(draftThenEdit(), { type: 'SET_STAKE', stakeCents: 5000 });
    const done = slipReducer(edited, { type: 'END_EDIT' });
    expect(active(done).legs.map((l) => l.gameId)).toEqual(['draft-game']);
    expect(active(done).stakeCents).toBe(2500);
  });

  it('keeps the ORIGINAL draft as the backup when a second edit is started', () => {
    const second = slipReducer(draftThenEdit(), {
      type: 'START_EDIT',
      betId: 'bet-2',
      league: 'nfl',
      mode: 'straight',
      legs: [leg('other-bet-game')],
      stakeCents: 300,
    });
    expect(second.editingBetId).toBe('bet-2');
    expect(second.editBackup?.slip.legs.map((l) => l.gameId)).toEqual(['draft-game']);

    const restored = slipReducer(second, { type: 'END_EDIT' });
    expect(active(restored).legs.map((l) => l.gameId)).toEqual(['draft-game']);
  });

  it('backs up the slip of the league the BET is in, not the active one', () => {
    const drafted = slipReducer(emptySlipState('ncaaf'), {
      type: 'TOGGLE_LEG',
      leg: leg('cfb-draft', {}, 'ncaaf'),
      maxLegs: MAX_LEGS,
    });
    const editing = slipReducer(drafted, {
      type: 'START_EDIT',
      betId: 'bet-1',
      league: 'nfl',
      mode: 'straight',
      legs: [leg('nfl-bet')],
      stakeCents: 1000,
    });
    expect(editing.active).toBe('nfl');
    // The NCAAF draft is untouched the whole time.
    expect(editing.byLeague.ncaaf.legs.map((l) => l.gameId)).toEqual(['cfb-draft']);

    const restored = slipReducer(editing, { type: 'END_EDIT' });
    expect(restored.byLeague.nfl).toEqual(EMPTY_SLIP);
    expect(restored.byLeague.ncaaf.legs.map((l) => l.gameId)).toEqual(['cfb-draft']);
  });

  it('CLEAR drops the backup: an explicit clear is not an edit ending', () => {
    const cleared = slipReducer(draftThenEdit(), { type: 'CLEAR' });
    expect(cleared.editingBetId).toBeNull();
    expect(cleared.editBackup).toBeNull();
    expect(active(cleared)).toEqual(EMPTY_SLIP);
  });

  it('END_EDIT is a no-op when nothing is being edited', () => {
    const state = emptySlipState('nfl');
    expect(slipReducer(state, { type: 'END_EDIT' })).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// LINE_CHANGED
// ---------------------------------------------------------------------------

describe('applyLineChange', () => {
  const slip = (legs: readonly SlipLeg[], stakeCents = 1000): LeagueSlip => ({
    mode: legs.length > 1 ? 'parlay' : 'straight',
    legs,
    stakeCents,
  });

  it('rewrites the leg to the price and line the SERVER quoted', () => {
    const before = slip([leg('g1', { americanPrice: -110, lineTenths: -35 })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -130, lineTenths: -45 })],
    });
    expect(after.legs[0]?.americanPrice).toBe(-130);
    expect(after.legs[0]?.lineTenths).toBe(-45);
  });

  it('relabels, so the sheet cannot keep quoting the old number', () => {
    const before = slip([leg('g1', { label: 'HOME -3.5' })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -130, lineTenths: -45 })],
    });
    expect(after.legs[0]?.label).toBe('HOME -4.5');
  });

  it('is what makes the RESUBMITTED `expected` current rather than stale', () => {
    // This is the whole bug: "Accept new line & place" used to resend the
    // original `expected` with acceptLineChange:true, so the bet was booked at a
    // price the slip had never shown.
    const before = slip([leg('g1', { americanPrice: -110, lineTenths: -35 })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -130, lineTenths: -45 })],
    });
    const body = buildPlaceBetRequest('nfl', after, true);
    expect(body.acceptLineChange).toBe(true);
    expect(body.legs[0]?.expected).toEqual({ americanPrice: -130, lineTenths: -45 });
  });

  it('re-prices the PREVIEW the user is looking at', () => {
    const before = slip([leg('g1', { americanPrice: 100 })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', 100, -35, { americanPrice: -200, lineTenths: -35 })],
    });
    expect(computePreview('nfl', before, 100_000).toWinCents).toBe(1000);
    expect(computePreview('nfl', after, 100_000).toWinCents).toBe(500);
  });

  it('leaves a leg the server did not flag alone', () => {
    const before = slip([leg('g1'), leg('g2', { americanPrice: 120 })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -115, lineTenths: -35 })],
    });
    expect(after.legs[1]).toBe(before.legs[1]);
  });

  it('leaves a PULLED market alone — there is no new price to move to', () => {
    const before = slip([leg('g1')]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, null)],
    });
    expect(after).toBe(before);
  });

  it('keeps the slip IDENTITY when nothing actually moved', () => {
    const before = slip([leg('g1', { americanPrice: -110, lineTenths: -35 })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -110, lineTenths: -35 })],
    });
    expect(after).toBe(before);
  });

  it('forces a moneyline leg to a null line whatever the server sends', () => {
    const before = slip([leg('g1', { market: 'moneyline', side: 'away' })]);
    const after = applyLineChange(before, {
      legs: [detail('g1', 'moneyline', 'away', -110, null, { americanPrice: 145, lineTenths: 0 })],
    });
    expect(after.legs[0]?.lineTenths).toBeNull();
    expect(after.legs[0]?.americanPrice).toBe(145);
  });
});

describe('lineChangeIsAcceptable', () => {
  it('is true when every flagged leg still has a current quote', () => {
    expect(
      lineChangeIsAcceptable({
        legs: [detail('g1', 'spread', 'home', -110, -35, { americanPrice: -130, lineTenths: -45 })],
      }),
    ).toBe(true);
  });

  it('is FALSE when a market was pulled — accepting would just 409 again', () => {
    expect(
      lineChangeIsAcceptable({
        legs: [
          detail('g1', 'spread', 'home', -110, -35, { americanPrice: -130, lineTenths: -45 }),
          detail('g2', 'total', 'over', -110, 475, null),
        ],
      }),
    ).toBe(false);
  });

  it('is false for an empty details payload', () => {
    expect(lineChangeIsAcceptable({ legs: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a full parlay, and the one-leg "parlay"
// ---------------------------------------------------------------------------

describe('a parlay that is already full', () => {
  function full(maxLegs = 3): SlipState {
    let state = emptySlipState('nfl');
    for (let i = 0; i < maxLegs; i += 1) {
      state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg(`g${String(i)}`), maxLegs });
    }
    return state;
  }

  it('refuses a NEW game with a notice and changes nothing at all', () => {
    const before = full();
    const after = slipReducer(before, { type: 'TOGGLE_LEG', leg: leg('g-new'), maxLegs: 3 });

    expect(after.notice).toBe(parlayFullNotice(3));
    // Identity, not just equality: the refusal allocates no new slip or legs.
    expect(after.byLeague.nfl).toBe(before.byLeague.nfl);
    expect(after.byLeague.nfl.legs).toBe(before.byLeague.nfl.legs);
  });

  it('still allows SWAPPING markets on a game already in the parlay', () => {
    const before = full();
    const after = slipReducer(before, {
      type: 'TOGGLE_LEG',
      leg: leg('g0', { market: 'total', side: 'over', lineTenths: 475 }),
      maxLegs: 3,
    });
    expect(after.notice).toBeNull();
    expect(after.byLeague.nfl.legs).toHaveLength(3);
    expect(after.byLeague.nfl.legs.map((l) => l.market)).toContain('total');
  });

  it('still allows removing a leg', () => {
    const after = slipReducer(full(), { type: 'TOGGLE_LEG', leg: leg('g0'), maxLegs: 3 });
    expect(after.byLeague.nfl.legs).toHaveLength(2);
    expect(after.notice).toBeNull();
  });

  it('clears the notice on the next action, and on demand', () => {
    const refused = slipReducer(full(), { type: 'TOGGLE_LEG', leg: leg('g-new'), maxLegs: 3 });
    expect(slipReducer(refused, { type: 'SET_STAKE', stakeCents: 500 }).notice).toBeNull();
    expect(slipReducer(refused, { type: 'DISMISS_NOTICE' }).notice).toBeNull();
  });
});

describe('mode follows the leg count', () => {
  it('refuses to call a one-leg slip a parlay', () => {
    const one = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('g1'),
      maxLegs: MAX_LEGS,
    });
    expect(slipReducer(one, { type: 'SET_MODE', mode: 'parlay' }).byLeague.nfl.mode).toBe(
      'straight',
    );
  });

  it('allows parlay once there are two legs', () => {
    let state = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('g1'),
      maxLegs: MAX_LEGS,
    });
    state = slipReducer(state, { type: 'TOGGLE_LEG', leg: leg('g2'), maxLegs: MAX_LEGS });
    expect(state.byLeague.nfl.mode).toBe('parlay');
    expect(slipReducer(state, { type: 'SET_MODE', mode: 'parlay' }).byLeague.nfl.mode).toBe(
      'parlay',
    );
  });

  it('NORMALISES a persisted one-leg "parlay" back to a straight on hydrate', () => {
    const raw = JSON.stringify({
      mode: 'parlay',
      stakeCents: 1000,
      legs: [
        {
          gameId: 'g1',
          market: 'spread',
          side: 'home',
          lineTenths: -35,
          americanPrice: -110,
          label: 'HOME -3.5',
          kickoffAt: 1_800_000_000_000,
          homeAbbr: 'HOME',
          awayAbbr: 'AWAY',
        },
      ],
    });
    expect(parseStoredSlip(raw, 'nfl')?.mode).toBe('straight');
  });

  it('round-trips the abbreviations the relabelling depends on', () => {
    const before: LeagueSlip = { mode: 'straight', legs: [leg('g1')], stakeCents: 1000 };
    const after = parseStoredSlip(serialiseSlip(before), 'nfl');
    expect(after?.legs[0]?.homeAbbr).toBe('HOME');
    expect(after?.legs[0]?.awayAbbr).toBe('AWAY');
  });

  it('rejects a stored leg with no abbreviations rather than guessing', () => {
    const raw = JSON.stringify({
      mode: 'straight',
      stakeCents: 1000,
      legs: [
        {
          gameId: 'g1',
          market: 'spread',
          side: 'home',
          lineTenths: -35,
          americanPrice: -110,
          label: 'HOME -3.5',
          kickoffAt: 1_800_000_000_000,
        },
      ],
    });
    expect(parseStoredSlip(raw, 'nfl')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the churn that broke the focus trap
// ---------------------------------------------------------------------------

describe('the identity churn behind the focus-trap bug', () => {
  it('a keystroke on the stake box produces a NEW state, slip and preview', () => {
    // This is the input to the bug, and it is legitimate: the reducer is pure.
    // What was wrong was letting it reach `useFocusTrap`'s dependency array.
    const before = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('g1'),
      maxLegs: MAX_LEGS,
    });
    const after = slipReducer(before, { type: 'SET_STAKE', stakeCents: 1250 });

    expect(after).not.toBe(before);
    expect(after.byLeague.nfl).not.toBe(before.byLeague.nfl);
    expect(computePreview('nfl', after.byLeague.nfl, 100_000)).not.toBe(
      computePreview('nfl', after.byLeague.nfl, 100_000),
    );
  });

  it('churns on EVERY keystroke of a multi-character stake', () => {
    let state = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('g1'),
      maxLegs: MAX_LEGS,
    });
    const seen = new Set<unknown>();
    for (const cents of [100, 1200, 1250]) {
      state = slipReducer(state, { type: 'SET_STAKE', stakeCents: cents });
      seen.add(state.byLeague.nfl);
    }
    expect(seen.size).toBe(3);
  });

  it('leaves the parts the trap depends on untouched: the LEGS do not churn', () => {
    // `useFocusTrap`'s only remaining deps are the dialog ref and `open`. The
    // closest pure proxy for "the trap is unaffected" is that a stake keystroke
    // touches nothing structural.
    const before = slipReducer(emptySlipState('nfl'), {
      type: 'TOGGLE_LEG',
      leg: leg('g1'),
      maxLegs: MAX_LEGS,
    });
    const after = slipReducer(before, { type: 'SET_STAKE', stakeCents: 1250 });

    expect(after.byLeague.nfl.legs).toBe(before.byLeague.nfl.legs);
    expect(after.editingBetId).toBe(before.editingBetId);
    expect(after.active).toBe(before.active);
  });
});
