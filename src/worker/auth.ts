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
import type { AdminUserView } from '../shared/api-types.js';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { LoginInput, SignupInput } from '../shared/validate.js';
import { RESERVED_USERNAME_PREFIX } from '../shared/validate.js';
import type { Env } from './env.js';
import { mainBalanceStatements } from './bankroll.js';
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
  /** Migration 0002. NULL for a live account. */
  readonly deleted_at: number | null;
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
 * Create a user + their `main` account balance + a session.
 *
 * The whole thing is ONE batch so that "first user becomes admin" cannot be won
 * by two simultaneous signups: `is_admin` is computed inside the INSERT as
 * `CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END`, and the
 * UNIQUE(username) constraint decides the winner.
 *
 * THE BALANCE IS CREATED HERE (M5b), not lazily on first read. That is the whole
 * point of the change: an account has exactly one opening deposit, for its
 * entire life, and it lands in the same atomic batch as the account itself — so
 * "a user exists but has no money" is not a reachable state, and no GET has to
 * write rows to make one. If the username collides, the UNIQUE index aborts
 * statement 1 and D1 rolls the balance and the session back with it.
 *
 * @throws AppError BAD_INVITE_CODE | USERNAME_TAKEN | RATE_LIMITED
 */
export async function signup(env: Env, input: SignupInput, now: EpochMs): Promise<AuthOk> {
  assertInviteCode(env, input.inviteCode);

  const serverSalt = newServerSalt();
  const passwordHash = await hashDerivedKey(input.dk, serverSalt, SERVER_KDF_ITERATIONS);
  const userId = newId();
  const { token, session } = await newSessionMaterial(userId, now);

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
      ...mainBalanceStatements(env, userId, newId(), now),
      insertSessionStatement(env, session),
      env.DB.prepare(
        `SELECT id, username, display_name, is_admin, is_disabled, created_at, deleted_at
           FROM users WHERE id = ?1`,
      ).bind(userId),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, 'users.username')) {
      throw new AppError('USERNAME_TAKEN', 'That username is already taken.');
    }
    throw err;
  }

  // Index 4: user, balance, deposit, session, read-back.
  const row = (results[4]?.results as readonly UserRow[] | undefined)?.[0];
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
      // `deleted_at IS NULL` is part of the LOOKUP, not a post-check, on purpose:
      // a deleted account has to be indistinguishable from an account that never
      // existed, so it falls into the dummy-verify branch below and gets the
      // identical 401 INVALID_CREDENTIALS. Revealing ACCOUNT_DISABLED for it
      // would confirm both the (renamed) username AND its password (PLAN §10.5).
      `SELECT id, username, display_name, is_admin, is_disabled, created_at, deleted_at,
              server_salt, server_iterations, password_hash
         FROM users WHERE username = ?1 AND deleted_at IS NULL`,
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
/**
 * Self-service rename (PLAN.md §11.2). One statement: the liveness guard is
 * in the WHERE (rule 5) and RETURNING hands back the row, so a deleted or
 * disabled account — whose session `requireAuth` has already refused — cannot
 * be renamed by a racing request either. `null` therefore means "no such live
 * user", which is the same 401 the session check would have produced.
 */
