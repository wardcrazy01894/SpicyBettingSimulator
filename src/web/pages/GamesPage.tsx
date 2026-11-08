/**
 * The board. League tabs, week picker, the college filter, the basketball
 * day filter (All / Today / Tomorrow / <weekday>), day groups.
 *
 * Grouping: for football the primary group is ESPN's `week` (authoritative —
 * it spans Thu-Mon for the NFL, so we never compute week boundaries
 * ourselves); within a week, games are subgrouped by the VIEWER'S LOCAL
 * calendar date via Intl.DateTimeFormat. MLB and basketball have no weeks:
 * their boards group by ET calendar date (`groupBoardGames`).
 *
 * The slate is re-fetched every 60 s while the tab is visible, because
 * `bettable` is a server verdict with a shelf life and the client clock is not
 * allowed to substitute for it (PLAN.md §12.3).
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { GameCard } from '../components/GameCard.js';
import { LeagueTabs } from '../components/LeagueTabs.js';
import { Spinner } from '../components/Spinner.js';
import { WeekPicker } from '../components/WeekPicker.js';
import { BoardFilterSelect } from '../components/BoardFilterSelect.js';
import { Segmented } from '../components/Segmented.js';
import { useGames } from '../hooks/useApi.js';
import { useNow, usePoll } from '../hooks/useNow.js';
import { BOARD_FILTERS, defaultBoardFilter, filterGames } from '../lib/board-filter.js';
import type { BoardFilter } from '../lib/board-filter.js';
import {
  ALL_DAYS,
  dayFilterOptions,
  filterGamesByDay,
  resolveDayFilter,
} from '../lib/day-filter.js';
import type { DayFilter } from '../lib/day-filter.js';
import {
  BOARD_HAS_WEEKS,
  boardEmptyCopy,
  groupBoardGames,
  weeksFromGames,
} from '../lib/grouping.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';
import type { League } from '../../shared/types.js';

const BOARD_POLL_MS = 60_000;

export function GamesPage(): ReactElement {
  const config = useConfig();
  const slip = useBetSlip();
  const [week, setWeek] = useState<number | null>(null);

  // The board's league. Changing it moves the BOARD only — the slip is one
  // cross-league draft and keeps every leg (M5b).
  const league = slip.boardLeague;

  // The college boards only (BOARD_FILTERS): Top 25 / a conference.
  // Client-side over the slate — a board narrowing, not a query (PLAN.md
  // §12.1, §24.14). The choice is held WITH its league, so any league change
  // lands on that league's default (Top 25 for college basketball, All for
  // CFB) without a reset having to run first.
  const [picked, setPicked] = useState<{ league: League; filter: BoardFilter } | null>(null);
  const filterSpec = BOARD_FILTERS[league];
  const filter = picked?.league === league ? picked.filter : defaultBoardFilter(league);
  // The day pick, held with its league like the conference pick: a league
  // change lands on All.
  const [pickedDay, setPickedDay] = useState<{ league: League; day: DayFilter } | null>(null);
  const season = config.currentSeason[league];
  const board = useGames(league, season, week);
  const now = useNow();

  usePoll(board.refetch, BOARD_POLL_MS);

  const games = board.data?.games ?? [];
  // Basketball's day filter (DAY_FILTER_LEAGUES, PLAN.md §24.14): built from
  // the UNFILTERED slate so a conference change never moves the day buttons,
  // and from `now` so "Today" rolls over at ET midnight. A stale pick (the
  // day left the window) resolves to All. Composes with the conference filter.
  const dayOptions = dayFilterOptions(league, games, now);
  const day = resolveDayFilter(pickedDay?.league === league ? pickedDay.day : null, dayOptions);
  const shown = filterGamesByDay(filterGames(league, games, filter), day?.key ?? ALL_DAYS);
  const groups = groupBoardGames(league, shown);
  const empty = boardEmptyCopy(
    league,
    games.length > 0 && shown.length === 0,
    filter,
    day?.phrase ?? null,
  );
  // Weeks come from the UNFILTERED slate: a conference with no game this week
  // must not make the week disappear from the picker.
  const weeks = weeksFromGames(games, board.data?.week ?? null, week);

  return (
    <section className="page">
      <div className="page-controls">
        <LeagueTabs
          league={league}
          leagues={config.leagues}
          onChange={(next) => {
            setWeek(null);
            setPicked(null);
            setPickedDay(null);
            slip.setBoardLeague(next);
          }}
        />
        {BOARD_HAS_WEEKS[league] && (
          <WeekPicker week={week ?? board.data?.week ?? null} weeks={weeks} onChange={setWeek} />
        )}
        {filterSpec !== null && (
          <BoardFilterSelect
            spec={filterSpec}
            filter={filter}
            onChange={(next) => {
              setPicked({ league, filter: next });
            }}
          />
        )}
        {/* Hidden while there is nothing to choose: All and no day with games. */}
        {dayOptions !== null && dayOptions.length > 1 && day !== null && (
          <Segmented
            label="Day"
            value={day.key}
            options={dayOptions.map((o) => ({ value: o.key, label: o.label }))}
            onChange={(next) => {
              setPickedDay({ league, day: next });
            }}
          />
        )}
      </div>

      {board.error !== undefined && board.data === undefined && (
        <ErrorBanner error={board.error} onRetry={board.refetch} />
      )}
      {board.loading && board.data === undefined && <Spinner label="Loading the board…" />}

      {board.data !== undefined && groups.length === 0 && (
        <EmptyState title={empty.title} hint={empty.hint} />
      )}

      {groups.map((group) => (
        <div className="day-group" key={group.dateKey}>
          <h2 className="day-heading">{group.label}</h2>
          {group.games.map((game) => (
            <GameCard key={game.id} game={game} now={now} />
          ))}
        </div>
      ))}
    </section>
  );
}
