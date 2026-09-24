import { describe, expect, it } from 'vitest';
import { TEASER_PAYOUTS, TEASER_POINTS_TENTHS } from '../../src/shared/constants.js';
import { LEAGUES } from '../../src/shared/types.js';
import {
  BET_LEAGUE_LABEL,
  LEAGUE_BADGE,
  LEAGUE_LABEL,
  MARKET_HEAD_LABEL,
  betShapeLabel,
  gameClockLabel,
  hasSameGameLegs,
  teaserPointsLabel,
  teaserTierOptionLabel,
} from '../../src/web/lib/labels.js';

describe('league labels (M12a)', () => {
  it('MLB is in all three tables, and a mixed bet is labelled "Mixed"', () => {
    expect(LEAGUE_LABEL.mlb).toBe('MLB');
    expect(LEAGUE_BADGE.mlb).toBe('MLB');
    expect(BET_LEAGUE_LABEL.mlb).toBe('MLB');
    // 'NFL + NCAAF' would be false for an MLB + NFL parlay (PLAN.md §23.12).
    expect(BET_LEAGUE_LABEL.mixed).toBe('Mixed');
  });

  it('every League has a non-empty label and badge', () => {
    for (const league of LEAGUES) {
      expect(LEAGUE_LABEL[league]).not.toBe('');
      expect(LEAGUE_BADGE[league]).not.toBe('');
      expect(BET_LEAGUE_LABEL[league]).toBe(LEAGUE_LABEL[league]);
    }
  });
});

describe('teaserTierOptionLabel', () => {
  it("shows the tier and its card price for the slip's leg count", () => {
    expect(teaserTierOptionLabel(30, 3, TEASER_PAYOUTS)).toBe('3-pt · +325');
    expect(teaserTierOptionLabel(140, 3, TEASER_PAYOUTS)).toBe('14-pt · -350');
    expect(teaserTierOptionLabel(65, 2, TEASER_PAYOUTS)).toBe('6.5-pt · -130');
  });

  it('a slip below the teaser minimum previews the smallest row; beyond the card it shows no price', () => {
    expect(teaserTierOptionLabel(60, 1, TEASER_PAYOUTS)).toBe('6-pt · -120');
    expect(teaserTierOptionLabel(60, 0, TEASER_PAYOUTS)).toBe('6-pt · -120');
    // Eleven legs is not on the card: never quote the 10-leg price for it.
    expect(teaserTierOptionLabel(60, 11, TEASER_PAYOUTS)).toBe('6-pt');
  });

  it('falls back to the bare points label when the card has no such cell', () => {
    expect(teaserTierOptionLabel(95, 2, TEASER_PAYOUTS)).toBe(teaserPointsLabel(95));
    expect(teaserTierOptionLabel(60, 2, {})).toBe('6-pt');
  });

  it('has a price for every offered tier at every leg count', () => {
    for (const tenths of TEASER_POINTS_TENTHS) {
      for (let legs = 2; legs <= 10; legs += 1) {
        expect(teaserTierOptionLabel(tenths, legs, TEASER_PAYOUTS)).toMatch(/ · [+-]\d+$/);
      }
    }
  });
});

describe('hasSameGameLegs', () => {
  it('is true only when two legs share a game', () => {
    expect(hasSameGameLegs([{ gameId: 'a' }, { gameId: 'b' }])).toBe(false);
    expect(hasSameGameLegs([{ gameId: 'a' }, { gameId: 'b' }, { gameId: 'a' }])).toBe(true);
    expect(hasSameGameLegs([{ gameId: 'a' }])).toBe(false);
    expect(hasSameGameLegs([])).toBe(false);
  });
});

