/** /api/bets — place, list, get, cancel (DELETE), edit (PUT). PLAN.md §11.4. */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function betsRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M5');
}
