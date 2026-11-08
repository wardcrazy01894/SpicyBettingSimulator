/**
 * F1: the admin "void game" action — `POST /api/admin/games/:id/void`
 * (PLAN.md §11.6, §24.11). A basketball final short of regulation is
 * `undecidable` and parks its bets in `stats.stuck[]`; this route is the
 * in-app way out, replacing the hand-run remote SQL in docs/OPERATIONS.md.
 *
 * The route is ONE guarded UPDATE (status → 'canceled', `updated_at = now`);
 * everything after it is the existing machinery: `RESET_DEFERRED_SQL` re-selects
 * the parked bet because `games.updated_at` moved, and the settle path voids
 * every leg on a canceled game. So the end-to-end test drives the real settle
 * job on both sides of the void and checks the money.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdminVoidGameResponse, UserResponse } from '../../src/shared/api-types.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { INITIAL_BANKROLL_CENTS, MAX_SETTLE_ATTEMPTS } from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { VOID_REASON_MAX } from '../../src/shared/validate.js';
import type { League } from '../../src/shared/types.js';
import { placeBet } from '../../src/worker/bets.js';
import { upsertSlate } from '../../src/worker/ingest.js';
import { buildApp } from '../../src/worker/index.js';
import type { ProviderSlate } from '../../src/worker/providers.js';
import { runSettle } from '../../src/worker/settle.js';
import { buildScoreboard, stubEspn } from './fixtures.js';
import type { EspnStub, EventSpec } from './fixtures.js';
import { bankrollDrift, mainBankrollId, seedGame, seedGameWithLine, updateGame } from './seed.js';

const ORIGIN = 'https://example.com';
const INVITE = 'test-invite'; // vitest.workers.config.ts
const MIN = 60_000;
const HOUR = 60 * MIN;

let espn: EspnStub;
let seq = 0;

beforeEach(() => {
  espn = stubEspn({});
  seq += 1;
});

afterEach(() => {
  espn.restore();
});

function send(path: string, cookie: string | null, payload?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'X-SBS-Client': '1' };
  if (cookie !== null) headers['cookie'] = cookie;
  const init: RequestInit = { method: 'POST', headers };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  return Promise.resolve(buildApp().request(`${ORIGIN}${path}`, init, env));
}

const voidPath = (id: string): string => `/api/admin/games/${encodeURIComponent(id)}/void`;

let accountSeq = 0;
async function register(admin: boolean): Promise<{ cookie: string; id: string }> {
  accountSeq += 1;
  const res = await send('/api/auth/signup', null, {
    username: `vg${String(seq)}x${String(accountSeq)}`,
    dk: 'a'.repeat(64),
    inviteCode: INVITE,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json<UserResponse>();
  await env.DB.prepare('UPDATE users SET is_admin = ?1 WHERE id = ?2')
    .bind(admin ? 1 : 0, body.user.id)
    .run();
  const cookie = /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
  return { cookie, id: body.user.id };
}

async function gameRow(
  id: string,
): Promise<{ status: string; status_detail: string | null; updated_at: number }> {
  const row = await env.DB.prepare(
    'SELECT status, status_detail, updated_at FROM games WHERE id = ?1',
  )
    .bind(id)
    .first<{ status: string; status_detail: string | null; updated_at: number }>();
  if (row === null) throw new Error(`no game ${id}`);
  return row;
}

function makeSlate(specs: readonly EventSpec[], league: League, fetchedAt: number): ProviderSlate {
  const parsed = parseScoreboard(buildScoreboard(specs), league, fetchedAt);
  return {
    games: parsed.games,
    lines: parsed.lines,
    warnings: parsed.warnings,
    pulled: parsed.pulled,
    fetchedAt,
    season: parsed.season,
    week: parsed.week,
  };
}

describe('POST /api/admin/games/:id/void — the stuck short final, end to end (PLAN.md §24.11)', () => {
  it('parks in stuck[], is voided in-app, and the next settle refunds the straight and reprices the parlay', async () => {
    const user = await register(false);
    const admin = await register(true);
    const T = Date.now();
    // Every instant the test hands the settle job is in the PAST, so the void
    // route's real `now` is strictly newer than any `settle_attempted_at`.
    const base = T - 6 * HOUR;
    const abandoned = `ncaab:va${String(seq)}`;
    const other = `ncaab:vb${String(seq)}`;
    for (const id of [abandoned, other]) {
      // `lastSeenAt` is also the seeded `updated_at`: old, like a real row
      // nobody has touched since ESPN called it final.
      await seedGameWithLine(env.DB, {
        id,
        league: 'ncaab',
        season: 2027,
        week: null,
        kickoffAt: base + HOUR,
        lastSeenAt: base,
      });
    }
    const straight = await placeBet(
      env,
      user.id,
      {
        league: 'ncaab',
        betType: 'straight',
        stakeCents: 1000,
        legs: [{ gameId: abandoned, market: 'spread', side: 'home' }],
      },
      base,
    );
    const parlay = await placeBet(
      env,
      user.id,
      {
        league: 'ncaab',
        betType: 'parlay',
        stakeCents: 1000,
        legs: [
          { gameId: abandoned, market: 'moneyline', side: 'home' },
          { gameId: other, market: 'spread', side: 'home' },
        ],
      },
      base,
    );

    // The abandoned game: ESPN says final after ONE half — `undecidable`.
    await updateGame(env.DB, abandoned, {
      status: 'final',
      homeScore: 30,
      awayScore: 20,
      period: 1,
    });
    // The other leg: a complete game, home by 10, covers −3.5.
    await updateGame(env.DB, other, { status: 'final', homeScore: 80, awayScore: 70, period: 2 });

    const first = await runSettle(env, T - 2 * HOUR, 200);
    expect(first.deferred).toBeGreaterThanOrEqual(2);
    for (const bet of [straight.bet, parlay.bet]) {
      const row = await env.DB.prepare('SELECT status, settle_error FROM bets WHERE id = ?1')
        .bind(bet.id)
        .first<{ status: string; settle_error: string | null }>();
      expect(row?.status).toBe('pending');
      expect(row?.settle_error).toContain('abandoned game');
    }

    // 480 runs later (simulated: the counter is the only thing they change).
    await env.DB.prepare('UPDATE bets SET settle_attempts = ?1 WHERE id IN (?2, ?3)')
      .bind(MAX_SETTLE_ATTEMPTS, straight.bet.id, parlay.bet.id)
      .run();
    const parked = await runSettle(env, T - HOUR, 200);
    expect(parked.stuck).toEqual(expect.arrayContaining([straight.bet.id, parlay.bet.id]));
    // The Jobs page's Void buttons: the UNDECIDABLE game only — the complete
    // final the parlay also rides on is not a candidate.
    expect(parked.stuckGames).toContain(abandoned);
    expect(parked.stuckGames).not.toContain(other);

    const res = await send(voidPath(abandoned), admin.cookie, { reason: 'called at half, roof' });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<AdminVoidGameResponse>();
    expect(body).toEqual({
      id: abandoned,
      status: 'canceled',
      statusDetail: 'admin void: called at half, roof',
      affectedBets: 2,
    });
    const voided = await gameRow(abandoned);
    expect(voided.status).toBe('canceled');
    expect(voided.updated_at).toBeGreaterThanOrEqual(T);

    // The very next settle run finishes both: the reset sweep re-selects them
    // because the game's updated_at moved past their last attempt.
    const after = await runSettle(env, Date.now(), 200);
    expect(after.reset).toBeGreaterThanOrEqual(2);
    expect(after.stuck).not.toContain(straight.bet.id);
    expect(after.stuck).not.toContain(parlay.bet.id);

    const betRow = (id: string) =>
      env.DB.prepare('SELECT status, payout_cents FROM bets WHERE id = ?1')
        .bind(id)
        .first<{ status: string; payout_cents: number }>();
    expect(await betRow(straight.bet.id)).toEqual({ status: 'void', payout_cents: 1000 });
    // §7.4: the void leg drops out and the parlay is the −110 leg alone —
    // 1909¢ on 1000¢, the same figure as PLAN §7.3's one-surviving-leg case.
    expect(await betRow(parlay.bet.id)).toEqual({ status: 'won', payout_cents: 1909 });

    const bankrollId = await mainBankrollId(env.DB, user.id);
    // A settled VOID returns the stake as the bet's `bet_payout` row
    // (SETTLE_PAYOUT_INSERT_SQL) — `bet_refund` is the owner's cancellation.
    const refund = await env.DB.prepare(
      `SELECT kind, amount_cents FROM ledger
        WHERE bankroll_id = ?1 AND ref_id = ?2 AND kind IN ('bet_payout', 'bet_refund')`,
    )
      .bind(bankrollId, straight.bet.id)
      .all<{ kind: string; amount_cents: number }>();
    expect(refund.results).toEqual([{ kind: 'bet_payout', amount_cents: 1000 }]);
    // The money invariant, for every bankroll in the database.
    expect(await bankrollDrift(env.DB)).toEqual([]);
    const balance = await env.DB.prepare('SELECT balance_cents AS b FROM bankrolls WHERE id = ?1')
      .bind(bankrollId)
      .first<{ b: number }>();
    expect(balance?.b).toBe(INITIAL_BANKROLL_CENTS - 2000 + 1000 + 1909);
  });
});

describe('POST /api/admin/games/:id/void — refusals and the terminal status', () => {
  it('with no body, defaults the reason and counts zero bets', async () => {
    const admin = await register(true);
    const id = `nba:vn${String(seq)}`;
    await seedGame(env.DB, {
      id,
      league: 'nba',
      week: null,
      kickoffAt: Date.now() - 3 * HOUR,
      status: 'final',
      period: 2,
    });
    const res = await send(voidPath(id), admin.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json<AdminVoidGameResponse>()).toEqual({
      id,
      status: 'canceled',
      statusDetail: 'admin void: abandoned game',
      affectedBets: 0,
    });
  });

  it('refuses a game that is already canceled: 400 VALIDATION, row untouched', async () => {
    const admin = await register(true);
    const id = `nba:vc${String(seq)}`;
    await seedGame(env.DB, {
      id,
      league: 'nba',
      week: null,
      kickoffAt: Date.now() - 3 * HOUR,
      status: 'canceled',
      statusDetail: 'auto-void: NBA postponed, not played on its date',
      lastSeenAt: 1234,
    });
    const res = await send(voidPath(id), admin.cookie, { reason: 'again' });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
    expect(await gameRow(id)).toEqual({
      status: 'canceled',
      status_detail: 'auto-void: NBA postponed, not played on its date',
      updated_at: 1234,
    });
  });

  it('refuses a reason over the limit or of the wrong type: 400 VALIDATION, row untouched', async () => {
    const admin = await register(true);
    const id = `nba:vr${String(seq)}`;
    await seedGame(env.DB, {
      id,
      league: 'nba',
      week: null,
      kickoffAt: Date.now() - 3 * HOUR,
      status: 'final',
    });
    for (const payload of [{ reason: 'x'.repeat(VOID_REASON_MAX + 1) }, { reason: 5 }]) {
      const res = await send(voidPath(id), admin.cookie, payload);
      expect(res.status).toBe(400);
      expect((await res.json<ApiErrorBody>()).error.code).toBe('VALIDATION');
    }
    expect((await gameRow(id)).status).toBe('final');
  });

  it('is 404 GAME_NOT_FOUND for an unknown id', async () => {
    const admin = await register(true);
    const res = await send(voidPath('ncaab:nope'), admin.cookie);
    expect(res.status).toBe(404);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('GAME_NOT_FOUND');
  });

  it('is invisible to a non-admin (404 NOT_FOUND, §11.6) and 401 when signed out; the game is untouched', async () => {
    const plain = await register(false);
    const id = `nba:vp${String(seq)}`;
    await seedGame(env.DB, {
      id,
      league: 'nba',
      week: null,
      kickoffAt: Date.now() - 3 * HOUR,
      status: 'final',
    });
    const res = await send(voidPath(id), plain.cookie);
    expect(res.status).toBe(404);
    expect((await res.json<ApiErrorBody>()).error.code).toBe('NOT_FOUND');
    const anon = await send(voidPath(id), null);
    expect(anon.status).toBe(401);
    expect((await gameRow(id)).status).toBe('final');
  });

  it('a refresh after the void cannot flip it back: canceled is terminal in the ingest upsert', async () => {
    const admin = await register(true);
    const eventId = `vt${String(seq)}`;
    const id = `ncaab:${eventId}`;
    const kickoff = Date.now() - 4 * HOUR;
    const spec: EventSpec = {
      eventId,
      league: 'ncaab',
      kickoffAt: kickoff,
      status: 'post',
      homeAbbr: 'LOU',
      awayAbbr: 'MORE',
      season: 2027,
      homeScore: 31,
      awayScore: 22,
      period: 1,
    };
    await upsertSlate(env, makeSlate([spec], 'ncaab', kickoff + 2 * HOUR), kickoff + 2 * HOUR);
    expect((await gameRow(id)).status).toBe('final');

    const res = await send(voidPath(id), admin.cookie, { reason: 'abandoned' });
    expect(res.status, await res.clone().text()).toBe(200);
    const before = await gameRow(id);

    // ESPN still says final — with a new score even, which would be a real
    // data change for any non-terminal row.
    await upsertSlate(
      env,
      makeSlate([{ ...spec, homeScore: 33 }], 'ncaab', Date.now()),
      Date.now(),
    );
    const after = await gameRow(id);
    expect(after.status).toBe('canceled');
    expect(after.status_detail).toBe('admin void: abandoned');
    expect(after.updated_at).toBe(before.updated_at);
  });
});
