/**
 * Session issuance, lookup and cookie handling. PLAN.md §10.5.
 *
 * `sessions.id` is sha256hex(token); the raw token exists only in the cookie, so
 * a database dump grants no live sessions.
 */

import type { Context } from 'hono';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { Env } from './env.js';

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly lastSeenAt: EpochMs;
}

/** Create a session row and return the raw token to put in the cookie. */
export function createSession(
  _env: Env,
  _userId: string,
  _now: EpochMs,
): Promise<{ readonly token: string; readonly session: SessionRecord }> {
  throw new Error('not implemented: M3');
}

/**
 * Resolve a raw token to its user. Returns null when absent, unknown, expired or
 * the user is disabled.
 *
 * Rolling expiry: `expires_at`/`last_seen_at` are rewritten only when more than
 * SESSION_TOUCH_INTERVAL_MS has elapsed, so a normal page view costs zero D1
 * writes against the 100k/day budget.
 */
export function resolveSession(
  _env: Env,
  _token: string,
  _now: EpochMs,
): Promise<{ readonly session: SessionRecord; readonly user: UserSummary } | null> {
  throw new Error('not implemented: M3');
}

export function deleteSession(_env: Env, _token: string): Promise<void> {
  throw new Error('not implemented: M3');
}

export function deleteAllSessionsForUser(_env: Env, _userId: string): Promise<void> {
  throw new Error('not implemented: M3');
}

/** `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…` */
export function buildSessionCookie(_token: string, _secure: boolean): string {
  throw new Error('not implemented: M3');
}

/** Same attributes with `Max-Age=0`, so the browser actually drops it. */
export function buildClearedSessionCookie(_secure: boolean): string {
  throw new Error('not implemented: M3');
}

export function readSessionCookie(_c: Context<{ Bindings: Env }>): string | null {
  throw new Error('not implemented: M3');
}
