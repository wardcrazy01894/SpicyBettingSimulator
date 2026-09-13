/**
 * Bet placement, cancellation and editing. PLAN.md §11.4 and §14.2.
 *
 * EVERY mutation here is exactly ONE `db.batch()`. There is no read-then-write
 * anywhere: the kickoff/status guard is a `WHERE` clause inside the same batch as
 * the INSERT, and insufficient funds is caught by
 * `CHECK (balance_cents >= 0)` firing inside the ledger trigger, which rolls the
 * whole batch back.
 *
 * The client NEVER sends the price it will be charged. The server reads the
 * current `game_lines` row and snapshots market, side, line, price, provider and
 * capture time into `bet_legs`. An optional `expected` block gives the user
 * line-change protection (409 LINE_CHANGED).
 *
 * `bets.season` is derived from the LEGS' games, never from a wall-clock guess,
 * and all legs must share one (league, season) so exactly one bankroll is
 * charged -- otherwise MIXED_LEAGUE_PARLAY / MIXED_SEASON_PARLAY.
 *
 * `bets` stores NO decimal-odds rational. `american_price` is display and
 * `potential_payout_cents` is capped at MAX_PAYOUT_CENTS; the exact price is
 * always recomputed from `bet_legs.american_price` (PLAN.md §5.2).
 */

import type {
  BetLegView,
  BetView,
  LineChangedDetails,
  PlaceBetRequest,
} from '../shared/api-types.js';
import type {
  AmericanPrice,
  BetLegSnapshot,
  BetStatus,
  BetType,
  EpochMs,
  GameStatus,
  League,
  LegResult,
  LineTenths,
  Market,
  Side,
} from '../shared/types.js';
import {
  BET_CUTOFF_BUFFER_MS,
  LINE_STALE_MS,
  MAX_ABS_AMERICAN_PRICE,
  MIN_ABS_AMERICAN_PRICE,
} from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import { projectLeg } from '../shared/grading.js';
import {
  americanToPrice,
  exceedsPayoutCap,
  formatDecimalOdds,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
} from '../shared/odds.js';
import { lockAtFor } from '../shared/time.js';
import type { PlaceBetInput } from '../shared/validate.js';
import { validatePlaceBet } from '../shared/validate.js';
import {
  bankrollId,
  ensureBankrollStatements,
  isLeague,
  placeholders,
  resolveBetScope,
} from './bankroll.js';
import {
  changesAt,
  isOrphanBankrollError,
  isOverdraftError,
  isUniqueViolation,
  newId,
  queryAll,
  queryOne,
  runBatch,
} from './db.js';
import type { Env } from './env.js';

export interface PlaceBetResult {
  readonly bet: BetView;
}

/** Default and ceiling for `GET /api/bets?limit=`. */
export const DEFAULT_BET_PAGE = 50;
export const MAX_BET_PAGE = 200;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface GameRow {
  id: string;
  league: string;
  season: number;
  status: string;
  kickoff_at: number;
  home_abbr: string;
  away_abbr: string;
}

interface LineRow {
  game_id: string;
  provider: string;
  spread_home_tenths: number | null;
  spread_home_price: number | null;
  spread_away_tenths: number | null;
  spread_away_price: number | null;
  total_tenths: number | null;
  total_over_price: number | null;
  total_under_price: number | null;
  ml_home_price: number | null;
  ml_away_price: number | null;
  captured_at: number;
  seen_at: number;
}

interface BetRow {
  id: string;
  user_id: string;
  bankroll_id: string;
  league: string;
  season: number;
  bet_type: string;
  leg_count: number;
  stake_cents: number;
  american_price: number;
  potential_payout_cents: number;
  status: string;
  payout_cents: number | null;
  placed_at: number;
  earliest_kickoff_at: number;
  settled_at: number | null;
  cancelled_at: number | null;
  replaces_bet_id: string | null;
  replaced_by_bet_id: string | null;
}

/** A `bet_legs` row joined to its CURRENT `games` row (for `projected` + display). */
interface LegRow {
  id: string;
  bet_id: string;
  leg_index: number;
  game_id: string;
  league: string;
  market: string;
  side: string;
  line_tenths: number | null;
  american_price: number;
  provider: string;
  line_captured_at: number;
  snapshot_at: number;
  kickoff_at_snapshot: number;
  home_abbr: string;
  away_abbr: string;
  result: string | null;
  g_status: string;
  g_status_detail: string | null;
  g_kickoff_at: number;
  g_home_score: number | null;
  g_away_score: number | null;
}

/** The immutable snapshot plus its position in the bet. */
export interface ResolvedLeg extends BetLegSnapshot {
  readonly legIndex: number;
}

// ---------------------------------------------------------------------------
// THE LITERAL SQL (PLAN.md §14.2). Kept as named constants so a reviewer can
// diff them against the plan without reading the code that assembles them.
// ---------------------------------------------------------------------------

