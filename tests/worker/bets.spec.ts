import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BetResponse,
  BetsResponse,
  LineChangedDetails,
  PlaceBetRequest,
  UserResponse,
} from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import {
  BET_CUTOFF_BUFFER_MS,
  INITIAL_BANKROLL_CENTS,
  LINE_STALE_MS,
  MAX_PAYOUT_CENTS,
} from '../../src/shared/constants.js';
import { isAppError } from '../../src/shared/errors.js';
import {
  americanToPrice,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
} from '../../src/shared/odds.js';
import { isOrphanBankrollError, isOverdraftError } from '../../src/worker/db.js';
import { validatePlaceBet } from '../../src/shared/validate.js';
import {
  betInsertSql,
  buildPlacement,
  cancelBet,
  editBet,
  editCancelSql,
  placeBet,
  resolveLegSnapshots,
} from '../../src/worker/bets.js';
import { buildApp } from '../../src/worker/index.js';
import {
  balanceOf,
  bankrollDrift,
  fullLine,
  ledgerSum,
  mainBankrollId,
  seedGame,
  seedGameWithLine,
  seedLine,
  updateGame,
} from './seed.js';

/**
 * TDD contract for M5. Every case here is a reviewer question answered.
 *
 * TWO ENTRY POINTS ARE USED ON PURPOSE:
 *   * HTTP (`buildApp().request`) for anything that is a route-level contract —
 *     status codes, error envelopes, auth.
 *   * the service functions directly, for anything where the exact value of
 *     `now` is the thing under test. A request captures `Date.now()` itself, so
 *     "at lockAt − 1 ms" is simply not expressible over HTTP; `placeBet(env,
 *     userId, req, now)` takes the clock as a parameter and is the same code
 *     path the route calls.
 *
 * ISOLATION. vitest-pool-workers 0.22 gives each test FILE fresh storage but does
 * NOT roll back between tests, and `ledger` has a BEFORE DELETE trigger, so no
 * `beforeEach` could truncate it even if it wanted to. Every test therefore
 * allocates its OWN user and its OWN game ids (`g()` / `gc()` below) and every
 * count assertion is scoped to that user. That is stricter than a rollback would
 * be: it also proves one user's bets never appear in another's totals.
 */

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let NOW = 0;
let testIndex = 0;
let userSeq = 0;

beforeEach(() => {
  NOW = Date.now();
  testIndex += 1;
});

/** A game id unique to this test. Ids are `<league>:<providerEventId>`. */
function g(n: number | string): string {
  return `nfl:${String(testIndex)}-${String(n)}`;
}
function gc(n: number | string): string {
  return `ncaaf:${String(testIndex)}-${String(n)}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function send(path: string, init: RequestInit): Promise<Response> {
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, env));
}

function jsonInit(method: string, payload: unknown, cookie?: string): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-SBS-Client': '1',
  };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return { method, headers, body: JSON.stringify(payload) };
}

function post(path: string, payload: unknown, cookie?: string): Promise<Response> {
  return send(path, jsonInit('POST', payload, cookie));
}
function put(path: string, payload: unknown, cookie?: string): Promise<Response> {
  return send(path, jsonInit('PUT', payload, cookie));
}
function del(path: string, cookie: string): Promise<Response> {
  return send(path, { method: 'DELETE', headers: { 'X-SBS-Client': '1', cookie } });
}
function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return send(path, { method: 'GET', headers });
}

interface Account {
  readonly cookie: string;
  readonly id: string;
  readonly username: string;
  /** The one account balance signup opened (M5b). Every stake comes out of it. */
  readonly bkId: string;
}

/**
 * Sign a NEW user up through the real flow and hand back their cookie, id and
 * account balance.
 *
 * The `dk` is an arbitrary well-formed 64-hex string rather than a `DK_VECTORS`
 * entry: these tests never log back in, and a vector is only valid for the one
 * username it was derived for, which would cap us at four users per file.
 */
async function register(base = 'user'): Promise<Account> {
  userSeq += 1;
  const username = `${base}${String(userSeq)}`;
  const res = await post('/api/auth/signup', {
    username,
    dk: 'a'.repeat(64),
    inviteCode: INVITE,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const parsed = await res.json<UserResponse>();
  const raw = res.headers.get('set-cookie') ?? '';
  return {
    cookie: /sbs_session=[^;]*/.exec(raw)?.[0] ?? '',
    id: parsed.user.id,
    username,
    // Not lazily created and not derivable from (user, league, season) any more:
    // the signup batch wrote it, and this is how a test finds it.
    bkId: await mainBankrollId(env.DB, parsed.user.id),
  };
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error.code;
}

/** The code of an AppError thrown by a service call, or a rethrow if it is not one. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  throw new Error('expected the call to throw an AppError, but it resolved');
}

// ---------------------------------------------------------------------------
// Bet-shape helpers
// ---------------------------------------------------------------------------

function straight(gameId: string, stakeCents = 2500): PlaceBetRequest {
  return {
    league: 'nfl',
    betType: 'straight',
    stakeCents,
    legs: [{ gameId, market: 'spread', side: 'home' }],
  };
}

function parlay(gameIds: readonly string[], stakeCents = 1000): PlaceBetRequest {
  return {
    league: 'nfl',
    betType: 'parlay',
    stakeCents,
    legs: gameIds.map((gameId) => ({ gameId, market: 'moneyline', side: 'home' }) as const),
  };
}

/** The single invariant every money scenario must end on (PLAN.md §4.1). */
async function expectLedgerMatchesBalance(): Promise<void> {
  expect(await bankrollDrift(env.DB)).toEqual([]);
}

interface BetRow {
  id: string;
  league: string;
  season: number;
  bet_type: string;
  teaser_points_tenths: number | null;
  leg_count: number;
  stake_cents: number;
  american_price: number;
  potential_payout_cents: number;
  status: string;
  bankroll_id: string;
  earliest_kickoff_at: number;
  cancelled_at: number | null;
  replaces_bet_id: string | null;
  replaced_by_bet_id: string | null;
}

function betRow(id: string): Promise<BetRow | null> {
  return env.DB.prepare(`SELECT * FROM bets WHERE id = ?1`).bind(id).first<BetRow>();
}

interface LegRow {
  leg_index: number;
  game_id: string;
  league: string;
  market: string;
  side: string;
  line_tenths: number | null;
  original_line_tenths: number | null;
  american_price: number;
  provider: string;
  line_captured_at: number;
  snapshot_at: number;
  kickoff_at_snapshot: number;
  home_abbr: string;
  away_abbr: string;
}

async function legRows(betId: string): Promise<LegRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?1 ORDER BY leg_index`)
    .bind(betId)
    .all<LegRow>();
  return [...res.results];
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Rows this USER owns. Global counts would see every other test's data. */
const betCount = (userId: string): Promise<number> =>
  count(`SELECT COUNT(*) AS n FROM bets WHERE user_id = ?1`, userId);
const legCount = (userId: string): Promise<number> =>
  count(
    `SELECT COUNT(*) AS n FROM bet_legs l JOIN bets b ON b.id = l.bet_id WHERE b.user_id = ?1`,
    userId,
  );
const ledgerCount = (userId: string, kind?: string): Promise<number> =>
  kind === undefined
    ? count(
        `SELECT COUNT(*) AS n FROM ledger le JOIN bankrolls bk ON bk.id = le.bankroll_id
          WHERE bk.user_id = ?1`,
        userId,
      )
    : count(
        `SELECT COUNT(*) AS n FROM ledger le JOIN bankrolls bk ON bk.id = le.bankroll_id
          WHERE bk.user_id = ?1 AND le.kind = ?2`,
        userId,
        kind,
      );

// ===========================================================================

