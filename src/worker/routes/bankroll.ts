/** /api/bankroll and /api/ledger. PLAN.md §11.5. */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function bankrollRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M5');
}
