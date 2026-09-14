import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/shared/errors.js';
import {
  MAX_PARLAY_LEGS,
  MIN_STAKE_CENTS,
  TEASER_PAYOUTS,
  TEASER_POINTS_TENTHS,
} from '../../src/shared/constants.js';
import { ERROR_MESSAGES, messageForCode, messageForError } from '../../src/web/api/messages.js';
import {
  buildPlaceBetRequest,
  computePreview,
  slipLeague,
} from '../../src/web/state/slip-preview.js';
import { DEFAULT_TEASER_POINTS_TENTHS } from '../../src/web/state/slip-reducer.js';
import type { Slip, SlipLeg, SlipMode } from '../../src/web/state/slip-reducer.js';
import type { League, Market, Side } from '../../src/shared/types.js';

function leg(
  gameId: string,
  americanPrice: number,
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
    americanPrice,
    label: gameId,
    kickoffAt: 1_800_000_000_000,
    homeAbbr: 'HOME',
    awayAbbr: 'AWAY',
  };
}

function slip(
  legs: readonly SlipLeg[],
  stakeCents: number,
  mode?: SlipMode,
  teaserPointsTenths = DEFAULT_TEASER_POINTS_TENTHS,
): Slip {
  return {
    mode: mode ?? (legs.length > 1 ? 'parlay' : 'straight'),
    legs,
    stakeCents,
    teaserPointsTenths,
  };
}

describe('computePreview', () => {
  it('asks for a pick when the slip is empty', () => {
    const preview = computePreview(slip([], 0), 100_000);
    expect(preview.error).not.toBeNull();
    expect(preview.americanPrice).toBeNull();
    expect(preview.payoutCents).toBe(0);
  });

  it('matches the PLAN §5 headline vector exactly: -110/+120/-105 at 100c pays 820', () => {
    const preview = computePreview(
      slip([leg('a', -110), leg('b', 120, 'total', 'over'), leg('c', -105, 'moneyline')], 100),
      100_000,
    );
    // The float formulations both give 819 here; the exact BigInt path gives 820.
    expect(preview.payoutCents).toBe(820);
    expect(preview.toWinCents).toBe(720);
    expect(preview.americanPrice).toBe(720);
    expect(preview.decimalOdds).toBe('8.200');
    expect(preview.error).toBeNull();
  });

  it('matches the same parlay at the top of the range (100000c -> 820000)', () => {
    const preview = computePreview(
      slip([leg('a', -110), leg('b', 120, 'total', 'over'), leg('c', -105, 'moneyline')], 100_000),
      1_000_000,
    );
    expect(preview.payoutCents).toBe(820_000);
    expect(preview.toWinCents).toBe(720_000);
  });

  it('prices a straight -110 at 2500c as 4772', () => {
    const preview = computePreview(slip([leg('a', -110)], 2500), 100_000);
    expect(preview.payoutCents).toBe(4772);
    expect(preview.toWinCents).toBe(2272);
    expect(preview.americanPrice).toBe(-110);
  });

  it('blocks a stake under the minimum with the SHARED validator message', () => {
    const preview = computePreview(slip([leg('a', -110)], MIN_STAKE_CENTS - 1), 100_000);
    expect(preview.error).toContain(String(MIN_STAKE_CENTS));
  });

  it('blocks a 1-leg slip that claims to be a parlay', () => {
    const preview = computePreview(slip([leg('a', -110)], 1000, 'parlay'), 100_000);
    expect(preview.error).not.toBeNull();
  });

  it('blocks a multi-leg slip that claims to be straight', () => {
    const preview = computePreview(
      slip([leg('a', -110), leg('b', -110)], 1000, 'straight'),
      100_000,
    );
    expect(preview.error).not.toBeNull();
  });

  it('reports the payout cap BEFORE producing a number (10 legs @ +2000)', () => {
    const legs = Array.from({ length: MAX_PARLAY_LEGS }, (_, i) => leg(`g${String(i)}`, 2000));
    const preview = computePreview(slip(legs, 100_000), 100_000_000);
    expect(preview.error).toBe(ERROR_MESSAGES.PAYOUT_LIMIT_EXCEEDED);
    expect(preview.payoutCents).toBe(0);
  });

  it('reports insufficient funds when the stake is over the balance', () => {
    const preview = computePreview(slip([leg('a', -110)], 5000), 4999);
    expect(preview.error).toBe(ERROR_MESSAGES.INSUFFICIENT_FUNDS);
    // The price is still shown — the user needs to see what they are being told no about.
    expect(preview.payoutCents).toBeGreaterThan(0);
  });

  it('does not pre-judge the balance when it is unknown', () => {
    expect(computePreview(slip([leg('a', -110)], 5000), null).error).toBeNull();
  });
});

