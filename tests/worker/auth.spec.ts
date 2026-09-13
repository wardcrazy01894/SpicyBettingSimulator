import { describe, it } from 'vitest';

/**
 * TDD contract for M3.
 *
 * WORKERD CAPS PBKDF2 AT 100,000 ITERATIONS (`OperationError` above it).
 * CLIENT_KDF.iterations is 210,000 — a browser/Node number. These tests must
 * use the PRECOMPUTED `dk` hex vectors from ./setup.ts and must NEVER call
 * deriveKey() inside the pool. The server-side hash (1,000 iterations) is far
 * under the cap and is exercised for real.
 */

describe('signup', () => {
  it.todo('creates a user and sets an HttpOnly; Secure; SameSite=Lax cookie');
  it.todo('the FIRST user becomes admin; the second does not');
  it.todo('two concurrent first signups cannot both become admin');
  it.todo('rejects a wrong invite code with 401 BAD_INVITE_CODE');
  it.todo('allows signup when INVITE_CODE is unset, and /api/health says inviteRequired:false');
  it.todo('rejects a duplicate username with 409 USERNAME_TAKEN');
  it.todo('never stores the derived key itself, only PBKDF2(dk, server_salt, 1000)');
  it.todo(
    'uses a precomputed dk vector — deriving 210k iterations in-pool throws ' +
      'OperationError (workerd caps PBKDF2 at 100k)',
  );
  it.todo('SERVER_KDF_ITERATIONS stays under workerd 100k cap and completes normally');
});

describe('login', () => {
  it.todo('accepts a correct dk and returns the user');
  it.todo('rejects a wrong dk with 401 INVALID_CREDENTIALS');
  it.todo('an UNKNOWN username returns the identical 401 with comparable timing');
  it.todo('a disabled account gets 403 ACCOUNT_DISABLED');
  it.todo('10 failures lock the account for 15 minutes with 429 + Retry-After');
  it.todo('a success clears the failure counter');
  it.todo('throttles by hashed IP as well as by username');
  it.todo('stores no raw IP anywhere');
});

describe('sessions', () => {
  it.todo('sessions.id is sha256hex(token); the raw token is never in the DB');
  it.todo('an expired session is rejected and /api/auth/me returns 401');
  it.todo('last_seen_at is NOT rewritten on every request (write-budget guard)');
  it.todo('logout deletes the row and clears the cookie with Max-Age=0');
});

describe('CSRF', () => {
  it.todo('a POST without X-SBS-Client is 403 CSRF_BLOCKED');
  it.todo('a POST with a foreign Origin is 403 CSRF_BLOCKED');
  it.todo('GET requests do not require the header');
});
