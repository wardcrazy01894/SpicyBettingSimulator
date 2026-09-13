/**
 * Minimal builders for the frozen wire shapes, so the grouping tests can say
 * what they mean without 40 lines of literal per case.
 *
 * Timestamps are built with the LOCAL `Date` constructor on purpose: the UI
 * groups by the viewer's local calendar day, so a test that hard-codes a UTC
 * epoch would pass or fail depending on the machine's timezone.
 */

import type { BetView, GameCard, GameTeamView } from '../../src/shared/api-types.js';
import type { Market, Side } from '../../src/shared/types.js';

export function localMs(year: number, month1: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0).getTime();
}

function team(abbr: string): GameTeamView {
  return { teamId: abbr, abbr, name: abbr, logo: null, rank: null, score: null };
}

export function gameCard(overrides: Partial<GameCard> & { id: string }): GameCard {
  const kickoffAt = overrides.kickoffAt ?? localMs(2026, 9, 11, 20);
  return {
    league: 'nfl',
    season: 2026,
    seasonType: 2,
    week: 2,
    kickoffAt,
    status: 'scheduled',
    statusDetail: null,
    period: null,
    displayClock: null,
    neutralSite: false,
    home: team('HOME'),
    away: team('AWAY'),
    lockAt: kickoffAt - 60_000,
    bettable: true,
    lines: null,
    ...overrides,
  };
}

interface BetLegSpec {
  readonly gameId: string;
  readonly kickoffAt: number;
  readonly market?: Market;
  readonly side?: Side;
  readonly americanPrice?: number;
}

type BetOverrides = Omit<Partial<BetView>, 'legs'> & {
  readonly id: string;
  readonly legs?: readonly BetLegSpec[];
};

export function betView(overrides: BetOverrides): BetView {
  const specs: readonly BetLegSpec[] = overrides.legs ?? [
    { gameId: 'g1', kickoffAt: localMs(2026, 9, 11, 20) },
  ];
  const legs = specs.map((spec, index) => ({
    id: `${overrides.id}-${String(index)}`,
    legIndex: index,
    gameId: spec.gameId,
    market: spec.market ?? 'spread',
    side: spec.side ?? 'home',
    lineTenths: -35,
    americanPrice: spec.americanPrice ?? -110,
    provider: 'DraftKings',
    lineCapturedAt: spec.kickoffAt - 3_600_000,
    snapshotAt: spec.kickoffAt - 3_600_000,
    kickoffAtSnapshot: spec.kickoffAt,
    homeAbbr: 'HOME',
    awayAbbr: 'AWAY',
    result: null,
    projected: null,
    game: {
      status: 'scheduled' as const,
      statusDetail: null,
      kickoffAt: spec.kickoffAt,
      homeScore: null,
      awayScore: null,
    },
  }));
  const earliest = Math.min(...legs.map((l) => l.game.kickoffAt));
  const base: BetView = {
    id: overrides.id,
    league: overrides.league ?? 'nfl',
    season: overrides.season ?? 2026,
    betType: legs.length > 1 ? 'parlay' : 'straight',
    stakeCents: 1000,
    americanPrice: -110,
    decimalOdds: '1.909',
    potentialPayoutCents: 1909,
    toWinCents: 909,
    status: 'pending',
    payoutCents: null,
    placedAt: earliest - 86_400_000,
    earliestKickoffAt: earliest,
    lockAt: earliest - 60_000,
    settledAt: null,
    cancelledAt: null,
    cancellable: true,
    replacesBetId: null,
    replacedByBetId: null,
    legs,
  };
  const rest: Omit<BetOverrides, 'legs'> = overrides;
  return { ...base, ...rest, legs };
}
