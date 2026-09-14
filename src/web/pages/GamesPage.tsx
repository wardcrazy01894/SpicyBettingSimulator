/**
 * The board. League tabs, week picker, day groups.
 *
 * Grouping: primary group is ESPN's `week` (authoritative — it spans Thu-Mon for
 * the NFL, so we never compute week boundaries ourselves); within a week, games
 * are subgrouped by the VIEWER'S LOCAL calendar date via Intl.DateTimeFormat.
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
import { filterGames } from '../lib/board-filter.js';
import type { BoardFilter } from '../lib/board-filter.js';
import { groupGamesByLocalDate, weeksFromGames } from '../lib/grouping.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';

const BOARD_POLL_MS = 60_000;

export function GamesPage(): ReactElement {
  const config = useConfig();
  const slip = useBetSlip();
  const [week, setWeek] = useState<number | null>(null);
  // CFB only: Top 25 / a conference. Client-side over the week's slate — a
  // board narrowing, not a query (PLAN.md §12.1). Reset with the league.
  const [filter, setFilter] = useState<BoardFilter>('all');

  // The board's league. Changing it moves the BOARD only — the slip is one
  // cross-league draft and keeps every leg (M5b).
  const league = slip.boardLeague;
  const season = config.currentSeason[league];
  const board = useGames(league, season, week);
  const now = useNow();

  usePoll(board.refetch, BOARD_POLL_MS);

  const games = board.data?.games ?? [];
  const shown = league === 'ncaaf' ? filterGames(games, filter) : games;
  const groups = groupGamesByLocalDate(shown);
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
            setFilter('all');
            slip.setBoardLeague(next);
          }}
        />
        <WeekPicker week={week ?? board.data?.week ?? null} weeks={weeks} onChange={setWeek} />
        {league === 'ncaaf' && <BoardFilterSelect filter={filter} onChange={setFilter} />}
      </div>

      {board.error !== undefined && board.data === undefined && (
        <ErrorBanner error={board.error} onRetry={board.refetch} />
      )}
      {board.loading && board.data === undefined && <Spinner label="Loading the board…" />}

      {board.data !== undefined && groups.length === 0 && (
        <EmptyState
          title={
            games.length > 0 && shown.length === 0
              ? 'No games match that filter this week.'
              : 'No games in this window.'
          }
          hint={
            games.length > 0 && shown.length === 0
              ? 'Pick another conference, or All games.'
              : 'Try another week, or check back once the schedule is ingested.'
          }
        />
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
