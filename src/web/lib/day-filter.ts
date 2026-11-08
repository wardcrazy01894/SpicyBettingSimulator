/**
 * The basketball boards' DAY filter: All, Today, Tomorrow, and — for college,
 * whose window is three ET dates — the day after by its weekday name
 * ("Monday"). PLAN.md §24.14 (follow-up F4, 2026-11-07).
 *
 * Pure and DOM-free (tests/web/day-filter.spec.ts). Like the conference
 * filter it narrows the slate the server already returned — a board
 * narrowing, never a money slice — so it needs no query parameter.
 *
 * Every calendar question goes through the shared ET helpers (CLAUDE.md rule
 * 3): the window's dates are `etDateKeyRange(today's ET midnight,
 * boardWindowEnd(league, now))` — the same `boardWindowEnd` the server's
 * board uses — and a game's day is `etDateKey(kickoffAt)`, the key
 * `groupBoardGames` groups by. Nothing here adds `MS_PER_DAY`, so the 25 h
 * 2026-11-01 and the 23 h March day come out right, and because the labels
 * are computed from `now` (the board's `useNow`) they roll over at ET
 * midnight on their own.
 */
import { boardWindowEnd, etDateKey, etDateKeyRange, etDayBounds } from '../../shared/time.js';
import type { GameCard } from '../../shared/api-types.js';
import type { EpochMs, League } from '../../shared/types.js';

/** `all`, or one ET date as `etDateKey` returns it (`YYYYMMDD`). */
export type DayFilter = string;

export const ALL_DAYS: DayFilter = 'all';

export interface DayFilterOption {
  readonly key: DayFilter;
  /** The button: "All", "Today", "Tomorrow", "Monday". */
  readonly label: string;
  /**
   * The same day inside a sentence, for the empty-board copy: "today",
   * "tomorrow", "on Monday". `null` for All.
   */
  readonly phrase: string | null;
}

/**
 * Which boards have a day filter. A total `Record`, so a sixth league has to
 * say whether it gets one. Football has a week picker; MLB's board is one day.
 */
export const DAY_FILTER_LEAGUES: Readonly<Record<League, boolean>> = {
  nfl: false,
  ncaaf: false,
  mlb: false,
  ncaab: true,
  nba: true,
};

/**
 * A `YYYYMMDD` key is ALREADY the date, so its weekday is read at UTC noon in
 * UTC — the formatting device `etCalendarDay` uses, with no zone arithmetic
 * that could shift the day. English, because "Today" / "Tomorrow" are.
 */
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

function weekdayOf(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6));
  const day = Number(key.slice(6, 8));
  return WEEKDAY_FORMAT.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/**
 * The day control for `league` at `now`, or `null` for a league without one.
 *
 * 'All' first, then each ET date of the league's window (today + 1 for the
 * NBA, today + 2 for college) that has at least one game in `games` — an
 * empty day is not offered, because a button that can only produce an empty
 * board is noise. Pass the UNFILTERED slate, so changing the conference does
 * not make the day buttons jump. A game outside the window (the board's 12 h
 * lookback reaches yesterday evening) shows under All only.
 */
export function dayFilterOptions(
  league: League,
  games: readonly GameCard[],
  now: EpochMs,
): readonly DayFilterOption[] | null {
  if (!DAY_FILTER_LEAGUES[league]) return null;
  const windowKeys = etDateKeyRange(etDayBounds(now).startAt, boardWindowEnd(league, now));
  const withGames = new Set(games.map((g) => etDateKey(g.kickoffAt)));
  const options: DayFilterOption[] = [{ key: ALL_DAYS, label: 'All', phrase: null }];
  windowKeys.forEach((key, index) => {
    if (!withGames.has(key)) return;
    if (index === 0) options.push({ key, label: 'Today', phrase: 'today' });
    else if (index === 1) options.push({ key, label: 'Tomorrow', phrase: 'tomorrow' });
    else {
      const weekday = weekdayOf(key);
      options.push({ key, label: weekday, phrase: `on ${weekday}` });
    }
  });
  return options;
}

/**
 * The Day row is offered only when there are at least two DAYS to choose
 * between: All plus one day is no choice (they differ only by yesterday's
 * late games from the lookback). The page hides the row below this count, and
 * `resolveDayFilter` applies All below it, so a hidden row can never leave a
 * day filter silently applied.
 */
export const MIN_DAY_OPTIONS = 3;

/**
 * The day actually applied: `picked` if it is still one of the options AND
 * the row is offered (`MIN_DAY_OPTIONS`), else All. A pick goes stale at ET
 * midnight (yesterday's "Today" leaves the window) or when its last game drops
 * off the slate; and when the board shrinks to one day, the row disappears and
 * the pick must go with it — otherwise the user has a filter applied with no
 * control to clear it. Falling back to All keeps the board from silently
 * showing less than it has.
 */
export function resolveDayFilter(
  picked: DayFilter | null,
  options: readonly DayFilterOption[] | null,
): DayFilterOption | null {
  if (options === null) return null;
  if (options.length < MIN_DAY_OPTIONS) return options[0] ?? null;
  return options.find((o) => o.key === picked) ?? options[0] ?? null;
}

/** `games` on one ET date; `all` returns the slate itself (same reference). */
export function filterGamesByDay(games: readonly GameCard[], key: DayFilter): readonly GameCard[] {
  if (key === ALL_DAYS) return games;
  return games.filter((g) => etDateKey(g.kickoffAt) === key);
}
