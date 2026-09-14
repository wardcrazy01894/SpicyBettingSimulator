/**
 * Pure grouping helpers for the board and My Bets. PLAN.md §12.3.
 *
 * DOM-free so `tests/web/grouping.spec.ts` can run in the node vitest project.
 */

import { footballWeekStart, formatDateRange, formatDayHeading, localDateKey } from './datetime.js';
import { BET_LEAGUE_LABEL } from './labels.js';
import type { BetView, GameCard } from '../../shared/api-types.js';
import type { BetLeague, EpochMs } from '../../shared/types.js';

export interface DayGroup {
  /** `YYYY-MM-DD` in the viewer's local timezone. Stable React key. */
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
