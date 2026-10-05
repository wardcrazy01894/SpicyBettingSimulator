/**
 * Migration 0010 widens `bets.leg_count`'s CHECK from 1..10 to 1..25
 * (MAX_PARLAY_LEGS) and adds a table CHECK holding a teaser to
 * MAX_TEASER_LEGS (10). D1 cannot alter a CHECK, so it is a CHILDREN-FIRST
 * rebuild of ledger → bet_legs → bets, the 0005 pattern (PLAN.md §16.2).
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0010. As in migration-0005/0009.spec.ts the rebuild is
 * exercised by seeding a money history through the real triggers and HTTP and
 * RE-RUNNING 0010's statements as ONE batch, exactly how
 * `wrangler d1 migrations apply` runs a file. Textual equivalence of the DDL
 * with 0009 is tests/unit/migration-0010-ddl.spec.ts.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/worker/index.js';
import { seedGameWithLine, seedSettledBet } from './seed.js';

const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;
const TABLES = { bets: 'id', bet_legs: 'id', ledger: 'id' } as const;

let seq = 0;
async function register(): Promise<{ cookie: string; id: string }> {
  seq += 1;
  const res = await buildApp().request(
    'https://example.com/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
      body: JSON.stringify({
        username: `rebuild10${String(seq)}`,
        dk: 'a'.repeat(64),
        inviteCode: INVITE,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const { user } = await res.json<{ user: { id: string } }>();
  return {
    cookie: /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '',
    id: user.id,
  };
}

async function placeOverHttp(cookie: string, body: unknown): Promise<string> {
  const res = await buildApp().request(
    'https://example.com/api/bets',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1', cookie },
      body: JSON.stringify(body),
    },
    env,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const { bet } = await res.json<{ bet: { id: string } }>();
  return bet.id;
}

/**
 * Re-run 0010 COMPOSED FORWARD with 0011, which rebuilds `ledger` once more
 * (the refill/buyout kinds). 0010 alone would put the five-kind CHECK back and
 * every later comparison in this shared database would be against 0010's DDL
 * rather than the live schema — the same reason migration-0009.spec.ts runs
 * 0010 on top of 0009.
 */
async function rerun0010(): Promise<void> {
  const queries = ['0010_', '0011_'].flatMap((prefix) => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix));
    if (m === undefined) throw new Error(`${prefix} not in TEST_MIGRATIONS`);
    return m.queries;
  });
  await env.DB.batch(queries.map((q) => env.DB.prepare(q)));
}

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).all()).results;
}

async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [t, order] of Object.entries(TABLES)) {
    out[t] = await all(`SELECT * FROM ${t} ORDER BY ${order}`);
    out[`${t}:columns`] = await all(`PRAGMA table_info(${t})`);
  }
  out['bankrolls'] = await all('SELECT * FROM bankrolls ORDER BY id');
  out['objects'] = await all(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE '_cf_%' ORDER BY type, name`,
  );
  return out;
}

async function balanceDrift(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bankrolls b
      WHERE b.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE bankroll_id = b.id)`,
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT balance_cents FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`,
  )
    .bind(userId)
    .first<{ balance_cents: number }>();
  return row?.balance_cents ?? -1;
}

/**
 * Settled won/lost bets, a pending 25-leg parlay (only legal AFTER 0010), a
 * 10-leg teaser and a same-game parlay — so bets, bet_legs and ledger all hold
 * rows referencing each other, including the shapes the new CHECKs bound.
 */
async function seedHistory(): Promise<{ userId: string; cookie: string; games: string[] }> {
  const alex = await register();
  const s = String(seq);
  await seedSettledBet(env.DB, {
    id: `r10-won-${s}`,
    userId: alex.id,
    status: 'won',
    stakeCents: 2500,
    payoutCents: 4772,
  });
  await seedSettledBet(env.DB, {
    id: `r10-lost-${s}`,
    userId: alex.id,
    status: 'lost',
    stakeCents: 1000,
    payoutCents: 0,
  });
  const now = Date.now();
  const games: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    games.push(
      await seedGameWithLine(env.DB, {
        id: `nfl:rb10-${s}-${String(i)}`,
        kickoffAt: now + 2 * HOUR,
      }),
    );
  }
  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'parlay',
    stakeCents: 100,
    legs: games.slice(0, 25).map((gameId) => ({ gameId, market: 'moneyline', side: 'home' })),
  });
  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'teaser',
    teaserPoints: 60,
    stakeCents: 500,
    legs: games.slice(0, 10).map((gameId) => ({ gameId, market: 'spread', side: 'home' })),
  });
  const sg = games[25] ?? '';
  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'parlay',
    stakeCents: 300,
    legs: [
      { gameId: sg, market: 'spread', side: 'home' },
      { gameId: sg, market: 'total', side: 'over' },
    ],
  });
  return { userId: alex.id, cookie: alex.cookie, games };
}

describe('migration 0010 (leg_count 1..25; teasers 2..10)', () => {
  it('re-running the rebuild on a populated database changes nothing', async () => {
    await seedHistory();
    expect(await balanceDrift()).toBe(0);
    const before = await snapshot();
    await rerun0010();
    expect(await snapshot()).toEqual(before);
    expect(await balanceDrift()).toBe(0);
  });

  it('ledger_ai_apply fires exactly once per row after the rebuild (no doubled balance)', async () => {
    const { userId, cookie, games } = await seedHistory();
    const balance = await balanceOf(userId);
    await rerun0010();
    // The copy-back must not have re-applied any ledger row.
    expect(await balanceOf(userId)).toBe(balance);
    await placeOverHttp(cookie, {
      league: 'nfl',
      betType: 'parlay',
      stakeCents: 700,
      legs: games.slice(0, 3).map((gameId) => ({ gameId, market: 'moneyline', side: 'home' })),
    });
    expect(await balanceOf(userId)).toBe(balance - 700);
    expect(await balanceDrift()).toBe(0);
  });

  it('bets.leg_count admits 25 and refuses 26; a teaser stops at 10', async () => {
    const { userId } = await seedHistory();
    await rerun0010();
    const bk = await env.DB.prepare(`SELECT id FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`)
      .bind(userId)
      .first<{ id: string }>();
    const insert = (id: string, betType: string, legs: number, points: number | null) =>
      env.DB.prepare(
        `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                           teaser_points_tenths, stake_cents, american_price,
                           potential_payout_cents, status, placed_at, earliest_kickoff_at,
                           created_at, updated_at)
         VALUES (?1, ?2, ?3, 'nfl', 2026, ?4, ?5, ?6, 100, 100, 200, 'pending', 1, 1, 1, 1)`,
      )
        .bind(id, userId, bk?.id, betType, legs, points)
        .run();
    const CHECK = /CHECK constraint failed/;

    await insert('p25', 'parlay', 25, null);
    await expect(insert('p26', 'parlay', 26, null)).rejects.toThrow(CHECK);
    await insert('t10', 'teaser', 10, 60);
    await expect(insert('t11', 'teaser', 11, 60)).rejects.toThrow(CHECK);
    // The pre-existing shape CHECKs survive.
    await expect(insert('s2', 'straight', 2, null)).rejects.toThrow(CHECK);
    await expect(insert('p1', 'parlay', 1, null)).rejects.toThrow(CHECK);
    await expect(insert('p0', 'parlay', 0, null)).rejects.toThrow(CHECK);
  });
});
