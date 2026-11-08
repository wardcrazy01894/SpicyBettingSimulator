/**
 * Pure grouping helpers for the board and My Bets. PLAN.md §12.3.
 *
 * DOM-free so `tests/web/grouping.spec.ts` can run in the node vitest project.
 */

import {
  etCalendarDay,
  footballWeekStart,
  formatDateRange,
  formatDayHeading,
  localDateKey,
} from './datetime.js';
import { BET_LEAGUE_LABEL } from './labels.js';
import type { BoardFilter } from './board-filter.js';
import type { BetView, GameCard } from '../../shared/api-types.js';
import type { BetLeague, EpochMs, League } from '../../shared/types.js';

/**
 * Whether a league's board is paged by ESPN's `week`. MLB has no weeks: its
 * board is TODAY in US Eastern (PLAN.md §23.5), so the week picker is hidden
 * and the day group is the only grouping (§23.12). A total `Record`, so a
 * fourth league has to say which it is.
 */
export const BOARD_HAS_WEEKS: Readonly<Record<League, boolean>> = {
  nfl: true,
  ncaaf: true,
  mlb: false,
  // Basketball has no weeks either (PLAN.md §24.14): both boards group by ET
  // date across their windows (today + 2 for college, today + 1 for the NBA).
  ncaab: false,
  nba: false,
};

export interface DayGroup {
  /**
   * `YYYY-MM-DD` — in the viewer's local timezone for a weekly league, in US
   * Eastern for MLB (see `groupBoardGames`). Stable React key.
   */
  readonly dateKey: string;
  /** "Thu, Sep 11". */
  readonly label: string;
  readonly games: readonly GameCard[];
}

/**
 * Group one week's games by the VIEWER'S local calendar date, kickoff ascending.
 *
 * The primary grouping (week) is the server's, never computed here: the board
 * requests one `week` at a time and this only subdivides what came back.
 */
export function groupGamesByLocalDate(games: readonly GameCard[]): readonly DayGroup[] {
  const buckets = new Map<string, GameCard[]>();
  for (const game of [...games].sort(byKickoff)) {
    const key = localDateKey(game.kickoffAt);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [game]);
    else bucket.push(game);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, bucket]) => ({
      dateKey,
      label: formatDayHeading(bucket[0]?.kickoffAt ?? 0),
      games: bucket,
    }));
}

/**
 * The board's day groups for `league`.
 *
 * Football: `groupGamesByLocalDate`, unchanged — the viewer's local day inside
 * the server's week.
 *
 * MLB: the ET calendar date, via the shared `etDateKey` (Intl +
 * `America/New_York`, never an offset). The MLB board IS an ET day (§23.5) and
 * ESPN schedules by it, so a 10:15 PM EDT first pitch — 02:15Z, already
 * tomorrow in UTC and for any viewer east of New York — stays under the day it
 * belongs to. The card's first-pitch TIME is still the viewer's local time.
 */
export function groupBoardGames(league: League, games: readonly GameCard[]): readonly DayGroup[] {
  if (BOARD_HAS_WEEKS[league]) return groupGamesByLocalDate(games);
  const buckets = new Map<string, { label: string; games: GameCard[] }>();
  for (const game of [...games].sort(byKickoff)) {
    const day = etCalendarDay(game.kickoffAt);
    const bucket = buckets.get(day.dateKey);
    if (bucket === undefined) buckets.set(day.dateKey, { label: day.label, games: [game] });
    else bucket.games.push(game);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, bucket]) => ({ dateKey, label: bucket.label, games: bucket.games }));
}

/**
 * The empty-board copy. Football's is unchanged; MLB's never mentions a week
 * (there is no picker to try another one with) and says why the board can be
 * thin: ESPN carries MLB lines on game day only, and tomorrow's games appear
 * after midnight ET (PLAN.md §23.5).
 *
 * Basketball (M13d, PLAN.md §24.14) has no weeks either. College basketball's
 * window is three ET dates, and its board opens on the Top 25 filter, so a
 * board emptied by that DEFAULT says so and points at All games; the NBA's
 * says tomorrow's games arrive a day ahead (its window is today + tomorrow).
 * `filter` is what emptied the board; football and MLB ignore it.
 *
 * `day` (F4, PLAN.md §24.14) is the basketball day filter's phrase —
 * "today", "tomorrow", "on Monday" (`DayFilterOption.phrase`) — or `null`
 * for All. When a day is picked the copy names it instead of "the next three
 * days": "No Top 25 games on Monday."
 */