/**
 * Statement 1 of placement. Guarded on ALL legs being bettable AND sharing the
 * one `(league, season)` the bankroll is keyed on, re-checked INSIDE the batch
 * so a reschedule cannot race between the read and the write (PLAN.md §14.1).
 *
 * `?7` is `leg_count`, which is also the `= :n` the COUNT must reach.
 * `?15…` are the leg game ids.
 */
function betInsertSql(legCount: number, extraGuard: string): string {
  return `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                    stake_cents, american_price, potential_payout_cents, status,
                    placed_at, earliest_kickoff_at, replaces_bet_id, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?13, ?11, ?11
 WHERE (SELECT COUNT(*) FROM games
         WHERE id IN (${placeholders(legCount, 15)})
           AND league = ?4 AND season = ?5
           AND status = 'scheduled'
           AND kickoff_at > ?14) = ?7${extraGuard}`;
}

/** Statements 2..n+1: one per leg, each guarded on the bet row existing. */
const LEG_INSERT_SQL = `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side,
                      line_tenths, american_price, provider, line_captured_at,
                      snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
 WHERE EXISTS (SELECT 1 FROM bets WHERE id = ?2)`;

/** Statement n+2: the stake debit, sourced from the bet row the batch just wrote. */
const STAKE_INSERT_SQL = `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT ?1, b.bankroll_id, 'bet_stake', b.id, b.id, ?3, ?4, ?5
  FROM bets b WHERE b.id = ?2`;

/**
 * The cancel transition.
 *
 * THE LOCK GUARD IS A `NOT EXISTS` OVER THE CURRENT `games` ROWS, never
 * `bets.earliest_kickoff_at` — that column is a placement-time snapshot which
 * ingestion never updates, so a guard against it alone lets a user whose game
 * was rescheduled two hours earlier watch the first quarter and then cancel for
 * a full refund (CLAUDE.md rule 8b / PLAN.md §14.2).
 *
 * The EDIT variant of this statement is spelled out inline in `editBet`: it
 * needs an extra `SET` and an extra guard, and a template with holes in it would
 * be harder to diff against the plan than two explicit copies.
 */
const CANCEL_UPDATE_SQL = `UPDATE bets
   SET status = 'cancelled', cancelled_at = ?3, updated_at = ?3
 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = ?1
        AND (g.status <> 'scheduled' OR g.kickoff_at <= ?4))`;

/**
 * The refund, guarded THREE ways.
 *
 * The obvious `... WHERE b.status = 'cancelled'` is wrong: on a SECOND cancel of
 * an already-cancelled bet the UPDATE matches 0 rows but this SELECT still
 * matches, so the INSERT fires, hits `UNIQUE(bankroll_id,'bet_refund',betId)`
 * and aborts the whole batch with a 500 — where the correct answer is a quiet
 * `409 BET_NOT_PENDING`. `?3` (`:now`) is captured once per request and is
 * therefore a nonce for THIS call; the ledger `NOT EXISTS` is the belt to its
 * braces.
 */
function refundInsertSql(extraGuard: string): string {
  return `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT ?5, b.bankroll_id, 'bet_refund', b.id, b.id, b.stake_cents, ?3, ?6
  FROM bets b
 WHERE b.id = ?1
   AND b.status = 'cancelled'
   AND b.cancelled_at = ?3${extraGuard}
   AND NOT EXISTS (SELECT 1 FROM ledger
                    WHERE bankroll_id = b.bankroll_id AND kind = 'bet_refund' AND ref_id = b.id)`;
}

// ---------------------------------------------------------------------------
// Reading the current market
// ---------------------------------------------------------------------------

interface MarketQuote {
  readonly americanPrice: AmericanPrice;
  readonly lineTenths: LineTenths | null;
}

/** A price we are willing to write into `bet_legs` (whose CHECK bounds it). */
function usablePrice(value: number | null): value is number {
  if (value === null || !Number.isSafeInteger(value)) return false;
  const magnitude = Math.abs(value);
  return magnitude >= MIN_ABS_AMERICAN_PRICE && magnitude <= MAX_ABS_AMERICAN_PRICE;
}

/**
 * The one quote a (market, side) pair refers to, or null when the book does not
 * offer it. `line_tenths` comes back FROM THE BETTOR'S SIDE: home −3.5 is −35,
 * away +3.5 is +35, and both sides of a total carry the total itself.
 */
