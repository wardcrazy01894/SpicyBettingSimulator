/** Header, nav tabs, <Outlet/>, and the sticky bet-slip bar on small screens. */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';

import { BetSlip } from './BetSlip.js';
import { BetSlipBar } from './BetSlipBar.js';
import { NavTabs } from './NavTabs.js';
import { Spinner } from './Spinner.js';
import { useBankroll } from '../hooks/useApi.js';
import { LEAGUE_LABEL } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';

/**
 * Balance and equity for the slip's active league, so the header agrees with
 * what the slip is spending. `equityCents = balance + pending` (PLAN.md §11.5):
 * pending stakes are ALREADY deducted from the balance, so equity is what the
 * bankroll would be worth if every open bet were voided.
 */
function BankrollBadge(): ReactElement {
  const config = useConfig();
  const slip = useBetSlip();
  const season = config.currentSeason[slip.league];
  const bankroll = useBankroll(slip.league, season);

  if (bankroll.data === undefined) {
    return <span className="bankroll bankroll-empty">{LEAGUE_LABEL[slip.league]} —</span>;
  }
  return (
    <span className="bankroll">
      <span className="bankroll-balance">{formatCents(bankroll.data.balanceCents)}</span>
      <span className="bankroll-equity">equity {formatCents(bankroll.data.equityCents)}</span>
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
