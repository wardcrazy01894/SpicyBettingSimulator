/**
 * The leaderboard, with All / NFL / NCAAF filters.
 *
 * THE TABS FILTER THE RECORD, NOT THE MONEY (M5b). Everyone's money is their one
 * account balance under all three, because that is the only balance that exists;
 * the tabs answer "who is best at college football", which is a question about
 * W-L and ROI. The old third tab was "All-time", which meant "summed across
 * per-league bankrolls" — a sum with nothing left to add up.
 *
 * THERE IS NO SEASON. Balances never roll over, so a per-season board would be a
 * slice of a number that was never reset (PLAN.md §19 Q5).
 */
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
  const [scope, setScope] = useState<Scope>('all');

  const board = useLeaderboard(scope);

  const options: readonly SegmentedOption<Scope>[] = [
    { value: 'all', label: 'All' },
    ...config.leagues.map((league) => ({ value: league, label: LEAGUE_LABEL[league] })),
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
        Ranked by <strong>equity</strong> — your balance plus whatever is riding on open bets, so a
        stake in flight neither helps nor hurts you until it settles. The tabs filter each
        player&rsquo;s record and ROI; the money is the whole account either way.
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
