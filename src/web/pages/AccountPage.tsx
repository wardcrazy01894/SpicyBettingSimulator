/**
 * Account balances, the full ledger history, and logout.
 *
 * ONE BALANCE, NOT ONE PER LEAGUE (M5b). The page lists every balance the
 * account owns — today that is exactly the `main` one, and the list shape is
 * what makes a future side pot a row rather than a rewrite. The league tabs it
 * used to carry are gone: they selected a BANKROLL, and there is nothing left
 * for them to select. The record/ROI filter lives on the leaderboard instead,
 * where comparing leagues is the point.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { BugReportSheet } from '../components/BugReportSheet.js';
import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LedgerList } from '../components/LedgerList.js';
import { LoadMore } from '../components/LoadMore.js';
import { Spinner } from '../components/Spinner.js';
import { getLedger } from '../api/client.js';
import { LEDGER_PAGE_SIZE, useBalances, useHealth, useLedger } from '../hooks/useApi.js';
import { usePages } from '../hooks/usePages.js';
import { formatRoi } from '../lib/labels.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';
import type { BankrollView, LedgerEntry } from '../../shared/api-types.js';

function BalanceCard(props: { readonly balance: BankrollView }): ReactElement {
  const b = props.balance;
  return (
    <div className="card">
      <h3 className="card-title">{b.name}</h3>
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
  const session = useSession();
  const balances = useBalances();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The button appears only when the server can actually file an issue
  // (`GITHUB_TOKEN` set). Health unreachable => hide it; a form that always 503s
  // is worse than no form.
  const health = useHealth();
  const bugReportsEnabled = health.data?.bugReportsEnabled === true;
  const [reporting, setReporting] = useState(false);

  // The main balance's history. `null` asks the server for its default, which is
  // the main balance — so the first render needs no round-trip to find an id.
  const ledger = useLedger(null);
  // `/api/ledger` pages with a cursor (§11.5). A history is longer than one page
  // for anyone who bets more than once a week.
  const paged = usePages<LedgerEntry>(
    'main',
    ledger.data === undefined
      ? undefined
      : { items: ledger.data.entries, nextCursor: ledger.data.nextCursor },
    (entry) => entry.id,
    async (cursor) => {
      const page = await getLedger({ limit: LEDGER_PAGE_SIZE, cursor });
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

      {balances.data === undefined ? (
        balances.error === undefined ? (
          <Spinner label="Loading your balance…" />
        ) : (
          <ErrorBanner error={balances.error} onRetry={balances.refetch} />
        )
      ) : (
        balances.data.balances.map((balance) => <BalanceCard key={balance.id} balance={balance} />)
      )}

      <h3 className="section-title">Ledger</h3>

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

      {bugReportsEnabled && (
        <>
          <h3 className="section-title">Something broken?</h3>
          <p className="muted page-note">
            Reports go straight to the project's public issue tracker with your username, the page
            you were on, the app version and your browser.
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setReporting(true);
              }}
            >
              Report a bug
            </button>
          </div>
          <BugReportSheet
            open={reporting}
            onClose={() => {
              setReporting(false);
            }}
          />
        </>
      )}

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
