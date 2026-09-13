import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BetResponse, PlaceBetRequest, UserResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { INITIAL_BANKROLL_CENTS, MAX_SETTLE_ATTEMPTS } from '../../src/shared/constants.js';
import { isAppError } from '../../src/shared/errors.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { gradeBet } from '../../src/shared/grading.js';
import { americanToPrice, formatDecimalOdds } from '../../src/shared/odds.js';
import { bankrollId } from '../../src/worker/bankroll.js';
import { placeBet } from '../../src/worker/bets.js';
import { isUniqueViolation } from '../../src/worker/db.js';
import { buildApp } from '../../src/worker/index.js';
import { upsertSlate } from '../../src/worker/ingest.js';
import { runJob } from '../../src/worker/jobs.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import {
  SETTLE_BET_UPDATE_SQL,
  SETTLE_LEG_UPDATE_SQL,
  SETTLE_PAYOUT_INSERT_SQL,
  SettleRunError,
  buildSettleBatch,
  deferBet,
  loadLegsForBets,
  pricingFor,
  resetDeferredBets,
  runSettle,
  selectSettleableBets,
  settleOneBet,
} from '../../src/worker/settle.js';
import type { SettleStats, SettleableBet } from '../../src/worker/settle.js';
import { buildScoreboard } from './fixtures.js';
import type { EventSpec } from './fixtures.js';
import { bankrollDrift, seedGameWithLine, seedLine, updateGame } from './seed.js';

/**
 * TDD contract for M6 — PLAN.md §7, §13, §14.5.
 *
 * ISOLATION, and why `beforeEach` cancels leftover pending bets.
 * `runSettle` selects from the WHOLE database, so — unlike `bets.spec.ts`, where
 * every assertion is scoped to one user — a bet left `pending` by an earlier test
 * in this file would be re-selected by a later test's run and pollute
 * `stats.selected` / `stats.deferred`. vitest-pool-workers gives each FILE fresh
 * storage but does not roll back between tests, and `ledger` has a BEFORE DELETE
 * trigger so nothing can be truncated. Flipping the leftovers to `cancelled`
 * removes them from the selection set and writes NO ledger row, so
 * `SUM(ledger) === balance_cents` keeps holding for every bankroll — which is
 * exactly the invariant these tests assert globally at the end of each scenario.
 *
 * Games are seeded with `lastSeenAt` in the PAST on purpose: `seedGame` writes
 * `updated_at = lastSeenAt ?? kickoffAt`, and a kickoff two hours in the future
 * would make `games.updated_at > bets.settle_attempted_at` true forever, so
 * `resetDeferredBets` would zero every deferred counter on the next run and the
 * head-of-line tests could never observe an increment.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const HOUR = 60 * 60 * 1000;

let NOW = 0;
let testIndex = 0;
let userSeq = 0;

/**
 * The FIRST account created in this file takes the `is_admin` flag (PLAN.md
 * §10), so it has to be claimed before any test registers its own user —
 * otherwise `/api/admin/*` would 404 for it. `beforeAll` here runs after
 * setup.ts's migration `beforeAll`.
 */
let ADMIN: Account;
beforeAll(async () => {
  ADMIN = await register();
});

beforeEach(async () => {
  NOW = Date.now();
  testIndex += 1;
  // See the header note: clear the selection set without touching money.
  await env.DB.prepare(
    `UPDATE bets SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1
      WHERE status = 'pending'`,
  )
    .bind(NOW)
    .run();
});

/** A game id unique to this test. Ids are `<league>:<providerEventId>`. */
function g(n: number | string): string {
  return `nfl:s${String(testIndex)}-${String(n)}`;
}

/* ------------------------------------------------------------------ *
 * HTTP + placement helpers
 * ------------------------------------------------------------------ */

function send(path: string, init: RequestInit): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, env));
}

