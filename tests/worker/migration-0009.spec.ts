/**
 * Migration 0009 widens `CHECK (league IN (...))` on `games`, `bets`,
 * `bet_legs` and `ingest_targets` to admit `'mlb'` (PLAN.md §23.3). D1 cannot
 * alter a CHECK, so it is a CHILDREN-FIRST rebuild of six tables in the style
 * of 0005: ledger → bet_legs → bets → game_lines → games, plus ingest_targets.
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0009. The rebuild is exercised the way
 * migration-0005.spec.ts exercises 0005: seed a full history through the real
 * triggers and HTTP, RE-RUN 0009's statements as ONE batch (exactly how
 * `wrangler d1 migrations apply` runs a file) and compare everything —
 * rows, balances, columns, and the `sqlite_master.sql` of every object.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LINE_PROVIDER_SECONDARY } from '../../src/shared/constants.js';
import { buildApp } from '../../src/worker/index.js';
import { seedGameWithLine, seedLine, seedSettledBet } from './seed.js';

const INVITE = 'test-invite';
const HOUR = 60 * 60 * 1000;

/** The six tables 0009 rebuilds, each with the ORDER BY that makes a dump stable. */
const REBUILT = {
  games: 'id',
  game_lines: 'game_id, provider',
  bets: 'id',
  bet_legs: 'id',
  ledger: 'id',
  ingest_targets: 'id',
} as const;
type Rebuilt = keyof typeof REBUILT;
const REBUILT_TABLES = Object.keys(REBUILT) as Rebuilt[];

/** EVERY trigger in the database after 0001–0009 — sorted, so compared with toEqual. */
const TRIGGERS = [
  'bankrolls_bi_balance_guard',
  'bankrolls_bu_balance_guard',
  'bet_legs_bi_one_side_per_game',
  'ledger_ai_apply',
  'ledger_bd_block',
  'ledger_bi_bankroll_exists',
  'ledger_bi_sufficient_funds',
  'ledger_bu_block',
] as const;

/** Every explicit (non-autoindex) index on the six rebuilt tables — sorted. */
const INDEXES = [
  'idx_bet_legs_bet',
  'idx_bet_legs_game',
  'idx_bets_bankroll',
  'idx_bets_pending',
  'idx_bets_user',
  'idx_games_board',
  'idx_games_status',
  'idx_games_week',
  'idx_ingest_targets_due',
  'idx_ledger_bankroll',
  'idx_ledger_bet',
  'idx_ledger_sum',
] as const;

let seq = 0;
async function register(): Promise<{ cookie: string; id: string }> {
  seq += 1;
  const res = await buildApp().request(
    'https://example.com/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
      body: JSON.stringify({
        username: `rebuild9${String(seq)}`,
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

function migration(prefix: string): readonly string[] {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix));
  if (m === undefined) throw new Error(`${prefix} not in TEST_MIGRATIONS`);
  return m.queries;
}

/** Run migration files' statements as ONE atomic batch, in the order given. */
async function rerun(...prefixes: string[]): Promise<void> {
  const queries = prefixes.flatMap((p) => migration(p));
  await env.DB.batch(queries.map((q) => env.DB.prepare(q)));
}

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).all()).results;
}

interface Seeded {
  readonly userId: string;
  readonly wonBetId: string;
  readonly nflGame: string;
  readonly cfbGame: string;
  readonly failedTarget: string;
}

type Row = Record<string, unknown>;

interface State {
  readonly rows: Readonly<Record<Rebuilt, readonly Row[]>>;
  readonly counts: Readonly<Record<Rebuilt, number>>;
  readonly bankrolls: readonly Record<string, unknown>[];
  readonly columns: Readonly<Record<Rebuilt, readonly Row[]>>;
  /** Every sqlite_master row but `rootpage` (which a rebuild legitimately moves). */
  readonly objects: readonly Record<string, unknown>[];
}

