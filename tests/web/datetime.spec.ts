import { describe, expect, it } from 'vitest';

import {
  footballWeekStart,
  formatCountdown,
  formatDateRange,
  localDateKey,
} from '../../src/web/lib/datetime.js';
import { localMs } from './factories.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('localDateKey', () => {
  it('is YYYY-MM-DD in the viewer local timezone', () => {
    expect(localDateKey(localMs(2026, 9, 11, 13))).toBe('2026-09-11');
  });

  it('puts a late-night local kickoff on the LOCAL day, not the UTC one', () => {
    // 23:30 local on Sep 12 is Sep 13 UTC anywhere west of Greenwich; the board
    // must still file it under Saturday.
    expect(localDateKey(localMs(2026, 9, 12, 23, 30))).toBe('2026-09-12');
  });

  it('agrees for two instants on the same local day and differs across midnight', () => {
    expect(localDateKey(localMs(2026, 9, 11, 0, 1))).toBe(
      localDateKey(localMs(2026, 9, 11, 23, 59)),
    );
    expect(localDateKey(localMs(2026, 9, 11, 23, 59))).not.toBe(localDateKey(localMs(2026, 9, 12)));
  });
});

describe('formatCountdown', () => {
  it('returns null once the deadline has passed', () => {
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-1)).toBeNull();
  });

  it('collapses under a minute rather than showing seconds', () => {
    expect(formatCountdown(59_000)).toBe('< 1 min');
    expect(formatCountdown(1)).toBe('< 1 min');
  });

  it('renders minutes, hours and days', () => {
    expect(formatCountdown(4 * MINUTE)).toBe('4m');
    expect(formatCountdown(59 * MINUTE)).toBe('59m');
    expect(formatCountdown(2 * HOUR)).toBe('2h');
    expect(formatCountdown(2 * HOUR + 14 * MINUTE)).toBe('2h 14m');
    expect(formatCountdown(3 * DAY)).toBe('3d');
    expect(formatCountdown(3 * DAY + 5 * HOUR)).toBe('3d 5h');
  });

  it('rounds DOWN, so a button never claims more time than remains', () => {
    expect(formatCountdown(2 * MINUTE - 1)).toBe('1m');
    expect(formatCountdown(HOUR - 1)).toBe('59m');
  });
});

describe('footballWeekStart', () => {
  it('anchors to Tuesday 00:00 local', () => {
    const start = new Date(footballWeekStart(localMs(2026, 9, 11, 20)));
    expect(start.getDay()).toBe(2);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });

  it('keeps a Thursday opener and the following Monday nighter in ONE bucket', () => {
    // 2026-09-10 is a Thursday; 2026-09-14 is the Monday after it.
    const thursday = footballWeekStart(localMs(2026, 9, 10, 20, 15));
    const sunday = footballWeekStart(localMs(2026, 9, 13, 13));
    const monday = footballWeekStart(localMs(2026, 9, 14, 20, 15));
    expect(sunday).toBe(thursday);
    expect(monday).toBe(thursday);
  });

  it('starts a new bucket on the next Tuesday', () => {
    const monday = footballWeekStart(localMs(2026, 9, 14, 20));
    const tuesday = footballWeekStart(localMs(2026, 9, 15, 0, 1));
    expect(tuesday).toBeGreaterThan(monday);
  });

  it('is idempotent', () => {
    const once = footballWeekStart(localMs(2026, 9, 11, 20));
    expect(footballWeekStart(once)).toBe(once);
  });
});

describe('formatDateRange', () => {
  it('collapses a single day', () => {
    const day = localMs(2026, 9, 11, 13);
    expect(formatDateRange(day, day)).not.toContain('–');
  });

  it('renders both ends of a real range', () => {
    expect(formatDateRange(localMs(2026, 9, 11), localMs(2026, 9, 15))).toContain('–');
  });
});
