/**
 * Signup / login / throttling service. PLAN.md §10.
 *
 * Never leaks whether a username exists on the LOGIN path: unknown users run a
 * dummy verification against a fixed decoy salt and get the identical
 * 401 INVALID_CREDENTIALS. (Signup necessarily returns 409 USERNAME_TAKEN; that
 * is documented and accepted for a 10-person invite-only app.)
 */

import {
  AUTH_LOCKOUT_MS,
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  CLIENT_KDF,
  KDF_VERSION,
  SERVER_KDF_ITERATIONS,
} from '../shared/constants.js';
import { AppError, isAppError } from '../shared/errors.js';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { LoginInput, SignupInput } from '../shared/validate.js';
import type { Env } from './env.js';
import {
  blobToBytes,
  hashDerivedKey,
  newServerSalt,
  dummyVerify,
  timingSafeEqual,
  timingSafeEqualString,
  toBlobParam,
  sha256Hex,
} from './crypto.js';
import { changesAt, newId, queryAll, queryOne, runBatch } from './db.js';
import { insertSessionStatement, newSessionMaterial } from './session.js';
import { isUniqueViolation } from './db.js';

export interface AuthOk {
  readonly user: UserSummary;
  readonly token: string;
}

/** The `users` columns every caller here reads back. */
interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly is_admin: number;
  readonly is_disabled: number;
  readonly created_at: number;
}

interface CredentialRow extends UserRow {
  readonly server_salt: unknown;
  readonly server_iterations: number;
  readonly password_hash: unknown;
}

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  };
}

/**
 * Check the invite gate. Constant-time, and a MISSING code is the same failure
 * as a wrong one. When `INVITE_CODE` is unset signup is open — `/api/health`
 * reports `inviteRequired: false` so that is never a silent misconfiguration.
 *
 * @throws AppError BAD_INVITE_CODE
 */
export function assertInviteCode(env: Env, supplied: string | null): void {
  const required = env.INVITE_CODE;
  if (typeof required !== 'string' || required === '') return;
  if (supplied === null || !timingSafeEqualString(supplied, required)) {
    throw new AppError('BAD_INVITE_CODE', 'That invite code is not valid.');
  }
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
export async function signup(env: Env, input: SignupInput, now: EpochMs): Promise<AuthOk> {
  assertInviteCode(env, input.inviteCode);

  const serverSalt = newServerSalt();
  const passwordHash = await hashDerivedKey(input.dk, serverSalt, SERVER_KDF_ITERATIONS);
  const userId = newId();
  const { token, session } = await newSessionMaterial(userId, now);

  // One batch: the user row, its session, and the read-back of the conditional
  // `is_admin`. If the username is taken the UNIQUE index aborts statement 1 and
  // D1 rolls the whole thing back, so no orphan session can survive.
  let results: readonly D1Result[];
  try {
    results = await runBatch(env.DB, [
      env.DB.prepare(
        `INSERT INTO users (id, username, display_name, kdf_version, client_iterations,
                              server_salt, server_iterations, password_hash,
                              is_admin, is_disabled, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                   CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END,
                   0, ?9, ?9)`,
      ).bind(
        userId,
        input.username,
        input.displayName,
        KDF_VERSION,
        CLIENT_KDF.iterations,
        toBlobParam(serverSalt),
        SERVER_KDF_ITERATIONS,
        toBlobParam(passwordHash),
        now,
      ),
      insertSessionStatement(env, session),
      env.DB.prepare(
        'SELECT id, username, display_name, is_admin, is_disabled, created_at FROM users WHERE id = ?1',
      ).bind(userId),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, 'users.username')) {
      throw new AppError('USERNAME_TAKEN', 'That username is already taken.');
    }
    throw err;
  }

  const row = (results[2]?.results as readonly UserRow[] | undefined)?.[0];
  if (row === undefined) throw new AppError('INTERNAL', 'Signup did not persist.');
  return { user: toSummary(row), token };
}

/** @throws AppError INVALID_CREDENTIALS | ACCOUNT_DISABLED | RATE_LIMITED */
export async function login(
  env: Env,
  input: LoginInput,
  clientIp: string | null,
  now: EpochMs,
): Promise<AuthOk> {
  // The throttle is checked BEFORE any verification, so a locked account cannot
  // be probed even with the correct key.
  const throttle = await checkThrottle(env, input.username, clientIp, now);
  if (throttle.locked) throw rateLimited(throttle);

  const row = await queryOne<CredentialRow>(
    env.DB.prepare(
      `SELECT id, username, display_name, is_admin, is_disabled, created_at,
              server_salt, server_iterations, password_hash
         FROM users WHERE username = ?1`,
    ).bind(input.username),
  );

  if (row === null) {
    // No such user: burn the same PBKDF2 against a decoy salt and return the
    // IDENTICAL error, so there is no enumeration oracle (PLAN.md §10.2).
    await dummyVerify(input.dk);
    await recordFailure(env, input.username, clientIp, now);
    throw invalidCredentials();
  }

  const candidate = await hashDerivedKey(
    input.dk,
    blobToBytes(row.server_salt),
    row.server_iterations,
  );
  if (!timingSafeEqual(candidate, blobToBytes(row.password_hash))) {
    await recordFailure(env, input.username, clientIp, now);
    throw invalidCredentials();
  }

  // Only AFTER the key checks out is the account state revealed — otherwise
  // "is this account disabled?" would itself be an oracle.
  if (row.is_disabled === 1) {
    throw new AppError('ACCOUNT_DISABLED', 'This account has been disabled.');
  }

  const { token, session } = await newSessionMaterial(row.id, now);
  await runBatch(env.DB, [insertSessionStatement(env, session)]);
  await clearFailures(env, input.username);
  return { user: toSummary(row), token };
}

function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect.');
}

