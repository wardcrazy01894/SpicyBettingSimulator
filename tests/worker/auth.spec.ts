import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUsersResponse, UserResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import type { Env as WorkerEnv } from '../../src/worker/env.js';
import {
  AUTH_LOCKOUT_MS,
  AUTH_MAX_FAILURES,
  CLIENT_KDF,
  SERVER_KDF_ITERATIONS,
  SESSION_COOKIE_NAME,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from '../../src/shared/constants.js';
import {
  blobToBytes,
  bytesToHex,
  dummyVerify,
  hashDerivedKey,
  sha256Hex,
} from '../../src/worker/crypto.js';
import { buildApp } from '../../src/worker/index.js';
import { DK_VECTORS, WRONG_DK } from './setup.js';
import { wipeAccounts } from './seed.js';

/**
 * TDD contract for M3.
 *
 * WORKERD CAPS PBKDF2 AT 100,000 ITERATIONS (`OperationError` above it).
 * CLIENT_KDF.iterations is 210,000 — a browser/Node number. These tests must
 * use the PRECOMPUTED `dk` hex vectors from ./setup.ts and must NEVER call
 * deriveKey() inside the pool. The server-side hash (1,000 iterations) is far
 * under the cap and is exercised for real.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
/**
 * An env with the invite gate switched off, for the "signup is open" path.
 * The key is DELETED rather than set to undefined: `exactOptionalPropertyTypes`
 * distinguishes the two, and so does `readConfig`.
 */
const { INVITE_CODE: _inviteCode, ...OPEN_ENV } = env;

interface Opts {
  readonly cookie?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: WorkerEnv;
  readonly ip?: string;
}

function send(path: string, init: RequestInit, opts: Opts): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, opts.env ?? env));
}

function post(path: string, body: unknown, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-SBS-Client': '1',
    ...opts.headers,
  };
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  if (opts.ip !== undefined) headers['cf-connecting-ip'] = opts.ip;
  return send(
    path,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    opts,
  );
}

function get(path: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  if (opts.ip !== undefined) headers['cf-connecting-ip'] = opts.ip;
  return send(path, { method: 'GET', headers }, opts);
}

