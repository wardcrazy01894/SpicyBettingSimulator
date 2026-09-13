/** Scope tabs: NFL / NCAAF / All-time. */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LeaderboardTable } from '../components/LeaderboardTable.js';
import { Segmented } from '../components/Segmented.js';
import type { SegmentedOption } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { useLeaderboard } from '../hooks/useApi.js';
import { LEAGUE_LABEL } from '../lib/labels.js';
import { useConfig } from '../state/config.js';
import { useSession } from '../state/session.js';
import type { League } from '../../shared/types.js';

type Scope = League | 'all';

export function LeaderboardPage(): ReactElement {
  const config = useConfig();
  const session = useSession();
  const [scope, setScope] = useState<Scope>(config.leagues[0] ?? 'all');

  const season = scope === 'all' ? null : config.currentSeason[scope];
  const board = useLeaderboard(scope, season);

  const options: readonly SegmentedOption<Scope>[] = [
    ...config.leagues.map((league) => ({ value: league, label: LEAGUE_LABEL[league] })),
    { value: 'all', label: 'All-time' },
  ];

  return (
    <section className="page">
      <div className="page-controls">
        <Segmented<Scope>
          label="Leaderboard scope"
          value={scope}
          options={options}
          onChange={setScope}
        />
      </div>

      <p className="muted page-note">
        Ranked by settled balance. Open stakes are already deducted; equity adds them back.
      </p>

      {board.error !== undefined && board.data === undefined && (
        <ErrorBanner error={board.error} onRetry={board.refetch} />
      )}
      {board.loading && board.data === undefined && <Spinner label="Loading the board…" />}

      {board.data !== undefined &&
        (board.data.rows.length === 0 ? (
          <EmptyState title="No one has placed a bet yet." />
        ) : (
          <LeaderboardTable rows={board.data.rows} meUserId={session.user?.id ?? null} />
        ))}
    </section>
  );
}