function quoteFor(line: LineRow, market: Market, side: Side): MarketQuote | null {
  switch (market) {
    case 'moneyline': {
      const price = side === 'home' ? line.ml_home_price : line.ml_away_price;
      return usablePrice(price) ? { americanPrice: price, lineTenths: null } : null;
    }
    case 'spread': {
      const price = side === 'home' ? line.spread_home_price : line.spread_away_price;
      const tenths = side === 'home' ? line.spread_home_tenths : line.spread_away_tenths;
      if (!usablePrice(price) || tenths === null || !Number.isSafeInteger(tenths)) return null;
      return { americanPrice: price, lineTenths: tenths };
    }
    case 'total': {
      const price = side === 'over' ? line.total_over_price : line.total_under_price;
      const tenths = line.total_tenths;
      if (!usablePrice(price) || tenths === null || !Number.isSafeInteger(tenths)) return null;
      return { americanPrice: price, lineTenths: tenths };
    }
  }
}

/** A failed `ValidationResult` -> AppError, preserving the offending field. */
function validated(req: PlaceBetRequest): PlaceBetInput {
  const parsed = validatePlaceBet(req);
  if (parsed.ok) return parsed.value;
  return throwValidation(parsed.message, parsed.field);
}

function throwValidation(message: string, field?: string): never {
  throw field === undefined
    ? new AppError('VALIDATION', message)
    : new AppError('VALIDATION', message, { field });
}

