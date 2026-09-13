import { describe, expect, it } from 'vitest';

import { centsToText, stakeFromText } from '../../src/web/lib/stake-text.js';

describe('centsToText', () => {
  it('renders whole dollars without a decimal part', () => {
    expect(centsToText(2500)).toBe('25');
  });

  it('pads the cents to two digits', () => {
    expect(centsToText(1205)).toBe('12.05');
    expect(centsToText(1250)).toBe('12.50');
  });

  it('renders zero as an EMPTY box, so the placeholder shows', () => {
    expect(centsToText(0)).toBe('');
  });
});

describe('stakeFromText', () => {
  it('accepts the shapes PLAN §12.4 names', () => {
    expect(stakeFromText('12.34')).toEqual({ cents: 1234, problem: null });
    expect(stakeFromText('1,000')).toEqual({ cents: 100_000, problem: null });
    expect(stakeFromText('.5')).toEqual({ cents: 50, problem: null });
    expect(stakeFromText('12.')).toEqual({ cents: 1200, problem: null });
  });

  it('treats empty (and whitespace) as a SILENT zero', () => {
    expect(stakeFromText('')).toEqual({ cents: 0, problem: null });
    expect(stakeFromText('   ')).toEqual({ cents: 0, problem: null });
  });

  it('treats unparseable text as a LOUD zero, never as "keep the last stake"', () => {
    // The regression: the old handler only set a message and left the previous
    // stake live, so a box reading "$abc" stayed submittable at the last good
    // amount. Zero is below MIN_STAKE_CENTS, which is what disables submit.
    for (const bad of ['abc', '1.234', '12,34', '-5', '1,00', '$$']) {
      const entry = stakeFromText(bad);
      expect(entry.cents, bad).toBe(0);
      expect(entry.problem, bad).not.toBeNull();
    }
  });

  it('reports no problem for text it accepts', () => {
    expect(stakeFromText('50').problem).toBeNull();
  });
});
