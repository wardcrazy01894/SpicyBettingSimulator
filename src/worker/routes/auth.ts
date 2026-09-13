/**
 * /api/auth/* — signup, login, logout, me. PLAN.md §11.2.
 *
 * Bodies carry `dk` (the 64-hex browser-derived key), never a password.
 */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function authRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M3');
}
