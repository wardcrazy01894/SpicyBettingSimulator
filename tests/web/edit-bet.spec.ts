/**
 * Starting an edit must seed the slip from TODAY'S prices.
 *
 * The regression: the edit slip was built from the bet's placement snapshot and
 * that snapshot was resubmitted as `expected`, so changing nothing but the stake
 * was answered `409 LINE_CHANGED` for any leg whose line had moved — on a sheet
 * that was still showing the old number.
 */

import { describe, expect, it } from 'vitest';

import { gameIdsToRefresh, refreshSlipLegs } from '../../src/web/state/edit-bet.js';
import { betView, gameCard, localMs } from './factories.js';
import type { GameCard, GameLinesView } from '../../src/shared/api-types.js';

const KICKOFF = localMs(2026, 9, 13, 13);

function lines(overrides: Partial<GameLinesView> = {}): GameLinesView {
  return {
    provider: 'DraftKings',
    capturedAt: KICKOFF - 7_200_000,
    seenAt: KICKOFF - 60_000,
    stale: false,
    spread: { homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -110 },
    total: { tenths: 475, overPrice: -110, underPrice: -110 },
    moneyline: { homePrice: -180, awayPrice: 155 },
    ...overrides,
  };
}

function board(...games: readonly GameCard[]): ReadonlyMap<string, GameCard> {
  return new Map(games.map((game) => [game.id, game]));
}

describe('gameIdsToRefresh', () => {
  it('is the DISTINCT game ids of the bet, in leg order', () => {
    const bet = betView({
      id: 'b1',
      legs: [
        { gameId: 'g2', kickoffAt: KICKOFF },
        { gameId: 'g1', kickoffAt: KICKOFF },
      ],
    });
    expect(gameIdsToRefresh(bet)).toEqual(['g2', 'g1']);
  });
});