describe('buildPlaceBetRequest', () => {
  it('sends expected line + price per leg and NEVER a price for the bet itself', () => {
    const body = buildPlaceBetRequest(
      slip([leg('a', -110), leg('b', 150, 'moneyline')], 1000),
      false,
    );
    expect(body).toEqual({
      league: 'nfl',
      betType: 'parlay',
      stakeCents: 1000,
      acceptLineChange: false,
      legs: [
        {
          gameId: 'a',
          market: 'spread',
          side: 'home',
          expected: { americanPrice: -110, lineTenths: -35 },
        },
        {
          gameId: 'b',
          market: 'moneyline',
          side: 'home',
          expected: { americanPrice: 150, lineTenths: null },
        },
      ],
    });
    expect(Object.keys(body)).not.toContain('americanPrice');
  });

  it('carries acceptLineChange through', () => {
    expect(buildPlaceBetRequest(slip([leg('a', -110)], 100), true).acceptLineChange).toBe(true);
  });
});

describe('the error-message table', () => {
  it('covers EVERY code in the frozen vocabulary with non-empty copy', () => {
    for (const code of ERROR_CODES) {
      expect(messageForCode(code), code).toMatch(/\S/);
    }
    expect(Object.keys(ERROR_MESSAGES)).toHaveLength(ERROR_CODES.length);
  });

  it('never leaks a raw code as the message', () => {
    for (const code of ERROR_CODES) {
      expect(messageForCode(code)).not.toBe(code);
    }
  });

  it('prefers the server text only for VALIDATION and RATE_LIMITED', () => {
    const validation = Object.assign(new Error('stakeCents must be an integer >= 100'), {
      code: 'VALIDATION',
    });
    expect(messageForError(validation)).toBe('stakeCents must be an integer >= 100');

    const locked = Object.assign(new Error('CHECK constraint failed: balance_cents >= 0'), {
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(messageForError(locked)).toBe(ERROR_MESSAGES.INSUFFICIENT_FUNDS);
  });

  it('falls back to INTERNAL for a non-Error', () => {
    expect(messageForError(undefined)).toBe(ERROR_MESSAGES.INTERNAL);
    expect(messageForError({ code: 'VALIDATION' })).toBe(ERROR_MESSAGES.INTERNAL);
  });

  it('ignores an unrecognised code rather than trusting it', () => {
    const bogus = Object.assign(new Error('boom'), { code: 'NOT_A_REAL_CODE' });
    expect(messageForError(bogus)).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// Teasers (M5b). The slip prices these from the SERVER's card, echoed by
// `GET /api/config`, never from its own bundled copy of `constants.ts`.
// ---------------------------------------------------------------------------

describe('computePreview — teasers', () => {
  const teaserLeg = (id: string, market: Market = 'spread'): SlipLeg =>
    leg(id, -110, market, market === 'total' ? 'over' : 'home');

  it('prices from the card, NOT from the product of the legs', () => {
    // Three -110 legs: as a PARLAY that is 6957c on 1000c (PLAN §5.4's shape);
    // as a 6-point teaser it is the card's +150, i.e. 2500c. REPL-verified.
    const legs = [teaserLeg('a'), teaserLeg('b'), teaserLeg('c')];
    const parlay = computePreview(slip(legs, 1000, 'parlay'), 100_000, TEASER_PAYOUTS);
    expect(parlay.payoutCents).toBe(6957);

    const teaser = computePreview(slip(legs, 1000, 'teaser', 60), 100_000, TEASER_PAYOUTS);
    expect(teaser.error).toBeNull();
    expect(teaser.americanPrice).toBe(150);
    expect(teaser.payoutCents).toBe(2500);
    expect(teaser.toWinCents).toBe(1500);
  });

  it('follows the tier selector', () => {
    const legs = [teaserLeg('a'), teaserLeg('b')];
    // REPL-verified at 1000c: 6pt -120 -> 1833, 6.5pt -130 -> 1769, 7pt -140 -> 1714.
    for (const [tenths, payout, american] of [
      [60, 1833, -120],
      [65, 1769, -130],
      [70, 1714, -140],
    ] as const) {
      const preview = computePreview(slip(legs, 1000, 'teaser', tenths), 100_000, TEASER_PAYOUTS);
      expect(preview.americanPrice).toBe(american);
      expect(preview.payoutCents).toBe(payout);
    }
  });

  it('says so rather than inventing a price when the server sent no card', () => {
    const legs = [teaserLeg('a'), teaserLeg('b')];
    const preview = computePreview(slip(legs, 1000, 'teaser', 60), 100_000, null);
    expect(preview.americanPrice).toBeNull();
    expect(preview.payoutCents).toBe(0);
    expect(preview.error).not.toBeNull();
  });

  it('surfaces the moneyline rule as the slip-blocking error', () => {
    const legs = [teaserLeg('a'), leg('b', 164, 'moneyline')];
    const preview = computePreview(slip(legs, 1000, 'teaser', 60), 100_000, TEASER_PAYOUTS);
    expect(preview.error).toMatch(/spread or a total/);
    expect(preview.payoutCents).toBe(0);
  });

  it('still blocks on an insufficient balance', () => {
    const legs = [teaserLeg('a'), teaserLeg('b')];
    const preview = computePreview(slip(legs, 1000, 'teaser', 60), 500, TEASER_PAYOUTS);
    expect(preview.error).toBe(ERROR_MESSAGES.INSUFFICIENT_FUNDS);
  });
});

// ---------------------------------------------------------------------------
// The cross-league slip (M5b). "Tease Michigan and the Steelers together."
// ---------------------------------------------------------------------------

describe('computePreview — a CROSS-LEAGUE slip', () => {
  /** One NFL spread and one NCAAF total, both at -110. The headline case. */
  const crossLeague: readonly SlipLeg[] = [
    leg('nfl:steelers', -110, 'spread', 'home', 'nfl'),
    leg('ncaaf:michigan', -110, 'total', 'over', 'ncaaf'),
  ];

  it('prices as a 2-leg 6-pt TEASER at -120 (REPL: 1000c -> 1833)', () => {
    const preview = computePreview(slip(crossLeague, 1000, 'teaser', 60), 100_000, TEASER_PAYOUTS);
    expect(preview.error).toBeNull();
    expect(preview.americanPrice).toBe(-120);
    expect(preview.payoutCents).toBe(1833);
    expect(preview.toWinCents).toBe(833);
  });

  it('prices as a 2-leg PARLAY at the PRODUCT price (REPL: -110 x -110 -> +264, 3644)', () => {
    const preview = computePreview(slip(crossLeague, 1000, 'parlay'), 100_000, TEASER_PAYOUTS);
    expect(preview.error).toBeNull();
    // 44100/12100 exactly; the card is not consulted at all for a parlay.
    expect(preview.americanPrice).toBe(264);
    expect(preview.payoutCents).toBe(3644);
  });

  it("sends league:'mixed' — advisory, and the same value the server will derive", () => {
    const body = buildPlaceBetRequest(slip(crossLeague, 1000, 'teaser', 60), false);
    expect(body.league).toBe('mixed');
    expect(body.betType).toBe('teaser');
    expect(body.teaserPoints).toBe(60);
    expect(body.legs.map((l) => l.gameId)).toEqual(['nfl:steelers', 'ncaaf:michigan']);
  });

  it('reports ONE league when the legs happen to share one', () => {
    const bothNfl = [
      leg('nfl:a', -110, 'spread', 'home', 'nfl'),
      leg('nfl:b', -110, 'total', 'over', 'nfl'),
    ];
    expect(buildPlaceBetRequest(slip(bothNfl, 1000, 'parlay'), false).league).toBe('nfl');
    expect(slipLeague(bothNfl)).toBe('nfl');
    expect(slipLeague(crossLeague)).toBe('mixed');
    // An empty slip has no league to report; the body just has to be legal,
    // because validation rejects it on `legs` long before `league` matters.
    expect(slipLeague([])).toBe('nfl');
  });

  it('applies the SAME rules across leagues — a CFB moneyline still blocks a teaser', () => {
    const nflLeg = crossLeague[0];
    if (nflLeg === undefined) throw new Error('fixture has no legs');
    const withMl = [nflLeg, leg('ncaaf:x', 164, 'moneyline', 'home', 'ncaaf')];
    const preview = computePreview(slip(withMl, 1000, 'teaser', 60), 100_000, TEASER_PAYOUTS);
    expect(preview.error).toMatch(/spread or a total/);
  });
});

describe('buildPlaceBetRequest — teasers', () => {
  it('sends the tier only on a teaser, and the BOOK line as `expected` either way', () => {
    const legs = [leg('a', -110), leg('b', -110)];
    const asTeaser = buildPlaceBetRequest(slip(legs, 1000, 'teaser', 65), false);
    expect(asTeaser.betType).toBe('teaser');
    expect(asTeaser.teaserPoints).toBe(65);
    // The number the BOARD showed. Sending the teased one would make every
    // teaser a false 409 LINE_CHANGED.
    expect(asTeaser.legs[0]?.expected).toEqual({ americanPrice: -110, lineTenths: -35 });

    const asParlay = buildPlaceBetRequest(slip(legs, 1000, 'parlay'), false);
    expect('teaserPoints' in asParlay).toBe(false);
  });

  it('sends the stored tier untouched — the SERVER decides what is on the card', () => {
    // A client-side narrowing here once turned every non-classic tier into a
    // silent 6-point bet. An off-card value must reach the server and be
    // refused there (400 TEASER_INVALID), never be "fixed" into a different bet.
    const legs = [leg('a', -110), leg('b', -110)];
    const req = buildPlaceBetRequest(slip(legs, 1000, 'teaser', 61), false);
    expect(req.teaserPoints).toBe(61);
  });
});

describe('buildPlaceBetRequest — teaser tier', () => {
  it('sends every tier on the card exactly as stored (no client-side narrowing)', () => {
    for (const tenths of TEASER_POINTS_TENTHS) {
      const body = buildPlaceBetRequest(
        slip([leg('g1', -110), leg('g2', -110, 'total', 'over')], 500, 'teaser', tenths),
        false,
      );
      expect(body.teaserPoints).toBe(tenths);
    }
  });
});
