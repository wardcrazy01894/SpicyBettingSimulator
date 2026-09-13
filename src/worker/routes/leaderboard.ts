/** /api/leaderboard and /api/leaderboard/all-time. PLAN.md §11.5. */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function leaderboardRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M5');
}
