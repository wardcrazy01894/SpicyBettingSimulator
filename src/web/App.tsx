/**
 * Router + provider stack. PLAN.md §12.1.
 *
 *   <SessionProvider> -> <ConfigProvider> -> <BetSlipProvider> -> <AppShell>
 *
 * Routes: / (games), /bets, /leaderboard, /players/:userId, /account, /admin, /login
 *
 * ORDER MATTERS. Session is outermost because everything below it needs to know
 * whether there is a user; Config is next because the slip needs
 * `currentSeason`/`maxParlayLegs`/`minStakeCents` before it can price anything;
 * the slip is innermost because only the board and My Bets touch it.
 *
 * `/login` sits OUTSIDE `<AppShell>` — the shell redirects anonymous visitors to
 * it, so nesting them would loop.
 */

import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

import { AppShell } from './components/AppShell.js';
import { AccountPage } from './pages/AccountPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { GamesPage } from './pages/GamesPage.js';
import { LeaderboardPage } from './pages/LeaderboardPage.js';
import { MyBetsPage } from './pages/MyBetsPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PlayerBetsPage } from './pages/PlayerBetsPage.js';
import { BetSlipProvider } from './state/BetSlipContext.js';
import { ConfigProvider } from './state/ConfigContext.js';
import { SessionProvider } from './state/SessionContext.js';

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ConfigProvider>
          <BetSlipProvider>
            <Routes>
              <Route path="/login" element={<AuthPage />} />
              <Route element={<AppShell />}>
                <Route index element={<GamesPage />} />
                <Route path="/bets" element={<MyBetsPage />} />
                <Route path="/leaderboard" element={<LeaderboardPage />} />
                <Route path="/players/:userId" element={<PlayerBetsPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BetSlipProvider>
        </ConfigProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
