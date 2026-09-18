import { describe, expect, it } from 'vitest';

import {
  LINE_PROVIDER_PRIMARY,
  LINE_PROVIDER_PRIORITY,
  LINE_PROVIDER_SECONDARY,
  MONEYLINE_NOT_OFFERED_SPREAD_TENTHS,
} from '../../src/shared/constants.js';
import {
  marketProvider,
  mergeEffectiveLine,
  missingMarkets,
  providerRank,
} from '../../src/shared/lines.js';
import type { EffectiveLine, LineRowView } from '../../src/shared/lines.js';
import { lineStaleAfterMs } from '../../src/shared/time.js';

/** TDD contract for src/shared/lines.ts (M9b). PLAN.md §21.4 / §21.2. */

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-09-18T20:00:00Z');
/** Kickoff 20 h out: every row seen inside 48 h of it gets the 3 h window. */
const KICKOFF = NOW + 20 * HOUR;

const EMPTY: Omit<LineRowView, 'provider' | 'capturedAt' | 'seenAt'> = {
  spreadHomeTenths: null,
  spreadHomePrice: null,
  spreadAwayTenths: null,
  spreadAwayPrice: null,
  spreadBook: null,
  totalTenths: null,
  totalOverPrice: null,
  totalUnderPrice: null,
  totalBook: null,
  mlHomePrice: null,
  mlAwayPrice: null,
  mlBook: null,
};
const SPREAD = {
  spreadHomeTenths: -35,
  spreadHomePrice: -110,
  spreadAwayTenths: 35,
  spreadAwayPrice: -110,
};
const TOTAL = { totalTenths: 535, totalOverPrice: -105, totalUnderPrice: -115 };
const ML = { mlHomePrice: -180, mlAwayPrice: 150 };

const primary = (over: Partial<LineRowView> = {}): LineRowView => ({
  ...EMPTY,
  ...SPREAD,
  ...TOTAL,
  ...ML,
  provider: LINE_PROVIDER_PRIMARY,
  capturedAt: NOW - 2 * HOUR,
  seenAt: NOW - 30 * MIN,
  ...over,
});
const secondary = (over: Partial<LineRowView> = {}): LineRowView => ({
  ...EMPTY,
  provider: LINE_PROVIDER_SECONDARY,
  capturedAt: NOW - 10 * MIN,
  seenAt: NOW - 10 * MIN,
  ...over,
});

describe('providerRank / marketProvider', () => {
  it('ranks the primary first, the secondary second, and anything else last', () => {
    expect(providerRank(LINE_PROVIDER_PRIMARY)).toBe(0);
    expect(providerRank(LINE_PROVIDER_SECONDARY)).toBe(1);
    expect(providerRank('someday-book')).toBe(LINE_PROVIDER_PRIORITY.length);
  });

  it('ranks by the NORMALISED provider string, so a row written under "Draft Kings" is still the primary', () => {
    // Rows already on the live D1 carry the space-variant ESPN served for a day.
    expect(providerRank('Draft Kings')).toBe(0);
    expect(providerRank('draftkings')).toBe(0);
    expect(providerRank('ODDS-API')).toBe(1);
    expect(providerRank('odds api')).toBe(1);
  });

  it('a fresh "Draft Kings" primary row beats a fresh secondary row on every market', () => {
    const spaced: LineRowView = { ...primary(), provider: 'Draft Kings' };
    const fill = secondary({
      ...SPREAD,
      spreadBook: 'fanduel',
      ...TOTAL,
      totalBook: 'fanduel',
      ...ML,
      mlBook: 'fanduel',
    });
    const line = mergeEffectiveLine([fill, spaced], KICKOFF, NOW);
    expect(line?.spread?.provider).toBe('Draft Kings');
    expect(line?.total?.provider).toBe('Draft Kings');
    expect(line?.moneyline?.provider).toBe('Draft Kings');
  });

  it('composes the provenance string the board shows and the leg records', () => {
    expect(marketProvider(LINE_PROVIDER_PRIMARY, null)).toBe('DraftKings');
    expect(marketProvider(LINE_PROVIDER_SECONDARY, 'fanduel')).toBe('odds-api:fanduel');
    expect(marketProvider(LINE_PROVIDER_SECONDARY, null)).toBe('odds-api');
  });
});

