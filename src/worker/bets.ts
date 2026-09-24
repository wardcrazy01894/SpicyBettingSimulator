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
 * WHICH BALANCE IS CHARGED is now an explicit choice (M5b): `bankrollId` on the
 * request, defaulting to the caller's `main`. It is no longer implied by the
 * legs' (league, season), which means legs may span leagues and seasons freely
 * -- `bets.league` becomes `'mixed'` and `bets.season` is the season of the
 * EARLIEST-KICKOFF leg, both purely as stats labels. MIXED_LEAGUE_PARLAY and
 * MIXED_SEASON_PARLAY are consequently never thrown from anywhere.
 *
 * TEASERS. A teaser's legs are resolved from the market exactly like any other
 * bet -- including `expected`, which is compared against the BOOK line, so
 * LINE_CHANGED means the same thing it always did -- and are then MOVED:
 * `bet_legs.line_tenths` holds the TEASED line (what grading reads),
 * `original_line_tenths` holds the book's. The legs' own prices are discarded
 * (`american_price = 100`, a placeholder) because a teaser is priced once, at
 * the bet level, from `TEASER_PAYOUTS`.
 *
 * `bets` stores NO decimal-odds rational. `american_price` is display and
 * `potential_payout_cents` is capped at MAX_PAYOUT_CENTS; for a parlay the exact
 * price is always recomputed from `bet_legs.american_price` (PLAN.md §5.2), and
 * for a teaser from `(teaser_points_tenths, leg_count)`.
 */

