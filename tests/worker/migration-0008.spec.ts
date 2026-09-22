/**
 * Migration 0008 rebuilds `bet_legs` to replace `UNIQUE (bet_id, game_id)` with
 * `UNIQUE (bet_id, game_id, market)` plus the one-side-pick trigger (same-game
 * parlays, PLAN.md §5.2c / §16.2). This proves the rebuild is lossless against
 * a populated database.
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0008. The rebuild is exercised by seeding bets whose
 * legs reference real games — including a same-game parlay, which only the
 * NEW constraint admits — and RE-RUNNING 0008's statements on top: the same
 * copy-drop-recreate-copy-back path the remote database goes through, on the
 * same engine. `bets`, `ledger` and every balance must come through untouched
 * because the file never names them.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/worker/index.js';
import { seedGameWithLine } from './seed.js';

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
        username: `rebuild8${String(seq)}`,
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

function migration0008(): readonly string[] {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith('0008_'));
  if (m === undefined) throw new Error('0008 not in TEST_MIGRATIONS');
  return m.queries;
}

async function schemaNames(type: 'trigger' | 'index' | 'table'): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
    .bind(type)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

describe('migration 0008 (bet_legs rebuild)', () => {
  it('re-running the rebuild on a populated database changes nothing', async () => {
    const alex = await register();
    const now = Date.now();
    const a = await seedGameWithLine(env.DB, { id: 'nfl:rb8-a', kickoffAt: now + 2 * HOUR });
    const b = await seedGameWithLine(env.DB, { id: 'nfl:rb8-b', kickoffAt: now + 2 * HOUR });
    // A same-game parlay (two legs, one game — the row shape 0008 exists for),
    // a cross-game teaser and a straight, all through the real placement path
    // so every leg has a stake row and a bet row behind it.
    await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'parlay',
      stakeCents: 1000,
      legs: [
        { gameId: a, market: 'spread', side: 'home' },
        { gameId: a, market: 'total', side: 'over' },
      ],
    });
    await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'teaser',
      teaserPoints: 60,
      stakeCents: 500,
      legs: [
        { gameId: a, market: 'spread', side: 'away' },
        { gameId: b, market: 'total', side: 'under' },
      ],
    });
    await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'straight',
      stakeCents: 250,
      legs: [{ gameId: b, market: 'moneyline', side: 'home' }],
    });

    const before = await snapshot();
    expect(before.legs.length).toBeGreaterThanOrEqual(5);
    expect(before.ledger.length).toBeGreaterThanOrEqual(4);
    const triggersBefore = await schemaNames('trigger');
    const indexesBefore = await schemaNames('index');
    const tablesBefore = await schemaNames('table');
    expect(triggersBefore).toContain('bet_legs_bi_one_side_per_game');

    // THE REBUILD, as one atomic batch — exactly how `wrangler d1 migrations
    // apply` runs the file.
    await env.DB.batch(migration0008().map((q) => env.DB.prepare(q)));

    const after = await snapshot();
    expect(after).toEqual(before);
    const drift = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bankrolls b
        WHERE b.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE bankroll_id = b.id)`,
    ).first<{ n: number }>();
    expect(drift?.n).toBe(0);
    expect(await schemaNames('trigger')).toEqual(triggersBefore);
    expect(await schemaNames('index')).toEqual(indexesBefore);
    expect(await schemaNames('table')).toEqual(tablesBefore);
    expect(tablesBefore.some((t) => t.endsWith('_copy'))).toBe(false);
  });

  it('after the rebuild the rules still hold: a repeated market and a second side pick are refused', async () => {
    const alex = await register();
    const now = Date.now();
    const a = await seedGameWithLine(env.DB, { id: 'nfl:rb8-c', kickoffAt: now + 2 * HOUR });
    await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'straight',
      stakeCents: 250,
      legs: [{ gameId: a, market: 'spread', side: 'home' }],
    });
    await env.DB.batch(migration0008().map((q) => env.DB.prepare(q)));
    const bet = await env.DB.prepare(
      `SELECT b.id FROM bets b JOIN bet_legs l ON l.bet_id = b.id WHERE l.game_id = ?1 AND b.user_id = ?2`,
    )
      .bind(a, alex.id)
      .first<{ id: string }>();
    if (bet === null) throw new Error('the straight should exist');
    const insert = (id: string, market: string, side: string, line: number | null) =>
      env.DB.prepare(
        `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                               american_price, provider, line_captured_at, snapshot_at,
                               kickoff_at_snapshot, home_abbr, away_abbr)
         VALUES (?1, ?2, 9, ?3, 'nfl', ?4, ?5, ?6, -110, 'draftkings', ?7, ?7, ?7, 'SEA', 'NE')`,
      )
        .bind(`rb8-${id}-${String(seq)}`, bet.id, a, market, side, line, now)
        .run();
    await expect(insert('x', 'spread', 'away', 35)).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert('y', 'moneyline', 'home', null)).rejects.toThrow(/one side pick per game/);
    await expect(insert('z', 'total', 'over', 455)).resolves.toBeDefined();
  });
});