function post(path: string, payload?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'X-SBS-Client': '1' };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers['cookie'] = cookie;
  return send(path, {
    method: 'POST',
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

interface Account {
  readonly cookie: string;
  readonly id: string;
}

async function register(): Promise<Account> {
  userSeq += 1;
  const res = await send('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
    body: JSON.stringify({
      username: `settler${String(userSeq)}`,
      dk: 'a'.repeat(64),
      inviteCode: INVITE,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const parsed = await res.json<UserResponse>();
  const raw = res.headers.get('set-cookie') ?? '';
  return { cookie: /sbs_session=[^;]*/.exec(raw)?.[0] ?? '', id: parsed.user.id };
}

/** Every market at ordinary prices, kicking off in two hours, seen a minute ago. */
async function seedScheduled(
  id: string,
  line: Partial<Parameters<typeof seedLine>[1]> = {},
): Promise<string> {
  return seedGameWithLine(
    env.DB,
    { id, kickoffAt: NOW + 2 * HOUR, lastSeenAt: NOW - 60_000 },
    line,
  );
}

/** Flip a seeded game to `final` with a score, the way ingestion would. */
function finalize(id: string, homeScore: number, awayScore: number): Promise<void> {
  return updateGame(env.DB, id, { status: 'final', homeScore, awayScore });
}

/** `games.updated_at` is what `resetDeferredBets` compares against. */
async function touchGame(id: string, updatedAt: number): Promise<void> {
  await env.DB.prepare(`UPDATE games SET updated_at = ?2 WHERE id = ?1`).bind(id, updatedAt).run();
}

/** The two stamps §8.5 keeps apart: "we saw it again" vs "the data changed". */
async function gameStamps(id: string): Promise<{ updated_at: number; last_seen_at: number }> {
  const row = await env.DB.prepare(`SELECT updated_at, last_seen_at FROM games WHERE id = ?1`)
    .bind(id)
    .first<{ updated_at: number; last_seen_at: number }>();
  if (row === null) throw new Error(`game ${id} should exist`);
  return row;
}

function spreadLeg(gameId: string): PlaceBetRequest['legs'][number] {
  return { gameId, market: 'spread', side: 'home' };
}
function mlLeg(gameId: string): PlaceBetRequest['legs'][number] {
  return { gameId, market: 'moneyline', side: 'home' };
}
function totalLeg(gameId: string): PlaceBetRequest['legs'][number] {
  return { gameId, market: 'total', side: 'over' };
}

async function place(
  userId: string,
  legs: PlaceBetRequest['legs'],
  stakeCents: number,
): Promise<string> {
  const req: PlaceBetRequest = {
    league: 'nfl',
    betType: legs.length === 1 ? 'straight' : 'parlay',
    stakeCents,
    legs,
  };
  const { bet } = await placeBet(env, userId, req, NOW);
  return bet.id;
}

/* ------------------------------------------------------------------ *
 * Row readers
 * ------------------------------------------------------------------ */

interface BetDbRow {
  id: string;
  bankroll_id: string;
  bet_type: string;
  leg_count: number;
  stake_cents: number;
  american_price: number;
  potential_payout_cents: number;
  status: string;
  payout_cents: number | null;
  settled_at: number | null;
  settle_run_id: string | null;
  settle_attempts: number;
  settle_attempted_at: number | null;
  settle_error: string | null;
}

async function betRow(id: string): Promise<BetDbRow> {
  const row = await env.DB.prepare(`SELECT * FROM bets WHERE id = ?1`).bind(id).first<BetDbRow>();
  if (row === null) throw new Error(`bet ${id} should exist`);
  return row;
}

interface LegDbRow {
  leg_index: number;
  game_id: string;
  american_price: number;
  result: string | null;
  graded_at: number | null;
}

async function legRows(betId: string): Promise<LegDbRow[]> {
  const res = await env.DB.prepare(
    `SELECT leg_index, game_id, american_price, result, graded_at
       FROM bet_legs WHERE bet_id = ?1 ORDER BY leg_index`,
  )
    .bind(betId)
    .all<LegDbRow>();
  return [...res.results];
}

interface LedgerDbRow {
  id: string;
  kind: string;
  amount_cents: number;
}

async function ledgerRows(betId: string, kind?: string): Promise<LedgerDbRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, kind, amount_cents FROM ledger
      WHERE bet_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY created_at, id`,
  )
    .bind(betId, kind ?? null)
    .all<LedgerDbRow>();
  return [...res.results];
}

async function balance(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance_cents AS b FROM bankrolls WHERE id = ?1`)
    .bind(bankrollId(userId, 'nfl', 2026))
    .first<{ b: number }>();
  return row?.b ?? -1;
}

/** PLAN.md §4.1's headline invariant, for EVERY bankroll in the database. */
async function expectNoDrift(): Promise<void> {
  expect(await bankrollDrift(env.DB)).toEqual([]);
}

/** Reconstruct the selection-query row shape for a direct `settleOneBet` call. */
async function settleableBetOf(betId: string): Promise<SettleableBet> {
  const row = await betRow(betId);
  return {
    id: row.id,
    bankrollId: row.bankroll_id,
    stakeCents: row.stake_cents,
    betType: row.bet_type,
    legCount: row.leg_count,
  };
}

/* ------------------------------------------------------------------ *
 * Fault injection
 * ------------------------------------------------------------------ */

/**
 * Make the next `count` `env.DB.batch()` calls reject, then behave normally.
 * Returns the restore function; ALWAYS call it in a `finally`.
 *
 * Fault injection is the only way into `runSettle`'s catch block. Every guard in
 * the settlement batch is a `WHERE`, so a bet that is already settled, or that
 * lost the race, writes zero rows and throws nothing — the catch is reserved for
 * a real D1 failure, which no amount of seeding can provoke.
 */
function breakNextBatches(count: number): () => void {
  const real = env.DB.batch.bind(env.DB);
  let left = count;
  const patched = <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    if (left > 0) {
      left -= 1;
      return Promise.reject(new Error('D1_ERROR: connection lost while committing'));
    }
    return real<T>(statements);
  };
  (env.DB as { batch: D1Database['batch'] }).batch = patched;
  return () => {
    (env.DB as { batch: D1Database['batch'] }).batch = real;
  };
}

/** `runSettle`, returning the stats whether or not it threw `SettleRunError`. */
async function runSettleExpectingErrors(now: number, chunk: number): Promise<SettleStats> {
  try {
    await runSettle(env, now, chunk);
  } catch (err) {
    if (err instanceof SettleRunError) return err.stats;
    throw err;
  }
  throw new Error('runSettle should have thrown SettleRunError');
}

/* ------------------------------------------------------------------ *
 * Real M4 ingestion, for the tests that must not fake `games.updated_at`
 * ------------------------------------------------------------------ */

/** Parse a synthesised ESPN slate exactly the way the refresh job would. */
function makeSlate(specs: readonly EventSpec[], fetchedAt: number): ProviderSlate {
  const parsed = parseScoreboard(buildScoreboard(specs), 'nfl', fetchedAt);
  return {
    games: parsed.games,
    lines: parsed.lines,
    warnings: parsed.warnings,
    fetchedAt,
    season: parsed.season,
    week: parsed.week,
  };
}

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

describe('runSettle — outcomes', () => {
  it('a straight win pays stake + profit and writes one bet_payout row', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17); // home -3.5 covers

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(1);
    expect(stats.settled).toBe(1);
    expect(stats.won).toBe(1);

    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    // REPL: floor(2500 * 210/110) = 4772 (PLAN.md §5.4, row 1).
    expect(bet.payout_cents).toBe(4772);
    expect(bet.settled_at).toBe(NOW + 1);
    expect(bet.settle_run_id).not.toBeNull();

    const payouts = await ledgerRows(betId, 'bet_payout');
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.amount_cents).toBe(4772);
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS - 2500 + 4772);
    await expectNoDrift();
  });

  it('a straight loss writes NO ledger row (the stake already debited it)', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 17, 31);

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.lost).toBe(1);

    const bet = await betRow(betId);
    expect(bet.status).toBe('lost');
    expect(bet.payout_cents).toBe(0);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(0);
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    await expectNoDrift();
  });

  it('a straight push returns the stake', async () => {
    const user = await register();
    // A WHOLE-number spread is the only one that can push: half-point lines are
    // exactly representable in tenths, so -35 can never land on margin10 === 0.
    const gid = await seedScheduled(g(1), { spreadHomeTenths: -30, spreadAwayTenths: 30 });
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 24, 21); // home by exactly 3

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.push).toBe(1);

    const bet = await betRow(betId);
    expect(bet.status).toBe('push');
    expect(bet.payout_cents).toBe(2500);
    expect(bet.american_price).toBe(100);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS);
    await expectNoDrift();
  });

  it('a canceled game voids the leg and returns the stake', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'canceled' });

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.void).toBe(1);

    const bet = await betRow(betId);
    expect(bet.status).toBe('void');
    expect(bet.payout_cents).toBe(2500);
    expect((await legRows(betId))[0]?.result).toBe('void');
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS);
    await expectNoDrift();
  });

  it('a parlay with a pushed leg is re-priced from the remaining legs', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const c = await seedScheduled(g(3), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), spreadLeg(b), mlLeg(c)], 1000);

    await finalize(a, 31, 17);
    await finalize(b, 28, 10);
    await finalize(c, 21, 21); // moneyline tie -> push

    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    // REPL (PLAN.md §5.4): 3 legs -110/-110/+150 @1000 -> 9111 @ +811;
    // leg 3 pushes -> 44100/12100 -> floor(1000 * 44100/12100) = 3644 @ +264.
    expect(bet.potential_payout_cents).toBe(9111);
    expect(bet.payout_cents).toBe(3644);
    expect(bet.american_price).toBe(264);
    expect((await legRows(betId)).map((l) => l.result)).toEqual(['win', 'win', 'push']);
    await expectNoDrift();
  });

  it('a parlay with a loss and pushes LOSES', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2), { totalTenths: 450 });
    const betId = await place(user.id, [spreadLeg(a), totalLeg(b)], 1000);

    await finalize(a, 17, 31); // leg 1 loses
    await finalize(b, 24, 21); // 45 total -> push on o45

    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('lost');
    expect(bet.payout_cents).toBe(0);
    expect((await legRows(betId)).map((l) => l.result)).toEqual(['loss', 'push']);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(0);
    await expectNoDrift();
  });

  it('persists per-leg results only when the whole bet settles', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const betId = await place(user.id, [mlLeg(a), mlLeg(b)], 1000);

    await finalize(a, 31, 17); // only ONE leg is final
    await runSettle(env, NOW + 1, 20);
    expect((await legRows(betId)).map((l) => l.result)).toEqual([null, null]);

    await finalize(b, 28, 10);
    await runSettle(env, NOW + 2, 20);
    expect((await legRows(betId)).map((l) => l.result)).toEqual(['win', 'win']);
    expect((await legRows(betId)).every((l) => l.graded_at === NOW + 2)).toBe(true);
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * Partial / pending
 * ------------------------------------------------------------------ */

describe('runSettle — partial and pending', () => {
  it('a parlay with 3 final and 2 in-progress legs stays pending', async () => {
    const user = await register();
    const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => seedScheduled(g(n))));
    const betId = await place(
      user.id,
      ids.map((id) => mlLeg(id)),
      1000,
    );
    for (const id of ids.slice(0, 3)) await finalize(id, 31, 17);
    for (const id of ids.slice(3)) await updateGame(env.DB, id, { status: 'in_progress' });

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(0);
    expect((await betRow(betId)).status).toBe('pending');
  });

  it('...and writes NOTHING: no leg results, no status change, no ledger row', async () => {
    const user = await register();
    const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => seedScheduled(g(n))));
    const betId = await place(
      user.id,
      ids.map((id) => mlLeg(id)),
      1000,
    );
    for (const id of ids.slice(0, 3)) await finalize(id, 31, 17);
    for (const id of ids.slice(3)) await updateGame(env.DB, id, { status: 'in_progress' });

    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('pending');
    expect(bet.payout_cents).toBeNull();
    expect(bet.settle_run_id).toBeNull();
    // Not even the head-of-line counter: the bet was never SELECTED.
    expect(bet.settle_attempts).toBe(0);
    expect(bet.settle_attempted_at).toBeNull();
    expect((await legRows(betId)).every((l) => l.result === null)).toBe(true);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(0);
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS - 1000);
    await expectNoDrift();
  });

  it('a postponed game keeps the bet pending (it may still be played)', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'postponed' });

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(0);
    const bet = await betRow(betId);
    expect(bet.status).toBe('pending');
    expect(bet.settle_attempts).toBe(0);
  });

  it('a final game with a null score leaves the bet pending', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' }); // scores never parsed

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(1);
    expect(stats.deferred).toBe(1);
    expect(stats.settled).toBe(0);

    const bet = await betRow(betId);
    expect(bet.status).toBe('pending');
    expect(bet.payout_cents).toBeNull();
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(0);
    await expectNoDrift();
  });

  it('a leg whose game row vanished is DEFERRED, never paid (leg-count guard)', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const betId = await place(user.id, [mlLeg(a), mlLeg(b)], 1000);
    await finalize(a, 31, 17);
    await finalize(b, 28, 10);

    // §7.2's query is an INNER JOIN, so a missing `games` row silently drops the
    // leg and a 2-leg parlay would grade — and PAY — as a 1-leg bet.
    await env.DB.prepare(`DELETE FROM bet_legs WHERE bet_id = ?1 AND leg_index = 1`)
      .bind(betId)
      .run();
    await env.DB.prepare(`DELETE FROM games WHERE id = ?1`).bind(b).run();

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(1);
    expect(stats.deferred).toBe(1);

    const bet = await betRow(betId);
    expect(bet.status).toBe('pending');
    expect(bet.settle_attempts).toBe(1);
    expect(bet.settle_error).toMatch(/leg/i);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(0);
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * Head-of-line blocking
 * ------------------------------------------------------------------ */

describe('runSettle — head-of-line blocking', () => {
  it('a selected-but-ungradeable bet increments settle_attempts and records settle_error', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });

    await runSettle(env, NOW + 1, 20);
    expect((await betRow(betId)).settle_attempts).toBe(1);
    expect((await betRow(betId)).settle_error).toContain('score');

    await runSettle(env, NOW + 2, 20);
    expect((await betRow(betId)).settle_attempts).toBe(2);
  });

  it('...and stamps settle_attempted_at', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });

    await runSettle(env, NOW + 7, 20);
    expect((await betRow(betId)).settle_attempted_at).toBe(NOW + 7);
  });

  it('...and changes no money, no bet status and no leg results', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });

    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('pending');
    expect(bet.payout_cents).toBeNull();
    expect(bet.settled_at).toBeNull();
    expect(bet.settle_run_id).toBeNull();
    expect((await legRows(betId)).every((l) => l.result === null && l.graded_at === null)).toBe(
      true,
    );
    expect(await ledgerRows(betId)).toHaveLength(1); // the placement stake only
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    await expectNoDrift();
  });

  it('selection orders by settle_attempts ASC, so fresh bets are never starved', async () => {
    const user = await register();
    const stale = await seedScheduled(g(1));
    const fresh = await seedScheduled(g(2));
    const staleBet = await place(user.id, [spreadLeg(stale)], 100);
    const freshBet = await place(user.id, [spreadLeg(fresh)], 100);
    await env.DB.prepare(
      `UPDATE bets SET settle_attempts = 5, settle_attempted_at = ?2
                           WHERE id = ?1`,
    )
      .bind(staleBet, NOW)
      .run();
    await updateGame(env.DB, stale, { status: 'final' });
    await finalize(fresh, 31, 17);

    const selected = await selectSettleableBets(env, 20, MAX_SETTLE_ATTEMPTS);
    expect(selected.map((b) => b.id)).toEqual([freshBet, staleBet]);
  });

  it('20 undecidable bets at the head of the queue do NOT prevent a settleable bet behind them from settling on the very next run', async () => {
    const user = await register();
    const blockers: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const gid = await seedGameWithLine(env.DB, {
        id: g(`b${String(i)}`),
        kickoffAt: NOW + HOUR, // strictly EARLIER than the good bet's game
        lastSeenAt: NOW - 60_000,
      });
      blockers.push(await place(user.id, [spreadLeg(gid)], 100));
      await updateGame(env.DB, gid, { status: 'final' }); // final, no score: undecidable
    }
    const goodGame = await seedScheduled(g('good'));
    const goodBet = await place(user.id, [spreadLeg(goodGame)], 100);
    await finalize(goodGame, 31, 17);

    const first = await runSettle(env, NOW + 1, 20);
    expect(first.selected).toBe(20);
    expect(first.deferred).toBe(20);
    expect(first.settled).toBe(0);
    expect((await betRow(goodBet)).status).toBe('pending');

    // Second run: every blocker now has settle_attempts = 1 and the good bet 0,
    // so `ORDER BY settle_attempts ASC` puts it first.
    const second = await runSettle(env, NOW + 2, 20);
    expect(second.settled).toBe(1);
    expect((await betRow(goodBet)).status).toBe('won');
    expect(blockers).toHaveLength(20);
    await expectNoDrift();
  });

  it('a bet at MAX_SETTLE_ATTEMPTS (96 = 24h) is skipped and reported in stats.stuck[]', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await env.DB.prepare(
      `UPDATE bets SET settle_attempts = ?2, settle_attempted_at = ?3 WHERE id = ?1`,
    )
      .bind(betId, MAX_SETTLE_ATTEMPTS, NOW)
      .run();

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.selected).toBe(0);
    expect(stats.stuck).toContain(betId);

    const bet = await betRow(betId);
    expect(bet.status).toBe('pending'); // money is never silently forfeited
    expect(bet.settle_attempts).toBe(MAX_SETTLE_ATTEMPTS);
  });
});

