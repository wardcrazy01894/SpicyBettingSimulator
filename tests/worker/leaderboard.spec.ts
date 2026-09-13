import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type {
  BankrollResponse,
  LeaderboardResponse,
  LedgerResponse,
  UserResponse,
} from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { INITIAL_BANKROLL_CENTS } from '../../src/shared/constants.js';
import { buildApp } from '../../src/worker/index.js';
import { bankrollDrift, seedBankroll, seedGameWithLine, seedSettledBet } from './seed.js';

/**
 * PLAN.md §11.5 — the bankroll, ledger and leaderboard read paths.
 *
 * The seven canonical leaderboard semantics live in `routes.spec.ts` (they were
 * the `it.todo`s there); this file covers the surrounding endpoints, the lazy
 * bankroll, pagination, and the ranking/scoping edges that only show up with
 * several bankrolls in play.
 *
 * Isolation, as in bets.spec.ts: the pool does not roll back between tests and
 * `ledger` cannot be truncated, so every test allocates its own user, its own
 * season and its own game ids.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;

let userSeq = 0;
let scopeSeq = 0;

function scope(): { gid: (n: string | number, league?: string) => string; season: number } {
  scopeSeq += 1;
  const n = scopeSeq;
  return {
    gid: (k, league = 'nfl') => `${league}:L${String(n)}-${String(k)}`,
    season: 4000 + n,
  };
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, { headers }, env));
}

async function register(base = 'user'): Promise<{ cookie: string; id: string; name: string }> {
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

/** Opening deposits belonging to ONE user. A global count would see every test. */
async function depositCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ledger le JOIN bankrolls bk ON bk.id = le.bankroll_id
      WHERE bk.user_id = ?1 AND le.kind = 'deposit_initial'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('GET /api/bankroll', () => {
  it('creates the bankroll lazily on the FIRST read, at 100000 via the ledger', async () => {
    const alex = await register();
    const { season } = scope();
    expect(await depositCount(alex.id)).toBe(0);

    const res = await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<BankrollResponse>();
    expect(body).toEqual({
      league: 'nfl',
      season,
      balanceCents: INITIAL_BANKROLL_CENTS,
      pendingStakeCents: 0,
      equityCents: INITIAL_BANKROLL_CENTS,
      record: { won: 0, lost: 0, push: 0, void: 0 },
      roi: null,
      settledCount: 0,
    });
    // The balance came from a ledger row, not from an application UPDATE.
    expect(await depositCount(alex.id)).toBe(1);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('is idempotent — a second read does not deposit again', async () => {
    const alex = await register();
    const { season } = scope();
    for (let i = 0; i < 3; i += 1) {
      const res = await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie);
      expect(res.status).toBe(200);
      expect((await res.json<BankrollResponse>()).balanceCents).toBe(INITIAL_BANKROLL_CENTS);
    }
    expect(await depositCount(alex.id)).toBe(1);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('keeps each (league, season) bankroll separate', async () => {
    const alex = await register();
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `b1-${String(season)}`,
      userId: alex.id,
      league: 'nfl',
      season,
      status: 'lost',
      stakeCents: 5000,
      payoutCents: 0,
    });
    const nfl = await (
      await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<BankrollResponse>();
    const ncaaf = await (
      await get(`/api/bankroll?league=ncaaf&season=${String(season)}`, alex.cookie)
    ).json<BankrollResponse>();
    expect(nfl.balanceCents).toBe(95_000);
    expect(ncaaf.balanceCents).toBe(INITIAL_BANKROLL_CENTS);
    expect(ncaaf.settledCount).toBe(0);
  });

  it('requires auth and a valid league', async () => {
    const anon = await get('/api/bankroll?league=nfl&season=2026');
    expect(anon.status).toBe(401);
    const alex = await register();
    const bad = await get('/api/bankroll?league=cricket&season=2026', alex.cookie);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('VALIDATION');
  });

  it('counts pending stakes as exposure, not as balance', async () => {
    const alex = await register();
    const { gid, season } = scope();
    const now = Date.now();
    await seedGameWithLine(env.DB, { id: gid(1), season, kickoffAt: now + 4 * HOUR });
    const placed = await buildApp().request(
      `${ORIGIN}/api/bets`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-SBS-Client': '1',
          cookie: alex.cookie,
        },
        body: JSON.stringify({
          league: 'nfl',
          betType: 'straight',
          stakeCents: 2500,
          legs: [{ gameId: gid(1), market: 'spread', side: 'home' }],
        }),
      },
      env,
    );
    expect(placed.status, await placed.clone().text()).toBe(201);

    const body = await (
      await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<BankrollResponse>();
    expect(body.balanceCents).toBe(97_500);
    expect(body.pendingStakeCents).toBe(2500);
    expect(body.equityCents).toBe(100_000);
    expect(body.settledCount).toBe(0);
    expect(body.roi).toBeNull();
  });
});

describe('GET /api/ledger', () => {
  it('lists the bankroll history newest first, with a working cursor', async () => {
    const alex = await register();
    const { season } = scope();
    const now = Date.now();
    // Open the bankroll FIRST, so the deposit is strictly the oldest row: the
    // cursor orders by (created_at, id) and a tie would be decided by a UUID.
    await seedBankroll(env.DB, alex.id, 'nfl', season, now);
    for (let i = 0; i < 4; i += 1) {
      await seedSettledBet(env.DB, {
        id: `b-${String(season)}-${String(i)}`,
        userId: alex.id,
        season,
        status: 'lost',
        stakeCents: 100 + i,
        payoutCents: 0,
        placedAt: now + 1 + i,
      });
    }
    const page1 = await (
      await get(`/api/ledger?league=nfl&season=${String(season)}&limit=3`, alex.cookie)
    ).json<LedgerResponse>();
    expect(page1.entries).toHaveLength(3);
    expect(page1.entries[0]?.kind).toBe('bet_stake');
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await (
      await get(
        `/api/ledger?league=nfl&season=${String(season)}&limit=3&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        alex.cookie,
      )
    ).json<LedgerResponse>();
    // 4 stakes + 1 opening deposit = 5 rows total.
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(page2.entries[1]?.kind).toBe('deposit_initial');
    expect(page2.entries[1]?.amountCents).toBe(INITIAL_BANKROLL_CENTS);

    const ids = [...page1.entries, ...page2.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('never leaks another user’s ledger', async () => {
    const alex = await register();
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `b-alex-${String(season)}`,
      userId: alex.id,
      season,
      status: 'lost',
      stakeCents: 4200,
      payoutCents: 0,
    });
    const bob = await register();
    const body = await (
      await get(`/api/ledger?league=nfl&season=${String(season)}`, bob.cookie)
    ).json<LedgerResponse>();
    // Bob's own bankroll is created lazily and holds only his opening deposit.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.kind).toBe('deposit_initial');
  });
});

describe('GET /api/leaderboard', () => {
  it('requires auth', async () => {
    const res = await get('/api/leaderboard?league=nfl&season=2026');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('scopes to one (league, season) and ignores every other bankroll', async () => {
    const alex = await register();
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `b-nfl-${String(season)}`,
      userId: alex.id,
      league: 'nfl',
      season,
      status: 'won',
      stakeCents: 1000,
      payoutCents: 3000,
    });
    await seedSettledBet(env.DB, {
      id: `b-cfb-${String(season)}`,
      userId: alex.id,
      league: 'ncaaf',
      season,
      status: 'lost',
      stakeCents: 50_000,
      payoutCents: 0,
    });
    const nfl = await (
      await get(`/api/leaderboard?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<LeaderboardResponse>();
    expect(nfl.league).toBe('nfl');
    expect(nfl.season).toBe(season);
    expect(nfl.rows).toHaveLength(1);
    expect(nfl.rows[0]?.balanceCents).toBe(102_000);
    expect(nfl.rows[0]?.record).toEqual({ won: 1, lost: 0, push: 0, void: 0 });

    const cfb = await (
      await get(`/api/leaderboard?league=ncaaf&season=${String(season)}`, alex.cookie)
    ).json<LeaderboardResponse>();
    expect(cfb.rows[0]?.balanceCents).toBe(50_000);
  });

  it('breaks a balance+roi tie by username, ascending', async () => {
    const { season } = scope();
    const bob = await register('bob');
    const alex = await register('alex');
    const carol = await register('carol');
    // Identical histories -> identical balance AND identical roi.
    for (const user of [bob, alex, carol]) {
      await seedSettledBet(env.DB, {
        id: `b-${user.id}`,
        userId: user.id,
        season,
        status: 'won',
        stakeCents: 1000,
        payoutCents: 1500,
      });
    }
    const body = await (
      await get(`/api/leaderboard?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<LeaderboardResponse>();
    expect(body.rows.map((r) => r.username)).toEqual([alex.name, bob.name, carol.name]);
    expect(body.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('a push leaves the ROI null, so username breaks the tie at equal balance', async () => {
    const { season } = scope();
    const alex = await register('alex');
    const bob = await register('bob');
    // bob has a settled PUSH, which is excluded from ROI entirely...
    await seedSettledBet(env.DB, {
      id: `b-bob-${String(season)}`,
      userId: bob.id,
      season,
      status: 'push',
      stakeCents: 2000,
      payoutCents: 2000,
    });
    // ...alex has no action at all. Both ROIs are null at the same balance.
    expect(
      (await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie)).status,
    ).toBe(200);

    const body = await (
      await get(`/api/leaderboard?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<LeaderboardResponse>();
    expect(body.rows.map((r) => r.balanceCents)).toEqual([100_000, 100_000]);
    expect(body.rows.map((r) => r.roi)).toEqual([null, null]);
    expect(body.rows.map((r) => r.username)).toEqual([alex.name, bob.name]);
    expect(body.rows.find((r) => r.username === bob.name)?.record).toEqual({
      won: 0,
      lost: 0,
      push: 1,
      void: 0,
    });
  });

  it('all-time sums balances and exposures across every league and season', async () => {
    const alex = await register();
    const a = scope();
    const b = scope();
    await seedSettledBet(env.DB, {
      id: `b1-${String(a.season)}`,
      userId: alex.id,
      league: 'nfl',
      season: a.season,
      status: 'won',
      stakeCents: 1000,
      payoutCents: 2500,
    });
    await seedSettledBet(env.DB, {
      id: `b2-${String(b.season)}`,
      userId: alex.id,
      league: 'ncaaf',
      season: b.season,
      status: 'pending',
      stakeCents: 4000,
    });
    const body = await (
      await get('/api/leaderboard/all-time', alex.cookie)
    ).json<LeaderboardResponse>();
    const row = body.rows.find((r) => r.username === alex.name);
    expect(row?.balanceCents).toBe(101_500 + 96_000);
    expect(row?.pendingStakeCents).toBe(4000);
    expect(row?.equityCents).toBe(101_500 + 96_000 + 4000);
    expect(row?.record).toEqual({ won: 1, lost: 0, push: 0, void: 0 });
  });
});
