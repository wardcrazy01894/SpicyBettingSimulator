/**
 * Migration 0011 rebuilds `ledger` (a LEAF table) to admit two new kinds,
 * `deposit_refill` and `bust_buyout` (PLAN.md §4.5 / §16.2). This proves the
 * rebuild is lossless against a populated database and that the five ledger
 * triggers come back — in particular that `ledger_ai_apply` did not fire
 * during the copy-back and double every balance.
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0011. As in migration-0008/0010.spec.ts the rebuild is
 * exercised by seeding a money history through the real triggers and HTTP and
 * RE-RUNNING 0011's statements as ONE batch, exactly how
 * `wrangler d1 migrations apply` runs a file. Textual equivalence of the DDL
 * with 0010 is tests/unit/migration-0011-ddl.spec.ts.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/worker/index.js';
import { seedGameWithLine, seedSettledBet } from './seed.js';

const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;

let seq = 0;
async function register(): Promise<{ cookie: string; id: string }> {
  seq += 1;
  const res = await buildApp().request(
    'https://example.com/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
      body: JSON.stringify({
        username: `rebuild11${String(seq)}`,
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

async function placeOverHttp(cookie: string, body: unknown): Promise<void> {
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
}

async function rerun0011(): Promise<void> {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith('0011_'));
  if (m === undefined) throw new Error('0011 not in TEST_MIGRATIONS');
  await env.DB.batch(m.queries.map((q) => env.DB.prepare(q)));
}

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).all()).results;
}

async function snapshot(): Promise<Record<string, unknown>> {
  return {
    ledger: await all('SELECT * FROM ledger ORDER BY id'),
    'ledger:columns': await all('PRAGMA table_info(ledger)'),
    bankrolls: await all('SELECT * FROM bankrolls ORDER BY id'),
    bets: await all('SELECT * FROM bets ORDER BY id'),
    objects: await all(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE '_cf_%' ORDER BY type, name`,
    ),
  };
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

async function mainId(userId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`)
    .bind(userId)
    .first<{ id: string }>();
  if (row === null) throw new Error('no main balance');
  return row.id;
}

/** Won/lost/pending bets plus one of each NEW kind, so the copy carries them too. */
async function seedHistory(): Promise<{ userId: string; cookie: string; gameId: string }> {
  const alex = await register();
  const s = String(seq);
  await seedSettledBet(env.DB, {
    id: `r11-won-${s}`,
    userId: alex.id,
    status: 'won',
    stakeCents: 2500,
    payoutCents: 4772,
  });
  await seedSettledBet(env.DB, {
    id: `r11-lost-${s}`,
    userId: alex.id,
    status: 'lost',
    stakeCents: 1000,
    payoutCents: 0,
  });
  const gameId = await seedGameWithLine(env.DB, {
    id: `nfl:rb11-${s}`,
    kickoffAt: Date.now() + 2 * HOUR,
  });
  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'straight',
    stakeCents: 300,
    legs: [{ gameId, market: 'moneyline', side: 'home' }],
  });
  const bk = await mainId(alex.id);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       VALUES (?1, ?2, 'deposit_refill', ?1, NULL, 100000, ?3, 'refill')`,
    ).bind(`r11-refill-${s}`, bk, now),
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       VALUES (?1, ?2, 'bust_buyout', ?3, NULL, -100000, ?4, 'buyout')`,
    ).bind(`r11-buyout-${s}`, bk, `r11-refill-${s}`, now + 1),
  ]);
  return { userId: alex.id, cookie: alex.cookie, gameId };
}

describe('migration 0011 (ledger kinds deposit_refill, bust_buyout)', () => {
  it('re-running the rebuild on a populated database changes nothing', async () => {
    await seedHistory();
    expect(await balanceDrift()).toBe(0);
    const before = await snapshot();
    await rerun0011();
    expect(await snapshot()).toEqual(before);
    expect(await balanceDrift()).toBe(0);
  });

  it('ledger_ai_apply fires exactly once per row after the rebuild (no doubled balance)', async () => {
    const { userId, cookie, gameId } = await seedHistory();
    const balance = await balanceOf(userId);
    await rerun0011();
    expect(await balanceOf(userId)).toBe(balance);
    await placeOverHttp(cookie, {
      league: 'nfl',
      betType: 'straight',
      stakeCents: 700,
      legs: [{ gameId, market: 'total', side: 'over' }],
    });
    expect(await balanceOf(userId)).toBe(balance - 700);
    expect(await balanceDrift()).toBe(0);
  });

  it('admits the two new kinds, refuses an unknown one, and keeps the ledger append-only', async () => {
    const { userId } = await seedHistory();
    await rerun0011();
    const bk = await mainId(userId);
    const insert = (id: string, kind: string, amount: number) =>
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, ?3, ?1, NULL, ?4, 1, NULL)`,
      )
        .bind(id, bk, kind, amount)
        .run();
    const s = String(seq);
    await insert(`k-refill-${s}`, 'deposit_refill', 5000);
    await insert(`k-buyout-${s}`, 'bust_buyout', -5000);
    await expect(insert(`k-bad-${s}`, 'rebuy', 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(`UPDATE ledger SET memo = 'x' WHERE id = ?1`).bind(`k-refill-${s}`).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare(`DELETE FROM ledger WHERE id = ?1`).bind(`k-refill-${s}`).run(),
    ).rejects.toThrow(/append-only/);
    // A second buyout naming the same refill collides on UNIQUE (bankroll_id, kind, ref_id).
    await expect(
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'bust_buyout', ?3, NULL, -1, 1, NULL)`,
      )
        .bind(`k-dup-${s}`, bk, `k-buyout-${s}`)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await balanceDrift()).toBe(0);
  });
});
