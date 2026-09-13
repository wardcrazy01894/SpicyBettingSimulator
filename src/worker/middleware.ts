/**
 * Hono middleware: auth, CSRF, error envelope, request-scoped clock.
 */

import type { ErrorHandler, MiddlewareHandler } from 'hono';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { Env, RuntimeConfig } from './env.js';

export interface AppVariables {
  /** Captured ONCE per request; every guard in the request uses this value. */
  readonly now: EpochMs;
  readonly config: RuntimeConfig;
  readonly user: UserSummary | null;
  readonly sessionToken: string | null;
}

export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}

/** Seeds `now` and `config`. Must be first. */
export function contextMiddleware(): MiddlewareHandler<AppContext> {
  throw new Error('not implemented: M1');
}

/**
 * CSRF posture (PLAN.md §10.5): SameSite=Lax already blocks cross-site
 * cookie-bearing POSTs; on top of that every non-GET/HEAD request must carry
 * `X-SBS-Client: 1`, and when an `Origin` header is present it must match the
 * request's own origin. Otherwise 403 CSRF_BLOCKED.
 */
export function csrfMiddleware(): MiddlewareHandler<AppContext> {
  throw new Error('not implemented: M3');
}

/** Resolves the session cookie into `c.var.user`, or null. Does not reject. */
export function sessionMiddleware(): MiddlewareHandler<AppContext> {
  throw new Error('not implemented: M3');
}

/** Rejects with 401 UNAUTHENTICATED when there is no user. */
export function requireAuth(): MiddlewareHandler<AppContext> {
  throw new Error('not implemented: M3');
}

/**
 * Rejects with 404 NOT_FOUND (not 403) for non-admins, so /api/admin/* is
 * invisible to a normal user.
 */
export function requireAdmin(): MiddlewareHandler<AppContext> {
  throw new Error('not implemented: M3');
}

/** Turns any thrown value into the `{ error: { code, message } }` envelope. */
export function errorHandler(): ErrorHandler<AppContext> {
  throw new Error('not implemented: M1');
}

/** `cf-connecting-ip`, or null locally. */
export function clientIp(_headers: Headers): string | null {
  throw new Error('not implemented: M3');
}
