import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type {
  BankrollView,
  BankrollsResponse,
  LeaderboardResponse,
  LedgerResponse,
  UserResponse,
} from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { INITIAL_BANKROLL_CENTS } from '../../src/shared/constants.js';
import { buildApp } from '../../src/worker/index.js';
import {
  balanceOf,
  bankrollDrift,
  mainBankrollId,
  seedBankroll,
  seedGameWithLine,
  seedSettledBet,
} from './seed.js';

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

/** The caller's main balance out of `GET /api/bankroll`'s `{ balances }` list. */
async function mainBalance(res: Response): Promise<BankrollView> {
  const body = await res.json<BankrollsResponse>();
  const main = body.balances.find((b) => b.kind === 'main');
  if (main === undefined) throw new Error(`no main balance in ${JSON.stringify(body)}`);
  return main;
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
  it('returns the ONE account balance signup opened, and creates nothing', async () => {
    const alex = await register();
    // M5b: signup already did this. The GET is a pure read.
    expect(await depositCount(alex.id)).toBe(1);

    const res = await get('/api/bankroll', alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<BankrollsResponse>();
    expect(body.balances).toHaveLength(1);
    expect(body.balances[0]).toEqual({
      id: await mainBankrollId(env.DB, alex.id),
      name: 'Main',
      kind: 'main',
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

  it('reading it repeatedly deposits nothing and opens no second balance', async () => {
    const alex = await register();
    for (let i = 0; i < 3; i += 1) {
      const res = await get('/api/bankroll', alex.cookie);
      expect(res.status).toBe(200);
      expect((await mainBalance(res)).balanceCents).toBe(INITIAL_BANKROLL_CENTS);
    }
    expect(await depositCount(alex.id)).toBe(1);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bankrolls WHERE user_id = ?1`)
      .bind(alex.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('the MONEY is account-wide; only record/ROI respect ?league=&season=', async () => {
    const alex = await register();
    const { season } = scope();
    // One settled NFL loss and one settled CFB loss, on the SAME balance.
    await seedSettledBet(env.DB, {
      id: `b1-${String(season)}`,
      userId: alex.id,
      league: 'nfl',
      season,
      status: 'lost',
      stakeCents: 5000,
      payoutCents: 0,
    });
    await seedSettledBet(env.DB, {
      id: `b2-${String(season)}`,
      userId: alex.id,
      league: 'ncaaf',
      season,
      status: 'lost',
      stakeCents: 3000,
      payoutCents: 0,
    });

    const all = await mainBalance(await get('/api/bankroll', alex.cookie));
    expect(all.balanceCents).toBe(INITIAL_BANKROLL_CENTS - 8000);
    expect(all.settledCount).toBe(2);

    const nfl = await mainBalance(
      await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie),
    );
    const cfb = await mainBalance(
      await get(`/api/bankroll?league=ncaaf&season=${String(season)}`, alex.cookie),
    );
    // Same money under every filter — there is only one pot.
    expect(nfl.balanceCents).toBe(INITIAL_BANKROLL_CENTS - 8000);
    expect(cfb.balanceCents).toBe(INITIAL_BANKROLL_CENTS - 8000);
    // ...and a record that actually narrows.
    expect(nfl.record).toEqual({ won: 0, lost: 1, push: 0, void: 0 });
    expect(cfb.record).toEqual({ won: 0, lost: 1, push: 0, void: 0 });
    expect(nfl.roi).toBeCloseTo(-1, 12);
  });

  it('a cross-league bet counts under `all` and under neither single league', async () => {
    const alex = await register();
    const { season } = scope();
    await seedSettledBet(env.DB, {
      id: `mix-${String(season)}`,
      userId: alex.id,
      league: 'mixed',
      season,
      status: 'lost',
      stakeCents: 4000,
      payoutCents: 0,
    });
    const all = await mainBalance(await get('/api/bankroll', alex.cookie));
    expect(all.record).toEqual({ won: 0, lost: 1, push: 0, void: 0 });
    const nfl = await mainBalance(
      await get(`/api/bankroll?league=nfl&season=${String(season)}`, alex.cookie),
    );
    expect(nfl.record).toEqual({ won: 0, lost: 0, push: 0, void: 0 });
    // ...but the money it cost is in the balance under both.
    expect(nfl.balanceCents).toBe(all.balanceCents);
  });

  it('requires auth; the league filter is optional but must be a known value', async () => {
    const anon = await get('/api/bankroll');
    expect(anon.status).toBe(401);
    const alex = await register();
    // Absent is legal now — it means "every league".
    expect((await get('/api/bankroll', alex.cookie)).status).toBe(200);
    const bad = await get('/api/bankroll?league=cricket', alex.cookie);
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

    const body = await mainBalance(await get('/api/bankroll', alex.cookie));
    expect(body.balanceCents).toBe(97_500);
    expect(body.pendingStakeCents).toBe(2500);
    expect(body.equityCents).toBe(100_000);
    expect(body.settledCount).toBe(0);
    expect(body.roi).toBeNull();
  });

  it('exposure is NOT filtered, so equity === balance + pending under every tab', async () => {
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
    // Filtering to the league the open bet is NOT in must not make the exposure
    // vanish, or `equityCents` would stop being `balance + pending`.
    const cfb = await mainBalance(await get('/api/bankroll?league=ncaaf', alex.cookie));
    expect(cfb.pendingStakeCents).toBe(2500);
    expect(cfb.equityCents).toBe(cfb.balanceCents + cfb.pendingStakeCents);
  });
});

describe('GET /api/ledger', () => {
  it('lists the balance history newest first, with a working cursor', async () => {
    const alex = await register();
    const { season } = scope();
    const now = Date.now();
    // The opening deposit is written by signup and is strictly the oldest row;
    // the seeded stakes are stamped after it so the cursor order is total (it
    // orders by (created_at, id) and a tie would be decided by a UUID).
    await seedBankroll(env.DB, alex.id, now);
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
    const page1 = await (await get('/api/ledger?limit=3', alex.cookie)).json<LedgerResponse>();
    expect(page1.entries).toHaveLength(3);
    expect(page1.entries[0]?.kind).toBe('bet_stake');
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await (
      await get(
        `/api/ledger?limit=3&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
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

  it('defaults to the main balance and accepts it explicitly', async () => {
    const alex = await register();
    const bkId = await mainBankrollId(env.DB, alex.id);
    const implicit = await (await get('/api/ledger', alex.cookie)).json<LedgerResponse>();
    const explicit = await (
      await get(`/api/ledger?bankrollId=${encodeURIComponent(bkId)}`, alex.cookie)
    ).json<LedgerResponse>();
    expect(implicit.entries.map((e) => e.id)).toEqual(explicit.entries.map((e) => e.id));
  });

  it('never leaks another user’s ledger — a foreign balance id is a 404', async () => {
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
    const body = await (await get('/api/ledger', bob.cookie)).json<LedgerResponse>();
    // Bob's own balance holds only his opening deposit.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.kind).toBe('deposit_initial');

    // Naming ALEX's balance is BANKROLL_NOT_FOUND, not 403: a balance id must
    // not be an existence oracle (PLAN.md §11.4's rule, applied to balances).
    const alexBk = await mainBankrollId(env.DB, alex.id);
    const res = await get(`/api/ledger?bankrollId=${encodeURIComponent(alexBk)}`, bob.cookie);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('BANKROLL_NOT_FOUND');
    // ...and an id that exists nowhere gets the IDENTICAL answer.
    const missing = await get('/api/ledger?bankrollId=no-such-balance', bob.cookie);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('BANKROLL_NOT_FOUND');
  });
});

describe('GET /api/leaderboard', () => {
  it('requires auth', async () => {
    const res = await get('/api/leaderboard?league=nfl&season=2026');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('the league filter narrows the RECORD; the balance is the account either way', async () => {
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
    // 100000 - 1000 + 3000 - 50000 = 52000, on ONE balance.
    const expectedBalance = INITIAL_BANKROLL_CENTS - 1000 + 3000 - 50_000;

    const nfl = await (
      await get('/api/leaderboard?league=nfl', alex.cookie)
    ).json<LeaderboardResponse>();
    expect(nfl.league).toBe('nfl');
    // There is no `season` on the response at all: the product has no seasons.
    expect('season' in nfl).toBe(false);
    const nflRow = nfl.rows.find((r) => r.username === alex.name);
    expect(nflRow?.balanceCents).toBe(expectedBalance);
    expect(nflRow?.record).toEqual({ won: 1, lost: 0, push: 0, void: 0 });

    const cfb = await (
      await get('/api/leaderboard?league=ncaaf', alex.cookie)
    ).json<LeaderboardResponse>();
    const cfbRow = cfb.rows.find((r) => r.username === alex.name);
    // SAME balance under the other tab — that is the whole point of M5b.
    expect(cfbRow?.balanceCents).toBe(expectedBalance);
    expect(cfbRow?.record).toEqual({ won: 0, lost: 1, push: 0, void: 0 });

    const all = await (await get('/api/leaderboard', alex.cookie)).json<LeaderboardResponse>();
    expect(all.league).toBe('all');
    const allRow = all.rows.find((r) => r.username === alex.name);
    expect(allRow?.balanceCents).toBe(expectedBalance);
    expect(allRow?.record).toEqual({ won: 1, lost: 1, push: 0, void: 0 });
  });

  it('a ?season= a stale client still sends is IGNORED, not a 400', async () => {
    const alex = await register();
    const res = await get('/api/leaderboard?league=nfl&season=2026', alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<LeaderboardResponse>();
    expect(body.league).toBe('nfl');
    expect('season' in body).toBe(false);
  });

  it('ranks by EQUITY, so money riding on an open bet still counts', async () => {
    // The product owner's own example: "$2,000 with $1,500 tied up in a bet
    // should be ahead of someone with $600." Under the M5 balance ranking the
    // bettor was LAST; equity is what makes an open stake neither help nor hurt.
    const { season } = scope();
    const bettor = await register('zbettor'); // 'z' so username cannot save it
    const sitter = await register('asitter'); // 'a' so username cannot sink it

    // bettor: won 2000 on a 1000 stake, then put 1500 on tonight's game.
    //   balance = 100000 - 1000 + 2000 - 1500 = 99500   <- BELOW the sitter
    //   equity  = 99500 + 1500                = 101000  <- ABOVE the sitter
    await seedSettledBet(env.DB, {
      id: `eq-won-${String(season)}`,
      userId: bettor.id,
      season,
      status: 'won',
      stakeCents: 1000,
      payoutCents: 2000,
    });
    await seedSettledBet(env.DB, {
      id: `eq-open-${String(season)}`,
      userId: bettor.id,
      season,
      status: 'pending',
      stakeCents: 1500,
    });
    // sitter: nothing at all -> balance 100000, equity 100000.

    const body = await (await get('/api/leaderboard', bettor.cookie)).json<LeaderboardResponse>();
    const rows = body.rows.filter((r) => [bettor.name, sitter.name].includes(r.username));
    const b = rows.find((r) => r.username === bettor.name);
    const s = rows.find((r) => r.username === sitter.name);

    expect(b?.balanceCents).toBe(99_500);
    expect(b?.pendingStakeCents).toBe(1500);
    expect(b?.equityCents).toBe(101_000);
    expect(s?.balanceCents).toBe(100_000);
    expect(s?.equityCents).toBe(100_000);

    // THE DISCRIMINATING ASSERTION. Balance alone would put the bettor SECOND
    // (99,500 < 100,000) and the username tie-break would not rescue them
    // either ('zbettor' > 'asitter'). Only equity puts them first.
    expect(rows.map((r) => r.username)).toEqual([bettor.name, sitter.name]);
    expect((b?.rank ?? 0) < (s?.rank ?? 0)).toBe(true);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('breaks an equity+roi tie by username, ascending', async () => {
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
    const three = body.rows.filter((r) => [alex.name, bob.name, carol.name].includes(r.username));
    expect(three.map((r) => r.username)).toEqual([alex.name, bob.name, carol.name]);
    expect(three.map((r) => r.rank)).toEqual([...three].map((r) => r.rank).sort((a, b) => a - b));
  });

  it('a push leaves the ROI null, so username breaks the tie at equal balance', async () => {
    const { season } = scope();
    const alex = await register('alex');
    const bob = await register('bob');
    // bob has a settled PUSH, which is excluded from ROI entirely; alex has no
    // action at all. Both ROIs are null at the same balance.
    await seedSettledBet(env.DB, {
      id: `b-bob-${String(season)}`,
      userId: bob.id,
      season,
      status: 'push',
      stakeCents: 2000,
      payoutCents: 2000,
    });

    const body = await (
      await get(`/api/leaderboard?league=nfl&season=${String(season)}`, alex.cookie)
    ).json<LeaderboardResponse>();
    const pair = body.rows.filter((r) => [alex.name, bob.name].includes(r.username));
    expect(pair.map((r) => r.balanceCents)).toEqual([100_000, 100_000]);
    expect(pair.map((r) => r.roi)).toEqual([null, null]);
    expect(pair.map((r) => r.username)).toEqual([alex.name, bob.name]);
    // bob's push is in the record for the season it belongs to.
    const bobRow = pair.find((r) => r.username === bob.name);
    expect(bobRow?.record).toEqual({ won: 0, lost: 0, push: 1, void: 0 });
  });

  it('/all-time is an ALIAS of the unfiltered board, not a second query', async () => {
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
    const legacy = await (
      await get('/api/leaderboard/all-time', alex.cookie)
    ).json<LeaderboardResponse>();
    const current = await (await get('/api/leaderboard', alex.cookie)).json<LeaderboardResponse>();
    expect(legacy).toEqual(current);

    // 100000 + 2500 - 1000 (settled) - 4000 (open stake, already deducted).
    const row = legacy.rows.find((r) => r.username === alex.name);
    expect(row?.balanceCents).toBe(INITIAL_BANKROLL_CENTS + 2500 - 1000 - 4000);
    expect(row?.pendingStakeCents).toBe(4000);
    expect(row?.equityCents).toBe(INITIAL_BANKROLL_CENTS + 2500 - 1000);
    expect(row?.record).toEqual({ won: 1, lost: 0, push: 0, void: 0 });
  });

  it('ignores a CUSTOM balance: equity is main balance + MAIN pending only', async () => {
    const alex = await register('sidepot');
    const s = scope();
    const mainId = await mainBankrollId(env.DB, alex.id);

    // A future side pot (`kind='custom'`), funded through the real triggers so
    // `SUM(ledger) === balance_cents` still holds for it. v1 writes none of
    // these; the point is that the leaderboard is already correct when one
    // exists, rather than correct only because none does.
    const customId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         VALUES (?1, ?2, 'Bowl season', 'custom', 0, ?3, ?3)`,
      ).bind(customId, alex.id, Date.now()),
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'admin_adjust', ?1, NULL, 50000, ?3, 'side pot')`,
      ).bind(crypto.randomUUID(), customId, Date.now()),
    ]);

    // One OPEN bet on the main balance, and one on the side pot.
    const gid = s.gid(1);
    await seedGameWithLine(env.DB, { id: gid, season: s.season, kickoffAt: Date.now() + HOUR });
    await seedSettledBet(env.DB, {
      id: `main-open-${String(s.season)}`,
      userId: alex.id,
      season: s.season,
      status: 'pending',
      stakeCents: 3000,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                           stake_cents, american_price, potential_payout_cents, status,
                           placed_at, earliest_kickoff_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'nfl', ?4, 'straight', 1, 7000, -110, 13363, 'pending', ?5, ?5, ?5, ?5)`,
      ).bind(`custom-open-${String(s.season)}`, alex.id, customId, s.season, Date.now()),
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'bet_stake', ?3, ?3, -7000, ?4, 'side pot stake')`,
      ).bind(crypto.randomUUID(), customId, `custom-open-${String(s.season)}`, Date.now()),
    ]);

    const body = await (await get('/api/leaderboard', alex.cookie)).json<LeaderboardResponse>();
    const row = body.rows.find((r) => r.username === alex.name);

    // balanceCents is the MAIN row only — the 50,000¢ side pot is invisible.
    expect(row?.balanceCents).toBe(INITIAL_BANKROLL_CENTS - 3000);
    // ...and so is the 7,000¢ riding on it. Counting that stake here would add
    // money that was never deducted from balanceCents.
    expect(row?.pendingStakeCents).toBe(3000);
    expect(row?.equityCents).toBe(INITIAL_BANKROLL_CENTS);
    expect(row?.equityCents).toBe((row?.balanceCents ?? 0) + (row?.pendingStakeCents ?? 0));

    // Both balances still reconcile, so the fixture itself is honest.
    expect(await bankrollDrift(env.DB)).toEqual([]);
    expect(await balanceOf(env.DB, customId)).toBe(50000 - 7000);
    expect(await balanceOf(env.DB, mainId)).toBe(INITIAL_BANKROLL_CENTS - 3000);
  });
});

// ---------------------------------------------------------------------------
// M5b: POST /api/admin/users/:id/adjust
// ---------------------------------------------------------------------------

describe('POST /api/admin/users/:id/adjust', () => {
  function send(path: string, payload: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-SBS-Client': '1',
    };
    if (cookie !== undefined) headers['cookie'] = cookie;
    return Promise.resolve(
      buildApp().request(
        `${ORIGIN}${path}`,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        env,
      ),
    );
  }

  /** A signed-in admin. Promoted directly so the test does not depend on being
   *  the first signup in the file. */
  async function admin(): Promise<{ cookie: string; id: string }> {
    const user = await register('admin');
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?1').bind(user.id).run();
    return user;
  }

  async function balanceOfUser(userId: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT balance_cents AS b FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`,
    )
      .bind(userId)
      .first<{ b: number }>();
    return row?.b ?? -1;
  }

  it('credits and debits the target’s main balance through the ledger', async () => {
    const boss = await admin();
    const target = await register();

    expect(
      (
        await send(
          `/api/admin/users/${target.id}/adjust`,
          {
            amountCents: 5000,
            memo: 'bonus',
          },
          boss.cookie,
        )
      ).status,
    ).toBe(204);
    expect(await balanceOfUser(target.id)).toBe(INITIAL_BANKROLL_CENTS + 5000);

    expect(
      (
        await send(
          `/api/admin/users/${target.id}/adjust`,
          {
            amountCents: -2500,
          },
          boss.cookie,
        )
      ).status,
    ).toBe(204);
    expect(await balanceOfUser(target.id)).toBe(INITIAL_BANKROLL_CENTS + 2500);

    // The balance moved because a LEDGER row moved it — nothing UPDATEs it.
    const rows = await env.DB.prepare(
      `SELECT le.amount_cents AS amount, le.memo AS memo
         FROM ledger le JOIN bankrolls bk ON bk.id = le.bankroll_id
        WHERE bk.user_id = ?1 AND le.kind = 'admin_adjust'
        ORDER BY le.amount_cents DESC`,
    )
      .bind(target.id)
      .all<{ amount: number; memo: string | null }>();
    expect(rows.results.map((r) => r.amount)).toEqual([5000, -2500]);
    expect(rows.results[0]?.memo).toBe('bonus');
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('the same amount twice is TWO events, not an idempotent one', async () => {
    const boss = await admin();
    const target = await register();
    for (let i = 0; i < 2; i += 1) {
      expect(
        (
          await send(
            `/api/admin/users/${target.id}/adjust`,
            {
              amountCents: 100,
            },
            boss.cookie,
          )
        ).status,
      ).toBe(204);
    }
    expect(await balanceOfUser(target.id)).toBe(INITIAL_BANKROLL_CENTS + 200);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('an overdraft is 409 INSUFFICIENT_FUNDS from the TRIGGER, and moves nothing', async () => {
    const boss = await admin();
    const target = await register();
    const res = await send(
      `/api/admin/users/${target.id}/adjust`,
      { amountCents: -(INITIAL_BANKROLL_CENTS + 1) },
      boss.cookie,
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOfUser(target.id)).toBe(INITIAL_BANKROLL_CENTS);
    // Exactly to zero IS allowed — the guard is `< 0`, not `<= 0`.
    expect(
      (
        await send(
          `/api/admin/users/${target.id}/adjust`,
          {
            amountCents: -INITIAL_BANKROLL_CENTS,
          },
          boss.cookie,
        )
      ).status,
    ).toBe(204);
    expect(await balanceOfUser(target.id)).toBe(0);
    expect(await bankrollDrift(env.DB)).toEqual([]);
  });

  it('validates the amount and refuses a user with no balance', async () => {
    const boss = await admin();
    const target = await register();
    for (const amountCents of [0, 2.5, '100', null, 1e9]) {
      const res = await send(`/api/admin/users/${target.id}/adjust`, { amountCents }, boss.cookie);
      expect(res.status, JSON.stringify(amountCents)).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION');
    }
    const ghost = await send('/api/admin/users/nobody/adjust', { amountCents: 100 }, boss.cookie);
    expect(ghost.status).toBe(404);
    expect(await errorCode(ghost)).toBe('BANKROLL_NOT_FOUND');
  });

  it('is invisible to a non-admin (404) and to an anonymous caller (401)', async () => {
    const boss = await admin();
    const target = await register();
    const before = await balanceOfUser(target.id);

    const nonAdmin = await send(
      `/api/admin/users/${target.id}/adjust`,
      { amountCents: 100_000 },
      target.cookie,
    );
    expect(nonAdmin.status).toBe(404);
    const anon = await send(`/api/admin/users/${target.id}/adjust`, { amountCents: 100_000 });
    expect(anon.status).toBe(401);
    expect(await balanceOfUser(target.id)).toBe(before);
    // `boss` is only here to prove the route exists at all for an admin.
    expect(
      (
        await send(
          `/api/admin/users/${target.id}/adjust`,
          {
            amountCents: 1,
          },
          boss.cookie,
        )
      ).status,
    ).toBe(204);
  });
});