describe('betShapeLabel', () => {
  const legs = (...gameIds: string[]) => gameIds.map((gameId) => ({ gameId }));
  it('names the shape, the tier and the leg count', () => {
    expect(betShapeLabel({ betType: 'straight', teaserPoints: null, legs: legs('a') })).toBe(
      'Straight',
    );
    expect(
      betShapeLabel({ betType: 'parlay', teaserPoints: null, legs: legs('a', 'b', 'c') }),
    ).toBe('Parlay · 3 legs');
    expect(betShapeLabel({ betType: 'teaser', teaserPoints: 65, legs: legs('a', 'b') })).toBe(
      '6.5-pt teaser · 2 legs',
    );
  });
  it('says "Same game" when a multi holds two legs on one game', () => {
    expect(betShapeLabel({ betType: 'parlay', teaserPoints: null, legs: legs('a', 'a') })).toBe(
      'Same game parlay · 2 legs',
    );
    expect(
      betShapeLabel({ betType: 'parlay', teaserPoints: null, legs: legs('a', 'a', 'b') }),
    ).toBe('Same game parlay · 3 legs');
    expect(betShapeLabel({ betType: 'teaser', teaserPoints: 60, legs: legs('a', 'a') })).toBe(
      'Same game 6-pt teaser · 2 legs',
    );
  });
});

// ---------------------------------------------------------------------------
// M12c: the innings clock and the Run-line head (PLAN.md §23.12). The
// statusDetail strings are ESPN's own `status.type.detail`, copied from
// docs/samples/espn-mlb-scoreboard-2026-09-2{2,4}.json.
// ---------------------------------------------------------------------------

describe('gameClockLabel — MLB innings (M12c)', () => {
  it('renders an in-progress game from statusDetail, never "Q7 · 0:00"', () => {
    expect(gameClockLabel('mlb', 'in_progress', 'Top 7th', 7, '0:00')).toBe('Top 7th');
    expect(gameClockLabel('mlb', 'in_progress', 'Bottom 1st', 1, '0:00')).toBe('Bottom 1st');
  });

  it('falls back to "Inning N" when a live game has no detail', () => {
    expect(gameClockLabel('mlb', 'in_progress', null, 5, '0:00')).toBe('Inning 5');
    expect(gameClockLabel('mlb', 'in_progress', null, null, null)).toBe('Live');
  });

  it('renders finals, extra-inning finals and postponements as ESPN says them', () => {
    expect(gameClockLabel('mlb', 'final', 'Final', 9, '0:00')).toBe('Final');
    expect(gameClockLabel('mlb', 'final', 'Final/12', 12, '0:00')).toBe('Final/12');
    expect(gameClockLabel('mlb', 'postponed', 'Postponed', 0, '0:00')).toBe('Postponed');
  });

  it('renders a scheduled game as Scheduled', () => {
    expect(gameClockLabel('mlb', 'scheduled', 'Scheduled', 0, '0:00')).toBe('Scheduled');
    expect(gameClockLabel('mlb', 'scheduled', null, null, null)).toBe('Scheduled');
  });
});

describe('gameClockLabel — football is byte-identical (M12c)', () => {
  // The pre-M12c output, pinned literally: M12c must not move a football label.
  const cases: readonly [
    Parameters<typeof gameClockLabel>[1],
    string | null,
    number | null,
    string | null,
    string,
  ][] = [
    ['in_progress', '3rd Quarter', 3, '4:12', 'Q3 · 4:12'],
    ['in_progress', 'Halftime', 2, '0:00', 'Q2 · 0:00'],
    ['in_progress', 'End of 1st', null, null, 'End of 1st'],
    ['in_progress', null, null, null, 'Live'],
    ['final', 'Final', 4, '0:00', 'Final'],
    ['final', 'Final/OT', 5, '0:00', 'Final/OT'],
    ['scheduled', null, null, null, 'Scheduled'],
    ['postponed', null, null, null, 'Postponed'],
  ];
  for (const league of ['nfl', 'ncaaf'] as const) {
    it(`${league}: every status renders exactly as before`, () => {
      for (const [status, detail, period, clock, expected] of cases) {
        expect(gameClockLabel(league, status, detail, period, clock)).toBe(expected);
      }
    });
  }
});

describe('MARKET_HEAD_LABEL (M12c)', () => {
  it('says "Run line" over an MLB spread and "Spread" over a football one', () => {
    expect(MARKET_HEAD_LABEL.mlb.spread).toBe('Run line');
    expect(MARKET_HEAD_LABEL.nfl.spread).toBe('Spread');
    expect(MARKET_HEAD_LABEL.ncaaf.spread).toBe('Spread');
  });

  it('keeps Total and Money for every league', () => {
    for (const league of LEAGUES) {
      expect(MARKET_HEAD_LABEL[league].total).toBe('Total');
      expect(MARKET_HEAD_LABEL[league].moneyline).toBe('Money');
    }
  });
});
