/**
 * Router + provider stack. PLAN.md §12.1.
 *
 *   <SessionProvider> -> <ConfigProvider> -> <BetSlipProvider> -> <AppShell>
 *
 * Routes: / (games), /bets, /leaderboard, /account, /admin, /login
 */

import type { ReactElement } from 'react';

export function App(): ReactElement {
  throw new Error('not implemented: M7a');
}
