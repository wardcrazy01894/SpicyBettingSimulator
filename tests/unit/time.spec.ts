import { describe, expect, it } from 'vitest';

import { BET_CUTOFF_BUFFER_MS } from '../../src/shared/constants.js';
import {
  ET_TIME_ZONE,
  MS_PER_DAY,
  etDateKey,
  etDateKeyRange,
  etDayBounds,
  lockAtFor,
  parseIsoToEpochMs,
} from '../../src/shared/time.js';

/** TDD contract for src/shared/time.ts (M2c). See also Spike S4. */

/** Every vector below was produced with Intl in America/New_York, not by hand. */
const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`bad test vector: ${iso}`);
  return ms;
};

describe('etDateKey', () => {
  it('a 00:20Z Sunday kickoff maps to the SATURDAY ET date key', () => {
    // Spike S4: dates=20260913 returns 13 NFL games INCLUDING this SNF kickoff.
    expect(etDateKey(at('2026-09-14T00:20Z'))).toBe('20260913');
  });

  it('a 17:00Z Sunday kickoff maps to that Sunday', () => {
    expect(etDateKey(at('2026-09-13T17:00Z'))).toBe('20260913');
  });

  it('pins the verified Spike S4 buckets for the Monday-night game', () => {
    // dates=20260914 returned exactly 1 game, MNF DEN@KC at 2026-09-15T00:15Z.
    expect(etDateKey(at('2026-09-15T00:15Z'))).toBe('20260914');
  });

  it('is correct across the November DST transition', () => {
    // DST ends 2026-11-01 02:00 EDT (= 06:00Z). A 00:30Z kickoff that night is
    // still 2026-10-31 20:30 EDT.
    expect(etDateKey(at('2026-11-01T00:30Z'))).toBe('20261031');
    expect(etDateKey(at('2026-11-01T03:59Z'))).toBe('20261031'); // 23:59 EDT Oct 31
    expect(etDateKey(at('2026-11-01T04:59Z'))).toBe('20261101'); // 00:59 EDT Nov 1
    // The repeated 01:30 local hour: EDT then EST, both still Nov 1.
    expect(etDateKey(at('2026-11-01T05:30Z'))).toBe('20261101');
    expect(etDateKey(at('2026-11-01T06:30Z'))).toBe('20261101');
  });

  it('is correct across the March DST transition', () => {
    // DST starts 2026-03-08 02:00 EST -> 03:00 EDT (= 07:00Z).
    expect(etDateKey(at('2026-03-08T04:30Z'))).toBe('20260307'); // 23:30 EST Mar 7
    expect(etDateKey(at('2026-03-08T05:00Z'))).toBe('20260308'); // 00:00 EST Mar 8
    expect(etDateKey(at('2026-03-08T06:59Z'))).toBe('20260308'); // 01:59 EST
    expect(etDateKey(at('2026-03-08T07:00Z'))).toBe('20260308'); // 03:00 EDT
  });

  it('is correct across UTC midnight in both directions', () => {
    // UTC midnight is the PREVIOUS ET day, summer and winter alike.
    expect(etDateKey(at('2026-09-13T00:00Z'))).toBe('20260912');
    expect(etDateKey(at('2026-01-15T00:00Z'))).toBe('20260114');
    // ET midnight is 04:00Z in summer, 05:00Z in winter.
    expect(etDateKey(at('2026-09-13T03:59Z'))).toBe('20260912');
    expect(etDateKey(at('2026-09-13T04:00Z'))).toBe('20260913');
    expect(etDateKey(at('2026-01-15T04:59Z'))).toBe('20260114');
    expect(etDateKey(at('2026-01-15T05:00Z'))).toBe('20260115');
  });

  it('returns a zero-padded YYYYMMDD, never a locale string', () => {
    expect(etDateKey(at('2026-01-02T17:00Z'))).toBe('20260102');
    expect(etDateKey(at('2026-01-02T17:00Z'))).toMatch(/^\d{8}$/);
  });

  it('names America/New_York as the one timezone in the system', () => {
    expect(ET_TIME_ZONE).toBe('America/New_York');
  });

  it('reproduces the committed NFL sample buckets exactly (PLAN.md §8.2)', () => {
    const kickoffs = [
      '2026-09-10T00:15Z', // Wed night ET -> 20260909
      '2026-09-11T00:20Z', // Thu night ET -> 20260910
      '2026-09-13T17:00Z', // Sun 1pm ET   -> 20260913
      '2026-09-14T00:20Z', // SNF          -> 20260913
      '2026-09-15T00:15Z', // MNF          -> 20260914
    ];
    expect(kickoffs.map((iso) => etDateKey(at(iso)))).toEqual([
      '20260909',
      '20260910',
      '20260913',
      '20260913',
      '20260914',
    ]);
  });
});