async function state(): Promise<State> {
  const rows = {} as Record<Rebuilt, Row[]>;
  const counts = {} as Record<Rebuilt, number>;
  const columns = {} as Record<Rebuilt, Row[]>;
  for (const t of REBUILT_TABLES) {
    rows[t] = await all(`SELECT * FROM ${t} ORDER BY ${REBUILT[t]}`);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
    counts[t] = n?.n ?? -1;
    // cid, name, type, notnull, dflt_value, pk — in physical order.
    columns[t] = await all(`PRAGMA table_info(${t})`);
  }
  return {
    rows,
    counts,
    columns,
    bankrolls: await all('SELECT * FROM bankrolls ORDER BY id'),
    objects: await all(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE '_cf_%' ORDER BY type, name`,
    ),
  };
}

async function names(type: 'trigger' | 'index' | 'table'): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
    .bind(type)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

async function balanceDrift(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bankrolls b
      WHERE b.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE bankroll_id = b.id)`,
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

/**
 * A populated database that touches every rebuilt table and every foreign key
 * between them: NFL + CFB games with DraftKings AND odds-api line rows (the
 * 0004 conference ids and the 0007 *_book / secondary_tried_at columns set), a
 * won and a lost bet, a pending teaser, a same-game parlay and a cross-league
 * ('mixed') parlay placed over HTTP, and ingest_targets rows with real history.
 * `sameGame: false` leaves out the same-game parlay — the one row shape 0005's
 * `bet_legs` (UNIQUE (bet_id, game_id)) cannot hold.
 */
async function seedHistory(opts: { sameGame?: boolean } = {}): Promise<Seeded> {
  const alex = await register();
  const s = String(seq);
  await seedSettledBet(env.DB, {
    id: `r9-won-${s}`,
    userId: alex.id,
    status: 'won',
    stakeCents: 2500,
    payoutCents: 4772,
  });
  await seedSettledBet(env.DB, {
    id: `r9-lost-${s}`,
    userId: alex.id,
    status: 'lost',
    stakeCents: 1000,
    payoutCents: 0,
  });
  const now = Date.now();
  const a = await seedGameWithLine(env.DB, { id: `nfl:rb9-a-${s}`, kickoffAt: now + 2 * HOUR });
  const b = await seedGameWithLine(env.DB, { id: `nfl:rb9-b-${s}`, kickoffAt: now + 3 * HOUR });
  const c = await seedGameWithLine(env.DB, {
    id: `ncaaf:rb9-c-${s}`,
    league: 'ncaaf',
    kickoffAt: now + 2 * HOUR,
    homeAbbr: 'MICH',
    awayAbbr: 'OSU',
    homeConferenceId: '5',
    awayConferenceId: '5',
    homeRank: 3,
    awayRank: 7,
  });
  // Secondary (odds-api) rows beside the primary ones, with the 0007 book columns.
  await seedLine(env.DB, {
    gameId: a,
    provider: LINE_PROVIDER_SECONDARY,
    spreadHomeTenths: -30,
    spreadHomePrice: -115,
    spreadAwayTenths: 30,
    spreadAwayPrice: -105,
    mlHomePrice: -160,
    mlAwayPrice: 140,
    spreadBook: 'fanduel',
    mlBook: 'betmgm',
    seenAt: now,
  });
  await seedLine(env.DB, {
    gameId: c,
    provider: LINE_PROVIDER_SECONDARY,
    totalTenths: 475,
    totalOverPrice: -112,
    totalUnderPrice: -108,
    totalBook: 'caesars',
    seenAt: now,
  });
  await env.DB.prepare('UPDATE games SET secondary_tried_at = ?1 WHERE id IN (?2, ?3)')
    .bind(now - HOUR, a, c)
    .run();

  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'teaser',
    teaserPoints: 60,
    stakeCents: 500,
    legs: [
      { gameId: a, market: 'spread', side: 'home' },
      { gameId: b, market: 'spread', side: 'home' },
    ],
  });
  if (opts.sameGame !== false) {
    await placeOverHttp(alex.cookie, {
      league: 'ncaaf',
      betType: 'parlay',
      stakeCents: 1000,
      legs: [
        { gameId: c, market: 'spread', side: 'home' },
        { gameId: c, market: 'total', side: 'over' },
      ],
    });
  }
  await placeOverHttp(alex.cookie, {
    league: 'nfl',
    betType: 'parlay',
    stakeCents: 300,
    legs: [
      { gameId: b, market: 'moneyline', side: 'away' },
      { gameId: c, market: 'moneyline', side: 'away' },
    ],
  });

  const target = env.DB.prepare(
    `INSERT INTO ingest_targets (id, league, kind, key, window_start_at, window_end_at, priority,
                                 next_run_at, last_run_at, last_status, last_error,
                                 consecutive_failures, games_seen, created_at, updated_at)
     VALUES (?1, ?2, 'date', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?4, ?5)`,
  );
  await env.DB.batch([
    target.bind(
      `nfl:date:r9-${s}-20260920`,
      'nfl',
      '20260920',
      now - 24 * HOUR,
      now,
      10,
      now + 7 * 60_000,
      now - 60_000,
      'error',
      'espn 503',
      3,
      0,
    ),
    target.bind(
      `ncaaf:date:r9-${s}-20260919`,
      'ncaaf',
      '20260919',
      now - 48 * HOUR,
      now - 24 * HOUR,
      100,
      now + HOUR,
      now - 2 * HOUR,
      'ok',
      null,
      0,
      86,
    ),
    target.bind(
      `ncaaf:date:r9-${s}-20260926`,
      'ncaaf',
      '20260926',
      now + 24 * HOUR,
      now + 48 * HOUR,
      50,
      now,
      null,
      null,
      null,
      0,
      0,
    ),
  ]);
  return {
    userId: alex.id,
    wonBetId: `r9-won-${s}`,
    nflGame: a,
    cfbGame: c,
    failedTarget: `nfl:date:r9-${s}-20260920`,
  };
}

/**
 * Pre-MLB DDL cannot hold an 'mlb' row, so a test that re-runs 0005 / 0008
 * (whose recreated tables predate 'mlb') first removes the 'mlb' rows earlier
 * tests in this file left behind: storage persists across a file's tests.
 * Nothing here touches the ledger — these bets were inserted directly, with no
 * money rows — and deleting a bet cascades to its legs.
 */
async function purgeMlbRows(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM bets WHERE league = 'mlb'
          OR id IN (SELECT bet_id FROM bet_legs WHERE league = 'mlb')`,
    ),
    env.DB.prepare(`DELETE FROM games WHERE league = 'mlb'`),
    env.DB.prepare(`DELETE FROM ingest_targets WHERE league = 'mlb'`),
  ]);
}

async function mainBankroll(userId: string): Promise<{ id: string; balance_cents: number }> {
  const row = await env.DB.prepare(
    "SELECT id, balance_cents FROM bankrolls WHERE user_id = ?1 AND kind = 'main'",
  )
    .bind(userId)
    .first<{ id: string; balance_cents: number }>();
  if (row === null) throw new Error('no main bankroll');
  return row;
}

/**
 * The text an object's CREATE statement has in the LAST migration before 0009
 * that defines it — what `sqlite_master.sql` must equal byte for byte.
 */
function sourceSql(kind: 'INDEX' | 'TRIGGER', name: string): string {
  let found: string | undefined;
  for (const m of env.TEST_MIGRATIONS) {
    if (m.name.startsWith('0009_')) continue;
    for (const q of m.queries) {
      const at = q.indexOf(`CREATE ${kind} ${name} `);
      if (at >= 0) found = q.slice(at).replace(/;\s*$/, '').trimEnd();
    }
  }
  if (found === undefined) throw new Error(`no source CREATE ${kind} ${name}`);
  return found;
}

describe('migration 0009 (league CHECK rebuild) — M12a', () => {
  /**
   * FIRST in the file, deliberately. Storage persists across a file's tests,
   * and 0005's `bet_legs` predates same-game parlays (UNIQUE (bet_id, game_id)):
   * once any test has placed one, 0005 can never be re-run on this database
   * again — the copy-back would violate the old UNIQUE. That is the same reason
   * production never replays an old rebuild, and why an older rebuild is only
   * ever re-run COMPOSED FORWARD with every later one.
   */
  describe('composition', () => {
    it('0005 + 0008 + 0009 and 0008 + 0009, composed forward, change nothing', async () => {
      await seedHistory({ sameGame: false });
      const before = await state();
      await rerun('0005_', '0008_', '0009_');
      expect(await state()).toEqual(before);
      // 0008 + 0009 also holds with a same-game parlay on the books.
      await seedHistory();
      const withSameGame = await state();
      await rerun('0008_', '0009_');
      expect(await state()).toEqual(withSameGame);
      expect(await balanceDrift()).toBe(0);
    });

    it('an older rebuild NOT composed forward puts pre-MLB DDL back — which is why it must be', async () => {
      await purgeMlbRows();
      const { userId } = await seedHistory();
      const { id: bk } = await mainBankroll(userId);
      // Parents that the widened games / bets CHECKs admit (0008 touches neither).
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO games (id, provider, provider_event_id, league, season, season_type,
                              name, short_name, kickoff_at, original_kickoff_at, status,
                              home_team_id, home_abbr, home_name, away_team_id, away_abbr,
                              away_name, first_seen_at, last_seen_at, updated_at)
           VALUES ('mlb:comp', 'espn', 'comp', 'mlb', 2026, 3, 'NYY at BOS', 'NYY @ BOS', 1, 1,
                   'scheduled', 't-BOS', 'BOS', 'Boston', 't-NYY', 'NYY', 'New York', 1, 1, 1)`,
        ),
        env.DB.prepare(
          `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                             stake_cents, american_price, potential_payout_cents, status,
                             placed_at, earliest_kickoff_at, created_at, updated_at)
           VALUES ('comp-mlb', ?1, ?2, 'mlb', 2026, 'straight', 1, 100, 100, 200, 'pending',
                   1, 1, 1, 1)`,
        ).bind(userId, bk),
      ]);
      const before = await state();
      const mlbLeg = () =>
        env.DB.prepare(
          `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                                 american_price, provider, line_captured_at, snapshot_at,
                                 kickoff_at_snapshot, home_abbr, away_abbr)
           VALUES ('comp-mlb-leg', 'comp-mlb', 0, 'mlb:comp', 'mlb', 'moneyline', 'home', NULL,
                   -150, 'DraftKings', 1, 1, 1, 'BOS', 'NYY')`,
        ).run();
      // 0008 ALONE recreates bet_legs from ITS text, which predates 'mlb'.
      await rerun('0008_');
      await expect(mlbLeg()).rejects.toThrow(/CHECK constraint failed/);
      // 0009 on top restores the widened schema, byte for byte.
      await rerun('0009_');
      expect(await state()).toEqual(before);
      await expect(mlbLeg()).resolves.toBeDefined();
    });

    it('re-running 0009 twice in a row is a no-op on every row and object', async () => {
      await seedHistory();
      const before = await state();
      await rerun('0009_');
      await rerun('0009_');
      expect(await state()).toEqual(before);
      expect(await balanceDrift()).toBe(0);
    });
  });

  describe('lossless on a populated database', () => {
    it('every row, count, balance and column survives the rebuild', async () => {
      const { userId } = await seedHistory();
      const before = await state();

      // The seed really does populate every table and every relationship.
      expect(before.counts.games).toBeGreaterThanOrEqual(3);
      expect(before.counts.game_lines).toBeGreaterThanOrEqual(5);
      expect(before.counts.bets).toBeGreaterThanOrEqual(5);
      expect(before.counts.bet_legs).toBeGreaterThanOrEqual(6);
      expect(before.counts.ledger).toBeGreaterThanOrEqual(7);
      expect(before.counts.ingest_targets).toBeGreaterThanOrEqual(3);
      const leagues = before.rows.bets.map((r) => r['league']);
      expect(leagues).toEqual(expect.arrayContaining(['nfl', 'ncaaf', 'mixed']));
      const bal = await mainBankroll(userId);
      expect(bal.balance_cents).not.toBe(0);

      await rerun('0009_');
      const after = await state();

      // Every row of all six tables, deep-equal.
      expect(after.rows).toEqual(before.rows);
      // Counts equal: dropping games fired no ON DELETE CASCADE into game_lines
      // (game_lines was dropped first) and nothing was lost from bet_legs.
      expect(after.counts).toEqual(before.counts);
      expect(after.counts.game_lines).toBe(before.counts.game_lines);
      expect(after.counts.bet_legs).toBe(before.counts.bet_legs);
      // Every bankroll untouched — FAILS (doubled) if ledger_ai_apply had been
      // live while the ledger was copied back.
      expect(after.bankrolls).toEqual(before.bankrolls);
      expect((await mainBankroll(userId)).balance_cents).toBe(bal.balance_cents);
      expect(await balanceDrift()).toBe(0);
      // Columns identical, including the ALTERed ones in their physical order.
      expect(after.columns).toEqual(before.columns);
      expect(after.columns.games.slice(-3).map((c) => c['name'])).toEqual([
        'home_conference_id',
        'away_conference_id',
        'secondary_tried_at',
      ]);
      expect(after.columns.game_lines.slice(-3).map((c) => c['name'])).toEqual([
        'spread_book',
        'total_book',
        'ml_book',
      ]);
    });

    it('ingest_targets keeps its history: next_run_at, failures, last_status, last_error', async () => {
      const { failedTarget } = await seedHistory();
      const before = await env.DB.prepare('SELECT * FROM ingest_targets WHERE id = ?1')
        .bind(failedTarget)
        .first();
      await rerun('0009_');
      const row = await env.DB.prepare('SELECT * FROM ingest_targets WHERE id = ?1')
        .bind(failedTarget)
        .first();
      expect(row).toEqual(before);
      expect(row?.['last_status']).toBe('error');
      expect(row?.['last_error']).toBe('espn 503');
      expect(row?.['consecutive_failures']).toBe(3);
      expect(row?.['priority']).toBe(10);
      expect(row?.['next_run_at']).toBeTypeOf('number');
      expect(row?.['last_run_at']).toBeTypeOf('number');
    });

    it('PRAGMA foreign_key_check returns no rows', async () => {
      await seedHistory();
      await rerun('0009_');
      expect(await all('PRAGMA foreign_key_check')).toEqual([]);
    });
  });

  describe('schema objects come back byte-identical', () => {
    it('every trigger and index by name AND sqlite_master.sql text', async () => {
      await seedHistory();
      const before = await state();
      await rerun('0009_');
      const after = await state();
      expect(after.objects).toEqual(before.objects);

      expect(await names('trigger')).toEqual([...TRIGGERS]);
      const idx = await all(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND sql IS NOT NULL
            AND tbl_name IN ('games','game_lines','bets','bet_legs','ledger','ingest_targets')
          ORDER BY name`,
      );
      expect(idx.map((r) => r['name'])).toEqual([...INDEXES]);

      // ...and each one's text is the text of the migration that ORIGINALLY
      // wrote it (0001 / 0005 / 0008), not a retyped near-copy.
      for (const [kind, list] of [
        ['TRIGGER', TRIGGERS],
        ['INDEX', INDEXES],
      ] as const) {
        for (const name of list) {
          const row = await env.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?1')
            .bind(name)
            .first<{ sql: string }>();
          expect(row?.sql, name).toBe(sourceSql(kind, name));
        }
      }
    });

    it('the table list is unchanged and no *_copy table survives', async () => {
      await seedHistory();
      const tables = await names('table');
      await rerun('0009_');
      expect(await names('table')).toEqual(tables);
      expect(tables.some((t) => t.endsWith('_copy'))).toBe(false);
      for (const t of REBUILT_TABLES) expect(tables).toContain(t);
    });
  });

  describe('the recreated triggers still guard money', () => {
    it('ledger: moves the balance, refuses overdraft, UPDATE, DELETE and orphans', async () => {
      const { userId } = await seedHistory();
      await rerun('0009_');
      const bankroll = await mainBankroll(userId);

      await env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at, memo)
         VALUES ('adj9-1', ?1, 'admin_adjust', 'adj9-1', -700, ?2, 'rebuild test')`,
      )
        .bind(bankroll.id, Date.now())
        .run();
      expect((await mainBankroll(userId)).balance_cents).toBe(bankroll.balance_cents - 700);

      await expect(
        env.DB.prepare(
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
           VALUES ('adj9-2', ?1, 'admin_adjust', 'adj9-2', -999999999, ?2)`,
        )
          .bind(bankroll.id, Date.now())
          .run(),
      ).rejects.toThrow(/insufficient funds/);
      await expect(
        env.DB.prepare("UPDATE ledger SET memo = 'x' WHERE id = 'adj9-1'").run(),
      ).rejects.toThrow(/append-only/);
      await expect(env.DB.prepare("DELETE FROM ledger WHERE id = 'adj9-1'").run()).rejects.toThrow(
        /append-only/,
      );
      await expect(
        env.DB.prepare(
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
           VALUES ('adj9-3', 'no-such-bankroll', 'admin_adjust', 'adj9-3', 1, 1)`,
        ).run(),
      ).rejects.toThrow(/unknown bankroll_id/);
      expect(await balanceDrift()).toBe(0);
    });

    it('bet_legs: a moneyline beside a spread on one game in one bet aborts', async () => {
      const { cfbGame } = await seedHistory();
      await rerun('0009_');
      // The same-game parlay placed in seedHistory holds a spread on the CFB game.
      const bet = await env.DB.prepare(
        `SELECT bet_id FROM bet_legs WHERE game_id = ?1 AND market = 'spread'`,
      )
        .bind(cfbGame)
        .first<{ bet_id: string }>();
      if (bet === null) throw new Error('the same-game parlay should exist');
      await expect(
        env.DB.prepare(
          `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                                 american_price, provider, line_captured_at, snapshot_at,
                                 kickoff_at_snapshot, home_abbr, away_abbr)
           VALUES ('rb9-ml', ?1, 9, ?2, 'ncaaf', 'moneyline', 'home', NULL, -110,
                   'DraftKings', 1, 1, 1, 'MICH', 'OSU')`,
        )
          .bind(bet.bet_id, cfbGame)
          .run(),
      ).rejects.toThrow(/one side pick per game/);
    });
  });

  describe('the widened CHECKs', () => {
    /** One INSERT per widened table, parameterised by league. */
    function inserts(userId: string, bankrollId: string) {
      const game = (id: string, league: string) =>
        env.DB.prepare(
          `INSERT INTO games (id, provider, provider_event_id, league, season, season_type, week,
                              name, short_name, kickoff_at, original_kickoff_at, status,
                              neutral_site, home_team_id, home_abbr, home_name,
                              away_team_id, away_abbr, away_name,
                              first_seen_at, last_seen_at, updated_at)
           VALUES (?1, 'espn', ?1, ?2, 2026, 3, NULL, 'NYY at BOS', 'NYY @ BOS', 1, 1,
                   'scheduled', 0, 't-BOS', 'BOS', 'Boston', 't-NYY', 'NYY', 'New York',
                   1, 1, 1)`,
        ).bind(id, league);
      const bet = (id: string, league: string) =>
        env.DB.prepare(
          `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                             stake_cents, american_price, potential_payout_cents, status,
                             placed_at, earliest_kickoff_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 2026, 'straight', 1, 100, 100, 200, 'pending', 1, 1, 1, 1)`,
        ).bind(id, userId, bankrollId, league);
      const leg = (id: string, betId: string, gameId: string, league: string) =>
        env.DB.prepare(
          `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                                 american_price, provider, line_captured_at, snapshot_at,
                                 kickoff_at_snapshot, home_abbr, away_abbr)
           VALUES (?1, ?2, 0, ?3, ?4, 'moneyline', 'home', NULL, -150, 'DraftKings', 1, 1, 1,
                   'BOS', 'NYY')`,
        ).bind(id, betId, gameId, league);
      const target = (id: string, league: string) =>
        env.DB.prepare(
          `INSERT INTO ingest_targets (id, league, kind, key, window_start_at, window_end_at,
                                       next_run_at, created_at, updated_at)
           VALUES (?1, ?2, 'date', '20261001', 1, 2, 1, 1, 1)`,
        ).bind(id, league);
      return { game, bet, leg, target };
    }

    it("league = 'mlb' INSERTs succeed on games, bets, bet_legs and ingest_targets", async () => {
      const { userId } = await seedHistory();
      await rerun('0009_');
      const { id: bankrollId } = await mainBankroll(userId);
      const ins = inserts(userId, bankrollId);
      await ins.game('mlb:401', 'mlb').run();
      await ins.bet('mlb-bet', 'mlb').run();
      await ins.leg('mlb-leg', 'mlb-bet', 'mlb:401', 'mlb').run();
      await ins.target('mlb:date:20261001', 'mlb').run();
      const n = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM games WHERE id = 'mlb:401' AND league = 'mlb')
              + (SELECT COUNT(*) FROM bets WHERE id = 'mlb-bet' AND league = 'mlb')
              + (SELECT COUNT(*) FROM bet_legs WHERE id = 'mlb-leg' AND league = 'mlb')
              + (SELECT COUNT(*) FROM ingest_targets
                  WHERE id = 'mlb:date:20261001' AND league = 'mlb') AS n`,
      ).first<{ n: number }>();
      expect(n?.n).toBe(4);
    });

    it("league = 'nba' fails CHECK on all four; 'mixed' is still bets-only", async () => {
      const { userId } = await seedHistory();
      await rerun('0009_');
      const { id: bankrollId } = await mainBankroll(userId);
      const ins = inserts(userId, bankrollId);
      // Valid parents for the bet_legs probes.
      await ins.game('mlb:402', 'mlb').run();
      await ins.bet('mlb-bet2', 'mlb').run();

      const CHECK = /CHECK constraint failed/;
      await expect(ins.game('nba:1', 'nba').run()).rejects.toThrow(CHECK);
      await expect(ins.bet('nba-bet', 'nba').run()).rejects.toThrow(CHECK);
      await expect(ins.leg('nba-leg', 'mlb-bet2', 'mlb:402', 'nba').run()).rejects.toThrow(CHECK);
      await expect(ins.target('nba:date:1', 'nba').run()).rejects.toThrow(CHECK);

      await ins.bet('mixed-bet', 'mixed').run();
      await expect(ins.game('mixed:1', 'mixed').run()).rejects.toThrow(CHECK);
      await expect(ins.leg('mixed-leg', 'mlb-bet2', 'mlb:402', 'mixed').run()).rejects.toThrow(
        CHECK,
      );
      await expect(ins.target('mixed:date:1', 'mixed').run()).rejects.toThrow(CHECK);
    });

    it('every other CHECK on the six tables still refuses what it refused before', async () => {
      const { userId, wonBetId: betId, nflGame: game } = await seedHistory();
      await rerun('0009_');
      const { id: bk } = await mainBankroll(userId);
      const refused: readonly (readonly [string, string, readonly unknown[]])[] = [
        [
          'games.status',
          `INSERT INTO games (id, provider_event_id, league, season, season_type, name, short_name,
                              kickoff_at, original_kickoff_at, status, home_team_id, home_abbr,
                              home_name, away_team_id, away_abbr, away_name, first_seen_at,
                              last_seen_at, updated_at)
           VALUES ('x1', 'x1', 'mlb', 2026, 2, 'n', 'n', 1, 1, 'halftime', 'h', 'H', 'H', 'a', 'A',
                   'A', 1, 1, 1)`,
          [],
        ],
        [
          'games.neutral_site',
          `INSERT INTO games (id, provider_event_id, league, season, season_type, name, short_name,
                              kickoff_at, original_kickoff_at, status, neutral_site, home_team_id,
                              home_abbr, home_name, away_team_id, away_abbr, away_name,
                              first_seen_at, last_seen_at, updated_at)
           VALUES ('x2', 'x2', 'mlb', 2026, 2, 'n', 'n', 1, 1, 'scheduled', 2, 'h', 'H', 'H', 'a',
                   'A', 'A', 1, 1, 1)`,
          [],
        ],
        ...(
          [
            ['bets.bet_type', `'mlb', 'accumulator', 2, NULL, 100`],
            ['bets.leg_count', `'mlb', 'parlay', 11, NULL, 100`],
            ['bets.stake_cents', `'mlb', 'straight', 1, NULL, 99`],
            ['bets.teaser tier off-grid', `'mlb', 'teaser', 2, 33, 100`],
            ['bets.teaser REAL', `'mlb', 'teaser', 2, 65.5, 100`],
            ['bets.straight with 2 legs', `'mlb', 'straight', 2, NULL, 100`],
            ['bets.teaser points on a parlay', `'mlb', 'parlay', 2, 60, 100`],
          ] as const
        ).map(
          ([label, values]) =>
            [
              label,
              `INSERT INTO bets (id, user_id, bankroll_id, league, bet_type, leg_count,
                                 teaser_points_tenths, stake_cents, season, american_price,
                                 potential_payout_cents, status, placed_at, earliest_kickoff_at,
                                 created_at, updated_at)
               VALUES ('xb-${label}', ?1, ?2, ${values}, 2026, 100, 200, 'pending', 1, 1, 1, 1)`,
              [userId, bk],
            ] as const,
        ),
        [
          'bets.settled without payout',
          `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                             stake_cents, american_price, potential_payout_cents, status,
                             placed_at, earliest_kickoff_at, created_at, updated_at)
           VALUES ('xb-won', ?1, ?2, 'mlb', 2026, 'straight', 1, 100, 100, 200, 'won', 1, 1, 1, 1)`,
          [userId, bk],
        ],
        ...(
          [
            ['bet_legs.market', `'props', 'home', NULL, -110`],
            ['bet_legs.side', `'spread', 'draw', -35, -110`],
            ['bet_legs.moneyline with a line', `'moneyline', 'home', -35, -110`],
            ['bet_legs.spread without a line', `'spread', 'home', NULL, -110`],
            ['bet_legs.total with home', `'total', 'home', 455, -110`],
            ['bet_legs.price', `'spread', 'home', -35, 99`],
          ] as const
        ).map(
          ([label, values]) =>
            [
              label,
              `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side,
                                     line_tenths, american_price, provider, line_captured_at,
                                     snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr)
               VALUES ('xl-${label}', ?1, 5, ?2, 'nfl', ${values}, 'DraftKings', 1, 1, 1, 'H', 'A')`,
              [betId, game],
            ] as const,
        ),
        [
          'bet_legs.result',
          `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                                 american_price, provider, line_captured_at, snapshot_at,
                                 kickoff_at_snapshot, home_abbr, away_abbr, result)
           VALUES ('xl-res', ?1, 6, ?2, 'nfl', 'total', 'over', 455, -110, 'DraftKings', 1, 1, 1,
                   'H', 'A', 'maybe')`,
          [betId, game],
        ],
        [
          'ledger.kind',
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, amount_cents, created_at)
           VALUES ('xg-1', ?1, 'gift', 'xg-1', 1, 1)`,
          [bk],
        ],
        [
          'ingest_targets.kind',
          `INSERT INTO ingest_targets (id, league, kind, key, window_start_at, window_end_at,
                                       next_run_at, created_at, updated_at)
           VALUES ('xt-1', 'mlb', 'month', 'k', 1, 2, 1, 1, 1)`,
          [],
        ],
        [
          'ingest_targets.last_status',
          `INSERT INTO ingest_targets (id, league, kind, key, window_start_at, window_end_at,
                                       next_run_at, last_status, created_at, updated_at)
           VALUES ('xt-2', 'mlb', 'date', 'k', 1, 2, 1, 'meh', 1, 1)`,
          [],
        ],
      ];
      for (const [label, sql, binds] of refused) {
        await expect(
          env.DB.prepare(sql)
            .bind(...binds)
            .run(),
          label,
        ).rejects.toThrow(/CHECK constraint failed/);
      }
      // game_lines has no CHECK; its guard is the foreign key, which survives too.
      await expect(
        env.DB.prepare(
          `INSERT INTO game_lines (game_id, provider, captured_at, seen_at)
           VALUES ('no-such-game', 'DraftKings', 1, 1)`,
        ).run(),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });
  });
});
