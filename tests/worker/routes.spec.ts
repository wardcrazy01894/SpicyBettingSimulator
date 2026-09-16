import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type {
  BankrollView,
  BankrollsResponse,
  ConfigResponse,
  GamesResponse,
  HealthResponse,
  LeaderboardResponse,
  UserResponse,
} from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import {
  BET_CUTOFF_BUFFER_MS,
  BOARD_MAX_GAMES,
  CLIENT_KDF,
  LINE_STALE_MS,
  MAX_PAYOUT_CENTS,
  MIN_STAKE_CENTS,
  TEASER_POINTS_TENTHS,
} from '../../src/shared/constants.js';
import { boardWindowEnd } from '../../src/shared/time.js';
import { buildApp } from '../../src/worker/index.js';
import { fullLine, seedGame, seedGameWithLine, seedLine, seedSettledBet } from './seed.js';

/** The caller's main balance out of `GET /api/bankroll`'s `{ balances }` list. */
async function mainBalance(res: Response): Promise<BankrollView> {
  const body = await res.json<BankrollsResponse>();
  const main = body.balances.find((b) => b.kind === 'main');
  if (main === undefined) throw new Error(`no main balance in ${JSON.stringify(body)}`);
  return main;
}

/** Hit the real app (same code path as the module-level fetch handler). */
function get(path: string, cookie?: string): Promise<Response> {
  const init = cookie === undefined ? undefined : { headers: { cookie } };
  return Promise.resolve(buildApp().request(`https://example.com${path}`, init, env));
}

/** The invite code bound in vitest.workers.config.ts. */
const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;

/**
 * Sign a NEW user up and hand back their cookie + id.
 *
 * vitest-pool-workers 0.22 gives each test FILE fresh storage but does NOT roll
 * back between tests, and `ledger` has a BEFORE DELETE trigger so no cleanup
 * hook could truncate it. Every test therefore gets its own user, its own game
 * ids (`gid()`) and — where a query is scoped by season — its own season.
 */
async function register(base = 'user'): Promise<{ cookie: string; id: string; name: string }> {
  userSeq += 1;
  const username = `${base}${String(userSeq)}`;
  const res = await buildApp().request(
    'https://example.com/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
      body: JSON.stringify({ username, dk: 'a'.repeat(64), inviteCode: INVITE }),
    },
    env,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const parsed = await res.json<UserResponse>();
  return {
    cookie: /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '',
    id: parsed.user.id,
    name: username,
  };
}

let userSeq = 0;
let scopeSeq = 0;
/** A namespace unique to the calling test: game ids and leaderboard seasons. */
function scope(): { gid: (n: string | number, league?: string) => string; season: number } {
  scopeSeq += 1;
  const n = scopeSeq;
  return {
    gid: (k, league = 'nfl') => `${league}:s${String(n)}-${String(k)}`,
    season: 3000 + n,
  };
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
    // M5b: the teaser card is echoed in full so the slip prices a teaser from
    // server truth rather than from its own bundled copy of constants.ts.
    expect(body.teaserPoints).toEqual([...TEASER_POINTS_TENTHS]);
    expect(body.teaserPayouts[30]?.[10]).toBe(12500);
    expect(body.teaserPayouts[140]?.[2]).toBe(-600);
    expect(body.teaserPayouts[60]?.[3]).toBe(150);
    expect(body.teaserPayouts[65]?.[2]).toBe(-130);
    expect(body.teaserPayouts[70]?.[10]).toBe(1500);
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

describe('games board window (PLAN.md §22)', () => {
  it('the default `to` is the Monday that closes the week: a game on that Monday is listed, the Tuesday after is not', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    const end = boardWindowEnd('nfl', now);
    await seedGameWithLine(env.DB, { id: gid('monday'), season, kickoffAt: end - HOUR });
    await seedGameWithLine(env.DB, { id: gid('tuesday'), season, kickoffAt: end + 2 * HOUR });
    const board = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    const ids = board.games.map((g) => g.id);
    expect(ids).toContain(gid('monday'));
    expect(ids).not.toContain(gid('tuesday'));

    // An explicit ?to= still overrides the default, unchanged.
    const wider = await (
      await get(
        `/api/games?league=nfl&season=${String(season)}&to=${String(end + 3 * HOUR)}`,
        alex.cookie,
      )
    ).json<GamesResponse>();
    expect(wider.games.map((g) => g.id)).toContain(gid('tuesday'));
  });

  it('GET /api/games/:id is UNWINDOWED: a game past the Monday still resolves (§22.7)', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const end = boardWindowEnd('nfl', Date.now());
    await seedGameWithLine(env.DB, { id: gid('later'), season, kickoffAt: end + 2 * HOUR });
    const res = await get(`/api/games/${encodeURIComponent(gid('later'))}`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json<{ game: { id: string } }>()).game.id).toBe(gid('later'));
  });
});