describe('placeBet — happy path', () => {
  it('SIGNUP opened the balance with one 100000 deposit_initial row; placement adds none', async () => {
    const alex = await register();
    const gameId = await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });

    // M5b: the balance exists BEFORE any bet. Nothing is created lazily.
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS);

    const res = await post('/api/bets', straight(gameId), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);

    const bkId = alex.bkId;
    const deposit = await env.DB.prepare(
      `SELECT amount_cents, ref_id, kind FROM ledger
        WHERE bankroll_id = ?1 AND kind = 'deposit_initial'`,
    )
      .bind(bkId)
      .all<{ amount_cents: number; ref_id: string; kind: string }>();
    expect(deposit.results).toHaveLength(1);
    expect(deposit.results[0]?.amount_cents).toBe(INITIAL_BANKROLL_CENTS);
    expect(deposit.results[0]?.ref_id).toBe('init');
    // ...and exactly one balance, still, after betting.
    const balances = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bankrolls WHERE user_id = ?1`)
      .bind(alex.id)
      .first<{ n: number }>();
    expect(balances?.n).toBe(1);
    await expectLedgerMatchesBalance();
  });

  it('debits exactly the stake and snapshots market/side/line/price/provider/times', async () => {
    const alex = await register();
    const kickoffAt = NOW + 3 * HOUR;
    await seedGame(env.DB, { id: g(1), kickoffAt });
    await seedLine(env.DB, { ...fullLine(g(1), NOW - 1000), capturedAt: NOW - 90_000 });

    const res = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();

    const bkId = alex.bkId;
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    const stake = await env.DB.prepare(
      `SELECT amount_cents, ref_id, bet_id FROM ledger
        WHERE bankroll_id = ?1 AND kind = 'bet_stake'`,
    )
      .bind(bkId)
      .all<{ amount_cents: number; ref_id: string; bet_id: string }>();
    expect(stake.results).toHaveLength(1);
    expect(stake.results[0]?.amount_cents).toBe(-2500);
    expect(stake.results[0]?.ref_id).toBe(bet.id);
    expect(stake.results[0]?.bet_id).toBe(bet.id);

    const legs = await legRows(bet.id);
    expect(legs).toHaveLength(1);
    const leg = legs[0];
    expect(leg?.market).toBe('spread');
    expect(leg?.side).toBe('home');
    // The BETTOR's side: home -3.5 is stored as -35 (PLAN.md §3.2).
    expect(leg?.line_tenths).toBe(-35);
    expect(leg?.american_price).toBe(-110);
    expect(leg?.provider).toBe('draftkings');
    // Provenance: when the BOOK's price last CHANGED, not when we polled it.
    expect(leg?.line_captured_at).toBe(NOW - 90_000);
    expect(leg?.kickoff_at_snapshot).toBe(kickoffAt);
    expect(leg?.snapshot_at).toBeGreaterThanOrEqual(NOW);
    expect(leg?.home_abbr).toBe('SEA');
    expect(leg?.away_abbr).toBe('NE');

    const row = await betRow(bet.id);
    expect(row?.leg_count).toBe(1);
    expect(row?.earliest_kickoff_at).toBe(kickoffAt);
    expect(row?.american_price).toBe(-110);
    expect(row?.potential_payout_cents).toBe(payoutCents(2500, americanToPrice(-110)));
    expect(row?.potential_payout_cents).toBe(4772); // PLAN.md §5.4
    expect(bet.lockAt).toBe(kickoffAt - BET_CUTOFF_BUFFER_MS);
    expect(bet.toWinCents).toBe(4772 - 2500);
    await expectLedgerMatchesBalance();
  });

  it('stores the exact rational price, not a float', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(res.status).toBe(201);
    const { bet } = await res.json<BetResponse>();

    // No rational is persisted at all — `bets` has no numerator/denominator
    // column, and every money/price column is a true SQLite INTEGER.
    const cols = await env.DB.prepare(`PRAGMA table_info(bets)`).all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    expect(names).not.toContain('price_num');
    expect(names).not.toContain('price_den');
    expect(names).not.toContain('decimal_odds');

    const types = await env.DB.prepare(
      `SELECT typeof(american_price) AS ap, typeof(potential_payout_cents) AS pp,
              typeof(stake_cents) AS st
         FROM bets WHERE id = ?1`,
    )
      .bind(bet.id)
      .first<{ ap: string; pp: string; st: string }>();
    expect(types).toEqual({ ap: 'integer', pp: 'integer', st: 'integer' });

    const legTypes = await env.DB.prepare(
      `SELECT typeof(american_price) AS ap, typeof(line_tenths) AS lt
         FROM bet_legs WHERE bet_id = ?1`,
    )
      .bind(bet.id)
      .first<{ ap: string; lt: string }>();
    expect(legTypes).toEqual({ ap: 'integer', lt: 'integer' });
  });

  it('SUM(ledger.amount_cents) === bankrolls.balance_cents afterwards', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    expect((await post('/api/bets', straight(g(1), 2500), alex.cookie)).status).toBe(201);
    expect((await post('/api/bets', straight(g(2), 700), alex.cookie)).status).toBe(201);

    const bkId = alex.bkId;
    expect(await ledgerSum(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS - 3200);
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS - 3200);
    await expectLedgerMatchesBalance();
  });
});

describe('placeBet — the kickoff lock', () => {
  it('accepts a bet at lockAt - 1ms', async () => {
    const alex = await register();
    const kickoffAt = NOW + 4 * HOUR;
    const at = kickoffAt - BET_CUTOFF_BUFFER_MS - 1;
    // The line must be fresh AT `at`, not at wall-clock now: these boundary
    // tests run the clock forward, and staleness would otherwise fire first.
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt }, { seenAt: at });
    // lockAt = kickoffAt - buffer; one millisecond earlier must still be legal.
    const { bet } = await placeBet(env, alex.id, straight(g(1)), at);
    expect(bet.status).toBe('pending');
    await expectLedgerMatchesBalance();
  });

  it('rejects at lockAt with 409 BETTING_CLOSED', async () => {
    const alex = await register();
    const kickoffAt = NOW + 4 * HOUR;
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    const at = kickoffAt - BET_CUTOFF_BUFFER_MS; // exactly lockAt
    expect(await codeOf(() => placeBet(env, alex.id, straight(g(1)), at))).toBe('BETTING_CLOSED');
    expect(await betCount(alex.id)).toBe(0);
    expect(await legCount(alex.id)).toBe(0);
  });

  it('rejects a game whose status is in_progress with 409 GAME_NOT_BETTABLE', async () => {
    const alex = await register();
    // Still comfortably before the stored kickoff, so only `status` can reject it.
    await seedGameWithLine(env.DB, {
      id: g(1),
      kickoffAt: NOW + 2 * HOUR,
      status: 'in_progress',
    });
    const res = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('GAME_NOT_BETTABLE');
  });

  it('rejects when ESPN has moved the kickoff EARLIER than the cutoff', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 5 * HOUR });
    // A reschedule two hours earlier puts it inside the buffer.
    await updateGame(env.DB, g(1), { kickoffAt: NOW + 30_000 });
    const res = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('BETTING_CLOSED');
    expect(await betCount(alex.id)).toBe(0);
  });

  it('uses the DB kickoff, never a client-supplied timestamp', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW - HOUR, status: 'scheduled' });
    // Every client-controllable "the game has not started, honest" field.
    const res = await post(
      '/api/bets',
      {
        ...straight(g(1)),
        now: NOW - 10 * HOUR,
        kickoffAt: NOW + 10 * HOUR,
        lockAt: NOW + 10 * HOUR,
      },
      alex.cookie,
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('BETTING_CLOSED');
  });

  it('rejects an unknown gameId with 404 GAME_NOT_FOUND', async () => {
    const alex = await register();
    const res = await post('/api/bets', straight('nfl:nope'), alex.cookie);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('GAME_NOT_FOUND');
  });
});

describe('placeBet — lines', () => {
  it('rejects a market with no line (409 MARKET_UNAVAILABLE)', async () => {
    const alex = await register();
    await seedGame(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    // A CFB-style row: spread + total posted, no moneyline.
    await seedLine(env.DB, {
      ...fullLine(g(1), NOW - 1000),
      mlHomePrice: null,
      mlAwayPrice: null,
    });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 500,
        legs: [{ gameId: g(1), market: 'moneyline', side: 'home' }],
      },
      alex.cookie,
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('MARKET_UNAVAILABLE');

    // ...and a game with NO game_lines row at all is the same answer.
    await seedGame(env.DB, { id: g(2), kickoffAt: NOW + 2 * HOUR });
    const res2 = await post('/api/bets', straight(g(2)), alex.cookie);
    expect(res2.status).toBe(409);
    expect(await errorCode(res2)).toBe('MARKET_UNAVAILABLE');
  });

  it('rejects a line older than LINE_STALE_MS', async () => {
    const alex = await register();
    await seedGame(env.DB, { id: g(1), kickoffAt: NOW + 6 * HOUR });
    // seen_at is what staleness keys off — captured_at is deliberately fresh, so
    // a guard written against the wrong column would let this through.
    await seedLine(env.DB, {
      ...fullLine(g(1), NOW - LINE_STALE_MS - 1000),
      capturedAt: NOW - 1000,
    });
    const res = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('MARKET_UNAVAILABLE');
  });

  it('a game days away accepts a 10-hour-old line and refuses a 19-hour-old one', async () => {
    // The window is 3 × the refresh cadence at the tier the line was seen in:
    // a line confirmed 5 days out was on the 6 h discovery cadence → 18 h.
    // Reverting placement to the flat 3 h LINE_STALE_MS fails the first half.
    const alex = await register();
    await seedGame(env.DB, { id: g(1), kickoffAt: NOW + 5 * DAY });
    await seedLine(env.DB, fullLine(g(1), NOW - 10 * HOUR));
    const ok = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(ok.status, await ok.clone().text()).toBe(201);

    await seedGame(env.DB, { id: g(2), kickoffAt: NOW + 5 * DAY });
    await seedLine(env.DB, fullLine(g(2), NOW - 19 * HOUR));
    const stale = await post('/api/bets', straight(g(2)), alex.cookie);
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('MARKET_UNAVAILABLE');
  });

  it('409 LINE_CHANGED when `expected` disagrees, with details.legs[].current', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 500,
        legs: [
          {
            gameId: g(1),
            market: 'spread',
            side: 'home',
            expected: { americanPrice: -105, lineTenths: -30 },
          },
        ],
      },
      alex.cookie,
    );
    expect(res.status).toBe(409);
    const parsed = await res.json<ApiErrorBody>();
    expect(parsed.error.code).toBe('LINE_CHANGED');
    const details = parsed.error.details as unknown as LineChangedDetails;
    expect(details.legs).toHaveLength(1);
    expect(details.legs[0]).toEqual({
      gameId: g(1),
      market: 'spread',
      side: 'home',
      expected: { americanPrice: -105, lineTenths: -30 },
      current: { americanPrice: -110, lineTenths: -35 },
    });
    expect(await betCount(alex.id)).toBe(0);
  });

  it('places anyway when acceptLineChange is true', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 500,
        acceptLineChange: true,
        legs: [
          {
            gameId: g(1),
            market: 'spread',
            side: 'home',
            expected: { americanPrice: -105, lineTenths: -30 },
          },
        ],
      },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    // Placed at the CURRENT line, not the one the client hoped for.
    const legs = await legRows(bet.id);
    expect(legs[0]?.american_price).toBe(-110);
    expect(legs[0]?.line_tenths).toBe(-35);
    await expectLedgerMatchesBalance();
  });

  it('the client-sent price is IGNORED — the server always uses game_lines', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 500,
        // Not part of the wire contract at all — a hostile client inventing a
        // price must not be able to get paid at it.
        legs: [
          {
            gameId: g(1),
            market: 'moneyline',
            side: 'away',
            americanPrice: 99999,
            lineTenths: -900,
            provider: 'pinky-swear',
          },
        ],
      },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    const legs = await legRows(bet.id);
    expect(legs[0]?.american_price).toBe(164); // game_lines.ml_away_price
    expect(legs[0]?.line_tenths).toBeNull(); // moneyline carries no line
    expect(legs[0]?.provider).toBe('draftkings');
    expect(bet.americanPrice).toBe(164);
  });
});

describe('placeBet — money and atomicity', () => {
  it('409 INSUFFICIENT_FUNDS when the stake exceeds the balance', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    // Create the bankroll first so the stake is the only thing that can fail.
    expect((await get('/api/bankroll?league=nfl&season=2026', alex.cookie)).status).toBe(200);

    const res = await post('/api/bets', straight(g(1), INITIAL_BANKROLL_CENTS + 1), alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });

  it('a rejected bet leaves NO bets row, NO bet_legs rows and NO ledger row', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      parlay([g(1), g(2)], INITIAL_BANKROLL_CENTS + 1),
      alex.cookie,
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('INSUFFICIENT_FUNDS');
    expect(await betCount(alex.id)).toBe(0);
    expect(await legCount(alex.id)).toBe(0);
    // The batch rolled back entirely. The opening deposit is NOT part of it any
    // more — it was written at signup — so the assertion is that the balance is
    // exactly as signup left it, and that the batch added no row of its own.
    expect(await ledgerCount(alex.id)).toBe(1);
    expect(await ledgerCount(alex.id, 'bet_stake')).toBe(0);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });

  it('rejects a stake below MIN_STAKE_CENTS', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', straight(g(1), 99), alex.cookie);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION');
    expect(await betCount(alex.id)).toBe(0);
  });

  it('an all-in bet for exactly the balance succeeds and leaves 0', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', straight(g(1), INITIAL_BANKROLL_CENTS), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(0);
    await expectLedgerMatchesBalance();
  });

  it('two concurrent all-in bets: exactly one succeeds', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 2 * HOUR });

    const [a, b] = await Promise.all([
      post('/api/bets', straight(g(1), INITIAL_BANKROLL_CENTS), alex.cookie),
      post('/api/bets', straight(g(2), INITIAL_BANKROLL_CENTS), alex.cookie),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await errorCode(loser)).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(env.DB, alex.bkId)).toBe(0);
    expect(await betCount(alex.id)).toBe(1);
    await expectLedgerMatchesBalance();
  });
});

describe('placeBet — parlays', () => {
  it('2..10 legs are accepted; 1 and 11 are rejected', async () => {
    const alex = await register();
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const id = g(i);
      await seedGameWithLine(env.DB, { id, kickoffAt: NOW + 2 * HOUR });
      ids.push(id);
    }
    const two = await post('/api/bets', parlay(ids.slice(0, 2), 100), alex.cookie);
    expect(two.status, await two.clone().text()).toBe(201);

    const ten = await post('/api/bets', parlay(ids.slice(0, 10), 100), alex.cookie);
    expect(ten.status, await ten.clone().text()).toBe(201);

    const one = await post('/api/bets', parlay(ids.slice(0, 1), 100), alex.cookie);
    expect(one.status).toBe(400);
    expect(await errorCode(one)).toBe('VALIDATION');

    const eleven = await post('/api/bets', parlay(ids, 100), alex.cookie);
    expect(eleven.status).toBe(400);
    expect(await errorCode(eleven)).toBe('VALIDATION');
    expect(await betCount(alex.id)).toBe(2);
    await expectLedgerMatchesBalance();
  });

  it('two legs on the same game are rejected (validation AND the DB UNIQUE)', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'parlay',
        stakeCents: 500,
        legs: [
          { gameId: g(1), market: 'moneyline', side: 'home' },
          { gameId: g(1), market: 'total', side: 'over' },
        ],
      },
      alex.cookie,
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION');

    // ...and the DB is the backstop: UNIQUE(bet_id, game_id).
    const ok = await post('/api/bets', straight(g(1), 500), alex.cookie);
    expect(ok.status, await ok.clone().text()).toBe(201);
    const { bet } = await ok.json<BetResponse>();
    await expect(
      env.DB.prepare(
        `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side,
                               line_tenths, american_price, provider, line_captured_at,
                               snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr)
         VALUES (?3, ?1, 1, ?4, 'nfl', 'total', 'over', 455, -110, 'draftkings',
                 ?2, ?2, ?2, 'SEA', 'NE')`,
      )
        .bind(bet.id, NOW, `dup-${String(testIndex)}`, g(1))
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("mixed-league legs are ACCEPTED and land as league='mixed'", async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, {
      id: gc(1),
      league: 'ncaaf',
      kickoffAt: NOW + 2 * HOUR,
    });
    const res = await post('/api/bets', parlay([g(1), gc(1)], 500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    // The request claimed 'nfl'; the SERVER labels the bet from the legs' own
    // game rows and never compares the two (the field is advisory since M5b).
    expect(bet.league).toBe('mixed');
    expect((await betRow(bet.id))?.league).toBe('mixed');
    // Each LEG still carries its own real league.
    expect((await legRows(bet.id)).map((l) => l.league).sort()).toEqual(['ncaaf', 'nfl']);
    expect(bet.bankrollId).toBe(alex.bkId);
    await expectLedgerMatchesBalance();
  });

  it('the stored bet price is the product of the leg prices', async () => {
    const alex = await register();
    // PLAN.md §5.4: -110 / +120 / -105 at a 100c stake pays exactly 820.
    const prices = [-110, 120, -105];
    const ids: string[] = [];
    for (const [i, price] of prices.entries()) {
      const id = g(i);
      await seedGame(env.DB, { id, kickoffAt: NOW + 2 * HOUR });
      await seedLine(env.DB, { ...fullLine(id, NOW - 1000), mlHomePrice: price });
      ids.push(id);
    }
    const res = await post('/api/bets', parlay(ids, 100), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();

    const expectedPrice = priceFromLegs(prices);
    expect(bet.potentialPayoutCents).toBe(820);
    expect(bet.americanPrice).toBe(priceToAmerican(expectedPrice));
    expect(bet.americanPrice).toBe(720);

    const legs = await legRows(bet.id);
    expect(legs.map((l) => l.american_price)).toEqual(prices);
    // Recomputed from the legs — the only price source after placement.
    const recomputed = priceFromLegs(legs.map((l) => l.american_price));
    expect(payoutCents(100, recomputed)).toBe(820);
    await expectLedgerMatchesBalance();
  });

  it('a 10-leg parlay stays under the 100-bound-parameter limit per statement', async () => {
    const alex = await register();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = g(i);
      await seedGameWithLine(env.DB, { id, kickoffAt: NOW + 2 * HOUR });
      ids.push(id);
    }
    // The legs MUST be 10 separate statements: one combined INSERT would need
    // ~150 bound parameters and D1 caps a statement at 100.
    const res = await post('/api/bets', parlay(ids, 1000), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(await legRows(bet.id)).toHaveLength(10);
    await expectLedgerMatchesBalance();
  });
});

describe('cancelBet', () => {
  async function placed(stakeCents = 2500): Promise<{ alex: Account; betId: string }> {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    const res = await post('/api/bets', straight(g(1), stakeCents), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    return { alex, betId: bet.id };
  }

  it('refunds the full stake exactly once', async () => {
    const { alex, betId } = await placed(2500);
    const res = await del(`/api/bets/${betId}`, alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const { bet } = await res.json<BetResponse>();
    expect(bet.status).toBe('cancelled');

    const bkId = alex.bkId;
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS);
    const refunds = await env.DB.prepare(
      `SELECT amount_cents FROM ledger WHERE bankroll_id = ?1 AND kind = 'bet_refund'`,
    )
      .bind(bkId)
      .all<{ amount_cents: number }>();
    expect(refunds.results).toHaveLength(1);
    expect(refunds.results[0]?.amount_cents).toBe(2500);
    await expectLedgerMatchesBalance();
  });

  it('a second cancel is a clean no-op — 409 BET_NOT_PENDING, never a 500', async () => {
    const { alex, betId } = await placed();
    expect((await del(`/api/bets/${betId}`, alex.cookie)).status).toBe(200);
    const second = await del(`/api/bets/${betId}`, alex.cookie);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('BET_NOT_PENDING');
  });

  it('a second cancel writes no second bet_refund row and does not move the balance', async () => {
    const { alex, betId } = await placed(2500);
    expect((await del(`/api/bets/${betId}`, alex.cookie)).status).toBe(200);
    const bkId = alex.bkId;
    const before = await balanceOf(env.DB, bkId);
    expect((await del(`/api/bets/${betId}`, alex.cookie)).status).toBe(409);
    expect(await balanceOf(env.DB, bkId)).toBe(before);
    expect(await ledgerCount(alex.id, 'bet_refund')).toBe(1);
    await expectLedgerMatchesBalance();
  });

  it('409 BET_LOCKED after the earliest leg locks', async () => {
    const alex = await register();
    const kickoffAt = NOW + 4 * HOUR;
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    const { bet } = await placeBet(env, alex.id, straight(g(1)), NOW);
    // At the lock, with the game row untouched.
    const at = kickoffAt - BET_CUTOFF_BUFFER_MS;
    expect(await codeOf(() => cancelBet(env, alex.id, bet.id, at))).toBe('BET_LOCKED');
    expect((await betRow(bet.id))?.status).toBe('pending');
    await expectLedgerMatchesBalance();
  });

  it(
    'ESPN moves a game EARLIER and it kicks off: cancel is rejected even though ' +
      'bets.earliest_kickoff_at is still in the future',
    async () => {
      const alex = await register();
      const kickoffAt = NOW + 6 * HOUR;
      await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
      const res = await post('/api/bets', straight(g(1)), alex.cookie);
      expect(res.status, await res.clone().text()).toBe(201);
      const { bet } = await res.json<BetResponse>();

      // Ingestion moves the game and it starts. `bets.earliest_kickoff_at` is a
      // PLACEMENT-TIME snapshot and is deliberately NOT updated, so a guard
      // written against it alone would still say "hours to go".
      await updateGame(env.DB, g(1), { kickoffAt: NOW - HOUR, status: 'in_progress' });
      const row = await betRow(bet.id);
      expect(row?.earliest_kickoff_at).toBe(kickoffAt);
      expect(row?.earliest_kickoff_at).toBeGreaterThan(Date.now());

      const cancel = await del(`/api/bets/${bet.id}`, alex.cookie);
      expect(cancel.status).toBe(409);
      expect(await errorCode(cancel)).toBe('BET_LOCKED');
      expect((await betRow(bet.id))?.status).toBe('pending');
      expect(await ledgerCount(alex.id, 'bet_refund')).toBe(0);
      await expectLedgerMatchesBalance();
    },
  );

  it('a leg whose game is in_progress blocks cancel', async () => {
    const { alex, betId } = await placed();
    await updateGame(env.DB, g(1), { status: 'in_progress' });
    const res = await del(`/api/bets/${betId}`, alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('BET_LOCKED');
  });

  it('a leg whose game is final blocks cancel', async () => {
    const { alex, betId } = await placed();
    await updateGame(env.DB, g(1), { status: 'final', homeScore: 27, awayScore: 24 });
    const res = await del(`/api/bets/${betId}`, alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('BET_LOCKED');
  });

  it("another user's bet id returns 404 BET_NOT_FOUND, not 403", async () => {
    const { betId } = await placed();
    const bob = await register();
    const res = await del(`/api/bets/${betId}`, bob.cookie);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('BET_NOT_FOUND');
    expect((await betRow(betId))?.status).toBe('pending');
  });
});

describe('editBet', () => {
  it('cancels the old bet and places the new one in ONE batch', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    const res = await put(`/api/bets/${old.id}`, straight(g(2), 4000), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = await res.json<BetResponse>();
    expect(parsed.replacedBetId).toBe(old.id);
    expect(parsed.bet.stakeCents).toBe(4000);

    expect((await betRow(old.id))?.status).toBe('cancelled');
    expect((await betRow(parsed.bet.id))?.status).toBe('pending');
    const bkId = alex.bkId;
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS - 4000);
    await expectLedgerMatchesBalance();
  });

  it('prices the new bet from the CURRENT line, not the old snapshot', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    const first = await post('/api/bets', straight(g(1), 1000), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();
    expect((await legRows(old.id))[0]?.american_price).toBe(-110);

    // The book moves.
    await seedLine(env.DB, {
      ...fullLine(g(1), NOW - 500),
      spreadHomeTenths: -45,
      spreadHomePrice: -130,
    });
    const res = await put(`/api/bets/${old.id}`, straight(g(1), 1000), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = await res.json<BetResponse>();
    const legs = await legRows(parsed.bet.id);
    expect(legs[0]?.american_price).toBe(-130);
    expect(legs[0]?.line_tenths).toBe(-45);
    await expectLedgerMatchesBalance();
  });

  it('a failure in the placement half leaves the old bet pending and unrefunded', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();
    const bkId = alex.bkId;
    const before = await balanceOf(env.DB, bkId);

    // The replacement stake is larger than the balance PLUS the refund, so the
    // stake insert aborts the batch after the cancel+refund statements ran.
    const res = await put(
      `/api/bets/${old.id}`,
      straight(g(2), INITIAL_BANKROLL_CENTS + 1),
      alex.cookie,
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('INSUFFICIENT_FUNDS');

    const row = await betRow(old.id);
    expect(row?.status).toBe('pending');
    expect(row?.replaced_by_bet_id).toBeNull();
    expect(await balanceOf(env.DB, bkId)).toBe(before);
    expect(await ledgerCount(alex.id, 'bet_refund')).toBe(0);
    await expectLedgerMatchesBalance();
  });

  it('a locked bet is rejected and nothing is written', async () => {
    const alex = await register();
    const kickoffAt = NOW + 4 * HOUR;
    const at = kickoffAt - BET_CUTOFF_BUFFER_MS;
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    // Fresh at `at`, so the edit fails on the LOCK and not on staleness.
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 20 * HOUR }, { seenAt: at });
    const { bet: old } = await placeBet(env, alex.id, straight(g(1), 2500), NOW);

    expect(await codeOf(() => editBet(env, alex.id, old.id, straight(g(2), 4000), at))).toBe(
      'BET_LOCKED',
    );
    expect((await betRow(old.id))?.status).toBe('pending');
    expect(await betCount(alex.id)).toBe(1);
    await expectLedgerMatchesBalance();
  });

  it('a bet whose game was rescheduled earlier and has started cannot be edited', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 6 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 8 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    await updateGame(env.DB, g(1), { kickoffAt: NOW - HOUR, status: 'in_progress' });
    expect((await betRow(old.id))?.earliest_kickoff_at).toBeGreaterThan(Date.now());

    const res = await put(`/api/bets/${old.id}`, straight(g(2), 2500), alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('BET_LOCKED');
    expect((await betRow(old.id))?.status).toBe('pending');
    await expectLedgerMatchesBalance();
  });

  it('links the two bets via replaces_bet_id / replaced_by_bet_id', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();
    const res = await put(`/api/bets/${old.id}`, straight(g(2), 2500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = await res.json<BetResponse>();

    expect((await betRow(old.id))?.replaced_by_bet_id).toBe(parsed.bet.id);
    expect((await betRow(parsed.bet.id))?.replaces_bet_id).toBe(old.id);
    expect(parsed.bet.replacesBetId).toBe(old.id);
  });

  it('an edit MAY now move the bet to another league — same balance either way', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: gc(1), league: 'ncaaf', kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    // M5b: the rule that made this a 409 was "an edit cannot move money between
    // BANKROLLS", and league no longer selects one. The refund and the new stake
    // land on the same account balance, which is all that ever mattered.
    const res = await put(
      `/api/bets/${old.id}`,
      { ...straight(gc(1), 2500), league: 'ncaaf' },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = await res.json<BetResponse>();
    expect(parsed.bet.league).toBe('ncaaf');
    expect(parsed.bet.bankrollId).toBe(alex.bkId);
    expect((await betRow(parsed.bet.id))?.bankroll_id).toBe(alex.bkId);
    expect((await betRow(old.id))?.status).toBe('cancelled');
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    await expectLedgerMatchesBalance();
  });

  it('an edit may NOT move the bet to a DIFFERENT balance (400 VALIDATION)', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    // The one thing an edit still may not do: refund one balance and stake
    // another in the same batch, linking two rows that never shared a ledger.
    // Refused outright rather than silently overridden.
    const res = await put(
      `/api/bets/${old.id}`,
      { ...straight(g(2), 2500), bankrollId: 'some-other-balance' },
      alex.cookie,
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION');
    expect((await betRow(old.id))?.status).toBe('pending');
    expect(await betCount(alex.id)).toBe(1);
    expect(await ledgerCount(alex.id, 'bet_refund')).toBe(0);
    await expectLedgerMatchesBalance();
  });

  it('an edit may now move the bet to another SEASON too', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), season: 2026, kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), season: 2027, kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    const res = await put(`/api/bets/${old.id}`, straight(g(2), 2500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = await res.json<BetResponse>();
    expect(parsed.bet.season).toBe(2027);
    expect(parsed.bet.bankrollId).toBe(alex.bkId);
    await expectLedgerMatchesBalance();
  });

  it("an unauthorised PUT is a 404 that writes NOTHING — not even the caller's bankroll", async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    const first = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    const bob = await register();
    const res = await put(`/api/bets/${old.id}`, straight(g(2), 1000), bob.cookie);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('BET_NOT_FOUND');

    // An unauthorised PUT must write NOTHING. Historically this test caught the
    // edit batch running §14.2's UNGUARDED lazy-bankroll prelude, which
    // committed even when the edit itself matched nothing. There is no prelude
    // at all now, and the assertion has grown teeth instead of losing them: the
    // caller's balance exists from signup, so "nothing was written" is checked
    // as "the balance is untouched at its opening value", which a stray write
    // would break just as loudly.
    expect(await balanceOf(env.DB, bob.bkId)).toBe(INITIAL_BANKROLL_CENTS);
    expect(await ledgerCount(bob.id)).toBe(1); // the opening deposit, and only that
    expect(await betCount(bob.id)).toBe(0);
    expect((await betRow(old.id))?.status).toBe('pending');
    await expectLedgerMatchesBalance();
  });

  it('buildPlacement is bet + legs + stake, with no bankroll prelude at all', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    const req = straight(g(1), 100);
    const parsed = validatePlaceBet(req);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const legs = await resolveLegSnapshots(env, req, NOW);
    const plan = buildPlacement(env, {
      userId: alex.id,
      input: parsed.value,
      bankrollId: alex.bkId,
      legs,
      now: NOW,
      replacesBetId: null,
      requiresCancelledBetId: null,
      memo: 'shape check',
    });

    // M5b deleted the two-statement prelude from BOTH halves: the balance is
    // opened at signup, so there is nothing left to create lazily and the `bets`
    // INSERT is always the first statement.
    expect(plan.betStatementIndex).toBe(0);
    expect(plan.statements).toHaveLength(3); // bet + leg + stake
  });
});

// ---------------------------------------------------------------------------
// The guards that live INSIDE the batch (PLAN.md §14.1 / §14.2).
//
// These are the only thing standing between a rescheduled game and a free bet,
// and the pre-flight reads mask them completely: with the world held still,
// deleting `AND status = 'scheduled' AND kickoff_at > ?14` from `betInsertSql`
// or making the edit's `COUNT(*) = :n` vacuous changes NOTHING observable,
// because the pre-flight already rejected every input the guard would catch.
//
// Two complementary kinds of test cover them:
//   (i)  the generated SQL is asserted to contain the guard text, and
//   (ii) `BetHooks.beforeBatch` — a test-only seam that is `undefined` on every
//        production call site — mutates the game row BETWEEN the read phase and
//        `db.batch()`, which is exactly the window a concurrent ingestion write
//        occupies, and the batch is then asserted to be a clean no-op.
// ---------------------------------------------------------------------------

describe('in-batch guards — the generated SQL', () => {
  it('betInsertSql carries the §14.1 lock guard verbatim', () => {
    const sql = betInsertSql(3, '');
    expect(sql).toContain(`AND status = 'scheduled'`);
    // STRICTLY greater: a kickoff exactly at the cutoff is CLOSED.
    expect(sql).toContain('AND kickoff_at > ?14');
    expect(sql).not.toContain('kickoff_at >= ?14');
    expect(sql).toContain('WHERE id IN (?16, ?17, ?18)');
    // `?7` is leg_count: EVERY requested game must come back bettable.
    expect(sql).toContain(') = ?7');
    // M5b: the balance is named on the request, so OWNERSHIP is what has to be
    // re-checked inside the batch. This conjunct REPLACES `AND league = ?4 AND
    // season = ?5`, which existed only to pin the bet to the bankroll its legs
    // implied — legs imply no bankroll now.
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM bankrolls WHERE id = ?3 AND user_id = ?2)');
    expect(sql).not.toContain('AND league = ?4 AND season = ?5');
    // The ACCOUNT STATE guard. Auth happened in the middleware several D1 reads
    // ago; a disable or a soft delete can land in that window, and without this
    // the stake leaves a balance nobody can reach again.
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND is_disabled = 0 AND deleted_at IS NULL)',
    );
  });

  it('editCancelSql carries BOTH the lock guard and the placement COUNT guard', () => {
    const sql = editCancelSql(2);
    // 1. the §14.2 lock over the OLD bet's legs' CURRENT game rows.
    expect(sql).toContain(`AND (g.status <> 'scheduled' OR g.kickoff_at <= ?4)`);
    // 2. the placement guard over the NEW legs, so neither half can land alone.
    expect(sql).toContain(`AND status = 'scheduled'`);
    expect(sql).toContain('AND kickoff_at > ?4');
    expect(sql).not.toContain('kickoff_at >= ?4');
    expect(sql).toContain('WHERE id IN (?6, ?7)');
    // `= ?8` (6 + legCount), NOT `>= 0` or a dropped comparison: a vacuous
    // count would let the cancel + refund commit without the replacement.
    expect(sql).toContain(') = ?8');
    expect(editCancelSql(1)).toContain(') = ?7');
    // The edit is pinned to the OLD BET'S BALANCE (read from `bets.bankroll_id`,
    // immutable), never to a league — so no league/season conjunct remains.
    expect(sql).not.toContain('AND league =');
    expect(sql).not.toContain('AND season =');
    // 3. the ACCOUNT STATE guard, on the cancel half too. The replacement INSERT
    // carries it; if this half did not, a deleted user's edit would cancel and
    // refund the old bet while the new one matched nothing — the position gone,
    // the money back, and a 409 reported.
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND is_disabled = 0 AND deleted_at IS NULL)',
    );
  });
});

