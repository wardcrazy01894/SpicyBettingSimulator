/**
 * /api/auth/* — signup, login, logout, me. PLAN.md §11.2.
 *
 * Bodies carry `dk` (the 64-hex browser-derived key), never a password.
 *
 * NOTE: GET /api/auth/kdf is served by routes/meta.ts (mounted first on
 * '/api'); do NOT add a '/kdf' handler here — it would be unreachable.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { UserResponse } from '../../shared/api-types.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { validateDisplayNameUpdate, validateLogin, validateSignup } from '../../shared/validate.js';
import {
  checkThrottle,
  clearFailures,
  isRateLimited,
  login,
  rateLimited,
  recordFailure,
  setDisplayName,
  signup,
} from '../auth.js';
import { clientIp, requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  deleteAllSessionsForUser,
  deleteSession,
} from '../session.js';

export function authRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.post('/signup', async (c) => {
    const parsed = validateSignup(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    const input = parsed.value;
    const ip = clientIp(c.req.raw.headers);

    // PLAN.md §11.2 lists 429 RATE_LIMITED for signup. §10.5 only specifies the
    // LOGIN throttle and `signup()` takes no IP, so the counter is driven from
    // here: an invite code is a shared secret and guessing it must be as
    // expensive as guessing a password. Only a BAD_INVITE_CODE counts —
    // USERNAME_TAKEN and VALIDATION are honest mistakes, not guesses.
    const throttle = await checkThrottle(c.env, input.username, ip, c.var.now);
    if (throttle.locked) return rateLimitResponse(c, rateLimited(throttle));

    let result;
    try {
      result = await signup(c.env, input, c.var.now);
    } catch (err) {
      if (isAppError(err) && err.code === 'BAD_INVITE_CODE') {
        await recordFailure(c.env, input.username, ip, c.var.now);
      }
      throw err;
    }
    await clearFailures(c.env, input.username);

    const body: UserResponse = { user: result.user };
    c.header('Set-Cookie', buildSessionCookie(result.token, c.var.config.cookieSecure));
    return c.json(body, 201);
  });

  app.post('/login', async (c) => {
    const parsed = validateLogin(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    let result;
    try {
      result = await login(c.env, parsed.value, clientIp(c.req.raw.headers), c.var.now);
    } catch (err) {
      if (isRateLimited(err)) return rateLimitResponse(c, err);
      throw err;
    }
    const body: UserResponse = { user: result.user };
    c.header('Set-Cookie', buildSessionCookie(result.token, c.var.config.cookieSecure));
    return c.json(body, 200);
  });

  // No `requireAuth`: logging out of an already-dead session is a 204, not an
  // error, and the browser still needs the cookie cleared.
  app.post('/logout', async (c) => {
    const token = c.var.sessionToken;
    if (token !== null) await deleteSession(c.env, token);
    c.header('Set-Cookie', buildClearedSessionCookie(c.var.config.cookieSecure));
    return c.body(null, 204);
  });

  app.post('/logout-all', requireAuth(), async (c) => {
    const user = c.var.user;
    if (user !== null) await deleteAllSessionsForUser(c.env, user.id);
    c.header('Set-Cookie', buildClearedSessionCookie(c.var.config.cookieSecure));
    return c.body(null, 204);
  });

  app.post('/display-name', requireAuth(), async (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const parsed = validateDisplayNameUpdate(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    const renamed = await setDisplayName(c.env, user.id, parsed.value.displayName, c.var.now);
    const body: UserResponse = { user: renamed };
    return c.json(body, 200);
  });

  app.get('/me', requireAuth(), (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const body: UserResponse = { user };
    return c.json(body, 200);
  });

  return app;
}

/**
 * `c.req.json()` on an absent or unparseable body throws a SyntaxError, which
 * would otherwise surface as 500 INTERNAL. PLAN.md §11 requires
 * 400 MALFORMED_JSON.
 */
export async function readJson(c: {
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined };
}): Promise<unknown> {
  // PLAN §11: bodies are JSON. Enforcing the media type is defence in depth on
  // top of the X-SBS-Client header (a cross-site text/plain form can't set
  // either), and it stops a proxy from ever mis-parsing us.
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new AppError('VALIDATION', 'Content-Type must be application/json.', {
      field: 'content-type',
    });
  }
  try {
    return await c.req.json();
  } catch {
    throw new AppError('MALFORMED_JSON', 'Request body is not valid JSON.');
  }
}

/**
 * 429 with a `Retry-After` header. Built here rather than in `errorHandler`
 * because that middleware is M1's and renders a body-only envelope; M3 must not
 * make structural edits to it (PLAN.md §16).
 */
function rateLimitResponse(c: Context<AppContext>, err: AppError): Response {
  const raw = err.details?.['retryAfterSeconds'];
  const seconds = typeof raw === 'number' && raw > 0 ? raw : 1;
  return c.json(err.toBody(), 429, { 'Retry-After': String(seconds) });
}

/** A failed `ValidationResult` -> 400 VALIDATION, keeping the offending field. */
export function validationError(result: {
  readonly message: string;
  readonly field?: string;
}): AppError {
  return result.field === undefined
    ? new AppError('VALIDATION', result.message)
    : new AppError('VALIDATION', result.message, { field: result.field });
}
