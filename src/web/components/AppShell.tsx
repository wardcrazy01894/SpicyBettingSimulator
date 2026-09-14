/** Header, nav tabs, <Outlet/>, and the sticky bet-slip bar on small screens. */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';

import { BetSlip } from './BetSlip.js';
import { BetSlipBar } from './BetSlipBar.js';
import { BugReportSheet } from './BugReportSheet.js';
import { NavTabs } from './NavTabs.js';
import { Spinner } from './Spinner.js';
import { useBalances, useHealth } from '../hooks/useApi.js';
import { BugReportProvider, useBugReport } from '../state/bug-report.js';
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

/**
 * "Report a bug" from ANY page (PLAN.md §11.7): a header button and the sheet
 * live here, above the router, and pages reach them through `useBugReport`.
 * Hidden when the server has no GitHub token to file with.
 */
function BugReportButton(): ReactElement {
  const health = useHealth();
  const bugs = useBugReport();
  if (health.data?.bugReportsEnabled !== true) return <></>;
  return (
    <button type="button" className="btn btn-quiet btn-bug" onClick={bugs.open}>
      Report a bug
    </button>
  );
}

function BugReportMount(): ReactElement {
  const bugs = useBugReport();
  return <BugReportSheet open={bugs.isOpen} onClose={bugs.close} />;
}

export function AppShell(): ReactElement {
  return (
    <BugReportProvider>
      <Shell />
    </BugReportProvider>
  );
}

function Shell(): ReactElement {
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
        <div className="app-header-right">
          <BugReportButton />
          <BankrollBadge />
        </div>
      </header>
      <NavTabs />
      <main className="app-main">
        <Outlet />
      </main>
      <BetSlipBar />
      <BetSlip />
      <BugReportMount />
    </div>
  );
}