describe('placeBet — the game changes BETWEEN the read and the batch', () => {
  interface Armed {
    readonly alex: Account;
    readonly bkId: string;
    readonly ledgerBefore: number;
    readonly balanceBefore: number | null;
  }

  /**
   * A user whose bankroll is ALREADY open, so "nothing was written" is
   * unambiguous: §14.2's prelude is deliberately unguarded and would otherwise
   * create the bankroll legitimately on the way past.
   */
  async function armed(kickoffAt: number): Promise<Armed> {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    expect((await get('/api/bankroll?league=nfl&season=2026', alex.cookie)).status).toBe(200);
    const bkId = alex.bkId;
    return {
      alex,
      bkId,
      ledgerBefore: await ledgerCount(alex.id),
      balanceBefore: await balanceOf(env.DB, bkId),
    };
  }

  async function expectNothingWritten(state: Armed): Promise<void> {
    expect(await betCount(state.alex.id)).toBe(0);
    expect(await legCount(state.alex.id)).toBe(0);
    expect(await ledgerCount(state.alex.id, 'bet_stake')).toBe(0);
    expect(await ledgerCount(state.alex.id)).toBe(state.ledgerBefore);
    expect(await balanceOf(env.DB, state.bkId)).toBe(state.balanceBefore);
    await expectLedgerMatchesBalance();
  }

  /** Place, mutating the game row after the snapshot read and before the batch. */
  function placeWith(state: Armed, beforeBatch: () => Promise<void>): Promise<unknown> {
    return placeBet(env, state.alex.id, straight(g(1), 2500), NOW, { beforeBatch });
  }

  it('kicks off in_progress mid-flight → GAME_NOT_BETTABLE, nothing written', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const code = await codeOf(() =>
      placeWith(state, () => updateGame(env.DB, g(1), { status: 'in_progress' })),
    );
    expect(code).toBe('GAME_NOT_BETTABLE');
    await expectNothingWritten(state);
  });

  it('rescheduled into the past mid-flight → BETTING_CLOSED, nothing written', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const code = await codeOf(() =>
      placeWith(state, () => updateGame(env.DB, g(1), { kickoffAt: NOW - HOUR })),
    );
    expect(code).toBe('BETTING_CLOSED');
    await expectNothingWritten(state);
  });

  it('kickoff moved to EXACTLY lockAt mid-flight → closed (`>`, never `>=`)', async () => {
    const state = await armed(NOW + 4 * HOUR);
    // lockAt == kickoff_at - BET_CUTOFF_BUFFER_MS, so `kickoff_at == now +
    // buffer` is the first instant that must be refused. A `>=` guard sells it.
    const code = await codeOf(() =>
      placeWith(state, () => updateGame(env.DB, g(1), { kickoffAt: NOW + BET_CUTOFF_BUFFER_MS })),
    );
    expect(code).toBe('BETTING_CLOSED');
    await expectNothingWritten(state);
  });

  it('one millisecond later than that still places', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const { bet } = await placeBet(env, state.alex.id, straight(g(1), 2500), NOW, {
      beforeBatch: () => updateGame(env.DB, g(1), { kickoffAt: NOW + BET_CUTOFF_BUFFER_MS + 1 }),
    });
    expect(bet.status).toBe('pending');
    expect(await betCount(state.alex.id)).toBe(1);
    await expectLedgerMatchesBalance();
  });

  it('the game row disappearing mid-flight → GAME_NOT_FOUND, nothing written', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const code = await codeOf(() =>
      placeWith(state, async () => {
        await env.DB.prepare(`DELETE FROM games WHERE id = ?1`).bind(g(1)).run();
      }),
    );
    expect(code).toBe('GAME_NOT_FOUND');
    await expectNothingWritten(state);
  });

  /**
   * THE ACCOUNT, not the game, changes mid-flight.
   *
   * `requireAuth` resolved the session at the top of the request; several D1
   * reads later the batch runs. `POST /api/admin/users/:id/disabled` and
   * `DELETE /api/admin/users/:id` both fit in that window, and both are things
   * an admin does precisely BECAUSE they want the account to stop betting. A bet
   * that commits afterwards puts the stake into a balance nobody can reach —
   * and, since a soft delete is refused while a bet is pending, makes the
   * account undeletable by the very row the delete was racing.
   */
  it('the account is DISABLED mid-flight → ACCOUNT_DISABLED, nothing written', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const code = await codeOf(() =>
      placeWith(state, async () => {
        await env.DB.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?1')
          .bind(state.alex.id)
          .run();
      }),
    );
    expect(code).toBe('ACCOUNT_DISABLED');
    await expectNothingWritten(state);
  });

  it('the account is soft-DELETED mid-flight → ACCOUNT_DISABLED, nothing written', async () => {
    const state = await armed(NOW + 4 * HOUR);
    const code = await codeOf(() =>
      placeWith(state, async () => {
        await env.DB.prepare('UPDATE users SET is_disabled = 1, deleted_at = ?2 WHERE id = ?1')
          .bind(state.alex.id, NOW)
          .run();
      }),
    );
    // Same code as a plain disable, deliberately: a deleted account IS disabled,
    // and telling a caller holding a stale cookie "your account is gone" says
    // more than "your account is off".
    expect(code).toBe('ACCOUNT_DISABLED');
    await expectNothingWritten(state);
  });
});

