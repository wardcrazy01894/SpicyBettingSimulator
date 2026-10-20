import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type {
  BetResponse,
  LeaderboardResponse,
  PlaceBetRequest,
  PlayerBetsResponse,
  PlayerBustsResponse,
  UserResponse,
} from '../../src/shared/api-types.js';
import { BUST_BUYOUT_CENTS, INITIAL_BANKROLL_CENTS } from '../../src/shared/constants.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';

import { buildApp } from '../../src/worker/index.js';
import { seedGameWithLine, seedSettledBet } from './seed.js';

/**
 * PLAN.md §11.8 — `GET /api/users/:id/bets`, another player's bet history.
 *
 * The contract, in one place:
 *   - any signed-in user may read any PLAYING account's bets, open or settled;
 *   - "playing" is the leaderboard's predicate (enabled, not deleted), and an
 *     account outside it is `404 NOT_FOUND`, indistinguishable from an id that
 *     never existed;
 *   - every bet comes back `cancellable: false`, whoever is asking — the page is
 *     read-only, and the viewer could not act on the bet anyway;
 *   - the filters are `GET /api/bets`'s, byte for byte: `status` partitions
 *     open/settled, `league` matches `bets.league` exactly, cursor paging.
 *
 * Isolation as in bets.spec.ts: the pool does not roll back between tests, so
 * every test allocates its own users and game ids.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

let userSeq = 0;
let gameSeq = 0;

function gid(): string {
  gameSeq += 1;
  return `nfl:P${String(gameSeq)}`;
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, { headers }, env));
}

function post(path: string, payload: unknown, cookie: string): Promise<Response> {
  return Promise.resolve(
    buildApp().request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-SBS-Client': '1', cookie },
        body: JSON.stringify(payload),
      },
      env,
    ),
  );
}

async function register(base = 'player'): Promise<{ cookie: string; id: string; name: string }> {
  userSeq += 1;
  const username = `${base}${String(userSeq)}`;
  const res = await buildApp().request(
    `${ORIGIN}/api/auth/signup`,
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

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error.code;
}

function straight(gameId: string, stakeCents = 2500): PlaceBetRequest {
  return {
    league: 'nfl',
    betType: 'straight',
    stakeCents,
    legs: [{ gameId, market: 'spread', side: 'home' }],
  };
}

/** Place a real open bet for `who` on a fresh game, through the API. */
async function placeOpen(who: { cookie: string }, stakeCents = 2500): Promise<string> {
  const game = gid();
  await seedGameWithLine(env.DB, { id: game, kickoffAt: NOW + 4 * HOUR });
  const res = await post('/api/bets', straight(game, stakeCents), who.cookie);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<BetResponse>()).bet.id;
}

