/**
 * Open / Settled tabs, grouped by (league, season, week) and labelled with local
 * dates.
 *
 * The "Week N" half of PLAN.md §12.3's label is NOT rendered: the frozen wire
 * contract carries no `week` on `BetView`/`BetLegView`. See `groupBetsByWeek`
 * for the full note; the grouping window itself is the same Thu→Mon span.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { BetCard } from '../components/BetCard.js';
import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { Segmented } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { useBets } from '../hooks/useApi.js';
import { usePoll } from '../hooks/useNow.js';
import { groupBetsByWeek } from '../lib/grouping.js';

type Filter = 'open' | 'settled';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'settled', label: 'Settled' },
];

/** Open bets carry a live `projected` grade, so they are worth re-reading. */
const OPEN_POLL_MS = 60_000;

export function MyBetsPage(): ReactElement {
  const [filter, setFilter] = useState<Filter>('open');
  const bets = useBets(filter);
  usePoll(bets.refetch, filter === 'open' ? OPEN_POLL_MS : 5 * OPEN_POLL_MS);

  const groups = groupBetsByWeek(bets.data?.bets ?? []);

  return (
    <section className="page">
      <div className="page-controls">
        <Segmented<Filter>
          label="Bet filter"
          value={filter}
          options={FILTERS}
          onChange={setFilter}
        />
      </div>

      {bets.error !== undefined && bets.data === undefined && (
        <ErrorBanner error={bets.error} onRetry={bets.refetch} />
      )}
      {bets.loading && bets.data === undefined && <Spinner label="Loading your bets…" />}

      {bets.data !== undefined && groups.length === 0 && (
        <EmptyState
          title={filter === 'open' ? 'No open bets.' : 'Nothing settled yet.'}
          {...(filter === 'open' ? { hint: 'Head to the board and tap a price.' } : {})}
        />
      )}

      {groups.map((group) => (
        <div className="bet-group" key={group.key}>
          <h2 className="day-heading">{group.label}</h2>
          {group.bets.map((bet) => (
            <BetCard key={bet.id} bet={bet} />
          ))}
        </div>
      ))}
    </section>
  );
}