describe('editBet — the game changes BETWEEN the read and the batch', () => {
  interface Edited {
    readonly alex: Account;
    readonly oldId: string;
    readonly bkId: string;
  }

  /** A pending 2500c bet on g(1); g(2) is a second bettable game to move to. */
  async function pending(): Promise<Edited> {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 6 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 7 * HOUR });
    const res = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    return { alex, oldId: bet.id, bkId: alex.bkId };
  }

  /**
   * NEITHER HALF LANDED. The cancel UPDATE carries the placement guard, so when
   * the replacement stops being placeable the cancel does not apply either: the
   * old bet is untouched, no refund exists and no new bet row was created.
   */
  async function expectCleanNoOp(state: Edited): Promise<void> {
    const row = await betRow(state.oldId);
    expect(row?.status).toBe('pending');
    expect(row?.cancelled_at).toBeNull();
    expect(row?.replaced_by_bet_id).toBeNull();
    expect(await betCount(state.alex.id)).toBe(1);
    expect(await legCount(state.alex.id)).toBe(1);
    expect(await ledgerCount(state.alex.id, 'bet_refund')).toBe(0);
    expect(await balanceOf(env.DB, state.bkId)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    await expectLedgerMatchesBalance();
  }

  it('the replacement game goes in_progress mid-flight → clean no-op', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: () => updateGame(env.DB, g(2), { status: 'in_progress' }),
      }),
    );
    expect(code).toBe('GAME_NOT_BETTABLE');
    await expectCleanNoOp(state);
  });

  it('the replacement game is rescheduled into the past mid-flight → clean no-op', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: () => updateGame(env.DB, g(2), { kickoffAt: NOW - HOUR }),
      }),
    );
    expect(code).toBe('BETTING_CLOSED');
    await expectCleanNoOp(state);
  });

  it('the replacement game moves to EXACTLY lockAt mid-flight → clean no-op', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: () => updateGame(env.DB, g(2), { kickoffAt: NOW + BET_CUTOFF_BUFFER_MS }),
      }),
    );
    expect(code).toBe('BETTING_CLOSED');
    await expectCleanNoOp(state);
  });

  it('the OLD bet locking mid-flight is also a clean no-op (409 BET_LOCKED)', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: () => updateGame(env.DB, g(1), { status: 'in_progress' }),
      }),
    );
    expect(code).toBe('BET_LOCKED');
    await expectCleanNoOp(state);
  });

  /**
   * The account-state guard is on BOTH halves, and this is why. The refund is
   * conditioned on the cancel, and the replacement on the cancel too — but the
   * cancel is conditioned on nothing except its own `WHERE`. Guard only the
   * INSERT and this test would find the old bet `cancelled`, a `bet_refund` row
   * in the ledger, and no replacement: the user's position deleted and their
   * stake handed back, reported as a 409.
   */
  it('the account is DISABLED mid-flight → clean no-op, both halves refused', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: async () => {
          await env.DB.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?1')
            .bind(state.alex.id)
            .run();
        },
      }),
    );
    expect(code).toBe('ACCOUNT_DISABLED');
    await expectCleanNoOp(state);
  });

  it('the account is soft-DELETED mid-flight → clean no-op, both halves refused', async () => {
    const state = await pending();
    const code = await codeOf(() =>
      editBet(env, state.alex.id, state.oldId, straight(g(2), 4000), NOW, {
        beforeBatch: async () => {
          await env.DB.prepare('UPDATE users SET is_disabled = 1, deleted_at = ?2 WHERE id = ?1')
            .bind(state.alex.id, NOW)
            .run();
        },
      }),
    );
    expect(code).toBe('ACCOUNT_DISABLED');
    await expectCleanNoOp(state);
  });
});

