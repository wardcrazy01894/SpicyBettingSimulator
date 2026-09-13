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

  it.todo('every non-public /api route returns 401 UNAUTHENTICATED when anonymous');
  it.todo('/api/admin/* returns 404 (not 403) for a non-admin');
  it.todo('malformed JSON bodies return 400 MALFORMED_JSON');
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
