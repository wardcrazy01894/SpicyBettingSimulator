/**
 * /api/games — the board. PLAN.md §11.3.
 *
 * `bettable` and `lockAt` are computed SERVER-side and sent down; the client must
 * never decide bettability itself.
 */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function gamesRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M5');
}
