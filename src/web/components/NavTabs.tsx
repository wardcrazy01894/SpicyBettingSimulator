/** Bottom tab bar on mobile, top nav on wide screens. Games / Bets / Board / Me. */
import { NavLink } from 'react-router-dom';
import type { ReactElement } from 'react';

import { useSession } from '../state/session.js';

interface Tab {
  readonly to: string;
  readonly label: string;
}

const TABS: readonly Tab[] = [
  { to: '/', label: 'Games' },
  { to: '/bets', label: 'My Bets' },
  { to: '/leaderboard', label: 'Board' },
  { to: '/account', label: 'Account' },
];

export function NavTabs(): ReactElement {
  const session = useSession();
  const tabs = session.user?.isAdmin === true ? [...TABS, { to: '/admin', label: 'Admin' }] : TABS;

  return (
    <nav className="nav-tabs" aria-label="Main">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/'}
          className={({ isActive }) => (isActive ? 'nav-tab nav-tab-active' : 'nav-tab')}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