describe('season and league labels (M5b: informational, not a bankroll key)', () => {
  it('bets.season comes from the LEGS games, never from a wall-clock guess', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), season: 2019, kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', straight(g(1)), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.season).toBe(2019);
    // ...and it is a LABEL now: the money comes out of the one account balance
    // whatever season the game belongs to.
    expect((await betRow(bet.id))?.bankroll_id).toBe(alex.bkId);
  });

  it('a January bowl is labelled season 2026 (its own season), not 2027', async () => {
    const alex = await register();
    // 2027-01-11, a championship game belonging to the 2026 season.
    await seedGameWithLine(
      env.DB,
      {
        id: gc('bowl'),
        league: 'ncaaf',
        season: 2026,
        seasonType: 3,
        kickoffAt: Date.UTC(2027, 0, 11, 0, 30),
      },
      { seenAt: Date.UTC(2027, 0, 10) },
    );
    const { bet } = await placeBet(
      env,
      alex.id,
      { ...straight(gc('bowl')), league: 'ncaaf' },
      Date.UTC(2027, 0, 10),
    );
    expect(bet.season).toBe(2026);
    expect(bet.league).toBe('ncaaf');
    expect((await betRow(bet.id))?.bankroll_id).toBe(alex.bkId);
    await expectLedgerMatchesBalance();
  });

  it('...even after 2027 preseason games have been ingested', async () => {
    const alex = await register();
    await seedGameWithLine(
      env.DB,
      {
        id: gc('bowl'),
        league: 'ncaaf',
        season: 2026,
        seasonType: 3,
        kickoffAt: Date.UTC(2027, 0, 11, 0, 30),
      },
      { seenAt: Date.UTC(2027, 0, 10) },
    );
    // A future season's slate exists in `games` — MAX(season) would be 2027.
    await seedGameWithLine(env.DB, {
      id: gc('next'),
      league: 'ncaaf',
      season: 2027,
      seasonType: 1,
      kickoffAt: Date.UTC(2027, 7, 30),
    });
    const { bet } = await placeBet(
      env,
      alex.id,
      { ...straight(gc('bowl')), league: 'ncaaf' },
      Date.UTC(2027, 0, 10),
    );
    expect(bet.season).toBe(2026);
  });

  it('legs from two seasons are ACCEPTED; the label is the EARLIEST leg season', async () => {
    const alex = await register();
    // g(2) is the 2027 game but kicks off FIRST, so 2027 is the label.
    await seedGameWithLine(env.DB, { id: g(1), season: 2026, kickoffAt: NOW + 3 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), season: 2027, kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', parlay([g(1), g(2)], 500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.season).toBe(2027);
    expect(bet.league).toBe('nfl');

    // Flip which one kicks off first and the label follows — it is the season of
    // the first game to start, not the smallest number and not the leg order.
    await updateGame(env.DB, g(1), { kickoffAt: NOW + 1 * HOUR });
    const second = await post('/api/bets', parlay([g(1), g(2)], 500), alex.cookie);
    expect(second.status, await second.clone().text()).toBe(201);
    expect((await second.json<BetResponse>()).bet.season).toBe(2026);
    await expectLedgerMatchesBalance();
  });

  it('a single-league bet keeps its own league label', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: gc(1), league: 'ncaaf', kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: gc(2), league: 'ncaaf', kickoffAt: NOW + 3 * HOUR });
    const res = await post(
      '/api/bets',
      { ...parlay([gc(1), gc(2)], 500), league: 'ncaaf' },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json<BetResponse>()).bet.league).toBe('ncaaf');
  });
});