async function loadGames(env: Env, gameIds: readonly string[]): Promise<Map<string, GameRow>> {
  const rows = await queryAll<GameRow>(
    env.DB.prepare(
      `SELECT id, league, season, status, kickoff_at, home_abbr, away_abbr
         FROM games WHERE id IN (${placeholders(gameIds.length)})`,
    ).bind(...gameIds),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The current `game_lines` row per game. `PRIMARY KEY (game_id, provider)`
 * allows more than one book; v1 only ever writes DraftKings, and if a second
 * provider ever appears the most recently CONFIRMED row wins.
 */
async function loadLines(env: Env, gameIds: readonly string[]): Promise<Map<string, LineRow>> {
  const rows = await queryAll<LineRow>(
    env.DB.prepare(
      `SELECT * FROM game_lines WHERE game_id IN (${placeholders(gameIds.length)})
        ORDER BY seen_at ASC`,
    ).bind(...gameIds),
  );
  // ASC + overwrite leaves the freshest row per game.
  const byGame = new Map<string, LineRow>();
  for (const row of rows) byGame.set(row.game_id, row);
  return byGame;
}

/**
 * Read the current line for each requested leg and build the immutable snapshot.
 * Rejects a market that is absent or whose `seen_at` (NOT `captured_at`) is older
 * than LINE_STALE_MS, and compares against `expected` when supplied.
 * `line_captured_at` on the snapshot copies `game_lines.captured_at`, i.e. when
 * the book's price last actually changed.
 *
 * ORDER OF REJECTION, and why: `GAME_NOT_FOUND` → `GAME_NOT_BETTABLE` →
 * `BETTING_CLOSED` → `MARKET_UNAVAILABLE` → `LINE_CHANGED`. Status precedes the
 * clock because an in-progress game is also past its lock and PLAN.md §13 asks
 * for `GAME_NOT_BETTABLE` there. `MARKET_UNAVAILABLE` precedes `LINE_CHANGED`
 * because a vanished market is not a price the user can accept: no value of
 * `acceptLineChange` makes a bet at a non-existent price placeable.
 */
export async function resolveLegSnapshots(
  env: Env,
  req: PlaceBetRequest,
  now: EpochMs,
): Promise<readonly ResolvedLeg[]> {
  const input = validated(req);
  const gameIds = input.legs.map((l) => l.gameId);
  const [games, lines] = await Promise.all([loadGames(env, gameIds), loadLines(env, gameIds)]);
  const nowPlusBuffer = now + BET_CUTOFF_BUFFER_MS;
  const resolved: ResolvedLeg[] = [];
  const changed: LineChangedDetails['legs'][number][] = [];

  for (const [legIndex, leg] of input.legs.entries()) {
    const game = games.get(leg.gameId);
    if (game === undefined) {
      throw new AppError('GAME_NOT_FOUND', `Game ${leg.gameId} does not exist.`, {
        gameId: leg.gameId,
      });
    }
    if (game.status !== 'scheduled') {
      throw new AppError('GAME_NOT_BETTABLE', `Game ${leg.gameId} is ${game.status}.`, {
        gameId: leg.gameId,
        status: game.status,
      });
    }
    if (game.kickoff_at <= nowPlusBuffer) {
      throw new AppError('BETTING_CLOSED', `Betting on ${leg.gameId} has closed.`, {
        gameId: leg.gameId,
        lockAt: lockAtFor(game.kickoff_at),
      });
    }
    const line = lines.get(leg.gameId);
    if (line === undefined || now - line.seen_at > LINE_STALE_MS) {
      throw new AppError('MARKET_UNAVAILABLE', `No current line for ${leg.gameId}.`, {
        gameId: leg.gameId,
        market: leg.market,
        side: leg.side,
      });
    }
    const quote = quoteFor(line, leg.market, leg.side);
    if (quote === null) {
      throw new AppError('MARKET_UNAVAILABLE', `${leg.market} is not offered on ${leg.gameId}.`, {
        gameId: leg.gameId,
        market: leg.market,
        side: leg.side,
      });
    }
    if (
      leg.expected !== undefined &&
      (leg.expected.americanPrice !== quote.americanPrice ||
        leg.expected.lineTenths !== quote.lineTenths)
    ) {
      changed.push({
        gameId: leg.gameId,
        market: leg.market,
        side: leg.side,
        expected: leg.expected,
        current: { americanPrice: quote.americanPrice, lineTenths: quote.lineTenths },
      });
    }
    if (!isLeague(game.league)) {
      throw new AppError('INTERNAL', 'Unrecognised league on a game row.');
    }
    resolved.push({
      legIndex,
      gameId: leg.gameId,
      league: game.league,
      market: leg.market,
      side: leg.side,
      lineTenths: quote.lineTenths,
      americanPrice: quote.americanPrice,
      provider: line.provider,
      lineCapturedAt: line.captured_at,
      snapshotAt: now,
      kickoffAtSnapshot: game.kickoff_at,
      homeAbbr: game.home_abbr,
      awayAbbr: game.away_abbr,
    });
  }

  if (changed.length > 0 && !input.acceptLineChange) {
    const details: LineChangedDetails = { legs: changed };
    throw new AppError('LINE_CHANGED', 'The line moved before your bet was placed.', details);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface PlacementPlan {
  readonly betId: string;
  readonly statements: readonly D1PreparedStatement[];
  /** Offset of the `bets` INSERT within `statements`; `meta.changes` there is the verdict. */
  readonly betStatementIndex: number;
}

interface PlacementArgs {
  readonly userId: string;
  readonly input: PlaceBetInput;
  readonly scope: { readonly league: League; readonly season: number };
  readonly legs: readonly ResolvedLeg[];
  readonly now: EpochMs;
  readonly replacesBetId: string | null;
  /** When set, the bet only lands if THIS call's cancel of that bet applied. */
  readonly requiresCancelledBetId: string | null;
  readonly memo: string;
}

/**
 * The placement half of §14.2, reused verbatim by `placeBet` and `editBet`.
 *
 * The payout cap is checked in BigInt BEFORE `priceToAmerican`, so an absurdly
 * priced parlay fails with `409 PAYOUT_LIMIT_EXCEEDED` rather than
 * `priceToAmerican`'s `400 VALIDATION` (PLAN.md §5.2b).
 */
function buildPlacement(env: Env, args: PlacementArgs): PlacementPlan {
  const { input, legs, now, scope } = args;
  const price = priceFromLegs(legs.map((l) => l.americanPrice));
  if (exceedsPayoutCap(input.stakeCents, price)) {
    throw new AppError(
      'PAYOUT_LIMIT_EXCEEDED',
      'That bet would pay out more than the cap allows.',
      { stakeCents: input.stakeCents },
    );
  }
  const potentialPayoutCents = payoutCents(input.stakeCents, price);
  const americanPrice = priceToAmerican(price);
  const earliestKickoffAt = legs.reduce(
    (min, leg) => (leg.kickoffAtSnapshot < min ? leg.kickoffAtSnapshot : min),
    legs[0]?.kickoffAtSnapshot ?? now,
  );
  const betId = newId();
  const bkId = bankrollId(args.userId, scope.league, scope.season);
  const gameIds = legs.map((l) => l.gameId);

  const extraGuard =
    args.requiresCancelledBetId === null
      ? ''
      : `\n   AND EXISTS (SELECT 1 FROM bets\n                WHERE id = ?${String(15 + legs.length)} AND status = 'cancelled'\n                  AND replaced_by_bet_id = ?1)`;

  const betStatement = env.DB.prepare(betInsertSql(legs.length, extraGuard)).bind(
    betId,
    args.userId,
    bkId,
    scope.league,
    scope.season,
    input.betType,
    legs.length,
    input.stakeCents,
    americanPrice,
    potentialPayoutCents,
    now,
    earliestKickoffAt,
    args.replacesBetId,
    now + BET_CUTOFF_BUFFER_MS,
    ...gameIds,
    ...(args.requiresCancelledBetId === null ? [] : [args.requiresCancelledBetId]),
  );

  const legStatements = legs.map((leg) =>
    env.DB.prepare(LEG_INSERT_SQL).bind(
      newId(),
      betId,
      leg.legIndex,
      leg.gameId,
      leg.league,
      leg.market,
      leg.side,
      leg.lineTenths,
      leg.americanPrice,
      leg.provider,
      leg.lineCapturedAt,
      leg.snapshotAt,
      leg.kickoffAtSnapshot,
      leg.homeAbbr,
      leg.awayAbbr,
    ),
  );

  const stakeStatement = env.DB.prepare(STAKE_INSERT_SQL).bind(
    newId(),
    betId,
    -input.stakeCents,
    now,
    args.memo,
  );

  const prelude = ensureBankrollStatements(env, args.userId, scope.league, scope.season, now);
  return {
    betId,
    statements: [...prelude, betStatement, ...legStatements, stakeStatement],
    betStatementIndex: prelude.length,
  };
}

/**
 * @throws AppError VALIDATION | GAME_NOT_FOUND | GAME_NOT_BETTABLE |
 *                  BETTING_CLOSED | MARKET_UNAVAILABLE | LINE_CHANGED |
 *                  INSUFFICIENT_FUNDS | MIXED_LEAGUE_PARLAY |
 *                  MIXED_SEASON_PARLAY | DUPLICATE_GAME_IN_PARLAY |
 *                  PAYOUT_LIMIT_EXCEEDED
 */
export async function placeBet(
  env: Env,
  userId: string,
  req: PlaceBetRequest,
  now: EpochMs,
): Promise<PlaceBetResult> {
  const input = validated(req);
  const scope = await scopeFor(env, input);
  const legs = await resolveLegSnapshots(env, input, now);
  const plan = buildPlacement(env, {
    userId,
    input,
    scope,
    legs,
    now,
    replacesBetId: null,
    requiresCancelledBetId: null,
    memo: 'bet placed',
  });

  const results = await runPlacementBatch(env, plan.statements);
  if (changesAt(results, plan.betStatementIndex) !== 1) {
    // Every later statement is guarded on the bet row, so the batch was a clean
    // no-op. Re-query to say precisely WHY (PLAN.md §14.2).
    await rejectPlacement(env, input, scope, now);
  }
  return { bet: await requireBet(env, userId, plan.betId, now) };
}

/**
 * The legs' own `(league, season)`, cross-checked against the league the client
 * claimed. v1 charges exactly one bankroll per bet, so the request's `league`
 * disagreeing with the games is the same fault as two legs disagreeing with each
 * other and gets the same code.
 */
async function scopeFor(
  env: Env,
  input: PlaceBetInput,
): Promise<{ readonly league: League; readonly season: number }> {
  const scope = await resolveBetScope(
    env,
    input.legs.map((l) => l.gameId),
  );
  if (scope.league !== input.league) {
    throw new AppError('MIXED_LEAGUE_PARLAY', 'Every leg must be in the requested league.', {
      requested: input.league,
      actual: scope.league,
    });
  }
  return scope;
}

/** Run a placement/cancel/edit batch, mapping DB-level aborts to API codes. */
async function runPlacementBatch(
  env: Env,
  statements: readonly D1PreparedStatement[],
): Promise<readonly D1Result[]> {
  try {
    return await runBatch(env.DB, statements);
  } catch (err) {
    if (isOverdraftError(err)) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Insufficient funds for this stake.');
    }
    if (isOrphanBankrollError(err)) {
      // Always a bug: the prelude in this very batch creates the bankroll.
      console.error('[bets] orphan bankroll on a guarded batch', err);
      throw new AppError('INTERNAL', 'Something went wrong.');
    }
    if (isUniqueViolation(err, 'bet_legs.bet_id, bet_legs.game_id')) {
      throw new AppError(
        'DUPLICATE_GAME_IN_PARLAY',
        'A parlay cannot include the same game twice.',
      );
    }
    throw err;
  }
}

/**
 * The batch matched nothing. Re-read the games to name the specific reason,
 * in PLAN.md §14.2's order, and fall back to BETTING_CLOSED — reaching here at
 * all means the world changed under us between the pre-flight read and the
 * batch, and "you were too late" is the only honest generic answer.
 */
async function rejectPlacement(
  env: Env,
  input: PlaceBetInput,
  scope: { readonly league: League; readonly season: number },
  now: EpochMs,
): Promise<never> {
  const gameIds = input.legs.map((l) => l.gameId);
  const games = await loadGames(env, gameIds);
  const nowPlusBuffer = now + BET_CUTOFF_BUFFER_MS;
  for (const gameId of gameIds) {
    const game = games.get(gameId);
    if (game === undefined) {
      throw new AppError('GAME_NOT_FOUND', `Game ${gameId} does not exist.`, { gameId });
    }
    if (game.status !== 'scheduled') {
      throw new AppError('GAME_NOT_BETTABLE', `Game ${gameId} is ${game.status}.`, {
        gameId,
        status: game.status,
      });
    }
    if (game.kickoff_at <= nowPlusBuffer) {
      throw new AppError('BETTING_CLOSED', `Betting on ${gameId} has closed.`, { gameId });
    }
    if (game.league !== scope.league) {
      throw new AppError('MIXED_LEAGUE_PARLAY', 'Every leg must be in the same league.');
    }
    if (game.season !== scope.season) {
      throw new AppError('MIXED_SEASON_PARLAY', 'Every leg must be in the same season.');
    }
  }
  throw new AppError('BETTING_CLOSED', 'The market changed before your bet was placed.');
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancel with a full refund. PLAN.md §14.2.
 *
 * @throws AppError BET_NOT_FOUND | BET_LOCKED | BET_NOT_PENDING
 */
export async function cancelBet(
  env: Env,
  userId: string,
  betId: string,
  now: EpochMs,
): Promise<PlaceBetResult> {
  const results = await runPlacementBatch(env, [
    env.DB.prepare(CANCEL_UPDATE_SQL).bind(betId, userId, now, now + BET_CUTOFF_BUFFER_MS),
    env.DB.prepare(refundInsertSql('')).bind(
      betId,
      userId,
      now,
      now + BET_CUTOFF_BUFFER_MS,
      newId(),
      'user cancelled',
    ),
  ]);
  if (changesAt(results, 0) !== 1) await rejectCancel(env, userId, betId, now);
  return { bet: await requireBet(env, userId, betId, now) };
}

/**
 * Distinguish BET_NOT_FOUND / BET_NOT_PENDING / BET_LOCKED after a guarded
 * UPDATE matched nothing. A bet belonging to someone else is `404 BET_NOT_FOUND`
 * rather than `403`, so there is no existence oracle (PLAN.md §11.4).
 */
async function rejectCancel(env: Env, userId: string, betId: string, now: EpochMs): Promise<never> {
  const row = await queryOne<{ status: string }>(
    env.DB.prepare(`SELECT status FROM bets WHERE id = ?1 AND user_id = ?2`).bind(betId, userId),
  );
  if (row === null) throw new AppError('BET_NOT_FOUND', 'No such bet.');
  if (row.status !== 'pending') {
    throw new AppError('BET_NOT_PENDING', `This bet is ${row.status}.`, { status: row.status });
  }
  throw new AppError('BET_LOCKED', 'One of this bet’s games has locked.', {
    lockedAt: now + BET_CUTOFF_BUFFER_MS,
  });
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * Edit == atomic cancel + place in ONE batch. The new bet is priced from CURRENT
 * lines, never from the old snapshot.
 *
 * DELIBERATE ADDITION TO §14.2's SQL, called out for review: the cancel UPDATE
 * carries the PLACEMENT guard too (the same `COUNT(*) … = :n` over the NEW legs'
 * games). §14.2 guards the place half on the cancel but not the reverse, and its
 * claim that "neither half can land alone" only holds for failures that THROW
 * (validation, funds). A placement guard that merely matches 0 rows throws
 * nothing, so without this the cancel + refund would commit alone and the user
 * would silently lose their bet. With it, both guards must hold or the batch is
 * a clean no-op.
 *
 * @throws every code `placeBet` throws, plus BET_LOCKED | BET_NOT_PENDING
 */
export async function editBet(
  env: Env,
  userId: string,
  betId: string,
  req: PlaceBetRequest,
  now: EpochMs,
): Promise<{ readonly bet: BetView; readonly replacedBetId: string }> {
  const input = validated(req);
  const scope = await scopeFor(env, input);
  const legs = await resolveLegSnapshots(env, input, now);
  const plan = buildPlacement(env, {
    userId,
    input,
    scope,
    legs,
    now,
    replacesBetId: betId,
    requiresCancelledBetId: betId,
    memo: 'bet placed (edit)',
  });
  const nowPlusBuffer = now + BET_CUTOFF_BUFFER_MS;
  const gameIds = legs.map((l) => l.gameId);

  // Built explicitly rather than through cancelUpdateSql(): the edit variant
  // needs its own parameter numbering for the extra SET and the extra guard.
  const cancelStatement = env.DB.prepare(
    `UPDATE bets
   SET status = 'cancelled', cancelled_at = ?3, updated_at = ?3,
       replaced_by_bet_id = ?5
 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = ?1
        AND (g.status <> 'scheduled' OR g.kickoff_at <= ?4))
   AND (SELECT COUNT(*) FROM games
         WHERE id IN (${placeholders(gameIds.length, 8)})
           AND league = ?6 AND season = ?7
           AND status = 'scheduled'
           AND kickoff_at > ?4) = ?${String(8 + gameIds.length)}`,
  ).bind(
    betId,
    userId,
    now,
    nowPlusBuffer,
    plan.betId,
    scope.league,
    scope.season,
    ...gameIds,
    gameIds.length,
  );

  const refundStatement = env.DB.prepare(
    refundInsertSql(`\n   AND b.replaced_by_bet_id = ?7`),
  ).bind(betId, userId, now, nowPlusBuffer, newId(), 'replaced by edit', plan.betId);

  const results = await runPlacementBatch(env, [
    cancelStatement,
    refundStatement,
    ...plan.statements,
  ]);
  if (changesAt(results, 0) !== 1) {
    // Either the old bet could not be cancelled, or the new legs are no longer
    // placeable. The old bet's own state is the more specific answer, so it is
    // diagnosed first; `rejectCancel` only throws when it really is at fault.
    const row = await queryOne<{ status: string }>(
      env.DB.prepare(`SELECT status FROM bets WHERE id = ?1 AND user_id = ?2`).bind(betId, userId),
    );
    if (row === null) throw new AppError('BET_NOT_FOUND', 'No such bet.');
    if (row.status !== 'pending') {
      throw new AppError('BET_NOT_PENDING', `This bet is ${row.status}.`, {
        status: row.status,
      });
    }
    if (await stillCancellable(env, betId, nowPlusBuffer)) {
      // The old bet is fine; it is the replacement that cannot be placed.
      await rejectPlacement(env, input, scope, now);
    }
    throw new AppError('BET_LOCKED', 'One of this bet’s games has locked.');
  }
  return {
    bet: await requireBet(env, userId, plan.betId, now),
    replacedBetId: betId,
  };
}

/** The §14.2 lock predicate, evaluated on its own for error attribution. */
async function stillCancellable(env: Env, betId: string, nowPlusBuffer: EpochMs): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bet_legs l JOIN games g ON g.id = l.game_id
        WHERE l.bet_id = ?1 AND (g.status <> 'scheduled' OR g.kickoff_at <= ?2)`,
    ).bind(betId, nowPlusBuffer),
  );
  return (row?.n ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBet(
  env: Env,
  userId: string,
  betId: string,
  now: EpochMs,
): Promise<BetView | null> {
  const bet = await queryOne<BetRow>(
    env.DB.prepare(`SELECT * FROM bets WHERE id = ?1 AND user_id = ?2`).bind(betId, userId),
  );
  if (bet === null) return null;
  const legs = await loadLegs(env, [bet.id]);
  return toBetView(bet, legs.get(bet.id) ?? [], now);
}

async function requireBet(env: Env, userId: string, betId: string, now: EpochMs): Promise<BetView> {
  const bet = await getBet(env, userId, betId, now);
  if (bet === null) {
    // Unreachable: the caller has just written (or guarded on) this row.
    throw new AppError('INTERNAL', 'The bet could not be read back.');
  }
  return bet;
}

async function loadLegs(env: Env, betIds: readonly string[]): Promise<Map<string, LegRow[]>> {
  const byBet = new Map<string, LegRow[]>();
  if (betIds.length === 0) return byBet;
  const rows = await queryAll<LegRow>(
    env.DB.prepare(
      `SELECT l.*, g.status AS g_status, g.status_detail AS g_status_detail,
              g.kickoff_at AS g_kickoff_at, g.home_score AS g_home_score,
              g.away_score AS g_away_score
         FROM bet_legs l JOIN games g ON g.id = l.game_id
        WHERE l.bet_id IN (${placeholders(betIds.length)})
        ORDER BY l.bet_id, l.leg_index`,
    ).bind(...betIds),
  );
  for (const row of rows) {
    const list = byBet.get(row.bet_id);
    if (list === undefined) byBet.set(row.bet_id, [row]);
    else list.push(row);
  }
  return byBet;
}

/**
 * List a user's bets. For OPEN bets each leg carries a live `projected` grade
 * computed from the current game row — computed on read, never persisted.
 *
 * `status=open` is exactly `status='pending'`; `settled` is its complement, so a
 * cancelled bet is reachable from the UI's "history" tab rather than vanishing.
 */
export async function listBets(
  env: Env,
  userId: string,
  filter: {
    readonly status: 'open' | 'settled' | 'all';
    readonly league?: League;
    readonly season?: number;
    readonly limit: number;
    readonly cursor?: string;
  },
  now: EpochMs,
): Promise<{ readonly bets: readonly BetView[]; readonly nextCursor: string | null }> {
  const clauses = ['user_id = ?1'];
  const values: unknown[] = [userId];
  const next = (value: unknown): string => {
    values.push(value);
    return `?${String(values.length)}`;
  };
  if (filter.status === 'open') clauses.push(`status = 'pending'`);
  if (filter.status === 'settled') clauses.push(`status <> 'pending'`);
  if (filter.league !== undefined) clauses.push(`league = ${next(filter.league)}`);
  if (filter.season !== undefined) clauses.push(`season = ${next(filter.season)}`);
  if (filter.cursor !== undefined) {
    const cursor = decodeBetCursor(filter.cursor);
    const at = next(cursor.placedAt);
    clauses.push(`(placed_at < ${at} OR (placed_at = ${at} AND id < ${next(cursor.id)}))`);
  }
  const probe = next(filter.limit + 1);
  const rows = await queryAll<BetRow>(
    env.DB.prepare(
      `SELECT * FROM bets WHERE ${clauses.join(' AND ')}
        ORDER BY placed_at DESC, id DESC LIMIT ${probe}`,
    ).bind(...values),
  );
  const page = rows.slice(0, filter.limit);
  const legs = await loadLegs(
    env,
    page.map((b) => b.id),
  );
  const last = page.at(-1);
  return {
    bets: page.map((bet) => toBetView(bet, legs.get(bet.id) ?? [], now)),
    nextCursor:
      rows.length > filter.limit && last !== undefined
        ? `${String(last.placed_at)}|${last.id}`
        : null,
  };
}

function decodeBetCursor(raw: string): { placedAt: number; id: string } {
  const at = raw.indexOf('|');
  const placedAt = Number(raw.slice(0, at));
  if (at < 0 || !Number.isSafeInteger(placedAt)) {
    throwValidation('cursor is not a valid pagination token', 'cursor');
  }
  return { placedAt, id: raw.slice(at + 1) };
}

/**
 * Row(s) -> wire shape.
 *
 * `americanPrice` is the EFFECTIVE price: at placement it is the price the bet
 * was struck at, and settlement (§7.4) overwrites it with the price of the
 * surviving legs, so a push-repriced parlay displays what it was actually paid.
 * `decimalOdds` is derived FROM that integer per §11.4 and is never parsed back
 * into arithmetic — including for a push, whose stored `american_price` of 100
 * renders as "2.000". The stake return is carried by `payoutCents`, not by this
 * display string.
 *
 * `cancellable` is computed from the legs' CURRENT `games` rows, exactly like
 * the §14.2 guard — never from `earliest_kickoff_at` (CLAUDE.md rule 8b).
 */
export function toBetView(bet: BetRow, legs: readonly LegRow[], now: EpochMs): BetView {
  const price = americanToPrice(bet.american_price);
  const pending = bet.status === 'pending';
  const nowPlusBuffer = now + BET_CUTOFF_BUFFER_MS;
  return {
    id: bet.id,
    league: bet.league as League,
    season: bet.season,
    betType: bet.bet_type as BetType,
    stakeCents: bet.stake_cents,
    americanPrice: bet.american_price,
    decimalOdds: formatDecimalOdds(price),
    potentialPayoutCents: bet.potential_payout_cents,
    toWinCents: bet.potential_payout_cents - bet.stake_cents,
    status: bet.status as BetStatus,
    payoutCents: bet.payout_cents,
    placedAt: bet.placed_at,
    earliestKickoffAt: bet.earliest_kickoff_at,
    lockAt: lockAtFor(bet.earliest_kickoff_at),
    settledAt: bet.settled_at,
    cancelledAt: bet.cancelled_at,
    cancellable:
      pending &&
      legs.length > 0 &&
      legs.every((l) => l.g_status === 'scheduled' && l.g_kickoff_at > nowPlusBuffer),
    replacesBetId: bet.replaces_bet_id,
    replacedByBetId: bet.replaced_by_bet_id,
    legs: legs.map((leg) => toLegView(leg, pending)),
  };
}

function toLegView(leg: LegRow, pending: boolean): BetLegView {
  const snapshot: BetLegSnapshot = {
    gameId: leg.game_id,
    league: leg.league as League,
    market: leg.market as Market,
    side: leg.side as Side,
    lineTenths: leg.line_tenths,
    americanPrice: leg.american_price,
    provider: leg.provider,
    lineCapturedAt: leg.line_captured_at,
    snapshotAt: leg.snapshot_at,
    kickoffAtSnapshot: leg.kickoff_at_snapshot,
    homeAbbr: leg.home_abbr,
    awayAbbr: leg.away_abbr,
  };
  return {
    id: leg.id,
    legIndex: leg.leg_index,
    gameId: leg.game_id,
    market: snapshot.market,
    side: snapshot.side,
    lineTenths: leg.line_tenths,
    americanPrice: leg.american_price,
    provider: leg.provider,
    lineCapturedAt: leg.line_captured_at,
    snapshotAt: leg.snapshot_at,
    kickoffAtSnapshot: leg.kickoff_at_snapshot,
    homeAbbr: leg.home_abbr,
    awayAbbr: leg.away_abbr,
    result: leg.result === null ? null : (leg.result as LegResult),
    // Live only while the bet is open; a settled leg already carries `result`.
    projected: pending
      ? projectLeg(snapshot, {
          status: leg.g_status as GameStatus,
          homeScore: leg.g_home_score,
          awayScore: leg.g_away_score,
        })
      : null,
    game: {
      status: leg.g_status as GameStatus,
      statusDetail: leg.g_status_detail,
      kickoffAt: leg.g_kickoff_at,
      homeScore: leg.g_home_score,
      awayScore: leg.g_away_score,
    },
  };
}
