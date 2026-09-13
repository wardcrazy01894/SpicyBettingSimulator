import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { HealthResponse, ConfigResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { CLIENT_KDF, MAX_PAYOUT_CENTS, MIN_STAKE_CENTS } from '../../src/shared/constants.js';
import { buildApp } from '../../src/worker/index.js';

/** Hit the real app (same code path as the module-level fetch handler). */
function get(path: string): Promise<Response> {
  return Promise.resolve(buildApp().request(`https://example.com${path}`, undefined, env));
}

/** The invite code bound in vitest.workers.config.ts. */
const INVITE = 'test-invite';

/** TDD contract for M1/M3/M5 routing and the asset/API boundary. */

describe('routing', () => {
  it('GET /api/health returns ok with version, now and inviteRequired', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json<HealthResponse>();
    expect(body.ok).toBe(true);
    expect(body.version).toBe('test');
    expect(typeof body.now).toBe('number');
    expect(body.now).toBeGreaterThan(1_700_000_000_000);
    // INVITE_CODE is set in vitest.workers.config.ts
    expect(body.inviteRequired).toBe(true);
  });

  it('GET /api/config echoes the shared constants', async () => {
    const res = await get('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json<ConfigResponse>();
    expect(body.leagues).toEqual(['nfl', 'ncaaf']);
    expect(body.minStakeCents).toBe(MIN_STAKE_CENTS);
    expect(body.maxPayoutCents).toBe(MAX_PAYOUT_CENTS);
    expect(body.maxParlayLegs).toBe(10);
    expect(body.initialBankrollCents).toBe(100_000);
    expect(body.cutoffBufferMs).toBe(60_000);
    // No games ingested yet -> no current season for either league.
    expect(body.currentSeason).toEqual({ nfl: null, ncaaf: null });
  });

  it('GET /api/auth/kdf returns the public client KDF parameters', async () => {
    const res = await get('/api/auth/kdf');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({
      version: 1,
      algorithm: CLIENT_KDF.algorithm,
      hash: CLIENT_KDF.hash,
      iterations: CLIENT_KDF.iterations,
      keyLengthBytes: CLIENT_KDF.keyLengthBytes,
      saltPrefix: CLIENT_KDF.saltPrefix,
    });
  });

  it('GET /api/definitely-not-a-route returns our JSON 404 envelope, NOT index.html', async () => {
    const res = await get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeTypeOf('string');
  });

  it('an unhandled throw becomes 500 INTERNAL with no stack in the body', async () => {
    const app = buildApp();
    app.get('/api/__boom', () => {
      throw new Error('kaboom: secret internal detail');
    });
    const res = await app.request('https://example.com/api/__boom', undefined, env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('kaboom');
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toMatch(/at .*\.ts:\d+/);
    const body = JSON.parse(text) as ApiErrorBody;
    expect(body.error.code).toBe('INTERNAL');
  });

  it('a thrown AppError is rendered with its canonical status and code', async () => {
    const { AppError } = await import('../../src/shared/errors.js');
    const app = buildApp();
    app.get('/api/__conflict', () => {
      throw new AppError('BET_LOCKED', 'too late', { betId: 'b1' });
    });
    const res = await app.request('https://example.com/api/__conflict', undefined, env);
    expect(res.status).toBe(409);
    const body = await res.json<ApiErrorBody>();
    expect(body.error).toEqual({
      code: 'BET_LOCKED',
      message: 'too late',
      details: { betId: 'b1' },
    });
  });

  it('every non-public /api route returns 401 UNAUTHENTICATED when anonymous', async () => {
    // §11.1 is the whole public surface; everything else is behind a session.
    const publicPaths = ['/api/health', '/api/config', '/api/auth/kdf'];
    for (const path of publicPaths) {
      expect((await get(path)).status, path).toBe(200);
    }
    // The non-public GETs that exist as of M3. M5 adds /api/games etc.
    const privatePaths = ['/api/auth/me', '/api/admin/users'];
    for (const path of privatePaths) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect((await res.json<ApiErrorBody>()).error.code, path).toBe('UNAUTHENTICATED');
    }
    // ...and the non-public POSTs, which must clear CSRF before the auth check.
    const res = await buildApp().request(
      'https://example.com/api/auth/logout-all',
      { method: 'POST', headers: { 'X-SBS-Client': '1' } },
      env,
    );
    expect(res.status).toBe(401);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('UNAUTHENTICATED');
  });

  it('/api/admin/* returns 404 (not 403) for a non-admin', async () => {
    // A fresh (non-first) user is never an admin.
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, client_iterations, server_salt,
                          server_iterations, password_hash, is_admin, created_at, updated_at)
       VALUES ('u-seed', 'seeduser', 'Seed', 210000, X'00', 1000, X'00', 1, ?1, ?1)`,
    )
      .bind(Date.now())
      .run();
    const app = buildApp();
    const signup = await app.request(
      'https://example.com/api/auth/signup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
        body: JSON.stringify({ username: 'plainuser', dk: 'a'.repeat(64), inviteCode: INVITE }),
      },
      env,
    );
    expect(signup.status).toBe(201);
    const cookie = /sbs_session=([^;]*)/.exec(signup.headers.get('set-cookie') ?? '')?.[0] ?? '';

    for (const path of ['/api/admin/users', '/api/admin/definitely-not-a-route']) {
      const res = await buildApp().request(
        `https://example.com${path}`,
        { headers: { cookie } },
        env,
      );
      expect(res.status, path).toBe(404);
      expect((await res.json<ApiErrorBody>()).error.code, path).toBe('NOT_FOUND');
    }
  });

  it('malformed JSON bodies return 400 MALFORMED_JSON', async () => {
    // A body that is absent or unparseable. (`null` and `[]` parse fine and are
    // a VALIDATION failure instead, which is a different contract.)
    for (const body of ['{ not json', '', '{"username":']) {
      const res = await buildApp().request(
        'https://example.com/api/auth/login',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
          body,
        },
        env,
      );
      expect(res.status, body).toBe(400);
      expect((await res.json<ApiErrorBody>()).error.code, body).toBe('MALFORMED_JSON');
    }
  });
});

describe('games board', () => {
  it.todo('bettable is false once now >= lockAt, even if the game is still scheduled');
  it.todo('bettable is false when the line is stale');
  it.todo('lines: null renders as "not posted", not as an error');
  it.todo('respects the BOARD_MAX_GAMES cap');
});

describe('leaderboard semantics', () => {
  it.todo('balanceCents excludes pending stakes');
  it.todo('equityCents === balanceCents + pendingStakeCents');
  it.todo('record counts settled bets only and excludes cancelled bets');
  it.todo('roi excludes push and void from BOTH numerator and denominator');
  it.todo('roi is null when there is no settled action');
  it.todo('ranks by balance desc, then roi desc, then username');
  it.todo('all-time pools the numerator and denominator rather than averaging ROIs');
});
