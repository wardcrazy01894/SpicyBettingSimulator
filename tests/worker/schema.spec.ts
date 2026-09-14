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
      `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
       VALUES (?1, ?2, 'Main', 'main', 0, ?3, ?3)`,
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

  /**
   * `readD1Migrations('./migrations')` in vitest.workers.config.ts hands the pool
   * EVERY file in order, so this asserts 0002 applied ON TOP of 0001 — the same
   * thing `wrangler d1 migrations apply --remote` will do to the live database.
   */
  it('0002 added users.deleted_at as a nullable INTEGER, defaulting to NULL', async () => {
    const res = await env.DB.prepare('PRAGMA table_info(users)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const column = res.results.find((c) => c.name === 'deleted_at');
    expect(column).toBeDefined();
    expect(column?.type).toBe('INTEGER');
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();

    // A freshly inserted user is NOT deleted.
    await seedUserAndBankroll();
    const row = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?1')
      .bind(U)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });

  it('0003 created bug_reports with its two indexes', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(bug_reports)').all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    expect(cols.results.map((c) => c.name)).toEqual([
      'id',
      'user_id',
      'title',
      'description',
      'page',
      'user_agent',
      'app_version',
      'created_at',
      'issue_number',
      'issue_url',
      'error',
    ]);
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(byName.get('issue_number')).toMatchObject({ type: 'INTEGER', notnull: 0 });
    const idx = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bug_reports' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(idx.results.map((i) => i.name)).toEqual([
      'idx_bug_reports_created',
      'idx_bug_reports_user_created',
    ]);
  });

  it('bug_reports.user_id must reference an existing user', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO bug_reports (id, user_id, title, description, app_version, created_at)
         VALUES ('orphan', 'no-such-user', 't', 'd', 'test', 1)`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('seeds the three job_locks rows', async () => {
    const rows = await env.DB.prepare('SELECT name FROM job_locks ORDER BY name').all<{
      name: string;
    }>();
    expect(rows.results.map((r) => r.name)).toEqual(['maintenance', 'refresh', 'settle']);
  });

  it('bankrolls carry no league or season, and bets/bet_legs carry the teaser columns', async () => {
    const columns = async (table: string): Promise<string[]> => {
      const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      return res.results.map((r) => r.name);
    };
    const bankrolls = await columns('bankrolls');
    expect(bankrolls).toContain('name');
    expect(bankrolls).toContain('kind');
    // M5b: a balance is account-level. These two are what made it per-season.
    expect(bankrolls).not.toContain('league');
    expect(bankrolls).not.toContain('season');
    expect(await columns('bets')).toContain('teaser_points_tenths');
    expect(await columns('bet_legs')).toContain('original_line_tenths');
  });
});

// ---------------------------------------------------------------------------
// M5b's bet-shape CHECKs. Each one is the DB half of a rule the application
// also enforces, so a bug in `validatePlaceBet` cannot land a bet that grading
// would then have to guess about.
// ---------------------------------------------------------------------------

describe('bets CHECK constraints (M5b)', () => {
  beforeEach(seedUserAndBankroll);

  /** A `bets` row with everything defaulted, so each test varies one thing. */
  function insertBet(
    id: string,
    over: {
      league?: string;
      betType?: string;
      legCount?: number;
      teaserPointsTenths?: number | null;
    } = {},
  ): Promise<unknown> {
    return env.DB.prepare(
      `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                         stake_cents, american_price, potential_payout_cents, status,
                         placed_at, earliest_kickoff_at, teaser_points_tenths,
                         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 2026, ?5, ?6, 1000, -110, 1909, 'pending', ?7, ?7, ?8, ?7, ?7)`,
    )
      .bind(
        `${B}-${id}`,
        U,
        B,
        over.league ?? 'nfl',
        over.betType ?? 'straight',
        over.legCount ?? 1,
        NOW,
        over.teaserPointsTenths ?? null,
      )
      .run();
  }

  it("accepts league 'mixed' for a cross-league bet", async () => {
    await insertBet('mixed', { league: 'mixed', betType: 'parlay', legCount: 2 });
    await expect(insertBet('nba', { league: 'nba' })).rejects.toThrow(/CHECK constraint failed/);
  });

  it('a teaser needs a tier, and nothing else may carry one', async () => {
    await insertBet('t6', { betType: 'teaser', legCount: 3, teaserPointsTenths: 60 });
    await expect(insertBet('t-none', { betType: 'teaser', legCount: 3 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertBet('p-tier', { betType: 'parlay', legCount: 3, teaserPointsTenths: 60 }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertBet('s-tier', { betType: 'straight', teaserPointsTenths: 60 }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('only 60, 65 and 70 tenths are on the card', async () => {
    for (const [i, tier] of [60, 65, 70].entries()) {
      await insertBet(`ok${String(i)}`, {
        betType: 'teaser',
        legCount: 2,
        teaserPointsTenths: tier,
      });
    }
    for (const [i, tier] of [6, 55, 61, 75, 0].entries()) {
      await expect(
        insertBet(`bad${String(i)}`, {
          betType: 'teaser',
          legCount: 2,
          teaserPointsTenths: tier,
        }),
      ).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it('a straight is exactly one leg; a parlay OR A TEASER is two or more', async () => {
    await expect(insertBet('s2', { betType: 'straight', legCount: 2 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertBet('p1', { betType: 'parlay', legCount: 1 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    // The pre-M5b CHECK was `bet_type = 'parlay' OR leg_count = 1`, which would
    // have let this through the moment 'teaser' joined the enum.
    await expect(
      insertBet('t1', { betType: 'teaser', legCount: 1, teaserPointsTenths: 60 }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe('ledger invariants (DB-enforced)', () => {
  beforeEach(seedUserAndBankroll);

  it('a ledger insert moves the balance through the AFTER INSERT trigger', async () => {
    expect(await balance()).toBe(100000);
    expect(await ledgerSum()).toBe(100000);
    await ledgerInsert('INSERT', 'l-s1', B, -2500).run();
    expect(await balance()).toBe(97500);
    expect(await ledgerSum()).toBe(97500);
  });

  it('a direct UPDATE of balance_cents that breaks SUM(ledger) = balance is rejected', async () => {
    await expect(
      env.DB.prepare('UPDATE bankrolls SET balance_cents = 999999999 WHERE id = ?1').bind(B).run(),
    ).rejects.toThrow(/balance_cents may only be written by the ledger trigger/);
    expect(await balance()).toBe(100000);
    // Writing the SAME value (identity preserved) and touching other columns is fine.
    await env.DB.prepare(
      'UPDATE bankrolls SET balance_cents = 100000, updated_at = 1 WHERE id = ?1',
    )
      .bind(B)
      .run();
    expect(await balance()).toBe(100000);
  });

  it('the M5b ensureMainBalance repair path is idempotent against a funded row', async () => {
    // Both statements are guarded `INSERT … SELECT … WHERE (NOT) EXISTS`, so a
    // second run matches zero rows everywhere instead of opening a second main
    // balance or landing a second deposit. The `bankrolls` BEFORE INSERT guard
    // must also tolerate the 0-balance insert that is about to match nothing.
    const ensure = () =>
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
           SELECT ?1, ?2, 'Main', 'main', 0, ?3, ?3
            WHERE NOT EXISTS (SELECT 1 FROM bankrolls WHERE user_id = ?2 AND kind = 'main')`,
        ).bind(`${B}-repair`, U, NOW),
        env.DB.prepare(
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
           SELECT ?1, ?2, 'deposit_initial', 'init', 100000, ?3
            WHERE EXISTS (SELECT 1 FROM bankrolls WHERE id = ?2)
              AND NOT EXISTS (SELECT 1 FROM ledger
                               WHERE bankroll_id = ?2 AND kind = 'deposit_initial')`,
        ).bind(`${B}-dep2`, B, NOW),
      ]);
    await ensure();
    await ensure();
    expect(await balance()).toBe(100000);
    expect(await ledgerSum()).toBe(100000);
    // ...and no second balance was opened.
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`,
    )
      .bind(U)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('a balance cannot be INSERTed with a non-zero opening balance', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         VALUES (?1, ?2, 'Side', 'custom', 5, ?3, ?3)`,
      )
        .bind(`${B}-x`, U, NOW)
        .run(),
    ).rejects.toThrow(/balance_cents may only be written by the ledger trigger/);
  });

  it('a user may hold only ONE main balance (partial unique index)', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         VALUES (?1, ?2, 'Main 2', 'main', 0, ?3, ?3)`,
      )
        .bind(`${B}-main2`, U, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // ...but any number of `custom` side pots, which the index deliberately
    // does not cover. (Nothing in v1 creates one; the schema models the list.)
    await env.DB.prepare(
      `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
       VALUES (?1, ?2, 'Bowls', 'custom', 0, ?3, ?3)`,
    )
      .bind(`${B}-side`, U, NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
       VALUES (?1, ?2, 'Playoffs', 'custom', 0, ?3, ?3)`,
    )
      .bind(`${B}-side2`, U, NOW)
      .run();
    // A name is still unique per user, whatever the kind.
    await expect(
      env.DB.prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         VALUES (?1, ?2, 'Bowls', 'custom', 0, ?3, ?3)`,
      )
        .bind(`${B}-side3`, U, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
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
    // NEGATIVE amount + OR REPLACE against an unknown bankroll must still be the
    // orphan message, never "insufficient funds" (the WHEN clauses are exclusive).
    await expect(ledgerInsert('INSERT OR REPLACE', 'l-ghost3', 'nope', -500).run()).rejects.toThrow(
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
