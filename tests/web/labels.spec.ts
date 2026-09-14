import { describe, expect, it } from 'vitest';
import { TEASER_PAYOUTS, TEASER_POINTS_TENTHS } from '../../src/shared/constants.js';
import { teaserPointsLabel, teaserTierOptionLabel } from '../../src/web/lib/labels.js';

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
