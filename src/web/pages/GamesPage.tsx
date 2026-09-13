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
import { useGames } from '../hooks/useApi.js';
import { useNow, usePoll } from '../hooks/useNow.js';
import { groupGamesByLocalDate, weeksFromGames } from '../lib/grouping.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';

const BOARD_POLL_MS = 60_000;

export function GamesPage(): ReactElement {
  const config = useConfig();
  const slip = useBetSlip();
  const [week, setWeek] = useState<number | null>(null);

  const league = slip.league;
  const season = config.currentSeason[league];
  const board = useGames(league, season, week);
  const now = useNow();

  usePoll(board.refetch, BOARD_POLL_MS);

  const games = board.data?.games ?? [];
  const groups = groupGamesByLocalDate(games);
  const weeks = weeksFromGames(games, board.data?.week ?? null, week);

  return (
    <section className="page">
      <div className="page-controls">
        <LeagueTabs
          league={league}
          leagues={config.leagues}
          onChange={(next) => {
            setWeek(null);
            slip.setLeague(next);
          }}
        />
        <WeekPicker
          week={week ?? board.data?.week ?? null}
          season={board.data?.season ?? season}
          weeks={weeks}
          onChange={setWeek}
        />
      </div>

      {board.error !== undefined && board.data === undefined && (
        <ErrorBanner error={board.error} onRetry={board.refetch} />
      )}
      {board.loading && board.data === undefined && <Spinner label="Loading the board…" />}

      {board.data !== undefined && groups.length === 0 && (
        <EmptyState
          title="No games in this window."
          hint="Try another week, or check back once the schedule is ingested."
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
