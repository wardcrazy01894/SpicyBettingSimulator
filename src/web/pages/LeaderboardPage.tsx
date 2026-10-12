/**
 * The leaderboard, with All / NFL / NCAAF / MLB filters.
 *
 * THE TABS FILTER THE RECORD, PROFIT AND ROI, NOT THE MONEY (M5b). Everyone's
 * money is their one account balance under every tab, because that is the only
 * balance that exists; the tabs answer "who is best at college football", which
 * is a question about W-L, settled profit and ROI. The old third tab was
 * "All-time", which meant "summed across per-league bankrolls" — a sum with
 * nothing left to add up.
 *
 * THERE IS NO SEASON. Balances never roll over, so a per-season board would be a
 * slice of a number that was never reset (PLAN.md §19 Q5).
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LeaderboardTable } from '../components/LeaderboardTable.js';
import { ScopeTabs } from '../components/ScopeTabs.js';
import { Spinner } from '../components/Spinner.js';
import { useLeaderboard } from '../hooks/useApi.js';
import type { Scope } from '../lib/scope.js';
import { useSession } from '../state/session.js';

export function LeaderboardPage(): ReactElement {
  const session = useSession();
  const [scope, setScope] = useState<Scope>('all');

  const board = useLeaderboard(scope);

  return (
    <section className="page">
      <div className="page-controls">
        <ScopeTabs scope={scope} onChange={setScope} />
      </div>

      <p className="muted page-note">
        Ranked by <strong>net profit</strong> — your equity (balance plus whatever is riding on open
        bets) minus what the house has put in, so a stake in flight neither helps nor hurts you
        until it settles, and a bust refill never erases what was lost before it. A 💀 is a bust:
        the player ran out of money and the house refilled it. The sport tabs filter each
        player&rsquo;s record, profit and ROI; the money is the whole account either way, and a
        parlay that mixes sports counts under All only. Profit is what settled bets won minus what
        they lost. ROI is that profit per dollar wagered on decided bets, not the change in your
        balance &mdash; the same dollars can be bet, won and bet again.
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
