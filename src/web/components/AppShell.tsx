/** Header, nav tabs, <Outlet/>, and the sticky bet-slip bar on small screens. */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';

import { BetSlip } from './BetSlip.js';
import { BetSlipBar } from './BetSlipBar.js';
import { NavTabs } from './NavTabs.js';
import { Spinner } from './Spinner.js';
import { useBalances } from '../hooks/useApi.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';

/**
 * The ACCOUNT balance and its equity. One number for the whole app (M5b) — it no
 * longer changes when the board's league tab does, because there is no longer a
 * per-league pot for it to change to.
 *
 * `equityCents = balance + pending` (PLAN.md §11.5): pending stakes are ALREADY
 * deducted from the balance, so equity is what the account would be worth if
 * every open bet were voided.
 */
function BankrollBadge(): ReactElement {
  const balances = useBalances();
  const main = balances.data?.balances.find((b) => b.kind === 'main');

  if (main === undefined) {
    return <span className="bankroll bankroll-empty">—</span>;
  }
  return (
    <span className="bankroll">
      <span className="bankroll-balance">{formatCents(main.balanceCents)}</span>
      <span className="bankroll-equity">equity {formatCents(main.equityCents)}</span>
    </span>
  );
}

export function AppShell(): ReactElement {
  const session = useSession();
  const location = useLocation();

  if (session.status === 'loading') {
    return (
      <div className="boot">
        <Spinner label="Signing you in…" />
      </div>
    );
  }
  if (session.status === 'anon') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">Spicy</span>
        <BankrollBadge />
      </header>
      <NavTabs />
      <main className="app-main">
        <Outlet />
      </main>
      <BetSlipBar />
      <BetSlip />
    </div>
  );
}