import type {
  BetLegView,
  BetView,
  LineChangedDetails,
  PlaceBetRequest,
} from '../shared/api-types.js';
import type {
  AmericanPrice,
  BetLeague,
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
import { BET_CUTOFF_BUFFER_MS } from '../shared/constants.js';
import { AppError, DB_MESSAGES, thrownMentions } from '../shared/errors.js';
import { distinctGameIds } from '../shared/validate.js';
import { mergeEffectiveLine, usablePrice, usableTenths } from '../shared/lines.js';
import type { EffectiveLine, LineRowView, MarketSource } from '../shared/lines.js';
import { projectLeg } from '../shared/grading.js';
import {
  PUSH_AMERICAN_PRICE,
  americanToPrice,
  exceedsPayoutCap,
  formatDecimalOdds,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
  teasedLineTenths,
  teaserPrice,
} from '../shared/odds.js';
import { lockAtFor } from '../shared/time.js';
import type { PlaceBetInput } from '../shared/validate.js';
import { validatePlaceBet } from '../shared/validate.js';
import { isLeague, placeholders, resolveBankrollId } from './bankroll.js';
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

/**
 * Per-league kill switch for PLACING bets (PLAN.md §23.14). A closed league's
 * games are on the board but never `bettable` (`routes/games.ts` ANDs this in),
 * and `resolveLegSnapshots` refuses a leg on one with the EXISTING
 * `409 GAME_NOT_BETTABLE` — no new error code. A pure check on
 * `games.league`, which never changes for a game, so there is no race to
 * guard in SQL.
 *
 * `mlb: false` until M12b ships the settlement rule for shortened and postponed
 * games (§23.6/§23.7); M12b flips it. It stays afterwards as a one-line switch.
 */
export const LEAGUE_BETTING_OPEN: Readonly<Record<League, boolean>> = {
  nfl: true,
  ncaaf: true,
  mlb: false,
};

/** True when `league` is a known league whose betting is open. */
export function isBettingOpen(league: string): boolean {
  return isLeague(league) && LEAGUE_BETTING_OPEN[league];
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
  spread_book: string | null;
  total_book: string | null;
  ml_book: string | null;
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
  teaser_points_tenths: number | null;
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
  original_line_tenths: number | null;
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

/**
 * The immutable snapshot plus its position in the bet, the season of its game
 * (which is where `bets.season` comes from — CLAUDE.md rule 8c) and, once a
 * teaser has been applied, the book line the teased one replaced.
 */
export interface ResolvedLeg extends BetLegSnapshot {
  readonly legIndex: number;
  readonly season: number;
  /** The pre-tease line. `null` on a straight or parlay leg. */
  readonly originalLineTenths: LineTenths | null;
}

/**
 * TEST-ONLY seam. A no-op in production: the routes never pass it, so
 * `hooks === undefined` and not a single extra statement, read or branch of
 * consequence exists on the shipped path.
 *
 * WHY IT EXISTS. Every mutation here is one `db.batch()` whose guards live in
 * the `WHERE` clauses of the writes themselves, and a pre-flight read
 * (`resolveLegSnapshots`, the owner lookup in `editBet`) runs first purely to
 * produce a SPECIFIC error message. That pre-flight masks the in-batch guards
 * from the test suite completely: with the world held still, deleting
 * `AND status = 'scheduled' AND kickoff_at > ?14` from `betInsertSql`, or
 * weakening the edit's `COUNT(*) = :n`, changes no observable behaviour, because
 * the pre-flight already rejected everything the guard would have caught. Those
 * guards are the ONLY thing standing between a rescheduled game and a free bet,
 * so they must be covered.
 *
 * `beforeBatch` runs after the reads and immediately before `db.batch()`, which
 * is exactly the window a concurrent ingestion write occupies. A test uses it to
 * move a kickoff into the past, flip a game to `in_progress` or delete the game
 * row, then asserts the batch is a clean no-op. It does NOT weaken the
 * single-batch design: nothing is read here, no guard moves out of its `WHERE`,
 * and the production call sites are unchanged.
 */
export interface BetHooks {
  readonly beforeBatch?: () => Promise<void>;
}

async function runHook(hooks: BetHooks | undefined): Promise<void> {
  if (hooks?.beforeBatch !== undefined) await hooks.beforeBatch();
}

// ---------------------------------------------------------------------------
// THE LITERAL SQL (PLAN.md §14.2). Kept as named constants so a reviewer can
// diff them against the plan without reading the code that assembles them.
// ---------------------------------------------------------------------------

/**
 * "The account placing this bet is enabled and not deleted", as a conjunct for a
 * `WHERE` clause. `?2` is the user id in BOTH statements that carry it
 * (`betInsertSql` and `editCancelSql`), which is why it can be a constant.
 *
 * ONE STRING, TWO STATEMENTS, ON PURPOSE. An edit is a cancel + a placement in
 * one batch, and the two halves are conditioned on each other (see
 * `editCancelSql`): guarding only the INSERT would let the cancel and its refund
 * commit alone for a deleted user — the bet vanishes, the money comes back, and
 * the replacement silently never exists. Both halves refuse together or neither
 * does.
 */
const USER_STATE_GUARD = `AND EXISTS (SELECT 1 FROM users
                WHERE id = ?2 AND is_disabled = 0 AND deleted_at IS NULL)`;

/**
 * Statement 1 of placement, guarded INSIDE the batch so a reschedule cannot race
 * between the read and the write (PLAN.md §14.1).
 *
 * `?7` is `leg_count`. `?14` is `nowPlusBuffer`; `?15` is `teaser_points_tenths`;
 * `?16…` the DISTINCT game ids, and the parameter after them is their COUNT —
 * the `= :n` the COUNT must reach. It is NOT `?7`: a same-game parlay (M11)
 * has more legs than games and `IN (…)` collapses a repeated id, so comparing
 * against `leg_count` would refuse every bet with two legs on one game.
 *
 * THE GUARDS ARE LORE, not decoration, and `tests/worker/bets.spec.ts` asserts
 * this string contains each of them:
 *   `id IN (…)` + `= :n`   every requested game exists (none deleted under us)
 *   `status = 'scheduled'` a game that went `in_progress` between the
 *                          pre-flight read and this batch stops accepting bets
 *   `kickoff_at > ?14`     STRICTLY greater: kickoff exactly at `lockAt` is
 *                          CLOSED. `>=` would sell a bet one millisecond after
 *                          the cutoff the UI showed.
 *   the `bankrolls` EXISTS THE BALANCE IS THE CALLER'S. This one REPLACES the
 *                          `league = ?4 AND season = ?5` conjuncts M5 carried:
 *                          those pinned the bet to the one bankroll its legs
 *                          implied, and legs no longer imply a bankroll at all.
 *                          The balance is named on the request instead, so the
 *                          thing that must be re-checked in the batch is
 *                          OWNERSHIP — `resolveBankrollId` reads it beforehand
 *                          only to produce a specific 404, and a read followed
 *                          by an unguarded write is the read-then-write CLAUDE.md
 *                          rule 5 forbids.
 *   the `users` EXISTS     THE ACCOUNT IS STILL PLAYABLE (`USER_STATE_GUARD`).
 *                          Authentication happened in the middleware, an unknown
 *                          number of milliseconds and at least three D1 reads
 *                          ago; `POST /api/admin/users/:id/disabled` and
 *                          `DELETE /api/admin/users/:id` can both land in that
 *                          window. Without this conjunct the bet commits anyway
 *                          and the stake leaves a balance nobody can reach again
 *                          — and a soft delete is REFUSED while a bet is pending
 *                          (`ACCOUNT_HAS_PENDING_BETS`), so that bet would also
 *                          make the account undeletable. `?2` is the user id the
 *                          row is being written for, so no extra binding.
 *
 * Exported for those assertions; nothing outside this module calls it.
 */
export function betInsertSql(gameCount: number, requiresCancelledBet: boolean): string {
  // EVERY parameter index after the fixed fifteen is derived HERE, from
  // `gameCount`, so a caller binds `...gameIds, gameIds.length` and then the
  // cancelled-bet id in that order and never computes an offset of its own.
  const countParam = 16 + gameCount;
  const cancelledParam = countParam + 1;
  const extraGuard = requiresCancelledBet
    ? `\n   AND EXISTS (SELECT 1 FROM bets\n                WHERE id = ?${String(cancelledParam)} AND status = 'cancelled'\n                  AND replaced_by_bet_id = ?1)`
    : '';
  return `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                    stake_cents, american_price, potential_payout_cents, status,
                    placed_at, earliest_kickoff_at, replaces_bet_id,
                    teaser_points_tenths, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?13, ?15, ?11, ?11
 WHERE (SELECT COUNT(*) FROM games
         WHERE id IN (${placeholders(gameCount, 16)})
           AND status = 'scheduled'
           AND kickoff_at > ?14) = ?${String(countParam)}
   AND EXISTS (SELECT 1 FROM bankrolls WHERE id = ?3 AND user_id = ?2)
   ${USER_STATE_GUARD}${extraGuard}`;
}

/** Statements 2..n+1: one per leg, each guarded on the bet row existing. */
const LEG_INSERT_SQL = `INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side,
                      line_tenths, original_line_tenths, american_price, provider,
                      line_captured_at, snapshot_at, kickoff_at_snapshot,
                      home_abbr, away_abbr)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?16, ?9, ?10, ?11, ?12, ?13, ?14, ?15
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
 * The EDIT variant is `editCancelSql()` below: it needs an extra `SET`, its own
 * parameter numbering and a SECOND guard, and a template with holes in it would
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
 * The cancel half of an EDIT. Two guards, and BOTH are load-bearing:
 *
 *   1. the §14.2 lock `NOT EXISTS` over the OLD bet's legs' CURRENT games, and
 *   2. the PLACEMENT guard — the same `COUNT(*) … = :n` over the NEW legs'
 *      games that `betInsertSql` carries.
 *
 * (2) IS A DELIBERATE ADDITION TO PLAN.md §14.2's ORIGINAL SQL, and §14.2 has
 * been amended to match. §14.2 guarded the place half on the cancel but not the
 * reverse, and its "neither half can land alone" claim only holds for failures
 * that THROW (validation, insufficient funds), which roll the batch back. A
 * placement guard that merely matches ZERO ROWS throws nothing: the cancel and
 * its refund would commit alone, the replacement would silently not exist, and
 * the user would lose their position while the edit reported a 409. With the
 * symmetric guard, each half is conditioned on the other and the batch is either
 * a complete swap or a clean no-op.
 *
 * (3) is `USER_STATE_GUARD`, and it is here for the SAME symmetry reason: the
 * replacement INSERT carries it, so without it a disabled-or-deleted user's edit
 * would cancel and refund the old bet while the new one matched nothing.
 *
 * `?1` old bet, `?2` user, `?3` now, `?4` nowPlusBuffer, `?5` new bet id,
 * `?6…` the new legs' DISTINCT game ids, then their count as `:n` last (not the
 * leg count — see `betInsertSql`). The `league`/`season` conjuncts M5
 * carried are gone for the same reason they left `betInsertSql`: an edit is
 * pinned to the OLD BET'S BALANCE (read from `bets.bankroll_id`, immutable), not
 * to a league.
 *
 * Exported so `tests/worker/bets.spec.ts` can assert the guard text is present;
 * nothing outside this module calls it.
 */
export function editCancelSql(gameCount: number): string {
  return `UPDATE bets
   SET status = 'cancelled', cancelled_at = ?3, updated_at = ?3,
       replaced_by_bet_id = ?5
 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = ?1
        AND (g.status <> 'scheduled' OR g.kickoff_at <= ?4))
   AND (SELECT COUNT(*) FROM games
         WHERE id IN (${placeholders(gameCount, 6)})
           AND status = 'scheduled'
           AND kickoff_at > ?4) = ?${String(6 + gameCount)}
   ${USER_STATE_GUARD}`;
}

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

/**
 * The one quote a (market, side) pair refers to, or null when the book does not
 * offer it. `line_tenths` comes back FROM THE BETTOR'S SIDE: home −3.5 is −35,
 * away +3.5 is +35, and both sides of a total carry the total itself.
 */
function quoteFor(
  line: EffectiveLine,
  market: Market,
  side: Side,
): (MarketQuote & MarketSource) | null {
  switch (market) {
    case 'moneyline': {
      const m = line.moneyline;
      if (m === null) return null;
      const price = side === 'home' ? m.homePrice : m.awayPrice;
      return usablePrice(price)
        ? {
            americanPrice: price,
            lineTenths: null,
            provider: m.provider,
            capturedAt: m.capturedAt,
            seenAt: m.seenAt,
          }
        : null;
    }
    case 'spread': {
      const m = line.spread;
      if (m === null) return null;
      const price = side === 'home' ? m.homePrice : m.awayPrice;
      const tenths = side === 'home' ? m.homeTenths : m.awayTenths;
      if (!usablePrice(price) || !usableTenths(tenths)) return null;
      return {
        americanPrice: price,
        lineTenths: tenths,
        provider: m.provider,
        capturedAt: m.capturedAt,
        seenAt: m.seenAt,
      };
    }
    case 'total': {
      const m = line.total;
      if (m === null) return null;
      const price = side === 'over' ? m.overPrice : m.underPrice;
      if (!usablePrice(price) || !usableTenths(m.tenths)) return null;
      return {
        americanPrice: price,
        lineTenths: m.tenths,
        provider: m.provider,
        capturedAt: m.capturedAt,
        seenAt: m.seenAt,
      };
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
 * EVERY `game_lines` row per game, any provider. The merge (`mergeEffectiveLine`)
 * is what picks a book per market — the same function the board uses, so the
 * price on the screen and the price charged cannot disagree (PLAN.md §21.4).
 * Never `LIMIT 1`, never a row-level tie-break here.
 */
async function loadLines(env: Env, gameIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const rows = await queryAll<LineRow>(
    env.DB.prepare(
      `SELECT * FROM game_lines WHERE game_id IN (${placeholders(gameIds.length)})
        ORDER BY game_id ASC, provider ASC`,
    ).bind(...gameIds),
  );
  const byGame = new Map<string, LineRow[]>();
  for (const row of rows) {
    const list = byGame.get(row.game_id) ?? [];
    list.push(row);
    byGame.set(row.game_id, list);
  }
  return byGame;
}

function toLineRowView(row: LineRow): LineRowView {
  return {
    provider: row.provider,
    spreadHomeTenths: row.spread_home_tenths,
    spreadHomePrice: row.spread_home_price,
    spreadAwayTenths: row.spread_away_tenths,
    spreadAwayPrice: row.spread_away_price,
    spreadBook: row.spread_book,
    totalTenths: row.total_tenths,
    totalOverPrice: row.total_over_price,
    totalUnderPrice: row.total_under_price,
    totalBook: row.total_book,
    mlHomePrice: row.ml_home_price,
    mlAwayPrice: row.ml_away_price,
    mlBook: row.ml_book,
    capturedAt: row.captured_at,
    seenAt: row.seen_at,
  };
}

/**
 * Read the current line for each requested leg and build the immutable snapshot.
 * Rejects a market that is absent or whose `seen_at` (NOT `captured_at`) is older
 * than the game's staleness window (`lineStaleAfterMs`), and compares against
 * `expected` when supplied.
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
  const gameIds = distinctGameIds(input.legs);
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
    // The league gate (LEAGUE_BETTING_OPEN), beside the status check so it
    // keeps the GAME_NOT_BETTABLE → BETTING_CLOSED order above. An unknown
    // league falls through to the INTERNAL check below, unchanged.
    if (isLeague(game.league) && !LEAGUE_BETTING_OPEN[game.league]) {
      throw new AppError(
        'GAME_NOT_BETTABLE',
        `Betting on ${game.league.toUpperCase()} is not open yet.`,
        { gameId: leg.gameId, status: game.status },
      );
    }
    if (game.kickoff_at <= nowPlusBuffer) {
      throw new AppError('BETTING_CLOSED', `Betting on ${leg.gameId} has closed.`, {
        gameId: leg.gameId,
        lockAt: lockAtFor(game.kickoff_at),
      });
    }
    // Staleness is judged per MARKET by the merge (a stale row loses its
    // markets; a fresh row next to it keeps its own), so "did THIS market
    // survive?" is the whole test — the same one the board applied.
    const line = mergeEffectiveLine(
      (lines.get(leg.gameId) ?? []).map(toLineRowView),
      game.kickoff_at,
      now,
    );
    if (line === null) {
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
      season: game.season,
      // A leg is resolved from the MARKET, never from the bet type: a teaser's
      // legs are snapshotted at the book's line and price here, and moved
      // afterwards by `applyTease`. That is what keeps `expected` (and therefore
      // LINE_CHANGED) meaningful — it compares against the number the board
      // showed, not against one the server invented.
      originalLineTenths: null,
      gameId: leg.gameId,
      league: game.league,
      market: leg.market,
      side: leg.side,
      lineTenths: quote.lineTenths,
      americanPrice: quote.americanPrice,
      // THE SNAPSHOT TRIO comes from the MARKET (PLAN.md §14.3): with a merged
      // line the spread can be DraftKings' and the total FanDuel's, and each
      // leg records the book that quoted it and when that quote was captured.
      provider: quote.provider,
      lineCapturedAt: quote.capturedAt,
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

export interface PlacementPlan {
  readonly betId: string;
  readonly statements: readonly D1PreparedStatement[];
  /** Offset of the `bets` INSERT within `statements`; `meta.changes` there is the verdict. */
  readonly betStatementIndex: number;
}

export interface PlacementArgs {
  readonly userId: string;
  readonly input: PlaceBetInput;
  /** The balance to charge. Already proven to be the caller's. */
  readonly bankrollId: string;
  readonly legs: readonly ResolvedLeg[];
  readonly now: EpochMs;
  readonly replacesBetId: string | null;
  /** When set, the bet only lands if THIS call's cancel of that bet applied. */
  readonly requiresCancelledBetId: string | null;
  readonly memo: string;
}

/** True for 0008's `bet_legs_bi_one_side_per_game` abort. */
function isOneSidePickError(err: unknown): boolean {
  return thrownMentions(err, DB_MESSAGES.oneSidePickPerGame);
}

/**
 * The league label for a bet: the legs' one league, or `'mixed'` when they span
 * both. INFORMATIONAL — it drives the stats filters and the UI, never the money.
 */
export function betLeagueOf(legs: readonly ResolvedLeg[]): BetLeague {
  const first = legs[0]?.league;
  if (first === undefined) throw new AppError('VALIDATION', 'A bet must have at least one leg.');
  return legs.every((leg) => leg.league === first) ? first : 'mixed';
}

/**
 * The season label for a bet: the season of the EARLIEST-KICKOFF leg.
 *
 * Read from the legs' own `games` rows, never from a wall clock (CLAUDE.md rule
 * 8c): a January bowl belongs to the season it is part of, not the calendar year
 * it is played in. With legs free to span seasons this is a label rather than a
 * partition, and "the first game to kick off" is the one a human would name.
 */
export function betSeasonOf(legs: readonly ResolvedLeg[]): number {
  let chosen = legs[0];
  if (chosen === undefined) throw new AppError('VALIDATION', 'A bet must have at least one leg.');
  for (const leg of legs) {
    if (leg.kickoffAtSnapshot < chosen.kickoffAtSnapshot) chosen = leg;
  }
  return chosen.season;
}

/**
 * Move every leg's line `pointsTenths` in the bettor's favour and discard the
 * legs' individual prices.
 *
 * `american_price = PUSH_AMERICAN_PRICE` (100) on a teaser leg is a PLACEHOLDER,
 * not a price: the schema requires `abs(american_price) BETWEEN 100 AND 100000`
 * on every leg, a teaser has no per-leg price to store, and 100 (even money) is
 * the one value that is unambiguously "no price here". Nothing reads it —
 * `gradeBet` is handed `{kind:'teaser'}` and prices from the card.
 *
 * @throws AppError VALIDATION for a moneyline leg. `validatePlaceBet` already
 *   refuses one; this is the backstop that keeps the invariant local.
 */
function applyTease(legs: readonly ResolvedLeg[], pointsTenths: number): readonly ResolvedLeg[] {
  return legs.map((leg) => {
    if (leg.market === 'moneyline' || leg.lineTenths === null) {
      throw new AppError('VALIDATION', 'A teaser leg must be a spread or a total.', {
        field: `legs[${String(leg.legIndex)}].market`,
      });
    }
    return {
      ...leg,
      lineTenths: teasedLineTenths(leg.market, leg.side, leg.lineTenths, pointsTenths),
      originalLineTenths: leg.lineTenths,
      americanPrice: PUSH_AMERICAN_PRICE,
    };
  });
}

/**
 * The placement half of §14.2, reused verbatim by `placeBet` and `editBet`.
 *
 * The payout cap is checked in BigInt BEFORE `priceToAmerican`, so an absurdly
 * priced parlay fails with `409 PAYOUT_LIMIT_EXCEEDED` rather than
 * `priceToAmerican`'s `400 VALIDATION` (PLAN.md §5.2b). A teaser cannot reach the
 * cap at all — the card's worst cell at the full bankroll is 2,600,000¢ against
 * 100,000,000¢ — but it goes through the same check rather than a special case.
 *
 * THERE IS NO BANKROLL PRELUDE ANY MORE. The balance is created at signup and
 * named on the request; `betInsertSql`'s `EXISTS` over `bankrolls` is what
 * proves it is the caller's, inside the batch.
 *
 * Exported for `tests/worker/bets.spec.ts`, which asserts the shape of the plan.
 */
export function buildPlacement(env: Env, args: PlacementArgs): PlacementPlan {
  const { input, now } = args;
  const teaserPoints = input.betType === 'teaser' ? (input.teaserPoints ?? null) : null;
  if (input.betType === 'teaser' && teaserPoints === null) {
    // Unreachable via `validated()`; stated so the schema's paired CHECK is not
    // the first thing to notice a missing tier.
    throw new AppError('TEASER_INVALID', 'A teaser must name its point tier.', {
      field: 'teaserPoints',
    });
  }
  const legs = teaserPoints === null ? args.legs : applyTease(args.legs, teaserPoints);

  const price =
    teaserPoints === null
      ? priceFromLegs(legs.map((l) => l.americanPrice))
      : americanToPrice(teaserPrice(teaserPoints, legs.length));
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
  // DISTINCT, in leg order: a same-game parlay names a game once in the guard
  // and once in the count it must reach (`betInsertSql`).
  const gameIds = distinctGameIds(legs);

  const betStatement = env.DB.prepare(
    betInsertSql(gameIds.length, args.requiresCancelledBetId !== null),
  ).bind(
    betId,
    args.userId,
    args.bankrollId,
    betLeagueOf(legs),
    betSeasonOf(legs),
    input.betType,
    legs.length,
    input.stakeCents,
    americanPrice,
    potentialPayoutCents,
    now,
    earliestKickoffAt,
    args.replacesBetId,
    now + BET_CUTOFF_BUFFER_MS,
    teaserPoints,
    ...gameIds,
    gameIds.length,
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
      leg.originalLineTenths,
    ),
  );

  const stakeStatement = env.DB.prepare(STAKE_INSERT_SQL).bind(
    newId(),
    betId,
    -input.stakeCents,
    now,
    args.memo,
  );

  return {
    betId,
    statements: [betStatement, ...legStatements, stakeStatement],
    betStatementIndex: 0,
  };
}

/**
 * @throws AppError VALIDATION | TEASER_INVALID | BANKROLL_NOT_FOUND |
 *                  GAME_NOT_FOUND | GAME_NOT_BETTABLE | BETTING_CLOSED |
 *                  MARKET_UNAVAILABLE | LINE_CHANGED | INSUFFICIENT_FUNDS |
 *                  DUPLICATE_GAME_IN_PARLAY | PAYOUT_LIMIT_EXCEEDED
 *
 * MIXED_LEAGUE_PARLAY / MIXED_SEASON_PARLAY are deliberately absent: legs may
 * span leagues and seasons since M5b.
 */
export async function placeBet(
  env: Env,
  userId: string,
  req: PlaceBetRequest,
  now: EpochMs,
  hooks?: BetHooks,
): Promise<PlaceBetResult> {
  const input = validated(req);
  const [bankrollId, legs] = await Promise.all([
    resolveBankrollId(env, userId, input.bankrollId),
    resolveLegSnapshots(env, input, now),
  ]);
  const plan = buildPlacement(env, {
    userId,
    input,
    bankrollId,
    legs,
    now,
    replacesBetId: null,
    requiresCancelledBetId: null,
    memo: 'bet placed',
  });

  await runHook(hooks);
  const results = await runPlacementBatch(env, plan.statements);
  if (changesAt(results, plan.betStatementIndex) !== 1) {
    // Every later statement is guarded on the bet row, so the batch was a clean
    // no-op. Re-query to say precisely WHY (PLAN.md §14.2).
    await rejectPlacement(env, userId, input, now);
  }
  return { bet: await requireBet(env, userId, plan.betId, now) };
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
      // Always a bug: the stake row is sourced from `bets.bankroll_id`, and the
      // bet only lands when its balance EXISTS and belongs to the caller.
      console.error('[bets] orphan bankroll on a guarded batch', err);
      throw new AppError('INTERNAL', 'Something went wrong.');
    }
    if (
      isUniqueViolation(err, 'bet_legs.bet_id, bet_legs.game_id, bet_legs.market') ||
      isOneSidePickError(err)
    ) {
      // Both are 0008's backstops under `sameGameConflict`, which `validated()`
      // already ran, so reaching here means the two disagree — still a 409, and
      // the code keeps its name and its wire meaning: one game, too many legs.
      throw new AppError(
        'DUPLICATE_GAME_IN_PARLAY',
        'A bet may hold one side pick and one total per game.',
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
 *
 * THE ACCOUNT IS CHECKED FIRST, because `USER_STATE_GUARD` can be the conjunct
 * that refused and no amount of staring at the games would say so — the caller
 * would be told "betting closed" about a game that is wide open. Reading it
 * HERE, after a batch that has already declined to write anything, is diagnosis
 * and not a gate: the guard itself stayed in the `WHERE` (CLAUDE.md rule 5), and
 * nothing this read returns can let the bet through.
 */
async function rejectPlacement(
  env: Env,
  userId: string,
  input: PlaceBetInput,
  now: EpochMs,
): Promise<never> {
  const account = await queryOne<{ n: number }>(
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE id = ?1 AND is_disabled = 0 AND deleted_at IS NULL`,
    ).bind(userId),
  );
  if ((account?.n ?? 0) === 0) {
    // Deleted accounts report as disabled too. They ARE disabled (the soft
    // delete sets `is_disabled = 1`), the session is already dead, and the
    // alternative would tell a caller holding a stale cookie that their account
    // is gone rather than merely off.
    throw new AppError('ACCOUNT_DISABLED', 'This account can no longer place bets.');
  }
  const gameIds = distinctGameIds(input.legs);
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
 * DELIBERATE ADDITION TO §14.2's ORIGINAL SQL (the plan has since been amended
 * to match): the cancel UPDATE carries the PLACEMENT guard too — see
 * `editCancelSql` for why the symmetry is required rather than merely tidy.
 *
 * ONE FURTHER RULE, about WHERE THE MONEY LIVES: **an edit must keep the bet's
 * BALANCE.** Allowing it to change would let a `PUT` refund one balance and
 * stake a different one in the same batch, under the banner of "editing a bet",
 * and it makes `replaces_bet_id` link two rows that never shared a ledger. That
 * rule used to be spelled `(league, season)`, because a balance was implied by
 * them; now it is spelled directly, and it is the only thing left of it — the
 * replacement's legs may be in any league or season, because the balance they
 * are charged to no longer depends on that. A caller who names a DIFFERENT
 * `bankrollId` is refused rather than silently overridden.
 *
 * The owner lookup that enforces it runs BEFORE anything is built, so an
 * unauthorised edit writes nothing at all. It is not a read-then-write guard:
 * `bets.bankroll_id` and `bets.user_id` are immutable once written, so nothing
 * it reads can change under the batch, and every mutable condition
 * (`status = 'pending'`, the kickoff lock) still lives in the `WHERE` of the
 * UPDATE.
 *
 * @throws every code `placeBet` throws, plus BET_NOT_FOUND | BET_LOCKED |
 *         BET_NOT_PENDING
 */
