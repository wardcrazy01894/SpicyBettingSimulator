/**
 * /api/admin/* — job triggers, job history, user management, reconcile.
 *
 * Non-admins get 404 (not 403) from `requireAdmin`, so the surface is invisible.
 *
 * OWNERSHIP (PLAN.md §16): M4 owns this router's skeleton; each milestone adds
 * its OWN delimited block and touches nobody else's. M3 landed the skeleton
 * early (M3 and M4 run in parallel and M3's user routes had nothing to attach
 * to) together with the `/users` block below and one placeholder per remaining
 * group. M4 replaces its placeholder in place; nothing else here moves.
 */

import { Hono } from 'hono';
import type { AdminUsersResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { validateDerivedKeyHex } from '../../shared/validate.js';
import { listUsers, setDisabled, setPassword } from '../auth.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readJson, validationError } from './auth.js';

export function adminRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  // Anonymous callers get 401 like every other private route; a signed-in
  // NON-admin gets 404, so the admin surface is invisible to them (PLAN §11.6).
  app.use('*', requireAuth(), requireAdmin());

  // --- users (M3) ---------------------------------------------------------
  app.get('/users', async (c) => {
    const body: AdminUsersResponse = { users: await listUsers(c.env) };
    return c.json(body, 200);
  });

  app.post('/users/:id/password', async (c) => {
    const raw = await readJson(c);
    const dk = validateDerivedKeyHex(isRecord(raw) ? raw['dk'] : undefined);
    if (!dk.ok) throw validationError(dk);
    // The admin never sees a password: they run scripts/admin-hash.mjs (or the
    // admin UI runs the browser KDF) and send the derived key. PLAN.md §10.6.
    await setPassword(c.env, c.req.param('id'), dk.value, c.var.now);
    return c.body(null, 204);
  });

  app.post('/users/:id/disabled', async (c) => {
    const raw = await readJson(c);
    const disabled = isRecord(raw) ? raw['disabled'] : undefined;
    if (typeof disabled !== 'boolean') {
      throw new AppError('VALIDATION', 'disabled must be a boolean', { field: 'disabled' });
    }
    await setDisabled(c.env, c.req.param('id'), disabled, c.var.now);
    return c.body(null, 204);
  });
  // --- end users (M3) -----------------------------------------------------

  // --- jobs (M4) ----------------------------------------------------------
  // TODO(M4): POST /jobs/:job  -> runJob(...) | 409 JOB_LOCKED
  // TODO(M4): GET  /jobs       -> last 50 job_runs

  // --- bets (M6) ----------------------------------------------------------
  // TODO(M6): POST /bets/:id/retry-settlement -> clear settle_attempts/settle_error

  // --- reconcile (M8) -----------------------------------------------------
  // TODO(M8): POST /reconcile  -> reconcileBankrolls(env), read-only drift report

  return app;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
