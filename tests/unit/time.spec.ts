import { describe, expect, it } from 'vitest';

import {
  BET_CUTOFF_BUFFER_MS,
  INGEST_WINDOW_MS,
  LINE_STALE_MS,
  NCAAF_WEEK_ROLLOVER_ET_HOUR,
  NFL_WEEK_ROLLOVER_ET_HOUR,
} from '../../src/shared/constants.js';
import {
  ET_TIME_ZONE,
  MS_PER_DAY,
  boardWindowEnd,
  etDateKey,
  etDateKeyRange,
  etDayBounds,
  lockAtFor,
  parseIsoToEpochMs,
  expectedRefreshMs,
  lineStaleAfterMs,
  REFRESH_DISCOVERY_MS,
  REFRESH_LIVE_MS,
  REFRESH_SOON_MS,
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
    // No Z/offset: Node would read local time and workerd UTC — refused outright.
    expect(parseIsoToEpochMs('2026-09-13T17:00')).toBeNull();
    expect(parseIsoToEpochMs('2026-09-13T17:00:00')).toBeNull();
    // Space separator goes through V8's legacy parser — refused.
    expect(parseIsoToEpochMs('2026-09-13 17:00Z')).toBeNull();
    // Calendar rollover that Date.parse would silently turn into March 2.
    expect(parseIsoToEpochMs('2026-02-30T00:00Z')).toBeNull();
    expect(parseIsoToEpochMs('2026-02-28T00:00Z')).toBe(Date.UTC(2026, 1, 28));
    expect(parseIsoToEpochMs('2024-02-29T00:00Z')).toBe(Date.UTC(2024, 1, 29));
    expect(parseIsoToEpochMs('2026-02-29T00:00Z')).toBeNull();
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

describe('expectedRefreshMs / lineStaleAfterMs (PLAN §8.4 / §8.5)', () => {
  const HOUR = 60 * 60 * 1000;
  const T = Date.UTC(2026, 8, 14, 12, 0, 0);

  it('expectedRefreshMs follows the three tiers by distance to kickoff', () => {
    expect(expectedRefreshMs(T + 1 * HOUR, T)).toBe(REFRESH_LIVE_MS);
    expect(expectedRefreshMs(T + 3 * HOUR, T)).toBe(REFRESH_LIVE_MS);
    expect(expectedRefreshMs(T + 3 * HOUR + 1, T)).toBe(REFRESH_SOON_MS);
    expect(expectedRefreshMs(T + 48 * HOUR, T)).toBe(REFRESH_SOON_MS);
    expect(expectedRefreshMs(T + 48 * HOUR + 1, T)).toBe(REFRESH_DISCOVERY_MS);
    expect(expectedRefreshMs(T + 5 * 24 * HOUR, T)).toBe(REFRESH_DISCOVERY_MS);
    // A scheduled game already past kickoff sits in the live tier.
    expect(expectedRefreshMs(T - HOUR, T)).toBe(REFRESH_LIVE_MS);
  });

  it('the window is 3 cycles at the tier when the line was SEEN, floored at 3 h', () => {
    // Seen inside 3 h: 3 × 15 min = 45 min, floored to 3 h.
    expect(lineStaleAfterMs(T + HOUR, T)).toBe(LINE_STALE_MS);
    // Seen inside 48 h: 3 × 1 h = 3 h.
    expect(lineStaleAfterMs(T + 24 * HOUR, T)).toBe(LINE_STALE_MS);
    expect(lineStaleAfterMs(T + 48 * HOUR, T)).toBe(LINE_STALE_MS);
    // Seen further out: 3 × 6 h = 18 h.
    expect(lineStaleAfterMs(T + 49 * HOUR, T)).toBe(18 * HOUR);
    expect(lineStaleAfterMs(T + 72 * HOUR, T)).toBe(18 * HOUR);
  });

  it('is monotone: a line fresh now cannot go stale just because kickoff got closer', () => {
    // Seen 60 h before kickoff (discovery tier → 18 h window). Ten hours later
    // the game is 50 h out; two hours after that it crosses the 48 h boundary.
    // The window was fixed at confirmation, so the line is fresh throughout
    // and stale only once 18 h have passed.
    const kickoff = T + 60 * HOUR;
    const seenAt = T;
    const window = lineStaleAfterMs(kickoff, seenAt);
    expect(window).toBe(18 * HOUR);
    for (const later of [10 * HOUR, 12 * HOUR + 1, 17 * HOUR]) {
      expect(later > window).toBe(false);
    }
    expect(18 * HOUR + 1 > window).toBe(true);
  });

  it('never shortens the old flat window', () => {
    for (const ahead of [-2 * HOUR, 0, HOUR, 3 * HOUR, 30 * HOUR, 48 * HOUR, 200 * HOUR]) {
      expect(lineStaleAfterMs(T + ahead, T)).toBeGreaterThanOrEqual(LINE_STALE_MS);
    }
  });
});

/* ------------------------------------------------------------------ *
 * boardWindowEnd — PLAN.md §22 (M9-0)
 * ------------------------------------------------------------------ */

/** The epoch ms of an ET wall-clock instant, DST-correct, via Intl (never by hand). */
const HOUR_MS = 3_600_000;
const etWall = (key: string, hh: number, mm = 0, ss = 0, ms = 0): number => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  const d = Number(key.slice(6, 8));
  const { startAt } = etDayBounds(Date.UTC(y, m - 1, d, 12)); // noon UTC is inside that ET date
  let at = startAt + hh * HOUR_MS + mm * 60_000 + ss * 1000 + ms;
  const hourOf = (t: number): number =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: ET_TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(t))
        .find((x) => x.type === 'hour')?.value,
    );
  // A 23 h or 25 h ET day shifts wall clocks after 02:00 by an hour; correct once.
  if (hourOf(at) < hh) at += HOUR_MS;
  else if (hourOf(at) > hh) at -= HOUR_MS;
  expect(hourOf(at)).toBe(hh);
  expect(etDateKey(at)).toBe(key);
  return at;
};
const spanDays = (now: number, end: number): number => (end + 1 - now) / MS_PER_DAY;
const isLastInstantOfEtDay = (end: number): boolean => etDayBounds(end + 1).startAt === end + 1;