describe('mergeEffectiveLine — one primary row (what toLinesView produced)', () => {
  it('reproduces the old view: three markets, DraftKings on each, headline trio from the row', () => {
    const row = primary();
    const line = mergeEffectiveLine([row], KICKOFF, NOW);
    expect(line).toEqual({
      spread: {
        ...{ homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -110 },
        provider: 'DraftKings',
        capturedAt: row.capturedAt,
        seenAt: row.seenAt,
      },
      total: {
        tenths: 535,
        overPrice: -105,
        underPrice: -115,
        provider: 'DraftKings',
        capturedAt: row.capturedAt,
        seenAt: row.seenAt,
      },
      moneyline: {
        homePrice: -180,
        awayPrice: 150,
        provider: 'DraftKings',
        capturedAt: row.capturedAt,
        seenAt: row.seenAt,
      },
      provider: 'DraftKings',
      capturedAt: row.capturedAt,
      seenAt: row.seenAt,
      stale: false,
    });
  });

  it('zero rows → null (never priced)', () => {
    expect(mergeEffectiveLine([], KICKOFF, NOW)).toBeNull();
  });

  it('an all-NULL primary row that is FRESH → three null markets and stale: false (the ESPN "OFF" case)', () => {
    const row = primary({ ...EMPTY });
    const line = mergeEffectiveLine([row], KICKOFF, NOW);
    expect(line).not.toBeNull();
    expect(line?.spread).toBeNull();
    expect(line?.total).toBeNull();
    expect(line?.moneyline).toBeNull();
    expect(line?.stale).toBe(false);
    expect(line?.provider).toBe('DraftKings');
  });

  it('an all-NULL primary row that is STALE is still "no line", not the stale banner', () => {
    const row = primary({ ...EMPTY, seenAt: NOW - 4 * HOUR });
    expect(mergeEffectiveLine([row], KICKOFF, NOW)?.stale).toBe(false);
  });

  it('a half-spread (one price missing) drops the spread; the other markets survive', () => {
    const line = mergeEffectiveLine([primary({ spreadAwayPrice: null })], KICKOFF, NOW);
    expect(line?.spread).toBeNull();
    expect(line?.total).not.toBeNull();
    expect(line?.moneyline).not.toBeNull();
    expect(line?.stale).toBe(false);
  });

  it('a stale primary row alone → every market null, stale: true', () => {
    const row = primary({ seenAt: NOW - 3 * HOUR - 1 });
    const line = mergeEffectiveLine([row], KICKOFF, NOW);
    expect(line?.spread).toBeNull();
    expect(line?.total).toBeNull();
    expect(line?.moneyline).toBeNull();
    expect(line?.stale).toBe(true);
  });

  it('never throws on nonsense in a row (NaN, non-integers), it just loses that market', () => {
    const line = mergeEffectiveLine(
      [primary({ spreadHomeTenths: Number.NaN, totalTenths: 53.5 })],
      KICKOFF,
      NOW,
    );
    expect(line?.spread).toBeNull();
    expect(line?.total).toBeNull();
    expect(line?.moneyline).not.toBeNull();
  });
});