export function boardEmptyCopy(
  league: League,
  filteredOut: boolean,
  filter: BoardFilter = 'all',
  day: string | null = null,
): { readonly title: string; readonly hint: string } {
  if (filteredOut && day !== null && (league === 'ncaab' || league === 'nba')) {
    if (league === 'ncaab' && filter === 'top25') {
      return {
        title: `No Top 25 games ${day}.`,
        hint: 'Pick another day, or switch Show to All games.',
      };
    }
    if (league === 'ncaab' && filter !== 'all') {
      return {
        title: `No games match that filter ${day}.`,
        hint: 'Pick another day or conference, or All games.',
      };
    }
    return {
      title: `No ${league === 'nba' ? 'NBA' : 'college basketball'} games ${day}.`,
      hint: 'Pick another day, or All.',
    };
  }
  if (filteredOut && league === 'ncaab') {
    return filter === 'top25'
      ? {
          title: 'No Top 25 games in the next three days.',
          hint: 'Try All games, or pick a conference.',
        }
      : {
          title: 'No games match that filter in the next three days.',
          hint: 'Pick another conference, or All games.',
        };
  }
  if (filteredOut) {
    return {
      title: 'No games match that filter this week.',
      hint: 'Pick another conference, or All games.',
    };
  }
  switch (league) {
    case 'mlb':
      return {
        title: 'No MLB games on the board today.',
        hint: "Lines post on game day — tomorrow's games appear after midnight Eastern.",
      };
    case 'ncaab':
      return {
        title: 'No college basketball games on the board.',
        hint: 'The board covers today and the next two days, Eastern — check back as lines post.',
      };
    case 'nba':
      return {
        title: 'No NBA games on the board.',
        hint: "Tomorrow's games appear with their lines a day ahead.",
      };
    case 'nfl':
    case 'ncaaf':
      return {
        title: 'No games in this window.',
        hint: 'Try another week, or check back once the schedule is ingested.',
      };
    default: {
      const unreachable: never = league;
      return unreachable;
    }
  }
}

function byKickoff(a: GameCard, b: GameCard): number {
  return a.kickoffAt - b.kickoffAt;
}

export interface BetGroup {
  readonly key: string;
  readonly league: BetLeague;
  /** "NFL · Sep 11 – Sep 15". */
  readonly label: string;
  readonly bets: readonly BetView[];
}

/**
 * Group bets by `(league, football week)`, newest week first.
 *
 * NO SEASON, in the key or the label (decided 2026-09-14, PLAN.md §19 Q5). The
 * product has no concept of one, and it was redundant here anyway: the bucket is
 * already keyed on `footballWeekStart`, an absolute timestamp, so two weeks a
 * year apart could never have collided.
 *
 * DEVIATION FROM PLAN.md §12.3, stated out loud: the plan asks for the label
 * "Week N — Sep 11–15" using ESPN's authoritative week number. The wire contract
 * does not expose `week` on `BetView` or `BetLegView` (only on `GameCard`), so
 * the number is not obtainable without an extra request per game. The window
 * itself is reproducible — `footballWeekStart` anchors to Tuesday 00:00 local,
 * which is the boundary that keeps a Thursday opener and the following Monday
 * nighter in one bucket — so the grouping is right and only the numeric label is
 * missing. The board still uses the server's `week`.
 */
export function groupBetsByWeek(bets: readonly BetView[]): readonly BetGroup[] {
  const buckets = new Map<string, { league: BetLeague; bets: BetView[] }>();
  for (const bet of bets) {
    const anchor = footballWeekStart(earliestKickoff(bet));
    const key = `${bet.league}:${String(anchor)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { league: bet.league, bets: [bet] });
    } else {
      bucket.bets.push(bet);
    }
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const sorted = [...bucket.bets].sort((a, b) => b.placedAt - a.placedAt);
      const kickoffs = sorted.map(earliestKickoff);
      const from = Math.min(...kickoffs);
      const to = Math.max(...sorted.map(latestKickoff));
      return {
        key,
        league: bucket.league,
        label: `${BET_LEAGUE_LABEL[bucket.league]} · ${formatDateRange(from, to)}`,
        bets: sorted,
      };
    })
    .sort((a, b) => earliestKickoff(b.bets[0]) - earliestKickoff(a.bets[0]));
}

/**
 * The bet's own `earliestKickoff` is a PLACEMENT-TIME snapshot that ingestion
 * never updates (CLAUDE.md §8b), so grouping reads the legs' live game rows and
 * falls back to the snapshot only when a bet somehow has no legs.
 */
function earliestKickoff(bet: BetView | undefined): EpochMs {
  if (bet === undefined) return 0;
  const live = bet.legs.map((leg) => leg.game.kickoffAt);
  return live.length === 0 ? bet.earliestKickoffAt : Math.min(...live);
}

function latestKickoff(bet: BetView): EpochMs {
  const live = bet.legs.map((leg) => leg.game.kickoffAt);
  return live.length === 0 ? bet.earliestKickoffAt : Math.max(...live);
}

/**
 * Distinct week numbers present in a slate, ascending. The API has no
 * "list the weeks" route, so the week picker is built from the weeks the board
 * actually returned, unioned with whatever week is currently selected.
 */
export function weeksFromGames(
  games: readonly GameCard[],
  ...alsoInclude: readonly (number | null)[]
): readonly number[] {
  const weeks = new Set<number>();
  for (const game of games) if (game.week !== null) weeks.add(game.week);
  for (const extra of alsoInclude) if (extra !== null) weeks.add(extra);
  return [...weeks].sort((a, b) => a - b);
}