export async function setDisplayName(
  env: Env,
  userId: string,
  displayName: string,
  now: EpochMs,
): Promise<UserSummary> {
  const row = await env.DB.prepare(
    `UPDATE users SET display_name = ?1, updated_at = ?2
      WHERE id = ?3 AND deleted_at IS NULL AND is_disabled = 0
      RETURNING id, username, display_name, is_admin, is_disabled, created_at, deleted_at`,
  )
    .bind(displayName, now, userId)
    .first<UserRow>();
  if (row === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return toSummary(row);
}

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
          WHERE id = ?1 AND deleted_at IS NULL`,
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
    // Unknown id and DELETED id are the same answer here: a deleted account has
    // no password worth setting, and `login` cannot see it anyway.
    throw new AppError('NOT_FOUND', 'No such user.');
  }
}

export async function setDisabled(
  env: Env,
  userId: string,
  disabled: boolean,
  now: EpochMs,
): Promise<void> {
  // Disabling is also a containment tool ("this account is compromised"), so
  // it EVICTS every live session in the same batch — re-enabling requires a
  // fresh login. `resolveSession` additionally joins on `is_disabled = 0` as a
  // belt-and-braces check.
  //
  // Last-admin guard: the row is not disabled if it is the only enabled admin,
  // because `is_admin` is only ever written by the first-signup CASE — there
  // is no promotion path, so locking out the last admin is unrecoverable
  // without `wrangler d1 execute`. Reported as a distinct error.
  //
  // `deleted_at IS NULL` keeps the toggle off deleted accounts entirely: a
  // re-enable there would be a half-resurrection (still unable to log in, still
  // off the board) whose only visible effect is a confusing chip. 404 instead.
  // It also keeps the last-admin subquery honest — a deleted admin is disabled
  // by construction, so it never counts toward the `> 1`.
  const results = await runBatch(env.DB, [
    env.DB.prepare(
      `UPDATE users SET is_disabled = ?2, updated_at = ?3
        WHERE id = ?1
          AND deleted_at IS NULL
          AND (?2 = 0
               OR is_admin = 0
               OR (SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_disabled = 0) > 1)`,
    ).bind(userId, disabled ? 1 : 0, now),
    // Conditional on the UPDATE above having applied: if the last-admin guard
    // refused it, is_disabled is still 0 and nothing is evicted.
    ...(disabled
      ? [
          env.DB.prepare(
            `DELETE FROM sessions WHERE user_id = ?1
               AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND is_disabled = 1)`,
          ).bind(userId),
        ]
      : []),
  ]);
  if (changesAt(results, 0) === 0) {
    const exists = await queryOne<{ n: number }>(
      env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?1 AND deleted_at IS NULL').bind(
        userId,
      ),
    );
    if ((exists?.n ?? 0) === 0) throw new AppError('NOT_FOUND', 'No such user.');
    throw new AppError('VALIDATION', 'Cannot disable the last enabled admin.', {
      field: 'disabled',
    });
  }
}

/**
 * SOFT-DELETE an account. PLAN.md §10.5 / §11.6.
 *
 * A HARD delete is impossible by design, and deliberately so: `bankrolls.user_id`
 * and `ledger.bankroll_id` are `ON DELETE RESTRICT` and `ledger_bd_block` refuses
 * `DELETE FROM ledger`, so there is no statement order that removes a user
 * without destroying the money history that `npm run db:reconcile` checks
 * (PLAN.md §4.1). What "delete" means here is therefore: disabled forever,
 * stamped, evicted, renamed out of the way, and invisible on the board.
 *
 * ONE BATCH (CLAUDE.md rule 5), and every guard is a WHERE clause inside the
 * write rather than a read-then-write:
 *   * `deleted_at IS NULL`  — makes the call idempotent instead of re-stamping
 *   * last-enabled-admin    — the SAME subquery `setDisabled` uses; deleting the
 *                             only admin is as unrecoverable as disabling them
 *   * no PENDING bets       — an open bet's stake is already out of the balance
 *                             and its payout is owed to an account nobody can
 *                             reach; settlement would credit a ghost. Refuse and
 *                             make the operator cancel or settle first.
 * The self-delete guard lives in the route, where `c.var.user` is (like the
 * self-disable guard next to it).
 *
 * The rename is what frees the username for re-registration:
 * `deleted_<first 12 hex of the uuid>` is 20 characters, inside the
 * `length(username) BETWEEN 3 AND 24` CHECK, lowercase like every stored
 * username, and derived from the id so it is stable. It is NOT collision-proof,
 * and the two ways it can collide are handled differently:
 *
 *   * SOMEBODY REGISTERED THE TOMBSTONE NAME. `deleted_<12 hex>` is a legal
 *     username under `validateUsername`'s charset rules, and every authenticated
 *     user can read every other user's uuid off `GET /api/leaderboard` — so
 *     without a rule this is a squat anybody can perform, on any account, and the
 *     admin's delete then fails forever on a `UNIQUE` violation with no way out
 *     but hand-editing the database. `validateUsername` now REJECTS the
 *     `deleted_` prefix outright (`RESERVED_USERNAME_PREFIX`), which is what
 *     actually closes it.
 *   * ANOTHER DELETED ACCOUNT SHARES THE FIRST 12 HEX DIGITS. Astronomically
 *     unlikely (2^48 per pair) but not attacker-controlled, and it is still a
 *     collision. The retry below widens the suffix to 16 hex digits — 24
 *     characters, exactly the CHECK's upper bound — which is a different value
 *     for the same id, so it cannot collide with the same row it just lost to.
 *
 * If even that collides, the answer is `409 USERNAME_TAKEN` naming the tombstone,
 * never a bare `500 INTERNAL`: an operator who is told which name is in the way
 * can rename that row and retry, whereas INTERNAL is a dead end.
 *
 * `display_name` becomes 'Deleted user' so nothing that renders a name has to
 * know about any of this.
 *
 * NO MONEY MOVES. Not one ledger row, not one `balance_cents` write: the bankroll
 * and its history stay exactly as they were, which is why `SUM(ledger) = balance`
 * still holds for the row afterwards and reconcile keeps passing.
 *
 * @returns 'deleted' on the delete, 'already-deleted' when it was a no-op
 * @throws AppError NOT_FOUND | VALIDATION | ACCOUNT_HAS_PENDING_BETS |
 *                  USERNAME_TAKEN
 */
export async function deleteUser(
  env: Env,
  userId: string,
  now: EpochMs,
): Promise<'deleted' | 'already-deleted'> {
  let results: readonly D1Result[];
  try {
    results = await runBatch(env.DB, deleteStatements(env, userId, now, 12));
  } catch (err) {
    if (!isUniqueViolation(err, 'users.username')) throw err;
    // The 12-hex tombstone is taken. Retry ONCE at the full 16 — a different
    // string for this id, so it cannot lose to the same row twice.
    try {
      results = await runBatch(env.DB, deleteStatements(env, userId, now, 16));
    } catch (retryErr) {
      if (!isUniqueViolation(retryErr, 'users.username')) throw retryErr;
      throw new AppError(
        'USERNAME_TAKEN',
        `Both tombstone names for this account (${RESERVED_USERNAME_PREFIX}<12 or 16 hex ` +
          `of its id>) are already in use. Rename the account holding them, then delete again.`,
        { userId },
      );
    }
  }
  if (changesAt(results, 0) > 0) return 'deleted';

  // Nothing changed: ONE read tells us which guard spoke. This is a diagnosis of
  // an already-completed write, not a check that gates one, so it is not the
  // read-then-write rule 5 forbids.
  const row = await queryOne<{ deleted_at: number | null; is_admin: number; pending: number }>(
    env.DB.prepare(
      `SELECT u.deleted_at AS deleted_at,
              u.is_admin   AS is_admin,
              (SELECT COUNT(*) FROM bets WHERE user_id = u.id AND status = 'pending') AS pending
         FROM users u WHERE u.id = ?1`,
    ).bind(userId),
  );
  if (row === null) throw new AppError('NOT_FOUND', 'No such user.');
  if (row.deleted_at !== null) return 'already-deleted';
  if (row.pending > 0) {
    throw new AppError(
      'ACCOUNT_HAS_PENDING_BETS',
      'That account still has open bets — cancel or settle them first, then delete it.',
      { pendingBets: row.pending },
    );
  }
  // The admin guard counts ENABLED admins, and the target need not be one of
  // them: deleting an already-disabled admin is refused too, because that row is
  // the only thing that could be re-enabled if the last enabled admin is lost.
  // "the last enabled admin" would therefore be a lie about who was refused.
  throw new AppError('VALIDATION', 'Cannot delete an admin while only one enabled admin remains.', {
    field: 'id',
  });
}

/**
 * The soft-delete batch, with the tombstone suffix width as a parameter so the
 * collision retry is the SAME two statements and not a second, divergent copy.
 *
 * `hexDigits` is 12 or 16, both interpolated from this module's own call sites —
 * never from a request — and both inside `length(username) BETWEEN 3 AND 24`
 * (`deleted_` is 8 characters).
 */
function deleteStatements(
  env: Env,
  userId: string,
  now: EpochMs,
  hexDigits: 12 | 16,
): readonly D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `UPDATE users
          SET is_disabled  = 1,
              deleted_at   = ?2,
              username     = '${RESERVED_USERNAME_PREFIX}' ||
                             substr(replace(id, '-', ''), 1, ${String(hexDigits)}),
              display_name = 'Deleted user',
              updated_at   = ?2
        WHERE id = ?1
          AND deleted_at IS NULL
          AND (is_admin = 0
               OR (SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_disabled = 0) > 1)
          AND NOT EXISTS (SELECT 1 FROM bets WHERE user_id = ?1 AND status = 'pending')`,
    ).bind(userId, now),
    // Conditional on the UPDATE above having applied, exactly like `setDisabled`:
    // if any guard refused it, `deleted_at` is still NULL and nobody is evicted.
    env.DB.prepare(
      `DELETE FROM sessions WHERE user_id = ?1
         AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND deleted_at IS NOT NULL)`,
    ).bind(userId),
  ];
}

/**
 * Everyone, for `GET /api/admin/users`. Never exposes credential material.
 *
 * DELETED ACCOUNTS ARE INCLUDED, with `isDeleted: true`. This is the one surface
 * that still shows them — they are off the leaderboard and cannot log in, but an
 * operator has to be able to see the row and understand why a username now reads
 * `deleted_<hex>`.
 */
export async function listUsers(env: Env): Promise<readonly AdminUserView[]> {
  const rows = await queryAll<UserRow>(
    env.DB.prepare(
      `SELECT id, username, display_name, is_admin, is_disabled, created_at, deleted_at
         FROM users ORDER BY username ASC`,
    ),
  );
  return rows.map((r) => ({
    ...toSummary(r),
    isDisabled: r.is_disabled === 1,
    deletedAt: r.deleted_at,
    isDeleted: r.deleted_at !== null,
  }));
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
