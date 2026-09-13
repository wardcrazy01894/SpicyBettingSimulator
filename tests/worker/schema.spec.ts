import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The money invariants live in migrations/0001_init.sql, not in application
 * code (PLAN.md §4). These tests pin, against a REAL D1, every behaviour the
 * adversarial review verified in sqlite3 — so a future "harmless" edit to a
 * trigger (or a D1 engine change) fails loudly here.
 */

const NOW = 1_757_700_000_000;

/**
 * Each test gets its own user + bankroll (unique ids), so the suite does not
 * depend on per-test storage rollback — the ledger is append-only by design,
 * so there is no "clean up" path other than fresh rows.
 */
let seq = 0;
let B = 'b0';
let U = 'u0';

async function seedUserAndBankroll(): Promise<void> {
  seq += 1;
  U = `u${String(seq)}`;
  B = `b${String(seq)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, display_name, client_iterations, server_salt,
                          server_iterations, password_hash, created_at, updated_at)
       VALUES (?1, ?2, 'Alex', 210000, X'00', 1000, X'00', ?3, ?3)`,
    ).bind(U, `alex${String(seq)}`, NOW),
    env.DB.prepare(
      `INSERT INTO bankrolls (id, user_id, league, season, balance_cents, created_at, updated_at)
       VALUES (?1, ?2, 'nfl', 2026, 0, ?3, ?3)`,
    ).bind(B, U, NOW),
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
       VALUES (?1, ?2, 'deposit_initial', ?2, 100000, ?3)`,
    ).bind(`${B}-dep`, B, NOW),
  ]);
}

async function balance(): Promise<number> {
  const row = await env.DB.prepare('SELECT balance_cents AS b FROM bankrolls WHERE id = ?1')
    .bind(B)
    .first<{ b: number }>();
  return row?.b ?? -1;
}

async function ledgerSum(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ledger WHERE bankroll_id = ?1',
  )
    .bind(B)
    .first<{ s: number }>();
  return row?.s ?? -1;
}

function ledgerInsert(verb: string, id: string, bankrollId: string, amount: number) {
  return env.DB.prepare(
    `${verb} INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
     VALUES (?1, ?2, 'bet_stake', ?1, ?3, ?4)`,
  ).bind(`${B}-${id}`, bankrollId, amount, NOW);
}

async function ledgerCount(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger WHERE id = ?1')
    .bind(`${B}-${id}`)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

describe('migration 0001', () => {
  it('applies: every table and trigger exists', async () => {
    const rows = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name`,
    ).all<{ type: string; name: string }>();
    const names = rows.results.map((r) => `${r.type}:${r.name}`);
    for (const t of [
      'users',
      'sessions',
      'auth_throttle',
      'games',
      'game_lines',
      'bankrolls',
      'bets',
      'bet_legs',
      'ledger',
      'ingest_targets',
      'job_locks',
      'job_runs',
    ]) {
      expect(names).toContain(`table:${t}`);
    }
    for (const trg of [
      'ledger_bi_bankroll_exists',
      'ledger_bi_sufficient_funds',
      'ledger_ai_apply',
      'ledger_bu_block',
      'ledger_bd_block',
    ]) {
      expect(names).toContain(`trigger:${trg}`);
    }
  });

  it('seeds the three job_locks rows', async () => {
    const rows = await env.DB.prepare('SELECT name FROM job_locks ORDER BY name').all<{
      name: string;
    }>();
    expect(rows.results.map((r) => r.name)).toEqual(['maintenance', 'refresh', 'settle']);
  });
});

describe('ledger invariants (DB-enforced)', () => {
  beforeEach(seedUserAndBankroll);

  it('the AFTER INSERT trigger is the only writer of balance_cents', async () => {
    expect(await balance()).toBe(100000);
    expect(await ledgerSum()).toBe(100000);
    await ledgerInsert('INSERT', 'l-s1', B, -2500).run();
    expect(await balance()).toBe(97500);
    expect(await ledgerSum()).toBe(97500);
  });

  it('an overdraft aborts with "ledger: insufficient funds" and changes nothing', async () => {
    await expect(ledgerInsert('INSERT', 'l-over', B, -100001).run()).rejects.toThrow(
      /ledger: insufficient funds/,
    );
    expect(await balance()).toBe(100000);
    expect(await ledgerSum()).toBe(100000);
  });

  it('an exact-to-zero stake is allowed', async () => {
    await ledgerInsert('INSERT', 'l-all', B, -100000).run();
    expect(await balance()).toBe(0);
  });

  it('INSERT OR IGNORE cannot smuggle an overdraft past the guard', async () => {
    // The round-1 review showed that OR IGNORE suppresses a CHECK raised from the
    // AFTER trigger, leaving a ledger row with no balance effect. The BEFORE
    // INSERT RAISE(ABORT) guard is what closes that hole.
    await expect(ledgerInsert('INSERT OR IGNORE', 'l-oi', B, -9999999).run()).rejects.toThrow(
      /ledger: insufficient funds/,
    );
    expect(await ledgerCount('l-oi')).toBe(0);
    expect(await ledgerSum()).toBe(await balance());
  });

  it('INSERT OR REPLACE cannot smuggle an overdraft past the guard either', async () => {
    await expect(ledgerInsert('INSERT OR REPLACE', 'l-or', B, -9999999).run()).rejects.toThrow(
      /ledger: insufficient funds/,
    );
    expect(await ledgerSum()).toBe(await balance());
  });

  it('a row for an unknown bankroll aborts with a DISTINCT message (even a positive amount)', async () => {
    await expect(ledgerInsert('INSERT', 'l-ghost', 'nope', 500).run()).rejects.toThrow(
      /ledger: unknown bankroll_id/,
    );
    await expect(ledgerInsert('INSERT OR IGNORE', 'l-ghost2', 'nope', 500).run()).rejects.toThrow(
      /ledger: unknown bankroll_id/,
    );
  });

  it('the ledger is append-only: UPDATE and DELETE are blocked', async () => {
    await expect(
      env.DB.prepare(`UPDATE ledger SET amount_cents = 1 WHERE id = ?1`).bind(`${B}-dep`).run(),
    ).rejects.toThrow(/append-only/i);
    await expect(
      env.DB.prepare(`DELETE FROM ledger WHERE id = ?1`).bind(`${B}-dep`).run(),
    ).rejects.toThrow(/append-only/i);
    expect(await balance()).toBe(100000);
  });

  it('UNIQUE (bankroll_id, kind, ref_id) makes a double payout impossible', async () => {
    const payout = (id: string) =>
      env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
         VALUES (?1, ?2, 'bet_payout', 'bet-1', 4772, ?3)`,
      ).bind(`${B}-${id}`, B, NOW);
    await payout('l-p1').run();
    await expect(payout('l-p2').run()).rejects.toThrow(/UNIQUE/);
    expect(await balance()).toBe(104772);
    expect(await ledgerSum()).toBe(104772);
  });

  it('a failing statement rolls back the whole batch()', async () => {
    await expect(
      env.DB.batch([
        ledgerInsert('INSERT', 'l-ok', B, -1000),
        ledgerInsert('INSERT', 'l-bad', B, -999999),
      ]),
    ).rejects.toThrow(/ledger: insufficient funds/);
    expect(await ledgerCount('l-ok')).toBe(0);
    expect(await balance()).toBe(100000);
  });
});
