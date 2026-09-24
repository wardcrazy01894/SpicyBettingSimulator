/**
 * Date/time formatting for the UI. PLAN.md §12.3.
 *
 * Everything from the API is epoch ms UTC; everything here renders in the
 * VIEWER'S LOCAL timezone via `Intl.DateTimeFormat(undefined, ...)`, so a friend
 * in Denver sees Denver times. No timezone NAME is written here: the one US
 * Eastern question the board asks — which ET calendar date an MLB game is on
 * (PLAN.md §23.12) — is answered by the shared `etDateKey()`, the same
 * `Intl`/`America/New_York` function the ingest planner uses.
 *
 * DOM-FREE ON PURPOSE: `tests/web/datetime.spec.ts` runs in the node vitest
 * project (jsdom is not installed), so nothing in this file may touch `window`,
 * `document` or `localStorage`.
 */

import { etDateKey } from '../../shared/time.js';
import type { EpochMs } from '../../shared/types.js';

/**
 * Stable key for "the local calendar day this instant falls on", as
 * `YYYY-MM-DD`. Built from `formatToParts` rather than `toISOString` because the
 * latter is UTC and would put a 9pm Pacific kickoff on the following day.
 */
const DAY_KEY_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localDateKey(at: EpochMs): string {
  const parts = DAY_KEY_FORMAT.formatToParts(new Date(at));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

const DAY_HEADING_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** "Thu, Sep 11". The heading above a day group on the board. */
export function formatDayHeading(at: EpochMs): string {
  return DAY_HEADING_FORMAT.format(new Date(at));
}

/**
 * A pure calendar-date heading ("Thu, Sep 24") for a `YYYYMMDD` key, the
 * shape `etDateKey()` returns. The key is ALREADY the date, so it is rendered at
 * UTC noon in UTC — a formatting device with no zone arithmetic in it, which
 * cannot shift the day for any viewer.
 */
const CALENDAR_HEADING_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * The ET calendar date `at` falls on, as `{ dateKey: 'YYYY-MM-DD', label }`.
 * MLB's board is "today, US Eastern" (§23.5), so its day groups are ET dates:
 * a 10:15 PM EDT first pitch (02:15Z) stays on the day it was scheduled for.
 */
export function etCalendarDay(at: EpochMs): { readonly dateKey: string; readonly label: string } {
  const key = etDateKey(at);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6));
  const day = Number(key.slice(6, 8));
  return {
    dateKey: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
    label: CALENDAR_HEADING_FORMAT.format(new Date(Date.UTC(year, month - 1, day, 12))),
  };
}

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

/** "Sep 11". */
export function formatShortDate(at: EpochMs): string {
  return SHORT_DATE_FORMAT.format(new Date(at));
}

/** "Sep 11 – Sep 15", collapsed to "Sep 11" when both ends are the same day. */
export function formatDateRange(from: EpochMs, to: EpochMs): string {
  const a = formatShortDate(from);
  const b = formatShortDate(to);
  return a === b ? a : `${a} – ${b}`;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** "1:00 PM" in the viewer's locale and timezone. */
export function formatTime(at: EpochMs): string {
  return TIME_FORMAT.format(new Date(at));
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Sep 11, 1:00 PM". Used in the ledger and on bet cards. */
export function formatDateTime(at: EpochMs): string {
  return DATE_TIME_FORMAT.format(new Date(at));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Countdown to a lock time, at MINUTE granularity.
 *
 * Cosmetic by design (PLAN.md §12.3): the client clock may be wrong, so this
 * never gates a button — `GameCard.bettable` from the server does. Minute
 * granularity is deliberate: a per-second countdown would re-render up to 300
 * cards every tick on a phone for no information (the cutoff buffer is 60 s).
 *
 * Returns `null` when the deadline has passed, so callers render their own
 * "locked" state rather than a negative duration.
 */
export function formatCountdown(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  if (remainingMs < MINUTE_MS) return '< 1 min';
  if (remainingMs < HOUR_MS) return `${String(Math.trunc(remainingMs / MINUTE_MS))}m`;
  if (remainingMs < DAY_MS) {
    const hours = Math.trunc(remainingMs / HOUR_MS);
    const minutes = Math.trunc((remainingMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
  }
  const days = Math.trunc(remainingMs / DAY_MS);
  const hours = Math.trunc((remainingMs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${String(days)}d` : `${String(days)}d ${String(hours)}h`;
}

/**
 * The start of the local football week containing `at`, as epoch ms.
 *
 * Anchored to **Tuesday 00:00 local**, which is the only boundary that keeps a
 * Thursday-night opener and the following Monday-night game in ONE bucket, the
 * way ESPN's own `week` field does.
 *
 * This exists ONLY because the frozen wire contract does not carry `week` on
 * `BetView`/`BetLegView` (it does on `GameCard`). PLAN.md §12.3 wants My Bets
 * grouped by ESPN's authoritative week; with the data available we can group by
 * the equivalent local window but cannot render the week NUMBER. The board
 * (`GamesPage`) still uses the server's `week` and never computes one.
 */
export function footballWeekStart(at: EpochMs): EpochMs {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0 Sun .. 6 Sat. Days since the most recent Tuesday (2).
  const sinceTuesday = (d.getDay() - 2 + 7) % 7;
  d.setDate(d.getDate() - sinceTuesday);
  return d.getTime();
}
