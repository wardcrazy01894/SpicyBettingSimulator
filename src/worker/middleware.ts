/**
 * Hono middleware: auth, CSRF, error envelope, request-scoped clock.
 */

import type { ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../shared/constants.js';
import { AppError, fromThrown } from '../shared/errors.js';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { Env, RuntimeConfig } from './env.js';
import { nowMs } from './db.js';
import { readConfig } from './env.js';
import { readSessionCookieHeaders, resolveSession } from './session.js';

export interface AppVariables {
  /** Captured ONCE per request; every guard in the request uses this value. */
  readonly now: EpochMs;
  readonly config: RuntimeConfig;
  readonly user: UserSummary | null;
  readonly sessionToken: string | null;
  /** Set by `errorHandler` so the request log can name the code, not just the status. */
  readonly errorCode: string | null;
}

export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}

/** Seeds `now` and `config`. Must be first. */
export function contextMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    c.set('now', nowMs());
    c.set('config', readConfig(c.env));
    // M3's sessionMiddleware overwrites these; until then every request is anonymous.
    c.set('user', null);
    c.set('sessionToken', null);
    c.set('errorCode', null);
    await next();
  };
}

/** A request slower than this is logged even when it succeeded. */
export const SLOW_REQUEST_MS = 1_000;

/**
 * ONE log line per request that went wrong or went slowly — status >= 400 or
 * over `SLOW_REQUEST_MS` — so `wrangler tail` and Workers Logs can answer "what
 * failed for whom, when" without a debugger (docs/OPERATIONS.md "Logs"). 2xx
 * requests under the threshold are silent: the log is for diagnosis, not
 * traffic. Must be OUTERMOST so it sees the error handler's response and the
 * session middleware's `user`. Never logs bodies, tokens or query strings.
 */
export function requestLogMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const started = Date.now();
    await next();
    const ms = Date.now() - started;
    const status = c.res.status;
    if (status < 400 && ms < SLOW_REQUEST_MS) return;
    const path = new URL(c.req.url).pathname;
    const user = c.var.user;
    const line = `${c.req.method} ${path} ${String(status)}${
      c.var.errorCode === null ? '' : ` ${c.var.errorCode}`
    } user=${user === null ? 'anon' : user.username} ${String(ms)}ms`;
    if (status >= 500) console.error('[api]', line);
    else console.warn('[api]', line);
  };
}

/**
 * CSRF posture (PLAN.md §10.5): SameSite=Lax already blocks cross-site
 * cookie-bearing POSTs; on top of that every non-GET/HEAD request must carry
 * `X-SBS-Client: 1`, and when an `Origin` header is present it must match the
 * request's own origin. Otherwise 403 CSRF_BLOCKED.
 */
export function csrfMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw new AppError('CSRF_BLOCKED', `Missing or invalid ${CSRF_HEADER} header.`);
    }
    // `Origin` is absent on same-origin non-CORS requests in some browsers, so
    // it is checked only when present — the header above is the primary gate.
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      throw new AppError('CSRF_BLOCKED', 'Cross-origin request refused.');
    }
    await next();
  };
}

/** GET/HEAD/OPTIONS are side-effect free and never carry the CSRF header. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves the session cookie into `c.var.user`, or null. Does not reject. */
export function sessionMiddleware(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const candidates = readSessionCookieHeaders(c.req.raw.headers.get('cookie'));
    // Set even when nothing resolves, so POST /api/auth/logout can still delete
    // the (expired) row the browser is holding.
    if (candidates[0] !== undefined) c.set('sessionToken', candidates[0]);
    for (const token of candidates) {
      const resolved = await resolveSession(c.env, token, c.var.now);
      if (resolved !== null) {
        c.set('sessionToken', token);
        c.set('user', resolved.user);
        break;
      }
    }
    await next();
  };
}

/** Rejects with 401 UNAUTHENTICATED when there is no user. */
export function requireAuth(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (c.var.user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    await next();
  };
}

/**
 * Rejects with 404 NOT_FOUND (not 403) for non-admins, so /api/admin/* is
 * invisible to a normal user.
 */
export function requireAdmin(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (c.var.user?.isAdmin !== true) {
      throw new AppError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`);
    }
    await next();
  };
}

/** Turns any thrown value into the `{ error: { code, message } }` envelope. */
export function errorHandler(): ErrorHandler<AppContext> {
  return (err, c) => {
    const appErr = fromThrown(err);
    c.set('errorCode', appErr.code);
    if (appErr.code === 'INTERNAL') {
      // The body never carries the original message or stack; the log does.
      console.error('[api] unhandled error', c.req.method, c.req.path, err);
    }
    return c.json(appErr.toBody(), appErr.status as ContentfulStatusCode);
  };
}

/** `cf-connecting-ip`, or null locally. */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get('cf-connecting-ip');
  return ip === null || ip.trim() === '' ? null : ip.trim();
}