describe('games board', () => {
  it('bettable is false once now >= lockAt, even if the game is still scheduled', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    // Still `scheduled`, still in the future — but inside the cutoff buffer.
    await seedGameWithLine(env.DB, {
      id: gid('locked'),
      season,
      kickoffAt: now + BET_CUTOFF_BUFFER_MS - 5_000,
    });
    await seedGameWithLine(env.DB, { id: gid('open'), season, kickoffAt: now + 4 * HOUR });

    const res = await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const board = await res.json<GamesResponse>();
    const byId = new Map(board.games.map((g) => [g.id, g]));
    expect(byId.get(gid('locked'))?.status).toBe('scheduled');
    expect(byId.get(gid('locked'))?.bettable).toBe(false);
    expect(byId.get(gid('locked'))?.lockAt).toBe(now + BET_CUTOFF_BUFFER_MS - 5_000 - 60_000);
    expect(byId.get(gid('open'))?.bettable).toBe(true);

    // ...and a game that is not `scheduled` is never bettable either.
    await seedGameWithLine(env.DB, {
      id: gid('live'),
      season,
      kickoffAt: now + 4 * HOUR,
      status: 'in_progress',
    });
    const second = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    expect(second.games.find((g) => g.id === gid('live'))?.bettable).toBe(false);
  });

  it('a game days away keeps a 10-hour-old line bettable, and drops a 19-hour-old one', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    await seedGame(env.DB, { id: gid('far-ok'), season, kickoffAt: now + 5 * 24 * HOUR });
    await seedLine(env.DB, fullLine(gid('far-ok'), now - 10 * HOUR));
    await seedGame(env.DB, { id: gid('far-stale'), season, kickoffAt: now + 5 * 24 * HOUR });
    await seedLine(env.DB, fullLine(gid('far-stale'), now - 19 * HOUR));
    const board = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    const ok = board.games.find((g) => g.id === gid('far-ok'));
    const stale = board.games.find((g) => g.id === gid('far-stale'));
    expect(ok?.lines?.stale).toBe(false);
    expect(ok?.bettable).toBe(true);
    expect(stale?.lines?.stale).toBe(true);
    expect(stale?.bettable).toBe(false);
  });

  it('the board judges the tier at seen_at too (game 47 h out, line seen 4 h ago is fresh)', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    await seedGame(env.DB, { id: gid('crossed'), season, kickoffAt: now + 47 * HOUR });
    await seedLine(env.DB, fullLine(gid('crossed'), now - 4 * HOUR));
    const board = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    const game = board.games.find((g) => g.id === gid('crossed'));
    expect(game?.lines?.stale).toBe(false);
    expect(game?.bettable).toBe(true);
  });

  it('bettable is false when the line is stale', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    await seedGame(env.DB, { id: gid('stale'), season, kickoffAt: now + 6 * HOUR });
    // captured_at is fresh; only seen_at is old. Staleness must key off seen_at.
    await seedLine(env.DB, {
      ...fullLine(gid('stale'), now - LINE_STALE_MS - 1_000),
      capturedAt: now - 1_000,
    });
    const board = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    const game = board.games.find((g) => g.id === gid('stale'));
    expect(game?.lines?.stale).toBe(true);
    expect(game?.bettable).toBe(false);
  });

  it('lines: null renders as "not posted", not as an error', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    // A normal CFB state early in the week: a game with no line row at all.
    await seedGame(env.DB, {
      id: gid('nolines', 'ncaaf'),
      league: 'ncaaf',
      season,
      kickoffAt: now + 3 * 24 * HOUR,
    });
    const res = await get(`/api/games?league=ncaaf&season=${String(season)}`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const board = await res.json<GamesResponse>();
    expect(board.games).toHaveLength(1);
    expect(board.games[0]?.lines).toBeNull();
    expect(board.games[0]?.bettable).toBe(false);
  });

  it('respects the BOARD_MAX_GAMES cap', async () => {
    const alex = await register('alex');
    const { gid, season } = scope();
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < BOARD_MAX_GAMES + 5; i += 1) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO games (id, provider, provider_event_id, league, season, season_type, week,
                              name, short_name, kickoff_at, original_kickoff_at, status,
                              neutral_site, home_team_id, home_abbr, home_name,
                              away_team_id, away_abbr, away_name,
                              first_seen_at, last_seen_at, updated_at)
           VALUES (?1, 'espn', ?1, 'nfl', ?4, 2, 1, 'A at B', 'A @ B', ?2, ?2, 'scheduled',
                   0, 'th', 'HOM', 'Home', 'ta', 'AWY', 'Away', ?3, ?3, ?3)`,
        ).bind(gid(i), now + HOUR + i * 1000, now, season),
      );
    }
    for (let i = 0; i < statements.length; i += 50) {
      await env.DB.batch(statements.slice(i, i + 50));
    }
    const board = await (
      await get(`/api/games?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<GamesResponse>();
    expect(board.games).toHaveLength(BOARD_MAX_GAMES);
  });
});