/* ------------------------------------------------------------------ *
 * Deferred-bet reset
 * ------------------------------------------------------------------ */

describe('runSettle — deferred-bet reset (no permanent parking)', () => {
  it('resetDeferredBets zeroes settle_attempts when a leg game updated_at advanced', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await deferBet(env, betId, 'unusable score', NOW);

    await touchGame(gid, NOW + 1_000); // ESPN republished

    expect((await resetDeferredBets(env)).reset).toBe(1);
    const bet = await betRow(betId);
    expect(bet.settle_attempts).toBe(0);
    expect(bet.settle_error).toBeNull();
  });

  it('...and leaves settle_attempts alone when no leg game changed', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await deferBet(env, betId, 'unusable score', NOW);

    expect((await resetDeferredBets(env)).reset).toBe(0);
    expect((await betRow(betId)).settle_attempts).toBe(1);
  });

  it('a bet parked at 96 attempts recovers on the next run once ESPN republishes a score', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await env.DB.prepare(
      `UPDATE bets SET settle_attempts = ?2, settle_attempted_at = ?3, settle_error = 'stuck'
        WHERE id = ?1`,
    )
      .bind(betId, MAX_SETTLE_ATTEMPTS, NOW)
      .run();

    // Parked: the selection query will not see it.
    expect((await runSettle(env, NOW + 1, 20)).selected).toBe(0);

    await finalize(gid, 31, 17);
    await touchGame(gid, NOW + 2);

    const stats = await runSettle(env, NOW + 3, 20);
    expect(stats.reset).toBe(1);
    expect(stats.settled).toBe(1);
    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.payout_cents).toBe(4772);
    await expectNoDrift();
  });

  it('POST /api/admin/bets/:id/retry-settlement clears the counter manually', async () => {
    const gid = await seedScheduled(g(1));
    const betId = await place(ADMIN.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await deferBet(env, betId, 'unusable score', NOW);

    const res = await post(`/api/admin/bets/${betId}/retry-settlement`, undefined, ADMIN.cookie);
    expect(res.status, await res.clone().text()).toBe(204);

    const bet = await betRow(betId);
    expect(bet.settle_attempts).toBe(0);
    expect(bet.settle_error).toBeNull();
    expect(bet.status).toBe('pending');
    expect(bet.payout_cents).toBeNull();
  });

  it('retry-settlement is 409 BET_NOT_PENDING once the bet has settled', async () => {
    const gid = await seedScheduled(g(1));
    const betId = await place(ADMIN.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);
    expect((await betRow(betId)).status).toBe('won');

    const res = await post(`/api/admin/bets/${betId}/retry-settlement`, undefined, ADMIN.cookie);
    expect(res.status, await res.clone().text()).toBe(409);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('BET_NOT_PENDING');

    // ...and the escape hatch touched nothing: it is a counter reset, not an
    // un-settle. Re-queuing a paid bet would be a second payout waiting to
    // happen, which is why the route refuses instead of clamping.
    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.payout_cents).toBe(4772);
    expect(bet.settle_attempts).toBe(0);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    await expectNoDrift();
  });

  it('retry-settlement is 404 for an unknown bet and for a non-admin caller', async () => {
    const other = await register();
    const missing = await post('/api/admin/bets/nope/retry-settlement', undefined, ADMIN.cookie);
    expect(missing.status).toBe(404);
    expect((await missing.json<ApiErrorBody>()).error.code).toBe('BET_NOT_FOUND');

    const gid = await seedScheduled(g(1));
    const betId = await place(ADMIN.id, [spreadLeg(gid)], 2500);
    const forbidden = await post(
      `/api/admin/bets/${betId}/retry-settlement`,
      undefined,
      other.cookie,
    );
    expect(forbidden.status).toBe(404);
    expect((await forbidden.json<ApiErrorBody>()).error.code).toBe('NOT_FOUND');
  });

  it('the reset never changes status, payout or any ledger row', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' });
    await deferBet(env, betId, 'unusable score', NOW);
    await touchGame(gid, NOW + 1_000);

    const before = await betRow(betId);
    await resetDeferredBets(env);
    const after = await betRow(betId);

    expect(after.status).toBe(before.status);
    expect(after.payout_cents).toBe(before.payout_cents);
    expect(after.settle_run_id).toBe(before.settle_run_id);
    expect(await ledgerRows(betId)).toHaveLength(1);
    await expectNoDrift();
  });

  it("the reset sweep's writes are counted in stats.rowsWritten", async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await updateGame(env.DB, gid, { status: 'final' }); // final, unusable score
    await deferBet(env, betId, 'unusable score', NOW);

    // ESPN republishes the game as POSTPONED: `updated_at` advances, so the
    // reset fires — but the bet then fails the selection query, so the reset is
    // the ONLY thing this run writes. That isolation is the point: while
    // `rowsWritten` summed only the per-bet work, this run reported zero rows
    // written and `jobs.ts::dayRowsWritten` under-counted the settle job's share
    // of the hard-enforced 100,000-rows-per-day cap by one sweep per run.
    await updateGame(env.DB, gid, { status: 'postponed' });
    await touchGame(gid, NOW + 1_000);

    const stats = await runSettle(env, NOW + 2_000, 20);
    expect(stats.reset).toBe(1);
    expect(stats.selected).toBe(0);
    expect(stats.settled).toBe(0);
    expect(stats.deferred).toBe(0);
    expect(stats.rowsWritten).toBeGreaterThan(0);
    expect((await betRow(betId)).settle_attempts).toBe(0);

    // A run that resets nothing writes nothing.
    const quiet = await runSettle(env, NOW + 3_000, 20);
    expect(quiet.reset).toBe(0);
    expect(quiet.rowsWritten).toBe(0);
  });

  it('re-ingesting an IDENTICAL slate through M4 does NOT reset the counter, but a changed score does', async () => {
    // The 96-attempt cap rests entirely on `games.updated_at` meaning "the data
    // changed", never "we saw it again" (§8.5's L1 `CASE` vs its L3 touch). The
    // other tests in this describe drive `updated_at` with a raw UPDATE, which
    // would keep passing if ingestion started stamping it on every refresh — and
    // then `resetDeferredBets` would zero every counter on every run, the cap
    // would be unreachable and `stats.stuck[]` would never fire. So this one
    // goes through the REAL `upsertSlate`.
    const user = await register();
    const eventId = `s${String(testIndex)}-ingest`;
    const gid = `nfl:${eventId}`;
    const base = {
      eventId,
      league: 'nfl',
      kickoffAt: NOW + 2 * HOUR,
      homeAbbr: 'SEA',
      awayAbbr: 'NE',
      // ESPN publishes no score at all for this game until the very last slate,
      // which is what makes the bet undecidable and therefore deferrable. (A
      // pre-game ESPN score is the STRING "0", so leaving this off would seed a
      // real 0-0 and the bet would simply grade as a loss.)
      omitScores: true,
      odds: { spreadHome: -3.5, total: 45.5, mlHome: -198, mlAway: 164 },
    } satisfies Omit<EventSpec, 'status'>;

    await upsertSlate(env, makeSlate([{ ...base, status: 'pre' }], NOW), NOW);
    const betId = await place(user.id, [spreadLeg(gid)], 2500);

    // The game goes final with no score ESPN will admit to: undecidable.
    const finalNoScore: EventSpec = { ...base, status: 'post' };
    await upsertSlate(env, makeSlate([finalNoScore], NOW + 1), NOW + 1);

    const deferredRun = await runSettle(env, NOW + 2, 20);
    expect(deferredRun.deferred).toBe(1);
    expect((await betRow(betId)).settle_attempts).toBe(1);

    // Seven hours later ESPN serves the very same payload again. That is past
    // GAME_SEEN_TOUCH_MS, so L3 really does WRITE the row (asserted below via
    // `last_seen_at`) — and `updated_at` must stay put anyway.
    const seenAgainAt = NOW + 2 + 7 * HOUR;
    const before = await gameStamps(gid);
    await upsertSlate(env, makeSlate([finalNoScore], seenAgainAt), seenAgainAt);
    const after = await gameStamps(gid);
    expect(after.last_seen_at).toBe(seenAgainAt); // the touch happened...
    expect(after.updated_at).toBe(before.updated_at); // ...and changed nothing
    expect((await resetDeferredBets(env)).reset).toBe(0);
    expect((await betRow(betId)).settle_attempts).toBe(1);

    // Now a REAL change — the score finally parses — and the bet gets a fresh
    // 24-hour budget on the very next run.
    const publishedAt = seenAgainAt + HOUR;
    await upsertSlate(
      env,
      makeSlate(
        [{ ...base, status: 'post', omitScores: false, homeScore: 31, awayScore: 17 }],
        publishedAt,
      ),
      publishedAt,
    );
    expect((await gameStamps(gid)).updated_at).toBe(publishedAt);
    expect((await resetDeferredBets(env)).reset).toBe(1);

    const settledRun = await runSettle(env, publishedAt + 1, 20);
    expect(settledRun.settled).toBe(1);
    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.payout_cents).toBe(4772);
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * Effective-price write-back
 * ------------------------------------------------------------------ */

describe('runSettle — effective price write-back', () => {
  it('a parlay with a pushed leg has american_price REWRITTEN to the surviving legs, and -110/-110/+150 with leg 3 pushed pays 3644 AND displays +264, not +811', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const c = await seedScheduled(g(3), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), spreadLeg(b), mlLeg(c)], 1000);
    expect((await betRow(betId)).american_price).toBe(811);

    await finalize(a, 31, 17);
    await finalize(b, 28, 10);
    await finalize(c, 21, 21);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.payout_cents).toBe(3644);
    expect(bet.american_price).toBe(264);
  });

  it('a push/void outcome writes american_price = 100 (even money) and payout = stake', async () => {
    const user = await register();
    const a = await seedScheduled(g(1), { spreadHomeTenths: -30, spreadAwayTenths: 30 });
    const b = await seedScheduled(g(2), { totalTenths: 450 });
    const betId = await place(user.id, [spreadLeg(a), totalLeg(b)], 1000);
    await finalize(a, 24, 21);
    await finalize(b, 24, 21);

    await runSettle(env, NOW + 1, 20);
    const bet = await betRow(betId);
    expect(bet.status).toBe('push');
    expect(bet.american_price).toBe(100);
    expect(bet.payout_cents).toBe(1000);
    await expectNoDrift();
  });

  it('a losing bet KEEPS its placement price', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), mlLeg(b)], 1000);
    const placed = (await betRow(betId)).american_price;

    await finalize(a, 17, 31);
    await finalize(b, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('lost');
    expect(bet.american_price).toBe(placed);
  });

  it('a fully-won parlay keeps its placement price', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), mlLeg(b)], 1000);
    const placed = (await betRow(betId)).american_price;

    await finalize(a, 31, 17);
    await finalize(b, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.american_price).toBe(placed);
    // REPL: -110 x +150 = 52500/11000 -> floor(1000 * 52500/11000) = 4772 @ +377.
    expect(placed).toBe(377);
    expect(bet.payout_cents).toBe(4772);
    await expectNoDrift();
  });

  it('BetView.decimalOdds is derived from the stored americanPrice', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const c = await seedScheduled(g(3), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), spreadLeg(b), mlLeg(c)], 1000);
    await finalize(a, 31, 17);
    await finalize(b, 28, 10);
    await finalize(c, 21, 21);
    await runSettle(env, NOW + 1, 20);

    const res = await send(`/api/bets/${betId}`, {
      method: 'GET',
      headers: { cookie: user.cookie },
    });
    expect(res.status).toBe(200);
    const { bet } = await res.json<BetResponse>();
    expect(bet.americanPrice).toBe(264);
    expect(bet.decimalOdds).toBe(formatDecimalOdds(americanToPrice(264)));
  });

  it('payout_cents <= potential_payout_cents always, so the MAX_PAYOUT_CENTS CHECK can never abort a settlement batch', async () => {
    const user = await register();
    const a = await seedScheduled(g(1));
    const b = await seedScheduled(g(2));
    const c = await seedScheduled(g(3), { mlHomePrice: 150 });
    const betId = await place(user.id, [spreadLeg(a), spreadLeg(b), mlLeg(c)], 1000);
    await finalize(a, 31, 17);
    await finalize(b, 28, 10);
    await finalize(c, 21, 21);
    await runSettle(env, NOW + 1, 20);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bets
        WHERE payout_cents IS NOT NULL AND payout_cents > potential_payout_cents`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect((await betRow(betId)).payout_cents).toBeLessThanOrEqual(
      (await betRow(betId)).potential_payout_cents,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Price recomputation
 * ------------------------------------------------------------------ */

describe('runSettle — price recomputation', () => {
  it('the payout is computed from bet_legs.american_price, not from any stored rational', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    // Corrupt the DISPLAY price. The payout must still come from the legs.
    await env.DB.prepare(`UPDATE bets SET american_price = 99999 WHERE id = ?1`).bind(betId).run();
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.payout_cents).toBe(4772); // from the leg's -110, not from 99999
    expect(bet.american_price).toBe(-110); // ...and the display price is rewritten
    expect((await legRows(betId))[0]?.american_price).toBe(-110);
  });

  it('bets has no price_num/price_den columns at all', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bets'`,
    ).first<{ sql: string }>();
    expect(row?.sql).toBeTypeOf('string');
    expect(row?.sql).not.toMatch(/price_num|price_den|decimal_odds/);
  });

  it('a 10-leg parlay payout is exact and never touches a REAL value', async () => {
    const user = await register();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await seedScheduled(g(`p${String(i)}`), { mlHomePrice: -110 }));
    }
    const betId = await place(
      user.id,
      ids.map((id) => mlLeg(id)),
      INITIAL_BANKROLL_CENTS,
    );
    for (const id of ids) await finalize(id, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    // REPL (PLAN.md §5.4, row 6): floor(100000 * (210/110)^10) = 64308161.
    expect(bet.payout_cents).toBe(64308161);
    expect(Number.isSafeInteger(bet.payout_cents)).toBe(true);
    const typed = await env.DB.prepare(
      `SELECT typeof(payout_cents) AS t, typeof(american_price) AS a FROM bets WHERE id = ?1`,
    )
      .bind(betId)
      .first<{ t: string; a: string }>();
    expect(typed?.t).toBe('integer');
    expect(typed?.a).toBe('integer');
    await expectNoDrift();
  });

  it('a payout that would exceed MAX_PAYOUT_CENTS cannot occur (rejected at placement)', async () => {
    const user = await register();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await seedScheduled(g(`x${String(i)}`), { mlHomePrice: 2000 }));
    }
    let code = 'none';
    try {
      await place(
        user.id,
        ids.map((id) => mlLeg(id)),
        INITIAL_BANKROLL_CENTS,
      );
    } catch (err) {
      code = isAppError(err) ? err.code : 'other';
    }
    expect(code).toBe('PAYOUT_LIMIT_EXCEEDED');
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency and crash safety
 * ------------------------------------------------------------------ */