/** `details.retryAfterSeconds` is what routes/auth.ts turns into `Retry-After`. */
export function rateLimited(state: ThrottleState): AppError {
  return new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', {
    retryAfterSeconds: retryAfterSeconds(state),
  });
}

/** Ceiling division in integers — `Math.ceil` is banned in src/worker. */
export function retryAfterSeconds(state: ThrottleState): number {
  const ms = state.retryAfterMs > 0 ? state.retryAfterMs : 1;
  return (ms + 999 - ((ms + 999) % 1000)) / 1000;
}

/** True when the thrown value is our own RATE_LIMITED AppError. */
export function isRateLimited(err: unknown): err is AppError {
  return isAppError(err) && err.code === 'RATE_LIMITED';
}

/** Admin-only password reset; takes an already-derived key, never a password. */
export async function setPassword(
  env: Env,
  userId: string,
  dkHex: string,
  now: EpochMs,
): Promise<void> {
  const serverSalt = newServerSalt();
  const passwordHash = await hashDerivedKey(dkHex, serverSalt, SERVER_KDF_ITERATIONS);
  const results = await runBatch(env.DB, [
    env.DB.prepare(
      `UPDATE users
            SET kdf_version = ?2, client_iterations = ?3, server_salt = ?4,
                server_iterations = ?5, password_hash = ?6, updated_at = ?7
          WHERE id = ?1`,
    ).bind(
      userId,
      KDF_VERSION,
      CLIENT_KDF.iterations,
      toBlobParam(serverSalt),
      SERVER_KDF_ITERATIONS,
      toBlobParam(passwordHash),
      now,
    ),
    // A password reset revokes every live session: otherwise an admin who resets
    // a compromised account has not actually evicted anyone.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
  ]);
  if (changesAt(results, 0) === 0) {
    throw new AppError('NOT_FOUND', 'No such user.');
  }
}

export async function setDisabled(
  env: Env,
  userId: string,
  disabled: boolean,
  now: EpochMs,
): Promise<void> {
  // Sessions are deliberately NOT deleted: `resolveSession` joins on
  // `is_disabled = 0`, so they stop resolving immediately and start working
  // again if the account is re-enabled.
  const results = await runBatch(env.DB, [
    env.DB.prepare('UPDATE users SET is_disabled = ?2, updated_at = ?3 WHERE id = ?1').bind(
      userId,
      disabled ? 1 : 0,
      now,
    ),
  ]);
  if (changesAt(results, 0) === 0) {
    throw new AppError('NOT_FOUND', 'No such user.');
  }
}

