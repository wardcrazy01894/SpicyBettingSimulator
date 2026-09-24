import { describe, expect, it } from 'vitest';
import { TEASER_PAYOUTS, TEASER_POINTS_TENTHS } from '../../src/shared/constants.js';
import { LEAGUES } from '../../src/shared/types.js';
import {
  BET_LEAGUE_LABEL,
  LEAGUE_BADGE,
  LEAGUE_LABEL,
  betShapeLabel,
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
