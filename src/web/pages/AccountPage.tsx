/** Bankroll summary per league, full ledger history, logout. */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LeagueTabs } from '../components/LeagueTabs.js';
import { LedgerList } from '../components/LedgerList.js';
import { LoadMore } from '../components/LoadMore.js';
import { Spinner } from '../components/Spinner.js';
import { getLedger } from '../api/client.js';
import { LEDGER_PAGE_SIZE, useBankroll, useLedger } from '../hooks/useApi.js';
import { usePages } from '../hooks/usePages.js';
import { formatRoi, LEAGUE_LABEL } from '../lib/labels.js';
import { useConfig } from '../state/config.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';
import type { LedgerEntry } from '../../shared/api-types.js';
import type { League } from '../../shared/types.js';

function BankrollSummary(props: { readonly league: League }): ReactElement {
  const config = useConfig();
  const season = config.currentSeason[props.league];
  const bankroll = useBankroll(props.league, season);

  if (season === null) {
    return (
      <div className="card">
        <h3 className="card-title">{LEAGUE_LABEL[props.league]}</h3>
        <p className="muted">No season open yet.</p>
      </div>
    );
  }
  if (bankroll.data === undefined) {
    return (
      <div className="card">
        <h3 className="card-title">
          {LEAGUE_LABEL[props.league]} {String(season)}
        </h3>
        {bankroll.error === undefined ? (
          <Spinner label="Loading…" />
        ) : (
          <ErrorBanner error={bankroll.error} onRetry={bankroll.refetch} />
        )}
      </div>
    );
  }

  const b = bankroll.data;
  return (
    <div className="card">
      <h3 className="card-title">
        {LEAGUE_LABEL[props.league]} {String(b.season)}
      </h3>
      <dl className="stat-grid">
        <div>
          <dt>Balance</dt>
          <dd>{formatCents(b.balanceCents)}</dd>
        </div>
        <div>
          <dt>Open exposure</dt>
          <dd>{formatCents(b.pendingStakeCents)}</dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>{formatCents(b.equityCents)}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            {String(b.record.won)}-{String(b.record.lost)}-{String(b.record.push)}
            {b.record.void > 0 ? ` (${String(b.record.void)} void)` : ''}
          </dd>
        </div>
        <div>
          <dt>ROI</dt>
          <dd>{formatRoi(b.roi)}</dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>{String(b.settledCount)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function AccountPage(): ReactElement {
  const config = useConfig();
  const session = useSession();
  const [league, setLeague] = useState<League>(config.leagues[0] ?? 'nfl');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const season = config.currentSeason[league];
  const ledger = useLedger(league, season);
  // `/api/ledger` pages with a cursor (§11.5). A season's history is longer than
  // one page for anyone who bets more than once a week.
  const paged = usePages<LedgerEntry>(
    `${league}:${String(season ?? '')}`,
    ledger.data === undefined
      ? undefined
      : { items: ledger.data.entries, nextCursor: ledger.data.nextCursor },
    (entry) => entry.id,
    async (cursor) => {
      const page = await getLedger({ league, season, limit: LEDGER_PAGE_SIZE, cursor });
      return { items: page.entries, nextCursor: page.nextCursor };
    },
  );

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void action()
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section className="page">
      <h2 className="page-title">
        {session.user?.displayName ?? 'Account'}
        {session.user !== null && <span className="muted"> @{session.user.username}</span>}
      </h2>

      {config.leagues.map((l) => (
        <BankrollSummary key={l} league={l} />
      ))}

      <h3 className="section-title">Ledger</h3>
      <LeagueTabs league={league} leagues={config.leagues} onChange={setLeague} />

      {ledger.error !== undefined && ledger.data === undefined && (
        <ErrorBanner error={ledger.error} onRetry={ledger.refetch} />
      )}
      {ledger.loading && ledger.data === undefined && <Spinner label="Loading the ledger…" />}
      {ledger.data !== undefined &&
        (paged.items.length === 0 ? (
          <EmptyState title="No money has moved yet." />
        ) : (
          <>
            <LedgerList entries={paged.items} />
            <LoadMore paged={paged} label="Load older entries" />
          </>
        ))}

      <h3 className="section-title">Session</h3>
      {error !== null && <ErrorBanner error={error} />}
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => {
            run(session.logout);
          }}
        >
          Log out
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => {
            run(session.logoutAll);
          }}
        >
          Log out everywhere
        </button>
      </div>
    </section>
  );
}