describe('etDayBounds', () => {
  it('brackets an ordinary summer day at 04:00Z to 04:00Z', () => {
    const bounds = etDayBounds(at('2026-09-13T17:00Z'));
    expect(bounds.startAt).toBe(at('2026-09-13T04:00Z'));
    expect(bounds.endAt).toBe(at('2026-09-14T04:00Z'));
    expect(bounds.endAt - bounds.startAt).toBe(MS_PER_DAY);
  });

  it('brackets an ordinary winter day at 05:00Z to 05:00Z', () => {
    const bounds = etDayBounds(at('2026-01-15T17:00Z'));
    expect(bounds.startAt).toBe(at('2026-01-15T05:00Z'));
    expect(bounds.endAt).toBe(at('2026-01-16T05:00Z'));
  });

  it('the day DST ends is 25 hours long', () => {
    const bounds = etDayBounds(at('2026-11-01T17:00Z'));
    expect(bounds.startAt).toBe(at('2026-11-01T04:00Z'));
    expect(bounds.endAt).toBe(at('2026-11-02T05:00Z'));
    expect(bounds.endAt - bounds.startAt).toBe(25 * 60 * 60 * 1000);
  });

  it('the day DST starts is 23 hours long', () => {
    const bounds = etDayBounds(at('2026-03-08T17:00Z'));
    expect(bounds.startAt).toBe(at('2026-03-08T05:00Z'));
    expect(bounds.endAt).toBe(at('2026-03-09T04:00Z'));
    expect(bounds.endAt - bounds.startAt).toBe(23 * 60 * 60 * 1000);
  });

  it('is idempotent: the start of a day bounds to the same day', () => {
    const bounds = etDayBounds(at('2026-11-01T17:00Z'));
    expect(etDayBounds(bounds.startAt)).toEqual(bounds);
    expect(etDateKey(bounds.startAt)).toBe('20261101');
    // endAt is EXCLUSIVE: it is the first instant of the next ET day.
    expect(etDateKey(bounds.endAt)).toBe('20261102');
    expect(etDateKey(bounds.endAt - 1)).toBe('20261101');
  });
});

describe('etDateKeyRange', () => {
  it('a 10-day window yields 10 or 11 keys, inclusive of both ends', () => {
    const from = at('2026-09-13T17:00Z');
    const keys = etDateKeyRange(from, from + 10 * MS_PER_DAY);
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(keys.length).toBeLessThanOrEqual(11);
    expect(keys[0]).toBe('20260913');
    expect(keys.at(-1)).toBe('20260923');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('handles a range that crosses the November DST boundary without duplicating a key', () => {
    const keys = etDateKeyRange(at('2026-10-30T12:00Z'), at('2026-11-03T12:00Z'));
    expect(keys).toEqual(['20261030', '20261031', '20261101', '20261102', '20261103']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('handles a range that crosses the March DST boundary without skipping a key', () => {
    const keys = etDateKeyRange(at('2026-03-06T12:00Z'), at('2026-03-10T12:00Z'));
    expect(keys).toEqual(['20260306', '20260307', '20260308', '20260309', '20260310']);
  });

  it('a range inside one ET day yields exactly that one key', () => {
    expect(etDateKeyRange(at('2026-09-13T17:00Z'), at('2026-09-14T00:20Z'))).toEqual(['20260913']);
  });

  it('returns an empty list when `to` precedes `from`', () => {
    expect(etDateKeyRange(at('2026-09-14T00:00Z'), at('2026-09-13T00:00Z'))).toEqual([]);
  });

  it('covers the ingest planner window (now .. now + 10d) with 11 keys at most', () => {
    // PLAN.md §8.4: 11 ET dates x 2 leagues = 22 targets.
    const keys = etDateKeyRange(at('2026-09-13T12:00Z'), at('2026-09-23T12:00Z'));
    expect(keys).toHaveLength(11);
  });
});

describe('parseIsoToEpochMs', () => {
  it('parses "2026-09-13T17:00Z" (no seconds, as ESPN emits it)', () => {
    expect(parseIsoToEpochMs('2026-09-13T17:00Z')).toBe(1789318800000);
  });

  it('parses a full ISO timestamp with seconds and milliseconds', () => {
    expect(parseIsoToEpochMs('2026-09-13T17:00:00Z')).toBe(1789318800000);
    expect(parseIsoToEpochMs('2026-09-13T17:00:00.000Z')).toBe(1789318800000);
  });

  it('honours a numeric UTC offset', () => {
    expect(parseIsoToEpochMs('2026-09-13T13:00-04:00')).toBe(1789318800000);
  });

  it('returns null for a non-string or an unparseable string', () => {
    expect(parseIsoToEpochMs(null)).toBeNull();
    expect(parseIsoToEpochMs(undefined)).toBeNull();
    expect(parseIsoToEpochMs(1789318800000)).toBeNull();
    expect(parseIsoToEpochMs({})).toBeNull();
    expect(parseIsoToEpochMs('')).toBeNull();
    expect(parseIsoToEpochMs('not-a-date')).toBeNull();
    expect(parseIsoToEpochMs('2026-13-45T99:99Z')).toBeNull();
  });

  it('rejects the loose formats Date.parse would otherwise accept', () => {
    // Implementation-defined Date.parse fallbacks must not become kickoff times.
    expect(parseIsoToEpochMs('Sep 13 2026')).toBeNull();
    expect(parseIsoToEpochMs('09/13/2026')).toBeNull();
  });
});

describe('lockAtFor', () => {
  it('subtracts exactly BET_CUTOFF_BUFFER_MS', () => {
    const kickoff = at('2026-09-13T17:00Z');
    expect(lockAtFor(kickoff)).toBe(kickoff - BET_CUTOFF_BUFFER_MS);
    expect(kickoff - lockAtFor(kickoff)).toBe(60_000);
  });
});