describe('boardWindowEnd (PLAN.md §22)', () => {
  it("reproduces every row of §22.2's table, as ET date keys", () => {
    const rows: [string, number, 'nfl' | 'ncaaf', string, number, number][] = [
      // now key, ET hour, league, end key, span d, keys planned
      ['20260918', 12, 'nfl', '20260921', 3.5, 4],
      ['20260918', 12, 'ncaaf', '20260921', 3.5, 4],
      ['20260919', 12, 'nfl', '20260921', 2.5, 3],
      ['20260919', 12, 'ncaaf', '20260921', 2.5, 3],
      ['20260920', 0, 'ncaaf', '20260928', 9.0, 9],
      ['20260920', 0, 'nfl', '20260921', 2.0, 2],
      ['20260920', 20, 'nfl', '20260928', 8.166, 9],
      ['20260921', 12, 'nfl', '20260928', 7.5, 8],
      ['20260921', 12, 'ncaaf', '20260928', 7.5, 8],
      ['20260922', 12, 'nfl', '20260928', 6.5, 7],
      ['20260923', 12, 'ncaaf', '20260928', 5.5, 6],
    ];
    for (const [key, hour, league, endKey, span, keys] of rows) {
      const now = etWall(key, hour);
      const end = boardWindowEnd(league, now);
      expect(etDateKey(end), `${league} ${key} ${String(hour)}:00`).toBe(endKey);
      expect(isLastInstantOfEtDay(end)).toBe(true);
      expect(spanDays(now, end)).toBeCloseTo(span, 1);
      expect(etDateKeyRange(now, end)).toHaveLength(keys);
    }
  });

  it('Sunday 19:59:59.999 ET has NOT rolled the NFL over; 20:00:00.000 has', () => {
    expect(etDateKey(boardWindowEnd('nfl', etWall('20260920', 19, 59, 59, 999)))).toBe('20260921');
    expect(etDateKey(boardWindowEnd('nfl', etWall('20260920', NFL_WEEK_ROLLOVER_ET_HOUR)))).toBe(
      '20260928',
    );
  });

  it('the CFB rollover straddles ET midnight: Saturday 23:59:59.999 vs Sunday 00:00:00.000', () => {
    expect(etDateKey(boardWindowEnd('ncaaf', etWall('20260919', 23, 59, 59, 999)))).toBe(
      '20260921',
    );
    expect(
      etDateKey(boardWindowEnd('ncaaf', etWall('20260920', NCAAF_WEEK_ROLLOVER_ET_HOUR))),
    ).toBe('20260928');
  });

  it('Monday 00:00:00.000 and 23:59:59.999 both give the FOLLOWING Monday (clause b)', () => {
    for (const league of ['nfl', 'ncaaf'] as const) {
      const early = etWall('20260921', 0);
      const late = etWall('20260921', 23, 59, 59, 999);
      expect(etDateKey(boardWindowEnd(league, early))).toBe('20260928');
      expect(etDateKey(boardWindowEnd(league, late))).toBe('20260928');
      expect(spanDays(early, boardWindowEnd(league, early))).toBeCloseTo(8.0, 2);
      expect(spanDays(late, boardWindowEnd(league, late))).toBeCloseTo(7.0, 2);
      expect(etDateKeyRange(early, boardWindowEnd(league, early))).toHaveLength(8);
    }
  });

  it('Tuesday 00:00 gives the Monday six days later — the window does NOT extend again', () => {
    for (const league of ['nfl', 'ncaaf'] as const) {
      const tue = etWall('20260922', 0);
      expect(etDateKey(boardWindowEnd(league, tue))).toBe('20260928');
      expect(etDateKeyRange(tue, boardWindowEnd(league, tue))).toHaveLength(7);
    }
  });

  it('a Sunday after the rollover and the Monday after it return the SAME instant', () => {
    expect(boardWindowEnd('nfl', etWall('20260920', 21))).toBe(
      boardWindowEnd('nfl', etWall('20260921', 9)),
    );
    expect(boardWindowEnd('ncaaf', etWall('20260920', 1))).toBe(
      boardWindowEnd('ncaaf', etWall('20260921', 9)),
    );
  });

  it('fall back (Sun 2026-11-01, a 25 h day): CFB 00:30 → 11-09; NFL 19:59 → 11-02, 20:00 → 11-09', () => {
    const cfb = etWall('20261101', 0, 30);
    expect(etDateKey(boardWindowEnd('ncaaf', cfb))).toBe('20261109');
    expect(spanDays(cfb, boardWindowEnd('ncaaf', cfb))).toBeCloseTo(9.02, 2);
    expect(etDateKey(boardWindowEnd('nfl', etWall('20261101', 19, 59)))).toBe('20261102');
    const nfl = etWall('20261101', 20);
    expect(etDateKey(boardWindowEnd('nfl', nfl))).toBe('20261109');
    expect(spanDays(nfl, boardWindowEnd('nfl', nfl))).toBeCloseTo(8.166, 2);
  });

  it('spring forward (Sun 2026-03-08, a 23 h day): CFB 00:30 → 03-16 (8.94 d); NFL 20:00 → 03-16', () => {
    const cfb = etWall('20260308', 0, 30);
    expect(etDateKey(boardWindowEnd('ncaaf', cfb))).toBe('20260316');
    expect(spanDays(cfb, boardWindowEnd('ncaaf', cfb))).toBeCloseTo(8.94, 2);
    expect(etDateKey(boardWindowEnd('nfl', etWall('20260308', 20)))).toBe('20260316');
  });

  it('a window that CONTAINS the fall-back transition still ends on its Monday with no key skipped', () => {
    const tue = etWall('20261027', 12); // Tuesday of the fall-back week
    const end = boardWindowEnd('nfl', tue);
    expect(etDateKey(end)).toBe('20261102');
    expect(etDateKeyRange(tue, end)).toEqual([
      '20261027',
      '20261028',
      '20261029',
      '20261030',
      '20261031',
      '20261101',
      '20261102',
    ]);
  });

  it('month and year boundaries: Wed 09-30 → Mon 10-05; Sun 12-27 20:00 → Mon 2027-01-04', () => {
    expect(etDateKey(boardWindowEnd('ncaaf', etWall('20260930', 12)))).toBe('20261005');
    expect(etDateKey(boardWindowEnd('nfl', etWall('20261227', 20)))).toBe('20270104');
  });

  it("over a year of 10-minute steps: always >= now, always a Monday's last instant, ≤ 9 keys, < the ceiling", () => {
    const start = etWall('20260801', 0);
    const stop = etWall('20270201', 0);
    const weekdayOf = (t: number): string =>
      new Intl.DateTimeFormat('en-US', { timeZone: ET_TIME_ZONE, weekday: 'short' }).format(
        new Date(t),
      );
    let maxSpan = 0;
    let minSpan = Infinity;
    for (let now = start; now < stop; now += 10 * 60_000) {
      for (const league of ['nfl', 'ncaaf'] as const) {
        const end = boardWindowEnd(league, now);
        if (end < now || !isLastInstantOfEtDay(end) || weekdayOf(end) !== 'Mon') {
          throw new Error(`bad end for ${league} at ${new Date(now).toISOString()}`);
        }
        const span = spanDays(now, end);
        maxSpan = span > maxSpan ? span : maxSpan;
        minSpan = span < minSpan ? span : minSpan;
        if (end - now > INGEST_WINDOW_MS) throw new Error('exceeds INGEST_WINDOW_MS');
      }
    }
    expect(maxSpan).toBeLessThan(9.05);
    expect(minSpan).toBeGreaterThan(1.16);
    // Key count at the widest points: a post-rollover Sunday.
    expect(
      etDateKeyRange(etWall('20260920', 0), boardWindowEnd('ncaaf', etWall('20260920', 0))),
    ).toHaveLength(9);
  });
});
