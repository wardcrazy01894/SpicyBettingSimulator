/**
 * Migration 0005 rebuilds `bets`, `bet_legs` and `ledger` (the only way to
 * widen a CHECK on D1 — PLAN.md §16.2). This proves the rebuild is lossless
 * against a populated database with the real triggers on.
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0005. The rebuild is therefore exercised by seeding a
 * full money history through the real triggers and RE-RUNNING 0005's
 * statements on top of it — the statements do not care which CHECK the source
 * table carried, so this is the same copy-drop-recreate-copy-back path the
 * remote database goes through, on the same engine.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { TEASER_POINTS_TENTHS } from '../../src/shared/constants.js';
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
        username: `rebuild${String(seq)}`,
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

interface Snapshot {
  readonly bets: readonly Record<string, unknown>[];
  readonly legs: readonly Record<string, unknown>[];
  readonly ledger: readonly Record<string, unknown>[];
  readonly bankrolls: readonly Record<string, unknown>[];
}

async function snapshot(): Promise<Snapshot> {
  const all = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await env.DB.prepare(sql).all()).results;
  return {
    bets: await all('SELECT * FROM bets ORDER BY id'),
    legs: await all('SELECT * FROM bet_legs ORDER BY id'),
    ledger: await all('SELECT * FROM ledger ORDER BY id'),
    bankrolls: await all('SELECT id, balance_cents FROM bankrolls ORDER BY id'),
  };
}

/**
 * 0005's statements FOLLOWED BY 0008's and 0009's. 0008 (same-game parlays)
 * rebuilds `bet_legs` again on top of 0005's DDL — a wider UNIQUE and a new
 * trigger — and 0009 (MLB, PLAN.md §23.3) rebuilds six tables to widen the
 * `league` CHECKs, so re-running 0005 alone on a post-0009 database would put
 * pre-MLB DDL back. The remote went through all three files in order; so does
 * this. (0005 cannot be re-run on a database holding a same-game parlay — its
 * `bet_legs` has the old UNIQUE(bet_id, game_id) — and this spec seeds none.)
 */
function rebuildStatements(): readonly string[] {
  const pick = (prefix: string): readonly string[] => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix));
    if (m === undefined) throw new Error(`${prefix} not in TEST_MIGRATIONS`);
    return m.queries;
  };
  return [...pick('0005_'), ...pick('0008_'), ...pick('0009_')];
}

async function schemaNames(type: 'trigger' | 'index' | 'table'): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
    .bind(type)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

