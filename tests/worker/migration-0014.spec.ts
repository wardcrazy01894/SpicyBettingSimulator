/**
 * Migration 0014 rebuilds `bet_legs` to replace `UNIQUE (bet_id, game_id,
 * market)` with `UNIQUE (bet_id, game_id, market, side)` plus the
 * `bet_legs_bi_middle_teaser_only` trigger (teaser middles, PLAN.md §5.2d /
 * §16.2). This proves the rebuild is lossless against a populated database.
 *
 * The pool applies EVERY migration before each file (setup.ts), so the schema
 * here is already post-0014. The rebuild is exercised by seeding bets through
 * the real placement path — including a teaser MIDDLE, which only the NEW
 * constraint admits — and RE-RUNNING 0014's statements on top: the same
 * copy-drop-recreate-copy-back path the remote database goes through, on the
 * same engine. 0014 is the last rebuild, so it re-runs alone. `bets`, `ledger`
 * and every balance must come through untouched because the file never names
 * them.
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
        username: `rebuild14${String(seq)}`,
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

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).all()).results;
}

async function snapshot(): Promise<Record<string, unknown>> {
  return {
    bets: await all('SELECT * FROM bets ORDER BY id'),
    legs: await all('SELECT * FROM bet_legs ORDER BY id'),
    ledger: await all('SELECT * FROM ledger ORDER BY id'),
    bankrolls: await all('SELECT id, balance_cents FROM bankrolls ORDER BY id'),
    legColumns: await all('PRAGMA table_info(bet_legs)'),
    // Every table, index and trigger, WITH its text: the rebuild must put back
    // byte for byte what the migration run created.
    objects: await all(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
        ORDER BY type, name`,
    ),
  };
}

function migration0014(): readonly string[] {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith('0014_'));
  if (m === undefined) throw new Error('0014_ not in TEST_MIGRATIONS');
  return m.queries;
}

async function rerun0014(): Promise<void> {
  await env.DB.batch(migration0014().map((q) => env.DB.prepare(q)));
}

const middleTeaser = (gameId: string, market: 'spread' | 'total') => ({
  league: 'nfl',
  betType: 'teaser',
  teaserPoints: 60,
  stakeCents: 500,
  legs:
    market === 'spread'
      ? [
          { gameId, market, side: 'home' },
          { gameId, market, side: 'away' },
        ]
      : [
          { gameId, market, side: 'over' },
          { gameId, market, side: 'under' },
        ],
});

describe('migration 0014 (bet_legs rebuild, teaser middles)', () => {
  it('re-running the rebuild on a populated database changes nothing', async () => {
    const alex = await register();
    const now = Date.now();
    const a = await seedGameWithLine(env.DB, { id: 'nfl:rb14-a', kickoffAt: now + 2 * HOUR });
    const b = await seedGameWithLine(env.DB, { id: 'nfl:rb14-b', kickoffAt: now + 2 * HOUR });
    // A teaser middle on each market (the row shape 0014 exists for), a
    // same-game parlay, a cross-game teaser and a straight, all through the
    // real placement path so every leg has a stake row and a bet row behind it.
    await placeOverHttp(alex.cookie, middleTeaser(a, 'spread'));
    await placeOverHttp(alex.cookie, middleTeaser(b, 'total'));
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
    expect((before['legs'] as unknown[]).length).toBeGreaterThanOrEqual(9);
    expect((before['ledger'] as unknown[]).length).toBeGreaterThanOrEqual(6);

    // THE REBUILD, as one atomic batch — exactly how `wrangler d1 migrations
    // apply` runs the file. Twice, because a second run must be a no-op too.
    await rerun0014();
    await rerun0014();

    expect(await snapshot()).toEqual(before);
    const drift = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bankrolls b
        WHERE b.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE bankroll_id = b.id)`,
    ).first<{ n: number }>();
    expect(drift?.n).toBe(0);
    const leftovers = await all(`SELECT name FROM sqlite_master WHERE name LIKE '%_copy'`);
    expect(leftovers).toEqual([]);
  });

  it('after the rebuild the rules hold: a middle only in a teaser, never the same pick twice', async () => {
    const alex = await register();
    const now = Date.now();
    const a = await seedGameWithLine(env.DB, { id: 'nfl:rb14-c', kickoffAt: now + 2 * HOUR });
    const straight = await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'straight',
      stakeCents: 250,
      legs: [{ gameId: a, market: 'spread', side: 'home' }],
    });
    const teaser = await placeOverHttp(alex.cookie, {
      league: 'nfl',
      betType: 'teaser',
      teaserPoints: 60,
      stakeCents: 250,
      legs: [
        { gameId: a, market: 'spread', side: 'home' },
        { gameId: a, market: 'total', side: 'over' },
      ],
    });
    await rerun0014();
    let n = 0;
    const insert = (betId: string, market: string, side: string, line: number | null) => {
      n += 1;
      return env.DB.prepare(
        `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                               american_price, provider, line_captured_at, snapshot_at,
                               kickoff_at_snapshot, home_abbr, away_abbr)
         VALUES (?1, ?2, ?3, ?4, 'nfl', ?5, ?6, ?7, 100, 'draftkings', ?8, ?8, ?8, 'SEA', 'NE')`,
      )
        .bind(`rb14-${String(seq)}-${String(n)}`, betId, 10 + n, a, market, side, line, now)
        .run();
    };
    // A straight (or a parlay) may not take the other side...
    await expect(insert(straight, 'spread', 'away', 35)).rejects.toThrow(
      /both sides of a market only in a teaser/,
    );
    // ...a teaser may, for the spread and for the total...
    await expect(insert(teaser, 'spread', 'away', 95)).resolves.toBeDefined();
    await expect(insert(teaser, 'total', 'under', 515)).resolves.toBeDefined();
    // ...but never the identical pick, and 0008's rule still stands.
    await expect(insert(teaser, 'spread', 'away', 95)).rejects.toThrow(
      /UNIQUE constraint failed: bet_legs.bet_id, bet_legs.game_id, bet_legs.market, bet_legs.side/,
    );
    await expect(insert(teaser, 'moneyline', 'home', null)).rejects.toThrow(
      /one side pick per game/,
    );
  });
});