describe('leaderboard semantics', () => {
  interface Season {
    readonly season: number;
    readonly cookie: string;
    readonly names: { alex: string; bob: string; carol: string };
  }

  /** PLAN.md §11.5 spelled out as data: three users, one season, known results. */
  async function seedSeason(): Promise<Season> {
    const now = Date.now();
    const { season } = scope();
    const alex = await register('alex');
    const bob = await register('bob');
    const carol = await register('carol');
    const bet = (
      id: string,
      userId: string,
      status: 'won' | 'lost' | 'push' | 'void' | 'cancelled' | 'pending',
      stakeCents: number,
      payoutCents?: number,
    ): Promise<void> =>
      seedSettledBet(env.DB, {
        id: `${String(season)}-${id}`,
        userId,
        season,
        status,
        stakeCents,
        ...(payoutCents === undefined ? {} : { payoutCents }),
        placedAt: now,
      });

    // alex: won 2500 -> 4772, lost 1000, push 500, void 500, cancelled 9999.
    await bet('alex-won', alex.id, 'won', 2500, 4772);
    await bet('alex-lost', alex.id, 'lost', 1000, 0);
    await bet('alex-push', alex.id, 'push', 500, 500);
    await bet('alex-void', alex.id, 'void', 500, 500);
    await bet('alex-cancelled', alex.id, 'cancelled', 9999);
    // bob: one open bet only — exposure but no settled action.
    await bet('bob-open', bob.id, 'pending', 3000);
    // carol: exactly the same balance as alex, but a worse ROI.
    await bet('carol-won', carol.id, 'won', 10_000, 11_272);
    return {
      season,
      cookie: alex.cookie,
      names: { alex: alex.name, bob: bob.name, carol: carol.name },
    };
  }

  async function board(s: Season): Promise<LeaderboardResponse> {
    const res = await get(`/api/leaderboard?league=nfl&season=${String(s.season)}`, s.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json<LeaderboardResponse>();
  }

  it('balanceCents excludes pending stakes', async () => {
    const bob = await register('bob');
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `open-${String(season)}`,
      userId: bob.id,
      season,
      status: 'pending',
      stakeCents: 3000,
    });
    const res = await get('/api/bankroll', bob.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await mainBalance(res);
    expect(body.balanceCents).toBe(97_000);
    expect(body.pendingStakeCents).toBe(3000);
  });

  it('equityCents === balanceCents + pendingStakeCents', async () => {
    const bob = await register('bob');
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `open-${String(season)}`,
      userId: bob.id,
      season,
      status: 'pending',
      stakeCents: 3000,
    });
    const body = await mainBalance(await get('/api/bankroll', bob.cookie));
    expect(body.equityCents).toBe(body.balanceCents + body.pendingStakeCents);
    expect(body.equityCents).toBe(100_000);
  });

  it('record counts settled bets only and excludes cancelled bets', async () => {
    const s = await seedSeason();
    const rows = (await board(s)).rows;
    // The 9,999c cancelled bet appears nowhere in the record.
    expect(rows.find((r) => r.username === s.names.alex)?.record).toEqual({
      won: 1,
      lost: 1,
      push: 1,
      void: 1,
    });
    expect(rows.find((r) => r.username === s.names.bob)?.record).toEqual({
      won: 0,
      lost: 0,
      push: 0,
      void: 0,
    });
  });

  it('roi excludes push and void from BOTH numerator and denominator', async () => {
    const s = await seedSeason();
    const rows = (await board(s)).rows;
    // won 4772 on 2500 + lost 0 on 1000 => (4772 - 3500) / 3500.
    // The 500c push and the 500c void are in NEITHER sum.
    expect(rows.find((r) => r.username === s.names.alex)?.roi).toBeCloseTo(
      (4772 - 3500) / 3500,
      12,
    );
  });

  it('roi is null when there is no settled action', async () => {
    const s = await seedSeason();
    const rows = (await board(s)).rows;
    expect(rows.find((r) => r.username === s.names.bob)?.roi).toBeNull();
  });

  it('ranks by equity desc, then roi desc, then username', async () => {
    const s = await seedSeason();
    const body = await board(s);
    // Scoped to this test's three users: balances are ACCOUNT-level since M5b,
    // so every user the file ever created appears on every board.
    const names: readonly string[] = [s.names.alex, s.names.bob, s.names.carol];
    const mine = body.rows.filter((r) => names.includes(r.username));
    // alex:  100000 - 2500 + 4772 - 1000 - 500 + 500 - 500 + 500 - 9999 + 9999 = 101272
    // carol: 100000 - 10000 + 11272                                            = 101272
    // bob:   100000 - 3000                                                     = 97000
    expect(mine.map((r) => r.balanceCents)).toEqual([101_272, 101_272, 97_000]);
    // Tied on equity too (neither alex nor carol has an open bet): alex's ROI
    // (0.3634) beats carol's (0.1272), so ROI is what separates them.
    expect(mine.map((r) => r.equityCents)).toEqual([101_272, 101_272, 100_000]);
    expect(mine.map((r) => r.username)).toEqual([s.names.alex, s.names.carol, s.names.bob]);
    // Ranks are ascending and dense within the slice, whatever the offset is.
    expect(mine.map((r) => r.rank)).toEqual([...mine].map((r) => r.rank).sort((a, b) => a - b));
    expect(mine[0]?.equityCents).toBe(101_272);
    expect(mine[2]?.equityCents).toBe(100_000);
  });

  it('the unfiltered board pools the numerator and denominator rather than averaging ROIs', async () => {
    const alex = await register('alex');
    const a = scope();
    const b = scope();
    // Season A: +1000 profit on a 1000 stake  (ROI 1.0)
    await seedSettledBet(env.DB, {
      id: `pool-a-${String(a.season)}`,
      userId: alex.id,
      season: a.season,
      status: 'won',
      stakeCents: 1000,
      payoutCents: 2000,
    });
    // Season B: -9000 on a 9000 stake         (ROI -1.0)
    await seedSettledBet(env.DB, {
      id: `pool-b-${String(b.season)}`,
      userId: alex.id,
      season: b.season,
      status: 'lost',
      stakeCents: 9000,
      payoutCents: 0,
    });
    const body = await (
      await get('/api/leaderboard/all-time', alex.cookie)
    ).json<LeaderboardResponse>();
    expect(body.league).toBe('all');
    const row = body.rows.find((r) => r.username === alex.name);
    // The average of the two ROIs is 0. The POOLED figure is (2000-10000)/10000.
    expect(row?.roi).toBeCloseTo(-0.8, 12);
    // ONE balance: 100000 + (2000 - 1000) + (0 - 9000) = 92000. M5 summed two
    // per-season bankrolls here (101000 + 91000); there is only one pot now, so
    // the opening deposit is granted once rather than once per season.
    expect(row?.balanceCents).toBe(92_000);
    expect(row?.record).toEqual({ won: 1, lost: 1, push: 0, void: 0 });
  });
});
