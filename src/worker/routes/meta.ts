/** Public routes: /api/health, /api/config, /api/auth/kdf. No auth, no DB for health. */

import type { Hono } from 'hono';
import type { AppContext } from '../middleware.js';

export function metaRoutes(): Hono<AppContext> {
  throw new Error('not implemented: M1');
}