describe('GET /api/users/:id/bets', () => {
  it('requires a session', async () => {
    const tyler = await register('tyler');
    const res = await get(`/api/users/${tyler.id}/bets`);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it("returns another player's open bets, read-only, with who they belong to", async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    const betId = await placeOpen(tyler, 3000);

    const res = await get(`/api/users/${tyler.id}/bets`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<PlayerBetsResponse>();

    expect(body.player).toEqual({ id: tyler.id, username: tyler.name, displayName: tyler.name });
    expect(body.bets.map((b) => b.id)).toEqual([betId]);
    expect(body.nextCursor).toBeNull();

    const bet = body.bets[0];
    expect(bet?.status).toBe('pending');
    expect(bet?.stakeCents).toBe(3000);
    // The viewer sees the legs and the live projection, exactly as the owner
    // does on My Bets...
    expect(bet?.legs).toHaveLength(1);
    expect(bet?.legs[0]?.projected).toBe('pending');
    // ...but never an action. The owner's own view of the same bet says
    // `cancellable: true`; this one is read-only by contract.
    expect(bet?.cancellable).toBe(false);
    const own = await (await get(`/api/bets/${betId}`, tyler.cookie)).json<BetResponse>();
    expect(own.bet.cancellable).toBe(true);
  });

  it('defaults to open, and status=settled is the complement (cancelled included)', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    const open = await placeOpen(tyler);
    const won = `won-${tyler.id}`;
    const lost = `lost-${tyler.id}`;
    const cancelled = `cxl-${tyler.id}`;
    await seedSettledBet(env.DB, {
      id: won,
      userId: tyler.id,
      status: 'won',
      stakeCents: 1000,
      payoutCents: 1909,
      placedAt: NOW - 3 * HOUR,
    });
    await seedSettledBet(env.DB, {
      id: lost,
      userId: tyler.id,
      status: 'lost',
      stakeCents: 500,
      payoutCents: 0,
      placedAt: NOW - 2 * HOUR,
    });
    await seedSettledBet(env.DB, {
      id: cancelled,
      userId: tyler.id,
      status: 'cancelled',
      stakeCents: 700,
      placedAt: NOW - HOUR,
    });

    const ids = async (query: string): Promise<string[]> => {
      const res = await get(`/api/users/${tyler.id}/bets${query}`, alex.cookie);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json<PlayerBetsResponse>()).bets.map((b) => b.id);
    };

    expect(await ids('')).toEqual([open]);
    expect(await ids('?status=open')).toEqual([open]);
    // Newest first, like /api/bets; the money on each is what settlement paid.
    expect(await ids('?status=settled')).toEqual([cancelled, lost, won]);
    expect(await ids('?status=all')).toEqual([open, cancelled, lost, won]);

    const settled = await (
      await get(`/api/users/${tyler.id}/bets?status=settled`, alex.cookie)
    ).json<PlayerBetsResponse>();
    const byId = new Map(settled.bets.map((b) => [b.id, b]));
    expect(byId.get(won)).toMatchObject({ status: 'won', stakeCents: 1000, payoutCents: 1909 });
    expect(byId.get(lost)).toMatchObject({ status: 'lost', stakeCents: 500, payoutCents: 0 });
    expect(byId.get(cancelled)).toMatchObject({ status: 'cancelled', cancellable: false });
    expect(settled.bets.every((b) => !b.cancellable)).toBe(true);
  });

  it('filters by league exactly, so a mixed bet is under neither single league', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    await seedSettledBet(env.DB, {
      id: `nfl-${tyler.id}`,
      userId: tyler.id,
      league: 'nfl',
      status: 'won',
      stakeCents: 1000,
      payoutCents: 2000,
    });
    await seedSettledBet(env.DB, {
      id: `cfb-${tyler.id}`,
      userId: tyler.id,
      league: 'ncaaf',
      status: 'lost',
      stakeCents: 1000,
      payoutCents: 0,
    });
    await seedSettledBet(env.DB, {
      id: `mix-${tyler.id}`,
      userId: tyler.id,
      league: 'mixed',
      status: 'won',
      stakeCents: 1000,
      payoutCents: 2600,
    });
    const ids = async (query: string): Promise<string[]> => {
      const res = await get(`/api/users/${tyler.id}/bets?status=settled${query}`, alex.cookie);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json<PlayerBetsResponse>()).bets.map((b) => b.id).sort();
    };
    expect(await ids('&league=nfl')).toEqual([`nfl-${tyler.id}`]);
    expect(await ids('&league=ncaaf')).toEqual([`cfb-${tyler.id}`]);
    expect(await ids('&league=mixed')).toEqual([`mix-${tyler.id}`]);
    expect(await ids('')).toEqual([`cfb-${tyler.id}`, `mix-${tyler.id}`, `nfl-${tyler.id}`]);
  });

  it('pages with the same cursor as /api/bets', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    for (let i = 0; i < 3; i += 1) {
      await seedSettledBet(env.DB, {
        id: `pg${String(i)}-${tyler.id}`,
        userId: tyler.id,
        status: 'lost',
        stakeCents: 100,
        payoutCents: 0,
        placedAt: NOW - (10 - i) * HOUR,
      });
    }
    const first = await (
      await get(`/api/users/${tyler.id}/bets?status=settled&limit=2`, alex.cookie)
    ).json<PlayerBetsResponse>();
    expect(first.bets.map((b) => b.id)).toEqual([`pg2-${tyler.id}`, `pg1-${tyler.id}`]);
    expect(first.nextCursor).not.toBeNull();

    const second = await (
      await get(
        `/api/users/${tyler.id}/bets?status=settled&limit=2&cursor=${encodeURIComponent(
          first.nextCursor ?? '',
        )}`,
        alex.cookie,
      )
    ).json<PlayerBetsResponse>();
    expect(second.bets.map((b) => b.id)).toEqual([`pg0-${tyler.id}`]);
    expect(second.nextCursor).toBeNull();
  });

  it('lets you look at yourself, still read-only', async () => {
    const alex = await register('alex');
    const betId = await placeOpen(alex);
    const res = await get(`/api/users/${alex.id}/bets`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<PlayerBetsResponse>();
    expect(body.player.id).toBe(alex.id);
    expect(body.bets.map((b) => b.id)).toEqual([betId]);
    expect(body.bets[0]?.cancellable).toBe(false);
  });

  it('is 404 NOT_FOUND for an unknown, disabled or soft-deleted account alike', async () => {
    const alex = await register('alex');
    const disabled = await register('disabled');
    const deleted = await register('deleted');
    await placeOpen(disabled);
    await placeOpen(deleted);

    // Both are visible while they are playing...
    expect((await get(`/api/users/${disabled.id}/bets`, alex.cookie)).status).toBe(200);
    expect((await get(`/api/users/${deleted.id}/bets`, alex.cookie)).status).toBe(200);

    await env.DB.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?1').bind(disabled.id).run();
    await env.DB.prepare('UPDATE users SET is_disabled = 1, deleted_at = ?2 WHERE id = ?1')
      .bind(deleted.id, NOW)
      .run();

    // ...and drop off exactly as they drop off the leaderboard, with the same
    // answer an id that never existed gets. Nothing is deleted: re-enabling
    // puts the history straight back.
    for (const id of [disabled.id, deleted.id, 'no-such-user']) {
      const res = await get(`/api/users/${id}/bets`, alex.cookie);
      expect(res.status, id).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }
    await env.DB.prepare('UPDATE users SET is_disabled = 0 WHERE id = ?1').bind(disabled.id).run();
    expect((await get(`/api/users/${disabled.id}/bets`, alex.cookie)).status).toBe(200);
  });

  it('rejects a bad status, league, limit or cursor with 400 VALIDATION', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    for (const query of ['?status=won', '?league=xfl', '?limit=abc', '?cursor=garbage']) {
      const res = await get(`/api/users/${tyler.id}/bets${query}`, alex.cookie);
      expect(res.status, query).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:id/busts — the bust history (PLAN.md §4.5, §11.8)
// ---------------------------------------------------------------------------

describe('GET /api/users/:id/busts', () => {
  async function admin(): Promise<{ cookie: string; id: string }> {
    const user = await register('boss');
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?1').bind(user.id).run();
    return user;
  }

  async function adjust(boss: { cookie: string }, id: string, amountCents: number): Promise<void> {
    const res = await post(`/api/admin/users/${id}/adjust`, { amountCents }, boss.cookie);
    expect(res.status, await res.clone().text()).toBe(204);
  }

  it('requires a session, and an account off the board is 404', async () => {
    const tyler = await register('tyler');
    const anon = await get(`/api/users/${tyler.id}/busts`);
    expect(anon.status).toBe(401);

    const alex = await register('alex');
    await env.DB.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?1').bind(tyler.id).run();
    const hidden = await get(`/api/users/${tyler.id}/busts`, alex.cookie);
    expect(hidden.status).toBe(404);
    expect(await errorCode(hidden)).toBe('NOT_FOUND');
    expect((await get('/api/users/nobody/busts', alex.cookie)).status).toBe(404);
  });

  it('is empty for a player who never busted', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    const res = await get(`/api/users/${tyler.id}/busts`, alex.cookie);
    expect(res.status).toBe(200);
    expect(await res.json<PlayerBustsResponse>()).toEqual({
      player: { id: tyler.id, username: tyler.name, displayName: tyler.name },
      busts: [],
    });
  });

  it('lists every refill, oldest first, with when (and whether) its badge was bought off', async () => {
    const boss = await admin();
    const alex = await register('alex');
    const tyler = await register('tyler');

    // Bust #1: refilled at the default, then bought off.
    await adjust(boss, tyler.id, -INITIAL_BANKROLL_CENTS);
    const r1 = await post(`/api/admin/users/${tyler.id}/refill`, {}, boss.cookie);
    expect(r1.status, await r1.clone().text()).toBe(204);
    await adjust(boss, tyler.id, 40_000);
    const b1 = await post('/api/bankroll/buyout', {}, tyler.cookie);
    expect(b1.status, await b1.clone().text()).toBe(204);

    // Bust #2: a custom refill, still on the name.
    await adjust(boss, tyler.id, -40_000);
    const r2 = await post(
      `/api/admin/users/${tyler.id}/refill`,
      { amountCents: 25_000 },
      boss.cookie,
    );
    expect(r2.status, await r2.clone().text()).toBe(204);

    const res = await get(`/api/users/${tyler.id}/busts`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<PlayerBustsResponse>();
    expect(body.player.id).toBe(tyler.id);
    expect(body.busts).toHaveLength(2);

    const [first, second] = body.busts;
    expect(first?.priceCents).toBe(100_000);
    expect(first).toMatchObject({
      amountCents: INITIAL_BANKROLL_CENTS,
      priceCents: BUST_BUYOUT_CENTS,
    });
    expect(typeof first?.refilledAt).toBe('number');
    expect(typeof first?.boughtOutAt).toBe('number');
    expect(first?.boughtOutAt ?? 0).toBeGreaterThanOrEqual(first?.refilledAt ?? Infinity);
    expect(second).toMatchObject({ amountCents: 25_000, boughtOutAt: null, priceCents: null });
    expect(second?.refilledAt ?? 0).toBeGreaterThanOrEqual(first?.refilledAt ?? Infinity);

    // The same two facts the leaderboard carries: one badge on the name now.
    const board = await (await get('/api/leaderboard', alex.cookie)).json<LeaderboardResponse>();
    expect(board.rows.find((r) => r.userId === tyler.id)?.bustCount).toBe(1);
    // Your own history reads the same as anyone else's.
    const own = await (
      await get(`/api/users/${tyler.id}/busts`, tyler.cookie)
    ).json<PlayerBustsResponse>();
    expect(own).toEqual(body);
  });

  it('reads the MAIN balance only: a refill on a side pot is not a bust', async () => {
    const alex = await register('alex');
    const tyler = await register('tyler');
    // v1 never writes a `custom` balance, but the schema allows one and the
    // leaderboard's money is main-only; the history has to agree with it.
    const potId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         VALUES (?1, ?2, 'Side pot', 'custom', 0, ?3, ?3)`,
      ).bind(potId, tyler.id, NOW),
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'deposit_refill', ?3, NULL, 5000, ?4, 'side pot refill')`,
      ).bind(crypto.randomUUID(), potId, crypto.randomUUID(), NOW),
    ]);
    const res = await get(`/api/users/${tyler.id}/busts`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json<PlayerBustsResponse>()).busts).toEqual([]);
    const board = await (await get('/api/leaderboard', alex.cookie)).json<LeaderboardResponse>();
    expect(board.rows.find((r) => r.userId === tyler.id)?.bustCount).toBe(0);
  });
});
