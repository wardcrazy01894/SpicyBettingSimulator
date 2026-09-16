/**
 * Time helpers. Everything in the system is epoch MILLISECONDS, UTC.
 *
 * US Eastern appears in exactly TWO places, both of them calendars rather than
 * clocks:
 *
 *   1. ESPN's `dates=YYYYMMDD` parameter buckets by the US Eastern calendar day
 *      (an 8:20pm ET Saturday kickoff has a `date` of 00:20Z on Sunday but
 *      belongs to Saturday's bucket). See PLAN.md §8.2 and Spike S4.
 *   2. The BOARD WINDOW ends on the Monday ET date that closes the football
 *      week, and rolls over at an ET instant on Sunday (`boardWindowEnd`,
 *      PLAN.md §22). A football week is a US Eastern calendar object; there is
 *      no UTC expression of "Monday Night Football" that is not wrong twice a
 *      year.
 *
 * Nothing else in the system has a timezone: every stored instant is epoch ms.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only mechanism used:
 * it is an ECMA-402 built-in, not a platform global, and workerd ships the full
 * ICU tz database, so this file stays platform-free (PLAN.md §2.2) while being
 * DST-correct for free. Nothing here hard-codes -4 or -5 hours.
 */

import {
  BET_CUTOFF_BUFFER_MS,
  LINE_STALE_MS,
  LINE_STALE_MULTIPLIER,
  WEEK_ROLLOVER_ET_HOUR,
} from './constants.js';
import type { EpochMs, League } from './types.js';

export const ET_TIME_ZONE = 'America/New_York';
export const MS_PER_DAY = 86_400_000;

/**
 * ESPN emits `"2026-09-13T17:00Z"` — ISO 8601 with NO seconds. We accept that
 * plus the fuller ISO forms (seconds, fractions, numeric offsets) and a bare
 * date, and nothing else: no space separator, and NO time without a Z/offset
 * (Node parses that as local time, workerd as UTC). `Date.parse` also honours
 * implementation-defined formats ("Sep 13 2026"), and an implementation-defined
 * kickoff time is not something a betting lock should ever be derived from.
 */
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * One formatter, created once. Constructing an `Intl.DateTimeFormat` is the
 * expensive part (the 10 ms Worker CPU budget, PLAN.md §1), so the planner's
 * per-date loop reuses this instead of building one per call.
 */