describe('refreshSlipLegs', () => {
  it('replaces the snapshot price and line with the CURRENT quote', () => {
    // The bet was placed at -3.5 / -110 (the factory's snapshot); the book has
    // since moved to -4.5 / -105.
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const moved = gameCard({
      id: 'g1',
      kickoffAt: KICKOFF,
      lines: lines({
        spread: { homeTenths: -45, homePrice: -105, awayTenths: 45, awayPrice: -115 },
      }),
    });

    const { legs, unrefreshed } = refreshSlipLegs(bet, board(moved));

    expect(legs).toHaveLength(1);
    expect(legs[0]?.lineTenths).toBe(-45);
    expect(legs[0]?.americanPrice).toBe(-105);
    expect(unrefreshed).toEqual([]);
  });

  it('relabels the leg so the sheet shows the CURRENT line, not the old one', () => {
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const moved = gameCard({
      id: 'g1',
      kickoffAt: KICKOFF,
      lines: lines({
        spread: { homeTenths: -45, homePrice: -105, awayTenths: 45, awayPrice: -115 },
      }),
    });

    const { legs } = refreshSlipLegs(bet, board(moved));
    expect(legs[0]?.label).toBe('HOME -4.5');
  });

  it('leaves a moneyline leg with a null line and the current price', () => {
    const bet = betView({
      id: 'b1',
      legs: [{ gameId: 'g1', kickoffAt: KICKOFF, market: 'moneyline', side: 'away' }],
    });
    const { legs } = refreshSlipLegs(bet, board(gameCard({ id: 'g1', lines: lines() })));

    expect(legs[0]?.lineTenths).toBeNull();
    expect(legs[0]?.americanPrice).toBe(155);
    expect(legs[0]?.label).toBe('AWAY ML');
  });

  it('carries the abbreviations through, so a later line move can relabel again', () => {
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const { legs } = refreshSlipLegs(bet, board(gameCard({ id: 'g1', lines: lines() })));
    expect(legs[0]?.homeAbbr).toBe('HOME');
    expect(legs[0]?.awayAbbr).toBe('AWAY');
  });

  it('re-reads the kickoff from the game, not from the placement snapshot', () => {
    // CLAUDE.md §8b: ESPN reschedules games and the bet's snapshot is never updated.
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const rescheduled = gameCard({ id: 'g1', kickoffAt: KICKOFF - 86_400_000, lines: lines() });
    const { legs } = refreshSlipLegs(bet, board(rescheduled));
    expect(legs[0]?.kickoffAt).toBe(KICKOFF - 86_400_000);
  });

  it('keeps the snapshot and REPORTS the game when the market is no longer posted', () => {
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const pulled = gameCard({ id: 'g1', lines: lines({ spread: null }) });

    const { legs, unrefreshed } = refreshSlipLegs(bet, board(pulled));
    expect(legs[0]?.americanPrice).toBe(-110);
    expect(legs[0]?.lineTenths).toBe(-35);
    expect(unrefreshed).toEqual(['g1']);
  });

  it('keeps the snapshot when the game was not returned at all', () => {
    const bet = betView({ id: 'b1', legs: [{ gameId: 'g1', kickoffAt: KICKOFF }] });
    const { legs, unrefreshed } = refreshSlipLegs(bet, board());
    expect(legs[0]?.americanPrice).toBe(-110);
    expect(unrefreshed).toEqual(['g1']);
  });

  it('refreshes every leg of a parlay independently', () => {
    const bet = betView({
      id: 'b1',
      legs: [
        { gameId: 'g1', kickoffAt: KICKOFF },
        { gameId: 'g2', kickoffAt: KICKOFF, market: 'total', side: 'over' },
      ],
    });
    const g1 = gameCard({
      id: 'g1',
      lines: lines({
        spread: { homeTenths: -20, homePrice: -120, awayTenths: 20, awayPrice: 100 },
      }),
    });
    const g2 = gameCard({
      id: 'g2',
      lines: lines({ total: { tenths: 512, overPrice: -102, underPrice: -118 } }),
    });

    const { legs } = refreshSlipLegs(bet, board(g1, g2));
    expect(legs[0]?.americanPrice).toBe(-120);
    expect(legs[1]?.lineTenths).toBe(512);
    expect(legs[1]?.americanPrice).toBe(-102);
    expect(legs[1]?.label).toBe('O 51.2');
  });

  it("stamps every leg with the LEG's own league, not the bet's", () => {
    // M5b: `bet.league` may be `'mixed'`, which is not a league a slip leg can
    // hold. Each leg carries its own, and a cross-league bet rebuilds correctly.
    const bet = betView({
      id: 'b1',
      league: 'mixed',
      legs: [
        { gameId: 'g1', kickoffAt: KICKOFF, league: 'nfl' },
        { gameId: 'g2', kickoffAt: KICKOFF, league: 'ncaaf' },
      ],
    });
    const { legs } = refreshSlipLegs(
      bet,
      board(gameCard({ id: 'g1', lines: lines() }), gameCard({ id: 'g2', lines: lines() })),
    );
    expect(legs.map((l) => l.league)).toEqual(['nfl', 'ncaaf']);
  });

  it('seeds a TEASER leg from the BOOK line, never the teased one', () => {
    // The snapshot's `lineTenths` IS the teased number on a teaser leg; seeding
    // the slip with it and letting the server tease it again would move the line
    // twice. `originalLineTenths` is the pre-tease value.
    const base = betView({
      id: 'b1',
      betType: 'teaser',
      teaserPoints: 60,
      legs: [{ gameId: 'g1', kickoffAt: KICKOFF }],
    });
    const first = base.legs[0];
    if (first === undefined) throw new Error('fixture has no legs');
    const teased = { ...base, legs: [{ ...first, lineTenths: 25, originalLineTenths: -35 }] };
    // No current quote for the game, so the fallback path is the one under test.
    const { legs, unrefreshed } = refreshSlipLegs(teased, new Map());
    expect(unrefreshed).toEqual(['g1']);
    expect(legs[0]?.lineTenths).toBe(-35);
    expect(legs[0]?.label).toBe('HOME -3.5');
  });
});
