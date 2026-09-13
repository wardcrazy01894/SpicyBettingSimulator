/**
 * /api/admin/* — job triggers, job history, user management, reconcile.
 *
 * Non-admins get 404 (not 403) from `requireAdmin`, so the surface is invisible.
 */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function adminRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M4');
}