describe('mergeEffectiveLine — the §21.4 worked example and the merge rules', () => {
  const dkOff = primary({
    totalTenths: null,
    totalOverPrice: null,
    totalUnderPrice: null,
    mlHomePrice: null,
    mlAwayPrice: null,
  });
  const fill = secondary({ ...TOTAL, totalBook: 'draftkings', ...ML, mlBook: 'fanduel' });

  it('primary spread + secondary DraftKings total + secondary FanDuel moneyline, exactly', () => {
    const line = mergeEffectiveLine([dkOff, fill], KICKOFF, NOW);
    expect(line?.spread).toEqual({
      homeTenths: -35,
      homePrice: -110,
      awayTenths: 35,
      awayPrice: -110,
      provider: 'DraftKings',
      capturedAt: dkOff.capturedAt,
      seenAt: dkOff.seenAt,
    });
    expect(line?.total).toEqual({
      tenths: 535,
      overPrice: -105,
      underPrice: -115,
      provider: 'odds-api:draftkings',
      capturedAt: fill.capturedAt,
      seenAt: fill.seenAt,
    });
    expect(line?.moneyline).toEqual({
      homePrice: -180,
      awayPrice: 150,
      provider: 'odds-api:fanduel',
      capturedAt: fill.capturedAt,
      seenAt: fill.seenAt,
    });
    expect(line?.provider).toBe('DraftKings');
    expect(line?.capturedAt).toBe(dkOff.capturedAt);
    expect(line?.seenAt).toBe(dkOff.seenAt);
    expect(line?.stale).toBe(false);
  });

  it('is order-independent', () => {
    expect(mergeEffectiveLine([fill, dkOff], KICKOFF, NOW)).toEqual(
      mergeEffectiveLine([dkOff, fill], KICKOFF, NOW),
    );
  });

  it('the primary comes back: a total on the primary row wins over the secondary total', () => {
    const line = mergeEffectiveLine(
      [primary({ mlHomePrice: null, mlAwayPrice: null }), fill],
      KICKOFF,
      NOW,
    );
    expect(line?.total?.provider).toBe('DraftKings');
    expect(line?.moneyline?.provider).toBe('odds-api:fanduel');
  });

  it('staleness is PER ROW: a 4 h-old primary loses its markets, a 10 min-old secondary keeps its own', () => {
    const line = mergeEffectiveLine([primary({ seenAt: NOW - 4 * HOUR }), fill], KICKOFF, NOW);
    expect(line?.spread).toBeNull();
    expect(line?.total?.provider).toBe('odds-api:draftkings');
    expect(line?.moneyline?.provider).toBe('odds-api:fanduel');
    expect(line?.stale).toBe(false);
    // The headline trio is the highest-priority SURVIVING market's row.
    expect(line?.provider).toBe('odds-api');
    expect(line?.seenAt).toBe(fill.seenAt);
  });

  it('all rows stale → every market null and stale: true', () => {
    const line = mergeEffectiveLine(
      [
        primary({ seenAt: NOW - 4 * HOUR }),
        secondary({ ...TOTAL, totalBook: 'fanduel', seenAt: NOW - 4 * HOUR }),
      ],
      KICKOFF,
      NOW,
    );
    expect(line?.spread).toBeNull();
    expect(line?.total).toBeNull();
    expect(line?.moneyline).toBeNull();
    expect(line?.stale).toBe(true);
  });

  it('an unknown provider sorts last but is usable when it is the only one offering a market', () => {
    const odd: LineRowView = {
      ...secondary({ ...TOTAL, totalBook: null }),
      provider: 'someday-book',
    };
    const line = mergeEffectiveLine(
      [primary({ totalTenths: null, totalOverPrice: null, totalUnderPrice: null }), odd],
      KICKOFF,
      NOW,
    );
    expect(line?.total?.provider).toBe('someday-book');
    const both = mergeEffectiveLine([primary(), odd], KICKOFF, NOW);
    expect(both?.total?.provider).toBe('DraftKings');
  });

  it('two rows of the same rank: the more recently SEEN wins, then provider ASC', () => {
    const a: LineRowView = {
      ...secondary({ ...TOTAL, totalBook: 'a' }),
      provider: 'zeta',
      seenAt: NOW - 20 * MIN,
    };
    const b: LineRowView = {
      ...secondary({ ...TOTAL, totalBook: 'b' }),
      provider: 'alpha',
      seenAt: NOW - 20 * MIN,
    };
    const c: LineRowView = {
      ...secondary({ ...TOTAL, totalBook: 'c' }),
      provider: 'omega',
      seenAt: NOW - 5 * MIN,
    };
    expect(mergeEffectiveLine([a, b, c], KICKOFF, NOW)?.total?.provider).toBe('omega:c');
    expect(mergeEffectiveLine([a, b], KICKOFF, NOW)?.total?.provider).toBe('alpha:b');
  });

  it('MONOTONICITY: a market present at now is present at every instant up to its window and never reappears', () => {
    const row = primary({ seenAt: NOW - 10 * MIN });
    const window = lineStaleAfterMs(KICKOFF, row.seenAt);
    const edge = row.seenAt + window;
    for (const t of [NOW, NOW + 1, edge - 1, edge]) {
      expect(mergeEffectiveLine([row], KICKOFF, t)?.spread, String(t)).not.toBeNull();
    }
    for (const t of [edge + 1, edge + HOUR, edge + 48 * HOUR]) {
      expect(mergeEffectiveLine([row], KICKOFF, t)?.spread, String(t)).toBeNull();
    }
  });
});

