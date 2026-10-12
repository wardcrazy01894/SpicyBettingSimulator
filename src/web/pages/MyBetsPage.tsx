/**
 * Open / Settled tabs, grouped by (league, football week) and labelled with local
 * dates, with an All / NFL / NCAAF / MLB switch that narrows BOTH the list and
 * the stats strip above it ("stats by sport", 2026-10-11).
 *
 * The strip is `GET /api/bankroll?league=` — record, profit, ROI and settled
 * count over exactly the bets the list below shows, so the two can never
 * disagree about what "my MLB bets" means (PLAN.md §11.5). A parlay that mixes
 * sports is `'mixed'` and lives under All only; `<ScopeNote>` says so.
 *
 * The "Week N" half of PLAN.md §12.3's label is NOT rendered: the frozen wire
 * contract carries no `week` on `BetView`/`BetLegView`. See `groupBetsByWeek`
 * for the full note; the grouping window itself is the same Thu→Mon span.
 * Reviewed and accepted for M7 — adding `week` would mean reopening a frozen
 * file (CLAUDE.md, merge etiquette) or one extra request per game.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { BetCard } from '../components/BetCard.js';
import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LoadMore } from '../components/LoadMore.js';
import { RecordStats, ScopeNote } from '../components/RecordStats.js';
import { ScopeTabs } from '../components/ScopeTabs.js';
import { Segmented } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { getBets } from '../api/client.js';
import { useBalanceStats, useBets } from '../hooks/useApi.js';
import { usePoll } from '../hooks/useNow.js';
import { usePages } from '../hooks/usePages.js';
import { groupBetsByWeek } from '../lib/grouping.js';
import { betsEmptyTitle, scopeLeague } from '../lib/scope.js';
import type { Scope } from '../lib/scope.js';
import type { BetView } from '../../shared/api-types.js';

type Filter = 'open' | 'settled';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'settled', label: 'Settled' },
];

/** Open bets carry a live `projected` grade, so they are worth re-reading. */
const OPEN_POLL_MS = 60_000;

/** The main balance's statistics under the chosen sport, in a card with the switch. */
function StatsCard(props: {
  readonly scope: Scope;
  readonly onScope: (scope: Scope) => void;
}): ReactElement {
  const { scope, onScope } = props;
  const balances = useBalanceStats(scope);
  const main = balances.data?.balances.find((b) => b.kind === 'main');
  return (
    <div className="card">
      <div className="stats-head">
        <h3 className="card-title">Your stats</h3>
        <ScopeTabs scope={scope} onChange={onScope} />
      </div>
      {main === undefined ? (
        balances.error === undefined ? (
          <Spinner label="Loading your stats…" />
        ) : (
          <ErrorBanner error={balances.error} onRetry={balances.refetch} />
        )
      ) : (
        <dl className="stat-grid">
          <RecordStats stats={main} />
        </dl>
      )}
      <ScopeNote scope={scope} />
    </div>
  );
}

export function MyBetsPage(): ReactElement {
  const [filter, setFilter] = useState<Filter>('open');
  const [scope, setScope] = useState<Scope>('all');
  const bets = useBets(filter, scope);
  usePoll(bets.refetch, filter === 'open' ? OPEN_POLL_MS : 5 * OPEN_POLL_MS);

  // `/api/bets` pages with a cursor (§11.4); without this the list stopped dead
  // at the server's default page size with no way to reach anything older.
  const paged = usePages<BetView>(
    `${filter}:${scope}`,
    bets.data === undefined
      ? undefined
      : { items: bets.data.bets, nextCursor: bets.data.nextCursor },
    (bet) => bet.id,
    async (cursor) => {
      const page = await getBets({ status: filter, league: scopeLeague(scope) ?? null, cursor });
      return { items: page.bets, nextCursor: page.nextCursor };
    },
  );

  const groups = groupBetsByWeek(paged.items);

  return (
    <section className="page">
      <StatsCard scope={scope} onScope={setScope} />

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
          title={betsEmptyTitle(filter, scope, null)}
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

      <LoadMore paged={paged} label="Load older bets" />
    </section>
  );
}
