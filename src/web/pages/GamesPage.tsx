/**
 * The board. League tabs, week picker, the college filter, day groups.
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
import { useGames } from '../hooks/useApi.js';
import { useNow, usePoll } from '../hooks/useNow.js';
import { BOARD_FILTERS, defaultBoardFilter, filterGames } from '../lib/board-filter.js';
import type { BoardFilter } from '../lib/board-filter.js';
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
  const season = config.currentSeason[league];
  const board = useGames(league, season, week);
  const now = useNow();

  usePoll(board.refetch, BOARD_POLL_MS);

  const games = board.data?.games ?? [];
  const shown = filterGames(league, games, filter);
  const groups = groupBoardGames(league, shown);
  const empty = boardEmptyCopy(league, games.length > 0 && shown.length === 0, filter);
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