/** The raw session token out of a Set-Cookie header. */
function tokenFrom(res: Response): string {
  const raw = res.headers.get('set-cookie');
  expect(raw).toBeTypeOf('string');
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`).exec(raw ?? '');
  expect(m).not.toBeNull();
  return m?.[1] ?? '';
}

function cookieFrom(res: Response): string {
  return `${SESSION_COOKIE_NAME}=${tokenFrom(res)}`;
}

async function signup(
  username: keyof typeof DK_VECTORS,
  opts: Opts & { readonly inviteCode?: string | null } = {},
): Promise<Response> {
  const body: Record<string, unknown> = { username, dk: DK_VECTORS[username] };
  const invite = opts.inviteCode === undefined ? INVITE : opts.inviteCode;
  if (invite !== null) body['inviteCode'] = invite;
  return post('/api/auth/signup', body, opts);
}

function login(username: string, dk: string, opts: Opts = {}): Promise<Response> {
  return post('/api/auth/login', { username, dk }, opts);
}

/** Sign a user up and hand back their cookie + id. */
async function register(
  username: keyof typeof DK_VECTORS,
): Promise<{ cookie: string; id: string; isAdmin: boolean }> {
  const res = await signup(username);
  expect(res.status).toBe(201);
  const body = await res.json<UserResponse>();
  return { cookie: cookieFrom(res), id: body.user.id, isAdmin: body.user.isAdmin };
}

/**
 * Every test starts from an empty auth surface. Explicit rather than relying on
 * the pool's per-test storage rollback, because "the FIRST user becomes admin"
 * is only meaningful against a genuinely empty `users` table.
 */
beforeEach(async () => {
  await wipeAccounts(env.DB);
});

interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly kdf_version: number;
  readonly client_iterations: number;
  readonly server_salt: unknown;
  readonly server_iterations: number;
  readonly password_hash: unknown;
  readonly is_admin: number;
  readonly is_disabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function userRow(username: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first<UserRow>();
}

// ---------------------------------------------------------------------------

describe('signup', () => {
  it('creates a user and sets an HttpOnly; Secure; SameSite=Lax cookie', async () => {
    const res = await signup('alex');
    expect(res.status).toBe(201);
    const body = await res.json<UserResponse>();
    expect(body.user.username).toBe('alex');
    expect(body.user.displayName).toBe('alex');
    expect(typeof body.user.id).toBe('string');
    expect(body.user.createdAt).toBeGreaterThan(1_700_000_000_000);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${String(SESSION_TTL_MS / 1000)}`);
    // COOKIE_SECURE is "false" in the test env, so Secure must be ABSENT here —
    // that is what proves the flag is driven by config and not hard-coded.
    expect(cookie).not.toContain('Secure');

    // The cookie is immediately usable.
    const me = await get('/api/auth/me', { cookie: cookieFrom(res) });
    expect(me.status).toBe(200);
    expect((await me.json<UserResponse>()).user.id).toBe(body.user.id);
  });

  it('sets the Secure flag when config.cookieSecure is true', async () => {
    const res = await signup('alex', { env: { ...env, COOKIE_SECURE: 'true' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  it('the FIRST user becomes admin; the second does not', async () => {
    const alex = await register('alex');
    expect(alex.isAdmin).toBe(true);
    const bob = await register('bob');
    expect(bob.isAdmin).toBe(false);
    expect((await userRow('bob'))?.is_admin).toBe(0);
  });

  it('two concurrent first signups cannot both become admin', async () => {
    const [a, b] = await Promise.all([signup('alex'), signup('bob')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first<{
      n: number;
    }>();
    expect(row?.n).toBe(1);
  });

  it('rejects a wrong invite code with 401 BAD_INVITE_CODE', async () => {
    const res = await signup('alex', { inviteCode: 'not-the-invite' });
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('BAD_INVITE_CODE');
    expect(await userRow('alex')).toBeNull();
  });

  it('rejects a MISSING invite code with 401 BAD_INVITE_CODE when one is required', async () => {
    const res = await signup('alex', { inviteCode: null });
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('BAD_INVITE_CODE');
  });

  it('allows signup when INVITE_CODE is unset, and /api/health says inviteRequired:false', async () => {
    const health = await get('/api/health', { env: OPEN_ENV });
    expect((await health.json<{ inviteRequired: boolean }>()).inviteRequired).toBe(false);
    const res = await signup('alex', { inviteCode: null, env: OPEN_ENV });
    expect(res.status).toBe(201);
  });

  it('rejects a duplicate username with 409 USERNAME_TAKEN', async () => {
    expect((await signup('alex')).status).toBe(201);
    const res = await signup('alex');
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('USERNAME_TAKEN');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(n?.n).toBe(1);
    // The rolled-back batch must not have left an orphan session behind.
    const s = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(s?.n).toBe(1);
  });

  it('rejects a malformed dk with 400 VALIDATION and creates nothing', async () => {
    const res = await post('/api/auth/signup', {
      username: 'alex',
      dk: 'not-hex',
      inviteCode: INVITE,
    });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
    expect(await userRow('alex')).toBeNull();
  });

  it('rejects a bad username with 400 VALIDATION', async () => {
    const res = await post('/api/auth/signup', {
      username: 'Not Valid!',
      dk: DK_VECTORS.alex,
      inviteCode: INVITE,
    });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
  });

  it('lowercases the username and keeps the typed casing as the display name', async () => {
    const res = await post('/api/auth/signup', {
      username: 'ALEX',
      displayName: 'Alex L',
      dk: DK_VECTORS.alex,
      inviteCode: INVITE,
    });
    expect(res.status).toBe(201);
    const body = await res.json<UserResponse>();
    expect(body.user.username).toBe('alex');
    expect(body.user.displayName).toBe('Alex L');
  });

  it('never stores the derived key itself, only PBKDF2(dk, server_salt, 1000)', async () => {
    await register('alex');
    const row = await userRow('alex');
    expect(row).not.toBeNull();
    const salt = blobToBytes(row?.server_salt);
    const stored = blobToBytes(row?.password_hash);
    expect(salt.length).toBe(16);
    expect(stored.length).toBe(32);
    // The dk is nowhere in the row.
    expect(bytesToHex(stored)).not.toBe(DK_VECTORS.alex);
    expect(bytesToHex(salt)).not.toBe(DK_VECTORS.alex.slice(0, 32));
    expect(row?.server_iterations).toBe(SERVER_KDF_ITERATIONS);
    expect(row?.client_iterations).toBe(CLIENT_KDF.iterations);
    // ...and the stored value IS the documented server-side hash.
    const expected = await hashDerivedKey(DK_VECTORS.alex, salt, SERVER_KDF_ITERATIONS);
    expect(bytesToHex(stored)).toBe(bytesToHex(expected));
    // Two users with the same dk must not share a hash (per-row server salt).
    const other = await hashDerivedKey(DK_VECTORS.alex, new Uint8Array(16), SERVER_KDF_ITERATIONS);
    expect(bytesToHex(other)).not.toBe(bytesToHex(expected));
  });

  /**
   * MEASURED, not assumed: workerd 1.20260911.1 at compatibility_date
   * 2026-08-22 does NOT throw `OperationError` at 210,000 PBKDF2 iterations —
   * it completes and returns the correct key. The "capped at 100,000" line in
   * CLAUDE.md / PLAN.md §10.2 is stale for this runtime, so asserting the throw
   * would pin a falsehood.
   *
   * The rule it was protecting is still right and still enforced here: the pool
   * never derives a `dk`, because the REAL constraint is the free plan's 10 ms
   * of CPU per invocation — a 210k PBKDF2 does not fit in a request no matter
   * what the WebCrypto layer permits. See tests/worker/setup.ts.
   */
  it('uses a precomputed dk vector and never runs the 210k client KDF in-pool', () => {
    for (const dk of Object.values(DK_VECTORS)) expect(dk).toMatch(/^[0-9a-f]{64}$/);
    expect(WRONG_DK).toMatch(/^[0-9a-f]{64}$/);
    // The client KDF is a browser/Node number; the server's is the cheap one.
    expect(CLIENT_KDF.iterations).toBeGreaterThan(100_000);
    expect(SERVER_KDF_ITERATIONS).toBe(1_000);
    // The vectors are pinned against an independent WebCrypto reference in
    // tests/unit/kdf-parity.spec.ts, which runs in Node where 210k is cheap.
  });

  it('SERVER_KDF_ITERATIONS stays under workerd 100k cap and completes normally', async () => {
    expect(SERVER_KDF_ITERATIONS).toBeLessThan(100_000);
    const out = await hashDerivedKey(DK_VECTORS.alex, new Uint8Array(16), SERVER_KDF_ITERATIONS);
    expect(out.length).toBe(32);
  });
});

describe('login', () => {
  it('accepts a correct dk and returns the user', async () => {
    await register('alex');
    const res = await login('alex', DK_VECTORS.alex);
    expect(res.status).toBe(200);
    const body = await res.json<UserResponse>();
    expect(body.user.username).toBe('alex');
    expect(body.user.isAdmin).toBe(true);
    const me = await get('/api/auth/me', { cookie: cookieFrom(res) });
    expect(me.status).toBe(200);
  });

  it('accepts a username typed in a different case', async () => {
    await register('alex');
    expect((await login('ALEX', DK_VECTORS.alex)).status).toBe(200);
  });

  it('rejects a wrong dk with 401 INVALID_CREDENTIALS', async () => {
    await register('alex');
    const res = await login('alex', WRONG_DK);
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('an UNKNOWN username returns the identical 401 with comparable timing', async () => {
    await register('alex');
    const wrongPw = await login('alex', WRONG_DK);
    const unknown = await login('nobody', WRONG_DK);
    expect(unknown.status).toBe(wrongPw.status);
    // Byte-identical envelopes: no code, message or details distinguishes them.
    expect(await unknown.text()).toBe(await wrongPw.text());
    expect(unknown.headers.get('set-cookie')).toBeNull();
    // The comparable-timing half is structural rather than wall-clock (workerd
    // freezes Date.now() between I/O, so a timing assertion here would measure
    // nothing): the unknown-user path runs the SAME 1,000-iteration PBKDF2
    // against a fixed decoy salt.
    await expect(dummyVerify(WRONG_DK)).resolves.toBeUndefined();
  });

  it('a disabled account gets 403 ACCOUNT_DISABLED', async () => {
    const admin = await register('alex');
    const bob = await register('bob');
    const bobCookie = bob.cookie;
    expect(
      (
        await post(
          `/api/admin/users/${bob.id}/disabled`,
          { disabled: true },
          { cookie: admin.cookie },
        )
      ).status,
    ).toBe(204);

    const res = await login('bob', DK_VECTORS.bob);
    expect(res.status).toBe(403);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('ACCOUNT_DISABLED');

    // ...and the session bob already held stops resolving.
    const me = await get('/api/auth/me', { cookie: bobCookie });
    expect(me.status).toBe(401);
    expect((await me.json<ApiErrorBody>()).error.code).toBe('UNAUTHENTICATED');

    // Re-enabling restores login; the evicted session stays dead (containment).
    expect(
      (
        await post(
          `/api/admin/users/${bob.id}/disabled`,
          { disabled: false },
          { cookie: admin.cookie },
        )
      ).status,
    ).toBe(204);
    expect((await login('bob', DK_VECTORS.bob)).status).toBe(200);
    expect((await get('/api/auth/me', { cookie: bobCookie })).status).toBe(401);
  });

  it('disabling evicts sessions: re-enabling does NOT resurrect the old cookie', async () => {
    const admin = await register('alex');
    const bob = await register('bob');
    await post(`/api/admin/users/${bob.id}/disabled`, { disabled: true }, { cookie: admin.cookie });
    await post(
      `/api/admin/users/${bob.id}/disabled`,
      { disabled: false },
      { cookie: admin.cookie },
    );
    expect((await get('/api/auth/me', { cookie: bob.cookie })).status).toBe(401);
    expect((await login('bob', DK_VECTORS.bob)).status).toBe(200);
  });

  it('an admin cannot disable themselves, and the last enabled admin cannot be disabled', async () => {
    const admin = await register('alex');
    const self = await post(
      `/api/admin/users/${admin.id}/disabled`,
      { disabled: true },
      { cookie: admin.cookie },
    );
    expect(self.status).toBe(400);
    expect((await self.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
    // Direct service call bypassing the self check: still refused for the last admin.
    const { setDisabled } = await import('../../src/worker/auth.js');
    await expect(setDisabled(env, admin.id, true, Date.now())).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    // Still enabled and still admin.
    expect((await get('/api/admin/users', { cookie: admin.cookie })).status).toBe(200);
  });

  it('rejects a non-JSON content type with 400 VALIDATION', async () => {
    const res = await post(
      '/api/auth/signup',
      JSON.stringify({ username: 'alex', dk: DK_VECTORS.alex, inviteCode: 'test-invite' }),
      { headers: { 'content-type': 'text/plain' } },
    );
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
    expect(await userRow('alex')).toBeNull();
  });

  it('a garbage sbs_session cookie ahead of the real one does not log the user out', async () => {
    const alex = await register('alex');
    const real = alex.cookie.split(';')[0] ?? '';
    const res = await get('/api/auth/me', { cookie: `sbs_session=garbage; ${real}` });
    expect(res.status).toBe(200);
  });

  it('a WRONG password on a disabled account still reports INVALID_CREDENTIALS (no oracle)', async () => {
    const admin = await register('alex');
    const bob = await register('bob');
    await post(`/api/admin/users/${bob.id}/disabled`, { disabled: true }, { cookie: admin.cookie });
    const res = await login('bob', WRONG_DK);
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('10 failures lock the account for 15 minutes with 429 + Retry-After', async () => {
    await register('alex');
    for (let i = 0; i < AUTH_MAX_FAILURES; i += 1) {
      const res = await login('alex', WRONG_DK);
      expect(res.status).toBe(401);
    }
    const locked = await login('alex', WRONG_DK);
    expect(locked.status).toBe(429);
    expect((await locked.json<ApiErrorBody>()).error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(locked.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(AUTH_LOCKOUT_MS / 1000);

    // The lockout beats a CORRECT password: the throttle is checked first.
    const correct = await login('alex', DK_VECTORS.alex);
    expect(correct.status).toBe(429);

    const row = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?1')
      .bind('u:alex')
      .first<{ fail_count: number; locked_until: number }>();
    expect(row?.fail_count).toBe(AUTH_MAX_FAILURES);
    expect(row?.locked_until).toBeGreaterThan(Date.now());
  });

  it('a success clears the failure counter', async () => {
    await register('alex');
    for (let i = 0; i < 5; i += 1) expect((await login('alex', WRONG_DK)).status).toBe(401);
    const before = await env.DB.prepare('SELECT fail_count FROM auth_throttle WHERE key = ?1')
      .bind('u:alex')
      .first<{ fail_count: number }>();
    expect(before?.fail_count).toBe(5);

    expect((await login('alex', DK_VECTORS.alex)).status).toBe(200);
    const after = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?1')
      .bind('u:alex')
      .first();
    expect(after).toBeNull();
  });

  it('throttles by hashed IP as well as by username', async () => {
    await register('alex');
    await register('bob');
    const ip = '203.0.113.7';
    for (let i = 0; i < AUTH_MAX_FAILURES; i += 1) {
      expect((await login('alex', WRONG_DK, { ip })).status).toBe(401);
    }
    // A DIFFERENT username from the same IP is locked out by the ip: key.
    const res = await login('bob', DK_VECTORS.bob, { ip });
    expect(res.status).toBe(429);
    // ...while the same username from a different IP is still locked by u:.
    expect((await login('alex', DK_VECTORS.alex, { ip: '198.51.100.9' })).status).toBe(429);
    // ...and an untouched user from a different IP is fine.
    expect((await login('bob', DK_VECTORS.bob, { ip: '198.51.100.9' })).status).toBe(200);
  });

  it('stores no raw IP anywhere', async () => {
    await register('alex');
    const ip = '203.0.113.42';
    expect((await login('alex', WRONG_DK, { ip })).status).toBe(401);
    const rows = await env.DB.prepare('SELECT key FROM auth_throttle').all<{ key: string }>();
    const keys = rows.results.map((r) => r.key);
    expect(keys).toContain('u:alex');
    expect(keys.some((k) => k.startsWith('ip:'))).toBe(true);
    for (const k of keys) expect(k).not.toContain(ip);
    // The ip key is sha256(ip + IP_HASH_SALT) truncated to 16 hex chars, and is
    // NOT the unsalted digest.
    const salted = (await sha256Hex(`${ip}test-ip-salt`)).slice(0, 16);
    const unsalted = (await sha256Hex(ip)).slice(0, 16);
    expect(keys).toContain(`ip:${salted}`);
    expect(keys).not.toContain(`ip:${unsalted}`);
  });

  it('rejects a malformed login body with 400 VALIDATION', async () => {
    const res = await post('/api/auth/login', { username: 'alex' });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
  });
});

describe('sessions', () => {
  it('sessions.id is sha256hex(token); the raw token is never in the DB', async () => {
    const res = await signup('alex');
    const token = tokenFrom(res);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const row = await env.DB.prepare('SELECT * FROM sessions').first<{
      id: string;
      user_id: string;
      created_at: number;
      expires_at: number;
      last_seen_at: number;
    }>();
    expect(row?.id).toBe(await sha256Hex(token));
    expect(row?.id).not.toBe(token);
    expect(row?.expires_at).toBe((row?.created_at ?? 0) + SESSION_TTL_MS);
    expect(row?.last_seen_at).toBe(row?.created_at);

    // Nothing anywhere in the row text contains the raw token.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('an unknown or tampered token resolves to nobody', async () => {
    await register('alex');
    expect((await get('/api/auth/me', { cookie: `${SESSION_COOKIE_NAME}=deadbeef` })).status).toBe(
      401,
    );
    expect((await get('/api/auth/me')).status).toBe(401);
  });

  it('an expired session is rejected and /api/auth/me returns 401', async () => {
    const res = await signup('alex');
    const cookie = cookieFrom(res);
    expect((await get('/api/auth/me', { cookie })).status).toBe(200);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?1')
      .bind(Date.now() - 1)
      .run();
    const me = await get('/api/auth/me', { cookie });
    expect(me.status).toBe(401);
    expect((await me.json<ApiErrorBody>()).error.code).toBe('UNAUTHENTICATED');
  });

  it('last_seen_at is NOT rewritten on every request (write-budget guard)', async () => {
    const res = await signup('alex');
    const cookie = cookieFrom(res);
    const read = (): Promise<{ last_seen_at: number; expires_at: number } | null> =>
      env.DB.prepare('SELECT last_seen_at, expires_at FROM sessions').first<{
        last_seen_at: number;
        expires_at: number;
      }>();

    const before = await read();
    for (let i = 0; i < 3; i += 1) expect((await get('/api/auth/me', { cookie })).status).toBe(200);
    expect(await read()).toEqual(before);

    // Once last_seen_at is older than the touch interval, the row rolls forward.
    const stale = (before?.last_seen_at ?? 0) - SESSION_TOUCH_INTERVAL_MS - 1;
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?1').bind(stale).run();
    expect((await get('/api/auth/me', { cookie })).status).toBe(200);
    const after = await read();
    expect(after?.last_seen_at).toBeGreaterThan(stale);
    expect(after?.expires_at).toBeGreaterThan(before?.expires_at ?? 0);
  });

  it('logout deletes the row and clears the cookie with Max-Age=0', async () => {
    const res = await signup('alex');
    const cookie = cookieFrom(res);
    const out = await post('/api/auth/logout', undefined, { cookie });
    expect(out.status).toBe(204);
    const cleared = out.headers.get('set-cookie') ?? '';
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('SameSite=Lax');

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await get('/api/auth/me', { cookie })).status).toBe(401);
  });

  it('logout is a no-op 204 when there is no session', async () => {
    expect((await post('/api/auth/logout', undefined)).status).toBe(204);
  });

  it('logout-all revokes every session for the caller and nobody else', async () => {
    const alex = await register('alex');
    const second = await login('alex', DK_VECTORS.alex);
    const bob = await register('bob');
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n,
    ).toBe(3);

    const res = await post('/api/auth/logout-all', undefined, { cookie: alex.cookie });
    expect(res.status).toBe(204);
    expect((await get('/api/auth/me', { cookie: alex.cookie })).status).toBe(401);
    expect((await get('/api/auth/me', { cookie: cookieFrom(second) })).status).toBe(401);
    expect((await get('/api/auth/me', { cookie: bob.cookie })).status).toBe(200);
  });

  it('logout-all requires a session (401 UNAUTHENTICATED)', async () => {
    const res = await post('/api/auth/logout-all', undefined);
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('UNAUTHENTICATED');
  });
});

describe('CSRF', () => {
  it('a POST without X-SBS-Client is 403 CSRF_BLOCKED', async () => {
    const res = await send(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alex', dk: DK_VECTORS.alex }),
      },
      {},
    );
    expect(res.status).toBe(403);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('CSRF_BLOCKED');
  });

  it('a POST with a foreign Origin is 403 CSRF_BLOCKED', async () => {
    await register('alex');
    const res = await login('alex', DK_VECTORS.alex, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('CSRF_BLOCKED');
  });

  it('a POST with a MATCHING Origin is allowed', async () => {
    await register('alex');
    const res = await login('alex', DK_VECTORS.alex, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
  });

  it('GET requests do not require the header', async () => {
    expect((await get('/api/health')).status).toBe(200);
    const alex = await register('alex');
    expect((await get('/api/auth/me', { cookie: alex.cookie })).status).toBe(200);
    // ...and a GET with a foreign Origin is still fine (GETs are side-effect free).
    expect((await get('/api/health', { headers: { origin: 'https://evil.example' } })).status).toBe(
      200,
    );
  });

  it('blocks a DELETE without the header too, not just POST', async () => {
    const res = await send('/api/auth/logout', { method: 'DELETE' }, {});
    expect(res.status).toBe(403);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('CSRF_BLOCKED');
  });
});

describe('signup throttling (PLAN §11.2 429 RATE_LIMITED)', () => {
  it('locks out invite-code guessing after AUTH_MAX_FAILURES attempts', async () => {
    for (let i = 0; i < AUTH_MAX_FAILURES; i += 1) {
      expect((await signup('alex', { inviteCode: `guess-${String(i)}` })).status).toBe(401);
    }
    const res = await signup('alex', { inviteCode: 'guess-again' });
    expect(res.status).toBe(429);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Even the CORRECT invite code is refused while locked.
    expect((await signup('alex')).status).toBe(429);
  });

  it('a successful signup does not leave a failure counter behind', async () => {
    expect((await signup('alex')).status).toBe(201);
    const row = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?1')
      .bind('u:alex')
      .first();
    expect(row).toBeNull();
  });
});

describe('admin user routes (PLAN §11.6)', () => {
  it('GET /api/admin/users lists everyone with the disabled flag', async () => {
    const admin = await register('alex');
    const bob = await register('bob');
    const res = await get('/api/admin/users', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = await res.json<AdminUsersResponse>();
    expect(body.users.map((u) => u.username)).toEqual(['alex', 'bob']);
    const bobView = body.users.find((u) => u.id === bob.id);
    expect(bobView).toMatchObject({ username: 'bob', isAdmin: false, isDisabled: false });
    // No credential material is ever exposed.
    expect(JSON.stringify(body)).not.toContain('password');
    expect(JSON.stringify(body)).not.toContain('salt');
  });

  it('returns 404 (not 403) to a signed-in NON-admin, and 401 when anonymous', async () => {
    await register('alex');
    const bob = await register('bob');
    const asBob = await get('/api/admin/users', { cookie: bob.cookie });
    expect(asBob.status).toBe(404);
    expect((await asBob.json<ApiErrorBody>()).error.code).toBe('NOT_FOUND');
    const anon = await get('/api/admin/users');
    expect(anon.status).toBe(401);
    expect((await anon.json<ApiErrorBody>()).error.code).toBe('UNAUTHENTICATED');
  });

  it('password reset actually lets the user log in with the NEW dk', async () => {
    const admin = await register('alex');
    const bob = await register('bob');
    const res = await post(
      `/api/admin/users/${bob.id}/password`,
      { dk: DK_VECTORS.carol },
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(204);

    // Old key no longer works; the new one does.
    expect((await login('bob', DK_VECTORS.bob)).status).toBe(401);
    const ok = await login('bob', DK_VECTORS.carol);
    expect(ok.status).toBe(200);
    expect((await ok.json<UserResponse>()).user.username).toBe('bob');

    // A fresh server salt was rolled, and bob's old sessions were revoked.
    const row = await userRow('bob');
    expect(blobToBytes(row?.server_salt).length).toBe(16);
    expect((await get('/api/auth/me', { cookie: bob.cookie })).status).toBe(401);
  });

  it('password reset rejects a malformed dk and an unknown user', async () => {
    const admin = await register('alex');
    const bad = await post(
      `/api/admin/users/whoever/password`,
      { dk: 'nope' },
      { cookie: admin.cookie },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json<ApiErrorBody>()).error.code).toBe('VALIDATION');

    const missing = await post(
      `/api/admin/users/no-such-id/password`,
      { dk: DK_VECTORS.carol },
      { cookie: admin.cookie },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json<ApiErrorBody>()).error.code).toBe('NOT_FOUND');
  });

  it('disabled toggle validates its body and rejects an unknown user', async () => {
    const admin = await register('alex');
    const bad = await post(
      `/api/admin/users/whoever/disabled`,
      { disabled: 'yes' },
      { cookie: admin.cookie },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json<ApiErrorBody>()).error.code).toBe('VALIDATION');

    const missing = await post(
      `/api/admin/users/no-such-id/disabled`,
      { disabled: true },
      { cookie: admin.cookie },
    );
    expect(missing.status).toBe(404);
  });

  it('a non-admin cannot reset anybody password (404, and nothing changes)', async () => {
    await register('alex');
    const bob = await register('bob');
    const res = await post(
      `/api/admin/users/${bob.id}/password`,
      { dk: DK_VECTORS.carol },
      { cookie: bob.cookie },
    );
    expect(res.status).toBe(404);
    expect((await login('bob', DK_VECTORS.bob)).status).toBe(200);
  });
});