describe('missingMarkets (PLAN.md §21.2)', () => {
  const line = (over: Partial<EffectiveLine>): EffectiveLine => ({
    spread: {
      homeTenths: -35,
      homePrice: -110,
      awayTenths: 35,
      awayPrice: -110,
      provider: 'DraftKings',
      capturedAt: NOW,
      seenAt: NOW,
    },
    total: {
      tenths: 535,
      overPrice: -105,
      underPrice: -115,
      provider: 'DraftKings',
      capturedAt: NOW,
      seenAt: NOW,
    },
    moneyline: {
      homePrice: -180,
      awayPrice: 150,
      provider: 'DraftKings',
      capturedAt: NOW,
      seenAt: NOW,
    },
    provider: 'DraftKings',
    capturedAt: NOW,
    seenAt: NOW,
    stale: false,
    ...over,
  });
  const spreadOf = (homeTenths: number): EffectiveLine['spread'] => ({
    homeTenths,
    homePrice: -110,
    awayTenths: -homeTenths,
    awayPrice: -110,
    provider: 'DraftKings',
    capturedAt: NOW,
    seenAt: NOW,
  });

  it('a full line has no gaps', () => {
    expect(missingMarkets(line({}))).toEqual({
      spread: false,
      total: false,
      moneyline: false,
      any: false,
    });
  });

  it('spread absent → gap; total absent → gap', () => {
    expect(missingMarkets(line({ spread: null })).spread).toBe(true);
    expect(missingMarkets(line({ total: null })).total).toBe(true);
    expect(missingMarkets(line({ total: null })).any).toBe(true);
  });

  it('moneyline absent at a −29.5 spread → gap; at −30.0 and −40.5 → NOT a gap; at +30.0 → not a gap', () => {
    expect(missingMarkets(line({ moneyline: null, spread: spreadOf(-295) })).moneyline).toBe(true);
    expect(missingMarkets(line({ moneyline: null, spread: spreadOf(-300) })).moneyline).toBe(false);
    expect(missingMarkets(line({ moneyline: null, spread: spreadOf(-405) })).moneyline).toBe(false);
    expect(missingMarkets(line({ moneyline: null, spread: spreadOf(300) })).moneyline).toBe(false);
    expect(MONEYLINE_NOT_OFFERED_SPREAD_TENTHS).toBe(300);
  });

  it('moneyline absent with no spread at all → gap', () => {
    const gaps = missingMarkets(line({ moneyline: null, spread: null }));
    expect(gaps).toEqual({ spread: true, total: false, moneyline: true, any: true });
  });

  it('null (never priced) → three gaps', () => {
    expect(missingMarkets(null)).toEqual({ spread: true, total: true, moneyline: true, any: true });
  });
});