describe('payout cap', () => {
  /** One leg at +100000 and a full-bankroll stake: 100,100,000c > the 1e8 cap. */
  async function overCapBet(): Promise<{ alex: Account; req: PlaceBetRequest }> {
    const alex = await register();
    await seedGame(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedLine(env.DB, { ...fullLine(g(1), NOW - 1000), mlHomePrice: 100_000 });
    return {
      alex,
      req: {
        league: 'nfl',
        betType: 'straight',
        stakeCents: INITIAL_BANKROLL_CENTS,
        legs: [{ gameId: g(1), market: 'moneyline', side: 'home' }],
      },
    };
  }

  it('a bet whose potential payout exceeds MAX_PAYOUT_CENTS is 409 PAYOUT_LIMIT_EXCEEDED', async () => {
    const { alex, req } = await overCapBet();
    expect(payoutCents(1, americanToPrice(100_000))).toBe(1001);
    const res = await post('/api/bets', req, alex.cookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('PAYOUT_LIMIT_EXCEEDED');
  });

  it('nothing is written when the cap rejects the bet', async () => {
    const { alex, req } = await overCapBet();
    expect((await post('/api/bets', req, alex.cookie)).status).toBe(409);
    expect(await betCount(alex.id)).toBe(0);
    expect(await legCount(alex.id)).toBe(0);
    // The cap is checked BEFORE the batch is built, so no statement ever ran:
    // the ledger still holds only signup's opening deposit.
    expect(await ledgerCount(alex.id)).toBe(1);
    expect(await ledgerCount(alex.id, 'bet_stake')).toBe(0);
    await expectLedgerMatchesBalance();
  });

  it('potential_payout_cents is always an exact INTEGER, never REAL', async () => {
    const alex = await register();
    await seedGame(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    // Just UNDER the cap: 99,000c at +100000 returns 99,099,000.
    await seedLine(env.DB, { ...fullLine(g(1), NOW - 1000), mlHomePrice: 100_000 });
    const res = await post(
      '/api/bets',
      {
        league: 'nfl',
        betType: 'straight',
        stakeCents: 99_000,
        legs: [{ gameId: g(1), market: 'moneyline', side: 'home' }],
      },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.potentialPayoutCents).toBe(99_099_000);
    expect(bet.potentialPayoutCents).toBeLessThanOrEqual(MAX_PAYOUT_CENTS);
    const t = await env.DB.prepare(
      `SELECT typeof(potential_payout_cents) AS t, potential_payout_cents AS v
         FROM bets WHERE id = ?1`,
    )
      .bind(bet.id)
      .first<{ t: string; v: number }>();
    expect(t?.t).toBe('integer');
    expect(t?.v).toBe(99_099_000);
  });

  it(
    'a 10-leg long-odds parlay never stores a rational — the price is recomputed ' +
      'from bet_legs.american_price and matches the value used at placement',
    async () => {
      const alex = await register();
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = g(i);
        await seedGame(env.DB, { id, kickoffAt: NOW + 2 * HOUR });
        await seedLine(env.DB, { ...fullLine(id, NOW - 1000), mlHomePrice: -110 });
        ids.push(id);
      }
      const res = await post('/api/bets', parlay(ids, 1000), alex.cookie);
      expect(res.status, await res.clone().text()).toBe(201);
      const { bet } = await res.json<BetResponse>();

      const legs = await legRows(bet.id);
      expect(legs).toHaveLength(10);
      const recomputed = priceFromLegs(legs.map((l) => l.american_price));
      // (210/110)^10 — a 24-digit numerator, and it lives only in memory.
      expect(recomputed.num).toBe(210n ** 10n);
      expect(recomputed.den).toBe(110n ** 10n);
      expect(bet.potentialPayoutCents).toBe(payoutCents(1000, recomputed));
      expect(bet.americanPrice).toBe(priceToAmerican(recomputed));
      // PLAN.md §5.4: the same parlay at the full bankroll pays 64,308,161.
      expect(payoutCents(100_000, recomputed)).toBe(64_308_161);
      await expectLedgerMatchesBalance();
    },
  );
});

describe('ledger safety', () => {
  /** A funded bankroll to attack, created through the real lazy prelude. */
  async function funded(): Promise<{ alex: Account; bkId: string }> {
    const alex = await register();
    const res = await get('/api/bankroll?league=nfl&season=2026', alex.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    return { alex, bkId: alex.bkId };
  }

  function insertOrIgnore(
    bkId: string,
    kind: string,
    refId: string,
    amount: number,
  ): Promise<unknown> {
    return env.DB.prepare(
      `INSERT OR IGNORE INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 'attack')`,
    )
      .bind(crypto.randomUUID(), bkId, kind, refId, amount, Date.now())
      .run();
  }

  it('INSERT OR IGNORE of an overdrafting ledger row ABORTS, it is not silently dropped', async () => {
    const { bkId } = await funded();
    await expect(insertOrIgnore(bkId, 'bet_stake', 'ghost', -9_999_999)).rejects.toThrow(
      /insufficient funds/,
    );
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });

  it('INSERT OR IGNORE against an unknown bankroll_id ABORTS (negative amount)', async () => {
    await funded();
    await expect(insertOrIgnore('NOPE', 'bet_stake', 'ghost', -100)).rejects.toThrow(
      /unknown bankroll_id/,
    );
  });

  it('an orphan-bankroll abort maps to 500 INTERNAL, never 409 INSUFFICIENT_FUNDS', async () => {
    await funded();
    let thrown: unknown;
    try {
      await insertOrIgnore('NOPE', 'bet_stake', 'ghost', -100);
    } catch (err) {
      thrown = err;
    }
    expect(isOrphanBankrollError(thrown)).toBe(true);
    expect(isOverdraftError(thrown)).toBe(false);
    const { fromThrown } = await import('../../src/shared/errors.js');
    expect(fromThrown(thrown).code).toBe('INTERNAL');
    expect(fromThrown(thrown).status).toBe(500);
  });

  it('an overdraft abort maps to 409 INSUFFICIENT_FUNDS', async () => {
    const { bkId } = await funded();
    let thrown: unknown;
    try {
      await insertOrIgnore(bkId, 'bet_stake', 'ghost', -9_999_999);
    } catch (err) {
      thrown = err;
    }
    expect(isOverdraftError(thrown)).toBe(true);
    const { fromThrown } = await import('../../src/shared/errors.js');
    expect(fromThrown(thrown).code).toBe('INSUFFICIENT_FUNDS');
    expect(fromThrown(thrown).status).toBe(409);
  });

  it('isOverdraftError and isOrphanBankrollError never both match the same error', async () => {
    const { bkId } = await funded();
    const errors: unknown[] = [];
    for (const attempt of [
      (): Promise<unknown> => insertOrIgnore(bkId, 'bet_stake', 'g1', -9_999_999),
      (): Promise<unknown> => insertOrIgnore('NOPE', 'bet_stake', 'g2', -100),
      (): Promise<unknown> => insertOrIgnore('NOPE', 'bet_stake', 'g3', 100),
    ]) {
      try {
        await attempt();
        throw new Error('expected the insert to abort');
      } catch (err) {
        errors.push(err);
      }
    }
    for (const err of errors) {
      expect(isOverdraftError(err) && isOrphanBankrollError(err)).toBe(false);
      expect(isOverdraftError(err) || isOrphanBankrollError(err)).toBe(true);
    }
  });

  it('INSERT OR IGNORE against an unknown bankroll_id ABORTS (POSITIVE amount)', async () => {
    await funded();
    // A COALESCE(..., -1) sentinel would let this through: -1 + 100 >= 0. The
    // guard is an explicit NOT EXISTS, and OR IGNORE suppresses the FK too.
    await expect(insertOrIgnore('NOPE', 'admin_adjust', 'g-positive', 100)).rejects.toThrow(
      /unknown bankroll_id/,
    );
    expect(await count(`SELECT COUNT(*) AS n FROM ledger WHERE bankroll_id = 'NOPE'`)).toBe(0);
  });

  it('INSERT OR IGNORE of a DUPLICATE (bankroll, kind, ref_id) is silently skipped', async () => {
    const { alex, bkId } = await funded();
    // The opening deposit already occupies (bkId, 'deposit_initial', 'init').
    await insertOrIgnore(bkId, 'deposit_initial', 'init', 100_000);
    expect(await ledgerCount(alex.id, 'deposit_initial')).toBe(1);
  });

  it('...and in that case the balance does not move', async () => {
    const { bkId } = await funded();
    const before = await balanceOf(env.DB, bkId);
    await insertOrIgnore(bkId, 'deposit_initial', 'init', 100_000);
    expect(await balanceOf(env.DB, bkId)).toBe(before);
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS);
  });

  it('SUM(ledger.amount_cents) === bankrolls.balance_cents holds after all of the above', async () => {
    const { alex, bkId } = await funded();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });

    const ok = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(ok.status, await ok.clone().text()).toBe(201);
    const { bet } = await ok.json<BetResponse>();
    await insertOrIgnore(bkId, 'deposit_initial', 'init', 100_000); // skipped
    await expect(insertOrIgnore(bkId, 'bet_stake', 'ghost', -9_999_999)).rejects.toThrow();
    await expect(insertOrIgnore('NOPE', 'admin_adjust', 'ghost', 100)).rejects.toThrow();
    expect((await del(`/api/bets/${bet.id}`, alex.cookie)).status).toBe(200);
    expect((await del(`/api/bets/${bet.id}`, alex.cookie)).status).toBe(409);

    expect(await ledgerSum(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS);
    expect(await balanceOf(env.DB, bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });
});

// ---------------------------------------------------------------------------
// Read paths (PLAN.md §11.4). Not in the original it.todo list, but the
// milestone owns GET /api/bets and GET /api/bets/:id and their filters.
// ---------------------------------------------------------------------------

describe('GET /api/bets', () => {
  async function threeBets(): Promise<Account> {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    await seedGameWithLine(env.DB, {
      id: gc(1),
      league: 'ncaaf',
      season: 2025,
      kickoffAt: NOW + 6 * HOUR,
    });
    expect((await post('/api/bets', straight(g(1), 100), alex.cookie)).status).toBe(201);
    expect((await post('/api/bets', straight(g(2), 200), alex.cookie)).status).toBe(201);
    const third = await post(
      '/api/bets',
      { ...straight(gc(1), 300), league: 'ncaaf' },
      alex.cookie,
    );
    expect(third.status, await third.clone().text()).toBe(201);
    return alex;
  }

  it('requires auth', async () => {
    const res = await get('/api/bets');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('filters by status, league, season and honours limit + cursor', async () => {
    const alex = await threeBets();

    const all = await (await get('/api/bets?status=all', alex.cookie)).json<BetsResponse>();
    expect(all.bets).toHaveLength(3);

    const nfl = await (await get('/api/bets?league=nfl', alex.cookie)).json<BetsResponse>();
    expect(nfl.bets.map((b) => b.league)).toEqual(['nfl', 'nfl']);

    const season = await (
      await get('/api/bets?league=ncaaf&season=2025', alex.cookie)
    ).json<BetsResponse>();
    expect(season.bets).toHaveLength(1);
    expect(season.bets[0]?.season).toBe(2025);

    const page1 = await (await get('/api/bets?limit=2', alex.cookie)).json<BetsResponse>();
    expect(page1.bets).toHaveLength(2);
    expect(page1.nextCursor).toBeTypeOf('string');
    const page2 = await (
      await get(
        `/api/bets?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        alex.cookie,
      )
    ).json<BetsResponse>();
    expect(page2.bets).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.bets, ...page2.bets].map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('status=open excludes cancelled and settled bets; status=settled is the complement', async () => {
    const alex = await threeBets();
    const open = await (await get('/api/bets?status=open', alex.cookie)).json<BetsResponse>();
    expect(open.bets).toHaveLength(3);
    const cancel = await del(`/api/bets/${open.bets[0]?.id ?? ''}`, alex.cookie);
    expect(cancel.status, await cancel.clone().text()).toBe(200);

    const stillOpen = await (await get('/api/bets?status=open', alex.cookie)).json<BetsResponse>();
    expect(stillOpen.bets).toHaveLength(2);
    const settled = await (await get('/api/bets?status=settled', alex.cookie)).json<BetsResponse>();
    expect(settled.bets).toHaveLength(1);
    expect(settled.bets[0]?.status).toBe('cancelled');
  });

  it('each open leg carries a live `projected` grade from the CURRENT game row', async () => {
    const alex = await register();
    const kickoffAt = NOW + 4 * HOUR;
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    const res = await post('/api/bets', straight(g(1), 500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();

    const before = await (await get('/api/bets', alex.cookie)).json<BetsResponse>();
    // Scheduled game: not decidable yet.
    expect(before.bets[0]?.legs[0]?.projected).toBe('pending');
    expect(before.bets[0]?.legs[0]?.result).toBeNull();

    // Home -3.5 with a 27-24 home win falls half a point short of covering.
    await updateGame(env.DB, g(1), { status: 'final', homeScore: 27, awayScore: 24 });
    const after = await (await get(`/api/bets/${bet.id}`, alex.cookie)).json<BetResponse>();
    expect(after.bet.legs[0]?.projected).toBe('loss');
    expect(after.bet.legs[0]?.game).toEqual({
      status: 'final',
      statusDetail: null,
      kickoffAt,
      homeScore: 27,
      awayScore: 24,
    });
    // Projection is NEVER persisted.
    const persisted = await env.DB.prepare(
      `SELECT result, graded_at FROM bet_legs WHERE bet_id = ?1`,
    )
      .bind(bet.id)
      .first<{ result: string | null; graded_at: number | null }>();
    expect(persisted).toEqual({ result: null, graded_at: null });
  });

  it("GET /api/bets/:id returns 404 BET_NOT_FOUND for another user's bet", async () => {
    const alex = await threeBets();
    const mine = await (await get('/api/bets', alex.cookie)).json<BetsResponse>();
    const bob = await register();
    const res = await get(`/api/bets/${mine.bets[0]?.id ?? ''}`, bob.cookie);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('BET_NOT_FOUND');

    const missing = await get('/api/bets/does-not-exist', alex.cookie);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('BET_NOT_FOUND');
  });

  it('cancellable reflects the CURRENT game rows, not earliest_kickoff_at', async () => {
    const alex = await register();
    const kickoffAt = NOW + 6 * HOUR;
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt });
    const res = await post('/api/bets', straight(g(1), 500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.cancellable).toBe(true);

    await updateGame(env.DB, g(1), { kickoffAt: NOW - HOUR, status: 'in_progress' });
    const after = await (await get(`/api/bets/${bet.id}`, alex.cookie)).json<BetResponse>();
    expect(after.bet.cancellable).toBe(false);
    expect(after.bet.earliestKickoffAt).toBe(kickoffAt);
  });
});

// ===========================================================================
// M5b: which BALANCE is charged
// ===========================================================================

describe('placeBet — the account balance', () => {
  it('defaults to the caller’s main balance when `bankrollId` is absent', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', straight(g(1), 2500), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.bankrollId).toBe(alex.bkId);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS - 2500);
    await expectLedgerMatchesBalance();
  });

  it('accepts the caller’s own balance named explicitly', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post(
      '/api/bets',
      { ...straight(g(1), 2500), bankrollId: alex.bkId },
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json<BetResponse>()).bet.bankrollId).toBe(alex.bkId);
  });

  it("someone else's balance is 404 BANKROLL_NOT_FOUND and writes nothing", async () => {
    const alex = await register();
    const bob = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const before = await balanceOf(env.DB, alex.bkId);

    const res = await post(
      '/api/bets',
      { ...straight(g(1), 2500), bankrollId: alex.bkId },
      bob.cookie,
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('BANKROLL_NOT_FOUND');
    // 404, never 403 — a balance id must not be an existence oracle.
    const missing = await post(
      '/api/bets',
      { ...straight(g(1), 2500), bankrollId: 'no-such-balance' },
      bob.cookie,
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('BANKROLL_NOT_FOUND');

    expect(await betCount(bob.id)).toBe(0);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(before);
    await expectLedgerMatchesBalance();
  });

  it('the in-batch ownership guard holds even if the pre-flight read is bypassed', async () => {
    // `resolveBankrollId` runs first, but only to produce a specific 404. The
    // real guard is `AND EXISTS (… WHERE id = ?3 AND user_id = ?2)` inside the
    // INSERT, and this drives `buildPlacement` directly to reach it.
    const alex = await register();
    const bob = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const req = straight(g(1), 2500);
    const parsed = validatePlaceBet(req);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const legs = await resolveLegSnapshots(env, req, NOW);
    const plan = buildPlacement(env, {
      userId: bob.id,
      input: parsed.value,
      // Bob's bet, ALEX's balance. Nothing outside the batch objects.
      bankrollId: alex.bkId,
      legs,
      now: NOW,
      replacesBetId: null,
      requiresCancelledBetId: null,
      memo: 'ownership guard',
    });
    const results = await env.DB.batch([...plan.statements]);
    expect(results[0]?.meta.changes).toBe(0);
    expect(await betCount(bob.id)).toBe(0);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });
});

// ===========================================================================
// M5b: teasers. PLAN.md §5.8.
// ===========================================================================

describe('placeBet — teasers', () => {
  /** A 6-point teaser on `gameIds`, spread-home legs unless overridden. */
  function teaser(
    gameIds: readonly string[],
    over: Partial<PlaceBetRequest> = {},
  ): PlaceBetRequest {
    return {
      league: 'nfl',
      betType: 'teaser',
      teaserPoints: 60,
      stakeCents: 1000,
      legs: gameIds.map((gameId) => ({ gameId, market: 'spread', side: 'home' }) as const),
      ...over,
    };
  }

  it('stores the TEASED line, keeps the book line, and prices from the card', async () => {
    const alex = await register();
    // fullLine: home spread -3.5 @ -110, total 45.5, over @ -110.
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    const res = await post(
      '/api/bets',
      teaser([g(1)], {
        legs: [
          { gameId: g(1), market: 'spread', side: 'home' },
          { gameId: g(2), market: 'total', side: 'over' },
        ],
      }),
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();

    expect(bet.betType).toBe('teaser');
    expect(bet.teaserPoints).toBe(60);
    const legs = await legRows(bet.id);
    // spread home -35 + 60 = +25 (-3.5 -> +2.5); total over 455 - 60 = 395.
    expect(legs[0]?.line_tenths).toBe(25);
    expect(legs[0]?.original_line_tenths).toBe(-35);
    expect(legs[1]?.line_tenths).toBe(395);
    expect(legs[1]?.original_line_tenths).toBe(455);
    // A teaser leg carries NO price: +100 is the schema-required placeholder.
    expect(legs.map((l) => l.american_price)).toEqual([100, 100]);

    // TEASER_PAYOUTS[60][2] = -120. REPL-verified at a 1000c stake: 1833.
    const row = await betRow(bet.id);
    expect(row?.american_price).toBe(-120);
    expect(row?.teaser_points_tenths).toBe(60);
    expect(row?.potential_payout_cents).toBe(1833);
    expect(row?.potential_payout_cents).toBe(payoutCents(1000, americanToPrice(-120)));
    expect(bet.potentialPayoutCents).toBe(1833);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS - 1000);
    await expectLedgerMatchesBalance();
  });

  it('prices a 3-leg 6-point teaser at +150 (REPL: 1000c -> 2500)', async () => {
    const alex = await register();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await seedGameWithLine(env.DB, { id: g(i), kickoffAt: NOW + 2 * HOUR }));
    }
    const res = await post('/api/bets', teaser(ids), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.americanPrice).toBe(150);
    expect(bet.potentialPayoutCents).toBe(2500);
    // ...and it is NOT the product of the legs, which would be 2^3 = 8000.
    expect(bet.potentialPayoutCents).not.toBe(8000);
  });

  it('each tier moves the line by its own number of points', async () => {
    const alex = await register();
    for (const [i, tier] of [30, 60, 65, 70, 140].entries()) {
      const a = await seedGameWithLine(env.DB, {
        id: g(`a${String(i)}`),
        kickoffAt: NOW + 2 * HOUR,
      });
      const b = await seedGameWithLine(env.DB, {
        id: g(`b${String(i)}`),
        kickoffAt: NOW + 2 * HOUR,
      });
      const res = await post(
        '/api/bets',
        teaser([a, b], { teaserPoints: tier, stakeCents: 100 }),
        alex.cookie,
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const { bet } = await res.json<BetResponse>();
      const legs = await legRows(bet.id);
      expect(legs[0]?.line_tenths).toBe(-35 + tier);
      expect(bet.teaserPoints).toBe(tier);
    }
    await expectLedgerMatchesBalance();
  });

  it('a cross-league teaser is legal and lands as league=mixed', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: gc(1), league: 'ncaaf', kickoffAt: NOW + 3 * HOUR });
    const res = await post('/api/bets', teaser([g(1), gc(1)]), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.league).toBe('mixed');
    expect(bet.betType).toBe('teaser');
    expect((await legRows(bet.id)).every((l) => l.original_line_tenths !== null)).toBe(true);
    await expectLedgerMatchesBalance();
  });

  it('a moneyline leg is 400 VALIDATION naming that leg’s market', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    const res = await post(
      '/api/bets',
      teaser([g(1)], {
        legs: [
          { gameId: g(1), market: 'spread', side: 'home' },
          { gameId: g(2), market: 'moneyline', side: 'home' },
        ],
      }),
      alex.cookie,
    );
    expect(res.status).toBe(400);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details?.['field']).toBe('legs[1].market');
    expect(await betCount(alex.id)).toBe(0);
  });

  it('requires a tier, rejects an off-card one, and rejects one on a parlay', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    const ids = [g(1), g(2)];

    const none = await post(
      '/api/bets',
      { league: 'nfl', betType: 'teaser', stakeCents: 1000, legs: teaser(ids).legs },
      alex.cookie,
    );
    expect(none.status).toBe(400);
    expect(await errorCode(none)).toBe('VALIDATION');

    // 6 POINTS rather than 60 TENTHS is the obvious client bug.
    const points = await post('/api/bets', { ...teaser(ids), teaserPoints: 6 }, alex.cookie);
    expect(points.status).toBe(400);

    const onParlay = await post(
      '/api/bets',
      { ...parlay(ids, 1000), teaserPoints: 60 },
      alex.cookie,
    );
    expect(onParlay.status).toBe(400);
    expect(await betCount(alex.id)).toBe(0);
  });

  it('a one-leg teaser is refused before the DB CHECK ever sees it', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    const res = await post('/api/bets', teaser([g(1)]), alex.cookie);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION');
  });

  it('`expected` is compared against the BOOK line, so a tease is not a LINE_CHANGED', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    const res = await post(
      '/api/bets',
      teaser([g(1)], {
        legs: [
          {
            gameId: g(1),
            market: 'spread',
            side: 'home',
            // The number the BOARD showed, not the teased one.
            expected: { americanPrice: -110, lineTenths: -35 },
          },
          {
            gameId: g(2),
            market: 'spread',
            side: 'home',
            expected: { americanPrice: -110, lineTenths: -35 },
          },
        ],
      }),
      alex.cookie,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await legRows((await res.json<BetResponse>()).bet.id))[0]?.line_tenths).toBe(25);

    // ...and a real move is still caught.
    await seedLine(env.DB, { ...fullLine(g(1), NOW - 500), spreadHomeTenths: -45 });
    const moved = await post(
      '/api/bets',
      teaser([g(1)], {
        legs: [
          {
            gameId: g(1),
            market: 'spread',
            side: 'home',
            expected: { americanPrice: -110, lineTenths: -35 },
          },
          { gameId: g(2), market: 'spread', side: 'home' },
        ],
      }),
      alex.cookie,
    );
    expect(moved.status).toBe(409);
    expect(await errorCode(moved)).toBe('LINE_CHANGED');
  });

  it('a teaser can be cancelled and edited like any other bet', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 4 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 5 * HOUR });
    await seedGameWithLine(env.DB, { id: g(3), kickoffAt: NOW + 6 * HOUR });
    const first = await post('/api/bets', teaser([g(1), g(2)]), alex.cookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const { bet: old } = await first.json<BetResponse>();

    // Edit to a 3-leg 7-point teaser: re-teased from the CURRENT book lines.
    const edited = await put(
      `/api/bets/${old.id}`,
      teaser([g(1), g(2), g(3)], { teaserPoints: 70 }),
      alex.cookie,
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
    const { bet } = await edited.json<BetResponse>();
    expect(bet.teaserPoints).toBe(70);
    expect(bet.americanPrice).toBe(120); // TEASER_PAYOUTS[70][3]
    expect((await legRows(bet.id))[0]?.line_tenths).toBe(-35 + 70);
    expect(bet.bankrollId).toBe(alex.bkId);

    const cancelled = await del(`/api/bets/${bet.id}`, alex.cookie);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(await balanceOf(env.DB, alex.bkId)).toBe(INITIAL_BANKROLL_CENTS);
    await expectLedgerMatchesBalance();
  });

  it('BetView exposes the tier and both lines so My Bets can render the move', async () => {
    const alex = await register();
    await seedGameWithLine(env.DB, { id: g(1), kickoffAt: NOW + 2 * HOUR });
    await seedGameWithLine(env.DB, { id: g(2), kickoffAt: NOW + 3 * HOUR });
    const res = await post('/api/bets', teaser([g(1), g(2)]), alex.cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const { bet } = await res.json<BetResponse>();
    expect(bet.teaserPoints).toBe(60);
    expect(bet.legs[0]?.originalLineTenths).toBe(-35);
    expect(bet.legs[0]?.lineTenths).toBe(25);
    expect(bet.legs[0]?.league).toBe('nfl');
    // A straight's legs carry no pre-tease line at all.
    const plain = await post('/api/bets', straight(g(1), 500), alex.cookie);
    expect(plain.status, await plain.clone().text()).toBe(201);
    expect((await plain.json<BetResponse>()).bet.legs[0]?.originalLineTenths).toBeNull();
  });
});