describe('migration 0005 (bets rebuild)', () => {
  it('re-running the rebuild on a populated database changes nothing but the CHECK', async () => {
    // A money history that goes through every trigger: signup deposit, a won
    // bet, a lost bet, a pending teaser placed over HTTP (stake ledger row +
    // legs), so bets, bet_legs and ledger all have rows referencing each other.
    const alex = await register();
    await seedSettledBet(env.DB, {
      id: 'r-won',
      userId: alex.id,
      status: 'won',
      stakeCents: 2500,
      payoutCents: 4772,
    });
    await seedSettledBet(env.DB, {
      id: 'r-lost',
      userId: alex.id,
      status: 'lost',
      stakeCents: 1000,
      payoutCents: 0,
    });
    const now = Date.now();
    const a = await seedGameWithLine(env.DB, { id: 'nfl:rb-a', kickoffAt: now + 2 * HOUR });
    const b = await seedGameWithLine(env.DB, { id: 'nfl:rb-b', kickoffAt: now + 2 * HOUR });
    const placed = await buildApp().request(
      'https://example.com/api/bets',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-SBS-Client': '1', cookie: alex.cookie },
        body: JSON.stringify({
          league: 'nfl',
          betType: 'teaser',
          teaserPoints: 60,
          stakeCents: 500,
          legs: [
            { gameId: a, market: 'spread', side: 'home' },
            { gameId: b, market: 'spread', side: 'home' },
          ],
        }),
      },
      env,
    );
    expect(placed.status, await placed.clone().text()).toBe(201);

    const before = await snapshot();
    expect(before.bets.length).toBeGreaterThanOrEqual(3);
    expect(before.legs.length).toBeGreaterThanOrEqual(2);
    expect(before.ledger.length).toBeGreaterThanOrEqual(4);
    const triggersBefore = await schemaNames('trigger');
    const indexesBefore = await schemaNames('index');
    const tablesBefore = await schemaNames('table');

    // THE REBUILD, as one atomic batch — exactly how `wrangler d1 migrations
    // apply` runs the file.
    await env.DB.batch(rebuildStatements().map((q) => env.DB.prepare(q)));

    // Every row, every column, every value — and every balance — survives.
    const after = await snapshot();
    expect(after).toEqual(before);
    // The invariant the ledger triggers exist to keep.
    const drift = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bankrolls b
        WHERE b.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE bankroll_id = b.id)`,
    ).first<{ n: number }>();
    expect(drift?.n).toBe(0);
    // Triggers, indexes and tables come back by the same names; no temp table is left.
    expect(await schemaNames('trigger')).toEqual(triggersBefore);
    expect(await schemaNames('index')).toEqual(indexesBefore);
    expect(await schemaNames('table')).toEqual(tablesBefore);
    expect(tablesBefore.some((t) => t.endsWith('_copy'))).toBe(false);
  });

  it('the recreated ledger is still append-only and still moves the balance', async () => {
    const alex = await register();
    const bankroll = await env.DB.prepare(
      "SELECT id, balance_cents FROM bankrolls WHERE user_id = ?1 AND kind = 'main'",
    )
      .bind(alex.id)
      .first<{ id: string; balance_cents: number }>();
    if (bankroll === null) throw new Error('no main bankroll');
    await env.DB.batch(rebuildStatements().map((q) => env.DB.prepare(q)));

    // ledger_ai_apply: an insert moves the balance.
    await env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at, memo)
       VALUES ('adj-1', ?1, 'admin_adjust', 'adj-1', -700, ?2, 'rebuild test')`,
    )
      .bind(bankroll.id, Date.now())
      .run();
    const moved = await env.DB.prepare('SELECT balance_cents FROM bankrolls WHERE id = ?1')
      .bind(bankroll.id)
      .first<{ balance_cents: number }>();
    expect(moved?.balance_cents).toBe(bankroll.balance_cents - 700);
    // ledger_bi_sufficient_funds: an overdraft is refused.
    await expect(
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
         VALUES ('adj-2', ?1, 'admin_adjust', 'adj-2', -999999999, ?2)`,
      )
        .bind(bankroll.id, Date.now())
        .run(),
    ).rejects.toThrow(/insufficient funds/);
    // ledger_bu_block / ledger_bd_block: append-only.
    await expect(
      env.DB.prepare("UPDATE ledger SET memo = 'x' WHERE id = 'adj-1'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM ledger WHERE id = 'adj-1'").run()).rejects.toThrow(
      /append-only/,
    );
    // ledger_bi_bankroll_exists: an orphan is refused with its own message.
    await expect(
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
         VALUES ('adj-3', 'no-such-bankroll', 'admin_adjust', 'adj-3', 1, 1)`,
      ).run(),
    ).rejects.toThrow(/unknown bankroll_id/);
  });

  it('bets accepts every offered tier and refuses off-grid values', async () => {
    const alex = await register();
    const bankroll = await env.DB.prepare(
      "SELECT id FROM bankrolls WHERE user_id = ?1 AND kind = 'main'",
    )
      .bind(alex.id)
      .first<{ id: string }>();
    const insert = (id: string, tier: number): Promise<unknown> =>
      env.DB.prepare(
        `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                           teaser_points_tenths, stake_cents, american_price, potential_payout_cents,
                           status, placed_at, earliest_kickoff_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'nfl', 2026, 'teaser', 2, ?4, 100, 100, 200, 'pending', 1, 2, 1, 1)`,
      )
        .bind(id, alex.id, bankroll?.id ?? '', tier)
        .run();
    for (const tier of TEASER_POINTS_TENTHS) await insert(`t-${String(tier)}`, tier);
    // Multiples of 5 in [30, 140] are what the CHECK allows — one more than we
    // offer today, so a half-point tier is a constants change, not a rebuild.
    await insert('t-half', 95);
    for (const bad of [25, 145, 33, 6, 65.5, 0, -60]) {
      await expect(insert(`bad-${String(bad)}`, bad), String(bad)).rejects.toThrow(
        /CHECK constraint failed/,
      );
    }
  });
});
