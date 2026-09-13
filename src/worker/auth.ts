/**
 * Signup / login / throttling service. PLAN.md §10.
 *
 * Never leaks whether a username exists on the LOGIN path: unknown users run a
 * dummy verification against a fixed decoy salt and get the identical
 * 401 INVALID_CREDENTIALS. (Signup necessarily returns 409 USERNAME_TAKEN; that
 * is documented and accepted for a 10-person invite-only app.)
 */

import type { EpochMs, UserSummary } from '../shared/types.js';
import type { LoginInput, SignupInput } from '../shared/validate.js';
import type { Env } from './env.js';

export interface AuthOk {
  readonly user: UserSummary;
  readonly token: string;
}

/**
 * Create a user + session.
 *
 * The whole thing is ONE batch so that "first user becomes admin" cannot be won
 * by two simultaneous signups: `is_admin` is computed inside the INSERT as
 * `CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END`, and the
 * UNIQUE(username) constraint decides the winner.
 *
 * @throws AppError BAD_INVITE_CODE | USERNAME_TAKEN | RATE_LIMITED
 */
export function signup(_env: Env, _input: SignupInput, _now: EpochMs): Promise<AuthOk> {
  throw new Error('not implemented: M3');
}

/** @throws AppError INVALID_CREDENTIALS | ACCOUNT_DISABLED | RATE_LIMITED */
export function login(
  _env: Env,
  _input: LoginInput,
  _clientIp: string | null,
  _now: EpochMs,
): Promise<AuthOk> {
  throw new Error('not implemented: M3');
}

/** Admin-only password reset; takes an already-derived key, never a password. */
export function setPassword(
  _env: Env,
  _userId: string,
  _dkHex: string,
  _now: EpochMs,
): Promise<void> {
  throw new Error('not implemented: M3');
}

export function setDisabled(
  _env: Env,
  _userId: string,
  _disabled: boolean,
  _now: EpochMs,
): Promise<void> {
  throw new Error('not implemented: M3');
}

// --- throttling -----------------------------------------------------------

export interface ThrottleState {
  readonly locked: boolean;
  readonly retryAfterMs: number;
}

/** Checks BOTH the username key and the hashed-IP key; the stricter one wins. */
export function checkThrottle(
  _env: Env,
  _username: string,
  _clientIp: string | null,
  _now: EpochMs,
): Promise<ThrottleState> {
  throw new Error('not implemented: M3');
}

export function recordFailure(
  _env: Env,
  _username: string,
  _clientIp: string | null,
  _now: EpochMs,
): Promise<void> {
  throw new Error('not implemented: M3');
}

export function clearFailures(_env: Env, _username: string): Promise<void> {
  throw new Error('not implemented: M3');
}

/** sha256(ip + IP_HASH_SALT) truncated to 16 chars. Raw IPs are never stored. */
export function throttleIpKey(_env: Env, _clientIp: string | null): Promise<string | null> {
  throw new Error('not implemented: M3');
}