/** Everyone, for `GET /api/admin/users`. Never exposes credential material. */
export async function listUsers(
  env: Env,
): Promise<readonly (UserSummary & { isDisabled: boolean })[]> {
  const rows = await queryAll<UserRow>(
    env.DB.prepare(
      `SELECT id, username, display_name, is_admin, is_disabled, created_at
         FROM users ORDER BY username ASC`,
    ),
  );
  return rows.map((r) => ({ ...toSummary(r), isDisabled: r.is_disabled === 1 }));
}

// --- throttling -----------------------------------------------------------

export interface ThrottleState {
  readonly locked: boolean;
  readonly retryAfterMs: number;
}

interface ThrottleRow {
  readonly key: string;
  readonly window_start: number;
  readonly fail_count: number;
  readonly locked_until: number;
}

function usernameKey(username: string): string {
  return `u:${username}`;
}

/** Checks BOTH the username key and the hashed-IP key; the stricter one wins. */
export async function checkThrottle(
  env: Env,
  username: string,
  clientIp: string | null,
  now: EpochMs,
): Promise<ThrottleState> {
  const keys = [usernameKey(username), await throttleIpKey(env, clientIp)].filter(
    (k): k is string => k !== null,
  );
  const rows = await queryAll<ThrottleRow>(
    env.DB.prepare(
      `SELECT key, window_start, fail_count, locked_until
         FROM auth_throttle WHERE key IN (?1, ?2)`,
    ).bind(keys[0] ?? '', keys[1] ?? ''),
  );
  let retryAfterMs = 0;
  for (const row of rows) {
    const remaining = row.locked_until - now;
    if (remaining > retryAfterMs) retryAfterMs = remaining;
  }
  return { locked: retryAfterMs > 0, retryAfterMs };
}

/**
 * Increment both keys inside one batch, rolling the 15-minute window and
 * arming the lockout in the SAME statement — never read-then-write (CLAUDE
 * rule 5), so two concurrent failures cannot each read "9" and both stay unlocked.
 */
export async function recordFailure(
  env: Env,
  username: string,
  clientIp: string | null,
  now: EpochMs,
): Promise<void> {
  const keys = [usernameKey(username), await throttleIpKey(env, clientIp)].filter(
    (k): k is string => k !== null,
  );
  await runBatch(
    env.DB,
    keys.map((key) =>
      env.DB.prepare(
        `INSERT INTO auth_throttle (key, window_start, fail_count, locked_until)
           VALUES (?1, ?2, 1, 0)
           ON CONFLICT(key) DO UPDATE SET
             window_start = CASE WHEN auth_throttle.window_start <= ?2 - ?3
                                 THEN ?2 ELSE auth_throttle.window_start END,
             fail_count   = CASE WHEN auth_throttle.window_start <= ?2 - ?3
                                 THEN 1 ELSE auth_throttle.fail_count + 1 END,
             locked_until = CASE WHEN (CASE WHEN auth_throttle.window_start <= ?2 - ?3
                                            THEN 1 ELSE auth_throttle.fail_count + 1 END) >= ?4
                                 THEN ?2 + ?5 ELSE auth_throttle.locked_until END`,
      ).bind(key, now, AUTH_WINDOW_MS, AUTH_MAX_FAILURES, AUTH_LOCKOUT_MS),
    ),
  );
}

/**
 * A successful login clears the USERNAME key only (PLAN.md §10.5). The IP key
 * survives on purpose: one user guessing their own password correctly should
 * not reset a shared address's budget.
 */
export async function clearFailures(env: Env, username: string): Promise<void> {
  await runBatch(env.DB, [
    env.DB.prepare('DELETE FROM auth_throttle WHERE key = ?1').bind(usernameKey(username)),
  ]);
}

/** sha256(ip + IP_HASH_SALT) truncated to 16 chars. Raw IPs are never stored. */
export async function throttleIpKey(env: Env, clientIp: string | null): Promise<string | null> {
  if (clientIp === null || clientIp === '') return null;
  const salt = env.IP_HASH_SALT ?? '';
  if (salt === '') {
    // Without a salt the digest is a rainbow-tableable IP; refuse to write one
    // rather than silently storing a reversible value.
    console.warn('[auth] IP_HASH_SALT is unset; IP throttling is disabled');
    return null;
  }
  return `ip:${(await sha256Hex(`${clientIp}${salt}`)).slice(0, 16)}`;
}
