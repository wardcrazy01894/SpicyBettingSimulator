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

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LedgerList } from '../components/LedgerList.js';
import { LoadMore } from '../components/LoadMore.js';
import { Spinner } from '../components/Spinner.js';
import { BustBadges } from '../components/BustBadges.js';
import { getLedger, postBustBuyout } from '../api/client.js';
import { LEDGER_PAGE_SIZE, useBalances, useLedger } from '../hooks/useApi.js';
import { invalidate } from '../hooks/useResource.js';
import { usePages } from '../hooks/usePages.js';
import { NET_HELP, NET_HINT, ROI_HELP, ROI_HINT, formatRoi } from '../lib/labels.js';
import { useSession } from '../state/session.js';
import { BUST_BUYOUT_CENTS } from '../../shared/constants.js';
import { formatCents, formatSignedCents } from '../../shared/validate.js';
import { DISPLAY_NAME_MAX } from '../../shared/validate.js';
import type { BankrollView, LedgerEntry } from '../../shared/api-types.js';

/**
 * "Remove a bust badge" — the player pays BUST_BUYOUT_CENTS from this balance
 * to retire one 💀 (PLAN.md §4.5). Shown only on the MAIN balance, only while
 * a badge exists and the balance is STRICTLY above the price — the server
 * enforces the same two conditions inside the ledger INSERT, so the button is
 * a courtesy, not the guard.
 *
 * An INLINE two-step confirm that names the exact deduction, not
 * `window.confirm`: the whole point is that nobody pays $1,000 by accident, and
 * the confirm copy is the one place the price is stated in the player's face.
 */
function BustBuyout(props: { readonly balance: BankrollView }): ReactElement | null {
  const b = props.balance;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const price = formatCents(BUST_BUYOUT_CENTS);
  const receipt = done ? <p className="muted">Badge removed. {price} deducted.</p> : null;
  const eligible = b.kind === 'main' && b.bustCount > 0 && b.balanceCents > BUST_BUYOUT_CENTS;
  // Once the LAST badge is bought the refetch makes bustCount 0, and a plain
  // `return null` here would take the receipt with it — the one confirmation
  // the player gets. So the receipt survives the button.
  if (!eligible) return receipt === null ? null : <div className="bust-buyout">{receipt}</div>;
  const after = formatCents(b.balanceCents - BUST_BUYOUT_CENTS);
  return (
    <div className="bust-buyout">
      {!confirming && (
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => {
            setConfirming(true);
            setDone(false);
            setError(null);
          }}
        >
          Remove a bust badge for {price}
        </button>
      )}
      {confirming && (
        <>
          <p className="muted">
            This deducts <strong>{price}</strong> from your balance ({formatCents(b.balanceCents)} →{' '}
            {after}) and removes one 💀 from your name on the leaderboard. It is not refundable, and
            it counts against your net profit like any other money spent.
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-quiet tone-loss"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void postBustBuyout()
                  .then(() => {
                    setConfirming(false);
                    setDone(true);
                    invalidate('bankroll:');
                    invalidate('ledger:');
                    invalidate('leaderboard:');
                  })
                  .catch((thrown: unknown) => {
                    setError(thrown);
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Paying…' : `Yes, pay ${price}`}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep the badge
            </button>
          </div>
        </>
      )}
      {receipt}
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}

function BalanceCard(props: { readonly balance: BankrollView }): ReactElement {
  const b = props.balance;
  return (
    <div className="card">
      <h3 className="card-title">
        {b.name}
        <BustBadges count={b.bustCount} />
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
          <dt>
            <abbr className="help" title={NET_HELP}>
              Net
            </abbr>
          </dt>
          <dd>
            {formatSignedCents(b.netCents)}
            <small className="stat-hint">{NET_HINT}</small>
          </dd>
        </div>
        <div>
          <dt>Bought in</dt>
          <dd>{formatCents(b.depositedCents)}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            {String(b.record.won)}-{String(b.record.lost)}-{String(b.record.push)}
            {b.record.void > 0 ? ` (${String(b.record.void)} void)` : ''}
          </dd>
        </div>
        <div>
          <dt>
            <abbr className="help" title={ROI_HELP}>
              ROI
            </abbr>
          </dt>
          <dd>
            {formatRoi(b.roi)}
            <small className="stat-hint">{ROI_HINT}</small>
          </dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>{String(b.settledCount)}</dd>
        </div>
      </dl>
      <BustBuyout balance={b} />
    </div>
  );
}

/**
 * Self-service rename. The username is fixed (it is the KDF salt, PLAN.md
 * §10.2); the display name is what the leaderboard and the admin list show.
 * A real <form> so Enter submits; the server is the authority on what a valid
 * name is and its VALIDATION message is shown as-is.
 */
function DisplayNameForm(): ReactElement {
  const session = useSession();
  const current = session.user?.displayName ?? '';
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const unchanged = name.trim() === current || name.trim() === '';

  return (
    <form
      className="admin-reset"
      onSubmit={(e) => {
        e.preventDefault();
        if (unchanged) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        void session
          .setDisplayName(name)
          .then(() => {
            setSaved(true);
          })
          .catch((thrown: unknown) => {
            setError(thrown);
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <label className="field">
        <span className="field-label">Display name</span>
        <input
          className="field-input"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX}
          value={name}
          onChange={(e) => {
            setSaved(false);
            setName(e.target.value);
          }}
        />
      </label>
      <button type="submit" className="btn btn-quiet" disabled={busy || unchanged}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {saved && <p className="muted">Saved.</p>}
      {error !== null && <ErrorBanner error={error} />}
    </form>
  );
}

export function AccountPage(): ReactElement {
  const session = useSession();
  const balances = useBalances();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

      <h3 className="section-title">Profile</h3>
      <DisplayNameForm />

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