export async function editBet(
  env: Env,
  userId: string,
  betId: string,
  req: PlaceBetRequest,
  now: EpochMs,
  hooks?: BetHooks,
): Promise<{ readonly bet: BetView; readonly replacedBetId: string }> {
  const input = validated(req);
  const target = await queryOne<{ bankroll_id: string }>(
    env.DB.prepare(`SELECT bankroll_id FROM bets WHERE id = ?1 AND user_id = ?2`).bind(
      betId,
      userId,
    ),
  );
  // 404, never 403 — and BEFORE any statement is built, so an unauthorised edit
  // writes nothing at all.
  if (target === null) throw new AppError('BET_NOT_FOUND', 'No such bet.');
  if (input.bankrollId !== undefined && input.bankrollId !== target.bankroll_id) {
    throw new AppError('VALIDATION', 'An edit cannot move a bet to another balance.', {
      field: 'bankrollId',
    });
  }

  const legs = await resolveLegSnapshots(env, input, now);
  const plan = buildPlacement(env, {
    userId,
    input,
    bankrollId: target.bankroll_id,
    legs,
    now,
    replacesBetId: betId,
    requiresCancelledBetId: betId,
    memo: 'bet placed (edit)',
  });
  const nowPlusBuffer = now + BET_CUTOFF_BUFFER_MS;
  const gameIds = distinctGameIds(legs);

  const cancelStatement = env.DB.prepare(editCancelSql(gameIds.length)).bind(
    betId,
    userId,
    now,
    nowPlusBuffer,
    plan.betId,
    ...gameIds,
    gameIds.length,
  );

  const refundStatement = env.DB.prepare(
    refundInsertSql(`\n   AND b.replaced_by_bet_id = ?7`),
  ).bind(betId, userId, now, nowPlusBuffer, newId(), 'replaced by edit', plan.betId);

  await runHook(hooks);
  const results = await runPlacementBatch(env, [
    cancelStatement,
    refundStatement,
    ...plan.statements,
  ]);
  if (changesAt(results, 0) !== 1) {
    // Either the old bet could not be cancelled, or the new legs are no longer
    // placeable; the batch cannot say which. Re-read the old bet's status (the
    // up-front read is stale by now — a concurrent DELETE may have cancelled it
    // between the two) and answer with whichever fault is the more specific.
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
      await rejectPlacement(env, userId, input, now);
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
 * FILTER SEMANTICS, DECIDED AND DOCUMENTED (PLAN.md §11.4): `status=open` is
 * exactly `status='pending'`, and `status=settled` IS ITS COMPLEMENT — it
 * therefore INCLUDES `cancelled` bets, which are not "settled" in the betting
 * sense at all. That is deliberate: the two filters partition a user's bets, so
 * the UI's "history" tab shows cancellations rather than letting them vanish
 * from both tabs. `cancelled` is still excluded from every STATISTIC
 * (`summariseSettled` counts only won/lost/push/void), so the record and ROI are
 * unaffected. Callers wanting true settlements only should filter on
 * `bet.status` client-side.
 */
export async function listBets(
  env: Env,
  userId: string,
  filter: {
    readonly status: 'open' | 'settled' | 'all';
    /** Matches `bets.league` exactly, so `'mixed'` is its own filter value. */
    readonly league?: BetLeague;
    /** No `season`: the product has no concept of one (PLAN.md §19 Q5). */
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
    bankrollId: bet.bankroll_id,
    league: bet.league as BetLeague,
    season: bet.season,
    betType: bet.bet_type as BetType,
    teaserPoints: bet.teaser_points_tenths,
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
    league: snapshot.league,
    market: snapshot.market,
    side: snapshot.side,
    lineTenths: leg.line_tenths,
    originalLineTenths: leg.original_line_tenths,
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