const ET_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface EtParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function etParts(at: EpochMs): EtParts {
  const parts = ET_PARTS_FORMAT.formatToParts(new Date(at));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The UTC offset of America/New_York at `at`, in ms (so -4h in EDT, -5h in EST).
 * Derived by asking Intl what the wall clock reads and differencing, which is
 * the only offset source that cannot drift from the tz database.
 */
function etOffsetMs(at: EpochMs): number {
  const p = etParts(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `at` may carry sub-second precision that the parts above dropped.
  const truncatedAt = at - (((at % 1000) + 1000) % 1000);
  return asIfUtc - truncatedAt;
}

/** Epoch ms of ET midnight starting the given ET calendar date. */
function etMidnight(year: number, month: number, day: number): EpochMs {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Two passes: the offset measured at the naive instant may belong to the wrong
  // side of a DST transition; re-measuring at the first estimate fixes it. ET
  // midnight is never inside a skipped or repeated hour (US transitions happen
  // at 02:00 local), so the second pass is a fixed point.
  const firstPass = naive - etOffsetMs(naive);
  return naive - etOffsetMs(firstPass);
}

/** ESPN `dates=` key for a moment in time, in US Eastern. e.g. "20260913". */
export function etDateKey(at: EpochMs): string {
  const p = etParts(at);
  const month = p.month < 10 ? `0${String(p.month)}` : String(p.month);
  const day = p.day < 10 ? `0${String(p.day)}` : String(p.day);
  return `${String(p.year)}${month}${day}`;
}

/**
 * Midnight-to-midnight ET bounds of the day containing `at`, as epoch ms.
 * `startAt` is inclusive, `endAt` is EXCLUSIVE (it is the first instant of the
 * next ET day), so the day DST ends spans 25 h and the day it starts spans 23 h.
 */
export function etDayBounds(at: EpochMs): { readonly startAt: EpochMs; readonly endAt: EpochMs } {
  const p = etParts(at);
  return {
    startAt: etMidnight(p.year, p.month, p.day),
    // Date.UTC normalises a day overflow (Sep 31 -> Oct 1) for us.
    endAt: etMidnight(p.year, p.month, p.day + 1),
  };
}

/** Inclusive list of ET date keys covering [from, to]. Used by the ingest planner. */
export function etDateKeyRange(from: EpochMs, to: EpochMs): readonly string[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const keys: string[] = [];
  let cursor = from;
  // Walking day boundary to day boundary (rather than adding 24 h) is what keeps
  // the 23 h and 25 h DST days from duplicating or skipping a key.
  while (cursor <= to) {
    keys.push(etDateKey(cursor));
    const { endAt } = etDayBounds(cursor);
    if (endAt <= cursor) break; // defensive: never loop forever
    cursor = endAt;
  }
  return keys;
}

/* ------------------------------------------------------------------ *
 * The board / ingest window (PLAN.md §22)
 * ------------------------------------------------------------------ */

/**
 * The LAST INSTANT (inclusive) of the board and ingest window for `league` at
 * `now`: the end of the Monday ET date that closes the current football week.
 *
 * The rule, all in US Eastern:
 *
 * Let M be the next Monday ET date at or after today's ET date (today, if today
 * IS a Monday). The end is the last instant of M, EXCEPT that it is the last
 * instant of M + 7 days when `now` is
 *
 *   (a) a SUNDAY at or after `WEEK_ROLLOVER_ET_HOUR[league]` (constants.ts;
 *       M9-0 adds the import) — 00:00 ET for `ncaaf`, because Saturday's games
 *       are done, and 20:00 ET for `nfl`, because the early and late windows
 *       are; or
 *   (b) a MONDAY, so that the rollover STAYS rolled over. Without (b) the board
 *       would show next week on Sunday evening and hide it again all Monday.
 *
 * A football week runs Tuesday through Monday and the end is inclusive of its
 * Monday, because Monday Night Football IS a Monday ET date.
 *
 * Worked, verified in a REPL against these helpers (§22 reproduces the table):
 * a Friday gives the Monday three days out (3.50 d); a Sunday 19:59 ET gives the
 * NFL 1.17 d and CFB 8.17 d; a Sunday 20:00 ET gives both 8.17 d; a MONDAY noon
 * gives 7.50 d — the same instant Sunday night returned; a Tuesday noon gives
 * 6.50 d. Measured over Aug 2026 – Jan 2027, the span never leaves
 * [1.17 d, 9.04 d] and the ET-date count never leaves [2, 9].
 *
 * RETURNS AN INCLUSIVE END, i.e. `etDayBounds(thatMonday).endAt - 1`, because
 * every caller wants `kickoff_at <= end` and because `etDateKeyRange(from, end)`
 * is inclusive too: handing it the exclusive midnight would plan an extra ET
 * date target for the Tuesday.
 *
 * DST is not special-cased and must not be: the Monday is located by ET calendar
 * arithmetic (`etMidnight` re-measures the offset) and never by adding
 * `7 * MS_PER_DAY`, so the 23 h and 25 h ET days come out right — measured, a
 * window crossing the November fall-back is 9.02 days rather than 9.00.
 *
 * Total: never throws. A non-finite `now` yields `now` unchanged, so a caller
 * that somehow has no clock plans nothing rather than looping.
 *
 * PLAN.md §22.
 */
export function boardWindowEnd(league: League, now: EpochMs): EpochMs {
  if (!Number.isFinite(now)) return now;
  const p = etParts(now);
  // Weekday of the ET calendar date, 0 = Sunday … 6 = Saturday. Built from the
  // ET parts with Date.UTC so no second Intl formatter is constructed.
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  // Days until the next Monday on or after today: Mon → 0, Tue → 6, Sun → 1.
  let daysToMonday = (1 - weekday + 7) % 7;
  const rolledOver = weekday === 1 || (weekday === 0 && p.hour >= WEEK_ROLLOVER_ET_HOUR[league]);
  if (rolledOver) daysToMonday += 7;
  // `etMidnight` normalises the day overflow and re-measures the DST offset, so
  // this is calendar arithmetic, never `n * MS_PER_DAY`.
  return etMidnight(p.year, p.month, p.day + daysToMonday + 1) - 1;
}

/** Parse an ESPN ISO timestamp ("2026-09-13T17:00Z") to epoch ms, or null. */
export function parseIsoToEpochMs(iso: unknown): EpochMs | null {
  if (typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  const m = ISO_8601.exec(trimmed);
  if (m === null) return null;
  // A time without a Z/offset is local time in Node and UTC in workerd; the
  // regex above refuses it so the two runtimes can never disagree. Also refuse
  // calendar rollovers ("2026-02-30") that Date.parse would silently accept.
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** `kickoffAt - BET_CUTOFF_BUFFER_MS`. The single definition of "locked". */
export function lockAtFor(kickoffAt: EpochMs): EpochMs {
  return kickoffAt - BET_CUTOFF_BUFFER_MS;
}

/* ------------------------------------------------------------------ *
 * Refresh tiers (PLAN.md §8.4) and the line staleness window (§8.5)
 * ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How often a target is refreshed while a game in it is live or about to be. */
export const REFRESH_LIVE_MS = 15 * MINUTE_MS;
/** …while a game in it kicks off within `SOON_HORIZON_MS`. */
export const REFRESH_SOON_MS = 60 * MINUTE_MS;
/** …otherwise (line discovery for games days away). */
export const REFRESH_DISCOVERY_MS = 6 * HOUR_MS;
/** …once every game in it is final. */
export const REFRESH_DONE_MS = 24 * HOUR_MS;
/** "kickoff within 3 h" / "within 48 h" — the two tier boundaries. */
export const LIVE_HORIZON_MS = 3 * HOUR_MS;
export const SOON_HORIZON_MS = 48 * HOUR_MS;

/**
 * How often a still-scheduled game is expected to be refreshed, judged at
 * instant `at`, by distance to kickoff — the same tiers `computeNextRunAt`
 * (src/worker/ingest.ts) uses for a whole target. Per game it is conservative:
 * a target refreshes at the tier of its NEAREST game, so a game's real cadence
 * is this fast or faster.
 */
export function expectedRefreshMs(kickoffAt: EpochMs, at: EpochMs): number {
  const ahead = kickoffAt - at;
  if (ahead <= LIVE_HORIZON_MS) return REFRESH_LIVE_MS;
  if (ahead <= SOON_HORIZON_MS) return REFRESH_SOON_MS;
  return REFRESH_DISCOVERY_MS;
}

/**
 * A line is stale once `now - seenAt` exceeds this: `LINE_STALE_MULTIPLIER`
 * (3) refresh cycles at the tier that applied WHEN THE LINE WAS LAST SEEN,
 * never less than `LINE_STALE_MS` (3 h). So a line confirmed inside 48 h of
 * kickoff has a 3 h window (cadence hourly or faster; 3 h unconfirmed means
 * ingestion is broken) and one confirmed further out has 18 h (cadence 6 h).
 *
 * Keyed off `seenAt`, not the current time, on purpose: the window then
 * depends only on facts fixed at confirmation, so it is monotone — a line
 * that is fresh now cannot become stale by the game merely getting closer to
 * kickoff, and the board and placement (which evaluate at different instants)
 * cannot disagree about it. PLAN.md §8.5.
 */
export function lineStaleAfterMs(kickoffAt: EpochMs, seenAt: EpochMs): number {
  return Math.max(LINE_STALE_MS, LINE_STALE_MULTIPLIER * expectedRefreshMs(kickoffAt, seenAt));
}