describe('runSettle — idempotency', () => {
  it('running twice pays exactly once (ledger row count and balance unchanged)', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);

    await runSettle(env, NOW + 1, 20);
    const afterFirst = await balance(user.id);
    const runId = (await betRow(betId)).settle_run_id;

    const second = await runSettle(env, NOW + 2, 20);
    expect(second.selected).toBe(0); // the bet is no longer `pending`
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    expect(await balance(user.id)).toBe(afterFirst);
    expect((await betRow(betId)).settle_run_id).toBe(runId);
    expect((await betRow(betId)).settled_at).toBe(NOW + 1);
    await expectNoDrift();
  });

  it('a second run reports skippedAlreadySettled, not an error', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);

    // Replay the SAME bet through the per-bet path, as a racing run would.
    const bet = await settleableBetOf(betId);
    const legs = await loadLegsForBets(env, [betId]);
    const outcome = gradeBet(
      bet.stakeCents,
      legs.map((l) => l.snapshot),
      new Map(legs.map((l) => [l.snapshot.gameId, l.game])),
    );
    const replay = await settleOneBet(env, bet, outcome, 'a-different-run', NOW + 2);
    expect(replay.result).toBe('already-settled');
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    await expectNoDrift();
  });

  it('a concurrent run losing the settle_run_id race writes nothing', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const winnerRunId = (await betRow(betId)).settle_run_id;
    const gradedAt = (await legRows(betId))[0]?.graded_at;

    const bet = await settleableBetOf(betId);
    const legs = await loadLegsForBets(env, [betId]);
    const outcome = gradeBet(
      bet.stakeCents,
      legs.map((l) => l.snapshot),
      new Map(legs.map((l) => [l.snapshot.gameId, l.game])),
    );
    await settleOneBet(env, bet, outcome, 'loser-run', NOW + 5);

    expect((await betRow(betId)).settle_run_id).toBe(winnerRunId);
    expect((await legRows(betId))[0]?.graded_at).toBe(gradedAt);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    await expectNoDrift();
  });

  it('the ledger UNIQUE(bankroll_id, kind, ref_id) is the final backstop', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);

    let thrown: unknown = null;
    try {
      await env.DB.prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'bet_payout', ?3, ?3, 4772, ?4, 'double pay')`,
      )
        .bind(crypto.randomUUID(), bankrollId(user.id, 'nfl', 2026), betId, NOW + 9)
        .run();
    } catch (err) {
      thrown = err;
    }
    expect(isUniqueViolation(thrown, 'ledger.bankroll_id')).toBe(true);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    await expectNoDrift();
  });

  it('the per-bet batch is ONE batch whose guards are the documented three layers', () => {
    expect(SETTLE_BET_UPDATE_SQL).toContain("status = 'pending'");
    expect(SETTLE_LEG_UPDATE_SQL).toContain('settle_run_id = ?');
    expect(SETTLE_PAYOUT_INSERT_SQL).toContain('NOT EXISTS');
    // Layer 2 on the MONEY statement, not just on the leg updates. Without it a
    // run that lost the conditional transition would still be free to insert the
    // payout row on the strength of the `NOT EXISTS` alone, racing the winner
    // into the ledger with its own `amount_cents`.
    expect(SETTLE_PAYOUT_INSERT_SQL).toContain('settle_run_id = ?');
    expect(SETTLE_PAYOUT_INSERT_SQL).not.toMatch(/INSERT\s+OR\s+(IGNORE|REPLACE)/i);

    // 1 bet UPDATE + 10 leg UPDATEs + 1 ledger INSERT = 12, well under the
    // 40-statement budget `runBatch` enforces.
    const bet: SettleableBet = {
      id: 'b',
      bankrollId: 'bk',
      stakeCents: 1000,
      betType: 'parlay',
      legCount: 10,
    };
    const outcome = {
      status: 'won' as const,
      payoutCents: 2000,
      legs: Array.from({ length: 10 }, (_v, i) => ({
        legIndex: i,
        grade: 'win' as const,
        price: americanToPrice(-110),
      })),
      effectivePrice: americanToPrice(-110),
    };
    expect(buildSettleBatch(env, bet, outcome, 'run', NOW)).toHaveLength(12);
  });

  it('crash mid-run: every bet is fully settled or fully pending, never half', async () => {
    const user = await register();
    const first = await seedGameWithLine(env.DB, {
      id: g('early'),
      kickoffAt: NOW + HOUR,
      lastSeenAt: NOW - 60_000,
    });
    const second = await seedScheduled(g('late'));
    const betA = await place(user.id, [spreadLeg(first)], 100);
    const betB = await place(user.id, [spreadLeg(second)], 100);
    await finalize(first, 31, 17);
    await finalize(second, 31, 17);

    // A chunk of 1 is exactly "the Worker died after the first bet's batch".
    const partial = await runSettle(env, NOW + 1, 1);
    expect(partial.selected).toBe(1);
    expect(partial.settled).toBe(1);

    const a = await betRow(betA);
    const b = await betRow(betB);
    expect(a.status).toBe('won');
    expect(a.payout_cents).toBe(190);
    expect((await legRows(betA))[0]?.result).toBe('win');
    expect(await ledgerRows(betA, 'bet_payout')).toHaveLength(1);
    // ...and the one it never reached is UNTOUCHED, not half-written.
    expect(b.status).toBe('pending');
    expect(b.payout_cents).toBeNull();
    expect(b.settle_run_id).toBeNull();
    expect((await legRows(betB))[0]?.result).toBeNull();
    expect(await ledgerRows(betB, 'bet_payout')).toHaveLength(0);

    const rest = await runSettle(env, NOW + 2, 20);
    expect(rest.settled).toBe(1);
    expect((await betRow(betB)).status).toBe('won');
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot immutability (CLAUDE.md rule 7)
 * ------------------------------------------------------------------ */

describe('runSettle — snapshot immutability', () => {
  it('mutating game_lines AFTER placement does not change the payout', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);

    // The book moves hard against the bettor AFTER the ticket is written.
    await seedLine(env.DB, {
      gameId: gid,
      spreadHomeTenths: -200,
      spreadHomePrice: -5000,
      spreadAwayTenths: 200,
      spreadAwayPrice: 3000,
      seenAt: NOW,
    });
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);

    const bet = await betRow(betId);
    expect(bet.status).toBe('won'); // graded against the snapshot's -3.5, not -20
    expect(bet.payout_cents).toBe(4772); // ...and priced at the snapshot's -110
  });

  it('deleting the game_lines row entirely does not prevent settlement', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await env.DB.prepare(`DELETE FROM game_lines WHERE game_id = ?1`).bind(gid).run();
    await finalize(gid, 31, 17);

    await runSettle(env, NOW + 1, 20);
    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.payout_cents).toBe(4772);
    await expectNoDrift();
  });

  it('settle.ts never reads game_lines (module-boundary assertion)', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);

    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: D1Database['prepare'] }).prepare = (sql: string) => {
      seen.push(sql);
      return real(sql);
    };
    try {
      await runSettle(env, NOW + 1, 20);
    } finally {
      (env.DB as { prepare: D1Database['prepare'] }).prepare = real;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((sql) => /game_lines/i.test(sql))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Invariants
 * ------------------------------------------------------------------ */

describe('runSettle — invariants', () => {
  it('SUM(ledger.amount_cents) === bankrolls.balance_cents after every scenario', async () => {
    const user = await register();
    const win = await seedScheduled(g(1));
    const loss = await seedScheduled(g(2));
    const push = await seedScheduled(g(3), { spreadHomeTenths: -30, spreadAwayTenths: 30 });
    const dead = await seedScheduled(g(4));
    const wins = await place(user.id, [spreadLeg(win)], 500);
    const losses = await place(user.id, [spreadLeg(loss)], 500);
    const pushes = await place(user.id, [spreadLeg(push)], 500);
    const voids = await place(user.id, [spreadLeg(dead)], 500);

    await finalize(win, 31, 17);
    await finalize(loss, 17, 31);
    await finalize(push, 24, 21);
    await updateGame(env.DB, dead, { status: 'canceled' });

    const stats = await runSettle(env, NOW + 1, 20);
    expect(stats.settled).toBe(4);
    expect(stats.paidCents).toBe(954 + 0 + 500 + 500);
    expect(await balance(user.id)).toBe(INITIAL_BANKROLL_CENTS - 2000 + 954 + 500 + 500);
    expect([wins, losses, pushes, voids]).toHaveLength(4);
    await expectNoDrift();
  });

  it('balance never goes negative', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    await place(user.id, [spreadLeg(gid)], INITIAL_BANKROLL_CENTS);
    await finalize(gid, 17, 31);
    await runSettle(env, NOW + 1, 20);
    expect(await balance(user.id)).toBe(0);
    const negative = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bankrolls WHERE balance_cents < 0`,
    ).first<{ n: number }>();
    expect(negative?.n).toBe(0);
  });

  it('chunking at SETTLE_CHUNK leaves the remainder for the next run', async () => {
    const user = await register();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const gid = await seedGameWithLine(env.DB, {
        id: g(`c${String(i)}`),
        kickoffAt: NOW + HOUR + i * 1_000,
        lastSeenAt: NOW - 60_000,
      });
      ids.push(await place(user.id, [spreadLeg(gid)], 100));
      await finalize(gid, 31, 17);
    }
    const first = await runSettle(env, NOW + 1, 2);
    expect(first.selected).toBe(2);
    expect(first.settled).toBe(2);
    const second = await runSettle(env, NOW + 2, 2);
    expect(second.selected).toBe(1);
    expect(second.settled).toBe(1);
    for (const id of ids) expect((await betRow(id)).status).toBe('won');
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * A bet whose batch FAILS
 * ------------------------------------------------------------------ */

describe('runSettle — a failing batch', () => {
  it('increments settle_attempts, records settle_error, moves no money, and settles the next bet anyway', async () => {
    const user = await register();
    const doomedGame = await seedGameWithLine(env.DB, {
      id: g('doomed'),
      kickoffAt: NOW + HOUR, // strictly earlier: this bet is selected FIRST
      lastSeenAt: NOW - 60_000,
    });
    const healthyGame = await seedScheduled(g('healthy'));
    const doomed = await place(user.id, [spreadLeg(doomedGame)], 100);
    const healthy = await place(user.id, [spreadLeg(healthyGame)], 100);
    await finalize(doomedGame, 31, 17);
    await finalize(healthyGame, 31, 17);

    const restore = breakNextBatches(1);
    let stats: SettleStats;
    try {
      stats = await runSettleExpectingErrors(NOW + 1, 20);
    } finally {
      restore();
    }

    expect(stats.selected).toBe(2);
    expect(stats.errors.map((e) => e.betId)).toEqual([doomed]);
    expect(stats.errors[0]?.error).toContain('connection lost');

    // THE POINT: a throwing batch costs an attempt. Leave the counter alone and
    // twenty such bets sit at the front of `ORDER BY settle_attempts ASC`
    // forever, re-failing ahead of every healthy bet on every run — the
    // head-of-line starvation the counter exists to prevent, through a
    // different door.
    const bad = await betRow(doomed);
    expect(bad.settle_attempts).toBe(1);
    expect(bad.settle_error).toContain('settle failed');
    // ...and the batch rolled back as a unit, so the bet is still FULLY pending.
    expect(bad.status).toBe('pending');
    expect(bad.payout_cents).toBeNull();
    expect(bad.settled_at).toBeNull();
    expect(bad.settle_run_id).toBeNull();
    expect((await legRows(doomed))[0]?.result).toBeNull();
    expect(await ledgerRows(doomed, 'bet_payout')).toHaveLength(0);

    // One bad bet must not abort the chunk.
    expect(stats.settled).toBe(1);
    expect((await betRow(healthy)).status).toBe('won');
    expect(await ledgerRows(healthy, 'bet_payout')).toHaveLength(1);
    await expectNoDrift();

    // And the next run settles the bet that failed, now that D1 is healthy.
    const next = await runSettle(env, NOW + 2, 20);
    expect(next.settled).toBe(1);
    expect((await betRow(doomed)).status).toBe('won');
    expect((await betRow(doomed)).payout_cents).toBe(190);
    await expectNoDrift();
  });

  it('runJob("settle") records a run with errors as `error`, with the stats intact', async () => {
    const user = await register();
    const doomedGame = await seedGameWithLine(env.DB, {
      id: g('doomed'),
      kickoffAt: NOW + HOUR,
      lastSeenAt: NOW - 60_000,
    });
    const healthyGame = await seedScheduled(g('healthy'));
    const doomed = await place(user.id, [spreadLeg(doomedGame)], 100);
    const healthy = await place(user.id, [spreadLeg(healthyGame)], 100);
    await finalize(doomedGame, 31, 17);
    await finalize(healthyGame, 31, 17);

    const restore = breakNextBatches(1);
    let run;
    try {
      run = await runJob(env, 'settle', 'cron', NOW + 1);
    } finally {
      restore();
    }

    // A run that failed to settle bets it selected is NOT a green run.
    // `GET /api/admin/jobs` is the first place an operator looks when money
    // looks wrong, and `ok` there means "nothing to see here".
    expect(run.status).toBe('error');
    expect(run.error).toContain('1 of 2 selected bets failed');
    expect(run.error).toContain(doomed);

    // The message is only a summary; the stats still carry everything.
    expect(run.stats?.['selected']).toBe(2);
    expect(run.stats?.['settled']).toBe(1);
    expect(run.stats?.['errors']).toHaveLength(1);
    expect(run.stats?.['rowsWritten']).toBeTypeOf('number');

    // ...and the healthy bet in the same chunk was still settled and paid: the
    // error is raised AFTER the chunk, never instead of it.
    expect((await betRow(healthy)).status).toBe('won');
    expect(await ledgerRows(healthy, 'bet_payout')).toHaveLength(1);
    expect((await betRow(doomed)).status).toBe('pending');
    await expectNoDrift();
  });

  it('a bet re-opened after it was paid settles the row again but reports already-settled, not a second payment', async () => {
    const user = await register();
    const gid = await seedScheduled(g(1));
    const betId = await place(user.id, [spreadLeg(gid)], 2500);
    await finalize(gid, 31, 17);
    await runSettle(env, NOW + 1, 20);
    const paidBalance = await balance(user.id);

    // An operator repairing a game row (or an M8 fix-up script) puts a PAID bet
    // back to `pending`. The conditional transition then MATCHES on the next
    // run — layer 1 does not save us — but the ledger row is already there, so
    // the payout INSERT's `NOT EXISTS` writes nothing.
    await env.DB.prepare(
      `UPDATE bets
          SET status = 'pending', payout_cents = NULL, settled_at = NULL,
              settle_run_id = NULL, settle_attempts = 0
        WHERE id = ?1`,
    )
      .bind(betId)
      .run();

    const stats = await runSettle(env, NOW + 2, 20);
    expect(stats.selected).toBe(1);
    // Reporting this as `settled` (and adding 4772 to `paidCents`) would show an
    // operator a second payout in GET /api/admin/jobs that never happened.
    expect(stats.settled).toBe(0);
    expect(stats.paidCents).toBe(0);
    expect(stats.skippedAlreadySettled).toBe(1);
    expect(stats.errors).toEqual([]);

    // The bet row is repaired — that is the useful half — and no money moved.
    const bet = await betRow(betId);
    expect(bet.status).toBe('won');
    expect(bet.payout_cents).toBe(4772);
    expect(await ledgerRows(betId, 'bet_payout')).toHaveLength(1);
    expect(await balance(user.id)).toBe(paidBalance);
    await expectNoDrift();
  });
});

/* ------------------------------------------------------------------ *
 * M5b forward-compatibility
 * ------------------------------------------------------------------ */

describe('pricingFor', () => {
  it('is the single call site that M5b turns into teaser pricing', () => {
    const straight: SettleableBet = {
      id: 'b1',
      bankrollId: 'bk',
      stakeCents: 100,
      betType: 'straight',
      legCount: 1,
    };
    expect(pricingFor(straight)).toEqual({ kind: 'parlay' });
    expect(pricingFor({ ...straight, betType: 'parlay', legCount: 2 })).toEqual({ kind: 'parlay' });
  });
});
