/**
 * Grading and settlement. PLAN.md §7.
 *
 * THREE independent layers of idempotency, because paying a bet twice is the
 * worst bug this app could have:
 *   1. `UPDATE bets ... WHERE id = ? AND status = 'pending'` — a second run
 *      matches 0 rows.
 *   2. The leg-result and ledger statements are additionally guarded on
 *      `settle_run_id = :runId`, so a run that LOST the race writes nothing.
 *   3. `UNIQUE (bankroll_id, kind, ref_id)` on `ledger` — if 1 and 2 were both
 *      defeated, the INSERT aborts the batch and no money moves.
 *
 * NOTHING in this module reads `game_lines`. The line comes from the `bet_legs`
 * snapshot; only score and status come from `games`. That is asserted by a test
 * that mutates `game_lines` after placement and checks the payout is unchanged,
 * and by a second one that records every SQL string the run prepares and asserts
 * none of them names the table.
 *
 * A parlay with some legs final and some not does not match the selection query
 * at all, so it stays `pending` with zero writes.
 *
 * HEAD-OF-LINE BLOCKING: a bet CAN be selected (all games final) and still grade
 * `pending` -- e.g. a final game whose score never parsed. Such a bet increments
 * `bets.settle_attempts` and records `settle_error`; selection orders by
 * `settle_attempts ASC` and skips anything at MAX_SETTLE_ATTEMPTS, so a handful
 * of undecidable bets can never starve the queue. Those are the ONLY columns a
 * pending outcome writes, and they carry no money semantics.
 *
 * PRICE: `bets` stores no rational. The effective price is recomputed inside the
 * job from the SURVIVING (won) legs' `american_price` integers via
 * `priceFromLegs()`, and the resulting American integer is WRITTEN BACK to
 * `bets.american_price` in the same settlement UPDATE. Without that write-back a
 * push-repriced parlay would pay 3644c while still displaying the 3-leg +811 it
 * was placed at. The displayed price must match what was paid.
 *
 * When NO leg survives (all push/void) write `PUSH_AMERICAN_PRICE` (100) from
 * odds.ts — do NOT call `priceToAmerican(priceFromLegs([]))`: even money has no
 * American form and that call throws, which would park every all-push parlay
 * as "stuck". `effectiveAmericanPrice()` in grading.ts handles that for us.
 *
 * Re-pricing can only ever DECREASE the payout: every legal American price has
 * decimal odds strictly greater than 1 (the minimum over the whole legal domain
 * is 1.001, at -100000), so dropping pushed/voided legs strictly shrinks the
 * product. Therefore `payout_cents <= potential_payout_cents <=
 * MAX_PAYOUT_CENTS` always holds and the CHECK constraint can never abort a
 * settlement batch. Stated explicitly so the CHECK does not look like a latent
 * batch-abort.
 *
 * MONEY: every cent here comes out of `gradeBet` (which routes through
 * `payoutCents()` in odds.ts, BigInt end to end). This module never multiplies,
 * divides or rounds a cent of its own.
 */

import { MAX_SETTLE_ATTEMPTS } from '../shared/constants.js';
import { effectiveAmericanPrice, gradeBet } from '../shared/grading.js';
import type { BetOutcome } from '../shared/grading.js';
import type {
  BetLegSnapshot,
  EpochMs,
  GameResult,
  GameStatus,
  League,
  Market,
  Side,
} from '../shared/types.js';
import { EVEN_MONEY_UNIT } from '../shared/odds.js';
import { changesAt, isUniqueViolation, newId, rowsWrittenAt, runBatch } from './db.js';
import type { Env } from './env.js';

export interface SettleStats {
  /** Bets the §7.1 selection query returned this run. */
  readonly selected: number;
  readonly settled: number;
  /** Selected but undecidable; `settle_attempts` was incremented. */
  readonly deferred: number;
  /** Deferred bets whose leg games changed, handed a fresh attempt budget. */
  readonly reset: number;
  /** Parked at MAX_SETTLE_ATTEMPTS and reported for a human. */
  readonly stuck: readonly string[];
  readonly won: number;
  readonly lost: number;
  readonly push: number;
  readonly void: number;
  readonly paidCents: number;
  readonly skippedAlreadySettled: number;
  /**
   * D1 `meta.rows_written` summed over every statement this run issued — the
   * unit the hard-enforced 100,000-rows-per-day cap counts, and the field
   * `jobs.ts::dayRowsWritten` sums across jobs (PLAN.md §8.6).
   */
  readonly rowsWritten: number;
  readonly errors: readonly { readonly betId: string; readonly error: string }[];
}

/** The §7.1 selection query's row. Deliberately NOT the whole `bets` row. */
export interface SettleableBet {
  readonly id: string;
  readonly bankrollId: string;
  readonly stakeCents: number;
  readonly betType: string;
  readonly legCount: number;
}

/** One leg, plus ONLY the score/status of its game. Never a line from `games`. */
export interface SettleLeg {
  readonly betId: string;
  readonly legIndex: number;
  readonly snapshot: BetLegSnapshot;
  readonly game: GameResult;
}

/**
 * How the surviving legs are priced. TODAY there is exactly one kind, and this
 * function is the ONE place that decides it.
 *
 * M5b (in flight on another branch) adds `bet_type = 'teaser'` with
 * `teaser_points_tenths`, and `gradeBet` gains a 4th `pricing` argument. When
 * that lands, this function returns
 * `{ kind: 'teaser', pointsTenths: bet.teaserPointsTenths }` for a teaser and
 * the single `gradeBet(...)` call site below gains one argument. Nothing else in
 * this file moves — which is why the pricing decision is a named function
 * reading `bet_type` rather than an inline literal.
 */
export interface BetPricing {
  readonly kind: 'parlay';
}

export function pricingFor(_bet: SettleableBet): BetPricing {
  // M5b: `return _bet.betType === 'teaser' ? { kind: 'teaser', pointsTenths: … } : …`
  return { kind: 'parlay' };
}

/**
 * How many parked bets `stats.stuck[]` names. It is a human-readable alarm, not
 * a work queue, so it is capped rather than paged.
 */
export const STUCK_REPORT_LIMIT = 50;

/* ------------------------------------------------------------------ *
 * THE LITERAL SQL (PLAN.md §7.1 / §7.4). Kept as named constants so a
 * reviewer can diff them against the plan without reading the code that
 * assembles them, and so tests can assert the guards are present.
 * ------------------------------------------------------------------ */

/**
 * FIRST statement of every settle run. Gives a deferred bet a fresh attempt
 * budget as soon as the underlying data changes, so a transient ESPN glitch
 * cannot park a bet permanently.
 *
 * This relies on `games.updated_at` advancing only on a REAL data change (§8.5
 * lever L1's `CASE`), never on the 6-hour "still here" touch; otherwise the 96
 * cap would be unreachable and `stuck[]` would never fire.
 *
 * One statement per run, and it normally matches zero rows.
 */
export const RESET_DEFERRED_SQL = `
UPDATE bets SET settle_attempts = 0, settle_error = NULL
 WHERE status = 'pending' AND settle_attempts > 0
   AND EXISTS (SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
                WHERE l.bet_id = bets.id
                  AND g.updated_at > bets.settle_attempted_at)`;

/**
 * Pending bets whose EVERY leg's game is `final` or `canceled`.
 *
 * `postponed` is deliberately absent from the `IN` list: a postponed game keeps
 * its bet pending until it is played (→ `final`) or the maintenance job
 * auto-voids it (§7.5). A PARTIALLY final parlay fails the `NOT EXISTS`, is
 * never selected, and costs zero writes — that is the whole answer to "partially
 * graded parlay".
 *
 * `ORDER BY settle_attempts ASC` is what defeats head-of-line blocking: twenty
 * undecidable bets at the head of the queue drop behind fresh work on the very
 * next run instead of being re-selected forever.
 */
export const SELECT_SETTLEABLE_SQL = `
SELECT b.id, b.bankroll_id, b.stake_cents, b.bet_type, b.leg_count
  FROM bets b
 WHERE b.status = 'pending'
   AND b.settle_attempts < ?1
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = b.id
        AND g.status NOT IN ('final','canceled')
   )
 ORDER BY b.settle_attempts ASC, b.earliest_kickoff_at ASC
 LIMIT ?2`;

/** Bets past the attempt budget. They stay `pending`; money is never forfeited. */
export const SELECT_STUCK_SQL = `
SELECT b.id FROM bets b
 WHERE b.status = 'pending' AND b.settle_attempts >= ?1
 ORDER BY b.settle_attempts DESC, b.earliest_kickoff_at ASC
 LIMIT ?2`;

/**
 * The ONLY thing a `pending` outcome writes: three columns, no money, no bet
 * status, no leg results.
 */
export const DEFER_BET_SQL = `
UPDATE bets
   SET settle_attempts     = settle_attempts + 1,
       settle_attempted_at = ?2,
       settle_error        = ?3
 WHERE id = ?1 AND status = 'pending'`;

/**
 * §7.2. The line comes from `l.*` (the immutable snapshot); ONLY
 * `status`/`home_score`/`away_score` come from `games`. There is no code path in
 * this module that reads `game_lines` (CLAUDE.md rule 7).
 */
function selectLegsSql(count: number): string {
  const placeholders = Array.from({ length: count }, (_v, i) => `?${String(i + 1)}`).join(', ');
  return `
SELECT l.bet_id, l.leg_index, l.game_id, l.league, l.market, l.side, l.line_tenths,
       l.american_price, l.provider, l.line_captured_at, l.snapshot_at,
       l.kickoff_at_snapshot, l.home_abbr, l.away_abbr,
       g.status AS g_status, g.home_score AS g_home_score, g.away_score AS g_away_score
  FROM bet_legs l JOIN games g ON g.id = l.game_id
 WHERE l.bet_id IN (${placeholders})
 ORDER BY l.bet_id, l.leg_index`;
}

/**
 * Statement 1 of the settlement batch: the conditional transition, stamped with
 * this run's id. `WHERE status = 'pending'` is idempotency layer 1 — a second
 * (or concurrent) run matches 0 rows and the guarded statements below then write
 * nothing.
 *
 * `american_price = ?4` is the RE-PRICE write-back (§7.4): `bets` holds no
 * rational, so this column is the only persisted price, and a parlay paid at its
 * surviving legs' price must display that price and not the one it was placed
 * at.
 */
export const SETTLE_BET_UPDATE_SQL = `
UPDATE bets
   SET status         = ?2,
       payout_cents   = ?3,
       american_price = ?4,
       settled_at     = ?5,
       settle_run_id  = ?6,
       updated_at     = ?5
 WHERE id = ?1 AND status = 'pending'`;

/**
 * Statement 2..n: per-leg results, written ONLY if this run won the transition.
 * That is idempotency layer 2 — the losing run's `settle_run_id` does not match,
 * so its UPDATE matches 0 rows and the winner's `graded_at` is never stomped.
 */
export const SETTLE_LEG_UPDATE_SQL = `
UPDATE bet_legs SET result = ?3, graded_at = ?4
 WHERE bet_id = ?1 AND leg_index = ?2
   AND EXISTS (SELECT 1 FROM bets WHERE id = ?1 AND settle_run_id = ?5)`;

/**
 * The money. `INSERT … SELECT … WHERE NOT EXISTS`, NEVER `INSERT OR IGNORE`
 * (CLAUDE.md rule 6): `OR IGNORE` suppresses a CHECK violation raised from the
 * `ledger_ai_apply` AFTER trigger, which would land a row with no balance effect
 * permanently in an append-only table and break `SUM(ledger) = balance_cents`
 * forever. The explicit `NOT EXISTS` states the idempotency intent instead, and
 * `UNIQUE (bankroll_id, kind, ref_id)` is the backstop underneath it.
 *
 * `bankroll_id` comes from the BET ROW (`b.bankroll_id`), never from a lookup by
 * league/season: settlement pays the bankroll that was charged, whatever the
 * bankroll model happens to be.
 */
export const SETTLE_PAYOUT_INSERT_SQL = `
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT ?2, b.bankroll_id, 'bet_payout', b.id, b.id, ?3, ?4, ?5
  FROM bets b
 WHERE b.id = ?1
   AND b.settle_run_id = ?6
   AND b.status = ?7
   AND NOT EXISTS (SELECT 1 FROM ledger le
                    WHERE le.bankroll_id = b.bankroll_id
                      AND le.kind = 'bet_payout'
                      AND le.ref_id = b.id)`;

/** Admin escape hatch (§11.6): zeroes the counter, never touches status or money. */
export const RETRY_SETTLEMENT_SQL = `
UPDATE bets SET settle_attempts = 0, settle_error = NULL
 WHERE id = ?1 AND status = 'pending'`;

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

interface SettleableBetDbRow {
  readonly id: string;
  readonly bankroll_id: string;
  readonly stake_cents: number;
  readonly bet_type: string;
  readonly leg_count: number;
}

export async function selectSettleableBets(
  env: Env,
  limit: number,
  maxAttempts: number,
): Promise<readonly SettleableBet[]> {
  const res = await env.DB.prepare(SELECT_SETTLEABLE_SQL)
    .bind(maxAttempts, limit)
    .all<SettleableBetDbRow>();
  return res.results.map((row) => ({
    id: row.id,
    bankrollId: row.bankroll_id,
    stakeCents: row.stake_cents,
    betType: row.bet_type,
    legCount: row.leg_count,
  }));
}

export async function selectStuckBetIds(
  env: Env,
  maxAttempts: number,
  limit = STUCK_REPORT_LIMIT,
): Promise<readonly string[]> {
  const res = await env.DB.prepare(SELECT_STUCK_SQL).bind(maxAttempts, limit).all<{ id: string }>();
  return res.results.map((row) => row.id);
}

/**
 * Records that a selected bet could not be graded. One UPDATE of
 * `settle_attempts` / `settle_attempted_at` / `settle_error`. No money, no status
 * change, no leg results. Returns D1's `rows_written` for the run's budget line.
 */
export async function deferBet(
  env: Env,
  betId: string,
  reason: string,
  now: EpochMs,
): Promise<number> {
  const res = await env.DB.prepare(DEFER_BET_SQL).bind(betId, now, reason.slice(0, 500)).run();
  return rowsWrittenAt([res], 0);
}

/** §7.1's automatic reset. Returns how many bets got a fresh attempt budget. */
export async function resetDeferredBets(env: Env, _now: EpochMs): Promise<number> {
  const res = await env.DB.prepare(RESET_DEFERRED_SQL).run();
  return changesAt([res], 0);
}

interface LegDbRow {
  readonly bet_id: string;
  readonly leg_index: number;
  readonly game_id: string;
  readonly league: string;
  readonly market: string;
  readonly side: string;
  readonly line_tenths: number | null;
  readonly american_price: number;
  readonly provider: string;
  readonly line_captured_at: number;
  readonly snapshot_at: number;
  readonly kickoff_at_snapshot: number;
  readonly home_abbr: string;
  readonly away_abbr: string;
  readonly g_status: string;
  readonly g_home_score: number | null;
  readonly g_away_score: number | null;
}

/** One query for all legs of the chunk, joined to games for score/status ONLY. */
export async function loadLegsForBets(
  env: Env,
  betIds: readonly string[],
): Promise<readonly SettleLeg[]> {
  if (betIds.length === 0) return [];
  const res = await env.DB.prepare(selectLegsSql(betIds.length))
    .bind(...betIds)
    .all<LegDbRow>();
  return res.results.map((row) => ({
    betId: row.bet_id,
    legIndex: row.leg_index,
    snapshot: {
      gameId: row.game_id,
      league: row.league as League,
      market: row.market as Market,
      side: row.side as Side,
      lineTenths: row.line_tenths,
      americanPrice: row.american_price,
      provider: row.provider,
      lineCapturedAt: row.line_captured_at,
      snapshotAt: row.snapshot_at,
      kickoffAtSnapshot: row.kickoff_at_snapshot,
      homeAbbr: row.home_abbr,
      awayAbbr: row.away_abbr,
    },
    game: {
      status: row.g_status as GameStatus,
      homeScore: row.g_home_score,
      awayScore: row.g_away_score,
    },
  }));
}

/* ------------------------------------------------------------------ *
 * Grading + persistence
 * ------------------------------------------------------------------ */

/**
 * Grade one bet from its loaded legs.
 *
 * THE LEG-COUNT GUARD IS LOAD-BEARING. §7.2's query is an INNER JOIN on `games`,
 * so a leg whose game row is missing silently vanishes from `legs` and
 * `gradeBet` would happily grade — and PAY — a 3-leg parlay as a 2-leg one at a
 * much shorter (i.e. more expensive) price. A count mismatch defers the bet
 * instead, which costs one UPDATE and reports it to a human via `stuck[]`.
 */
export function gradeSettleableBet(bet: SettleableBet, legs: readonly SettleLeg[]): BetOutcome {
  if (legs.length !== bet.legCount) {
    return {
      status: 'pending',
      payoutCents: 0,
      legs: [],
      effectivePrice: EVEN_MONEY_UNIT,
      pendingReason:
        `leg data incomplete: ${String(legs.length)} of ${String(bet.legCount)} legs ` +
        `have a games row; refusing to grade a partial bet`,
    };
  }

  const ordered = [...legs].sort((a, b) => a.legIndex - b.legIndex);
  const games = new Map<string, GameResult>(ordered.map((l) => [l.snapshot.gameId, l.game]));
  return gradeWithPricing(
    bet.stakeCents,
    ordered.map((l) => l.snapshot),
    games,
    pricingFor(bet),
  );
}

/**
 * The ONE call site of `gradeBet` in the settlement path, isolated so the M5b
 * rebase is a one-line change: drop the underscore from `_pricing` and pass it
 * as `gradeBet`'s 4th argument. Nothing else in this module knows how a bet is
 * priced.
 */
function gradeWithPricing(
  stakeCents: number,
  snapshots: readonly BetLegSnapshot[],
  games: ReadonlyMap<string, GameResult>,
  _pricing: BetPricing,
): BetOutcome {
  return gradeBet(stakeCents, snapshots, games);
}

/**
 * The statements of ONE bet's settlement, in order. Exactly one `batch()`, so
 * "the Worker died between grading the legs and paying out" is a state that
 * cannot exist: D1 rolls the whole sequence back.
 *
 * `1 + legCount + (payout > 0 ? 1 : 0)` ≤ 12 for a 10-leg parlay, well inside
 * `runBatch`'s 40-statement budget.
 */
export function buildSettleBatch(
  env: Env,
  bet: SettleableBet,
  outcome: BetOutcome,
  runId: string,
  now: EpochMs,
): readonly D1PreparedStatement[] {
  const american = effectiveAmericanPrice(outcome);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(SETTLE_BET_UPDATE_SQL).bind(
      bet.id,
      outcome.status,
      outcome.payoutCents,
      american,
      now,
      runId,
    ),
  ];
  for (const leg of outcome.legs) {
    statements.push(
      env.DB.prepare(SETTLE_LEG_UPDATE_SQL).bind(bet.id, leg.legIndex, leg.grade, now, runId),
    );
  }
  if (outcome.payoutCents > 0) {
    statements.push(
      env.DB.prepare(SETTLE_PAYOUT_INSERT_SQL).bind(
        bet.id,
        newId(),
        outcome.payoutCents,
        now,
        `${outcome.status} payout`,
        runId,
        outcome.status,
      ),
    );
  }
  return statements;
}

export interface SettleOneResult {
  readonly result: 'settled' | 'already-settled';
  readonly rowsWritten: number;
}

/**
 * Settle exactly one bet in exactly one batch.
 *
 * `'already-settled'` covers both losing the conditional-UPDATE race (layer 1)
 * and the ledger UNIQUE firing (layer 3) — neither is an error, and neither
 * moved any money.
 */
export async function settleOneBet(
  env: Env,
  bet: SettleableBet,
  outcome: BetOutcome,
  runId: string,
  now: EpochMs,
): Promise<SettleOneResult> {
  const statements = buildSettleBatch(env, bet, outcome, runId, now);

  // `runBatch` enforces the 40-statement budget for us (12 is the worst case).
  let results: readonly D1Result[];
  try {
    results = await runBatch(env.DB, statements);
  } catch (err) {
    // Layer 3: the ledger UNIQUE aborted the batch, so nothing was written and
    // the bet was already paid. Anything else is a real failure.
    if (isUniqueViolation(err, 'ledger.bankroll_id')) {
      return { result: 'already-settled', rowsWritten: 0 };
    }
    throw err;
  }

  let rowsWritten = 0;
  for (let i = 0; i < results.length; i += 1) rowsWritten += rowsWrittenAt(results, i);
  return {
    result: changesAt(results, 0) === 1 ? 'settled' : 'already-settled',
    rowsWritten,
  };
}

/* ------------------------------------------------------------------ *
 * The job
 * ------------------------------------------------------------------ */

/**
 * Entry point for the `settle` job. Chunked at `SETTLE_CHUNK` bets per run.
 *
 * Call shape per run: 1 reset + 1 select + 1 stuck report + 1 leg load + one
 * batch (or one deferral UPDATE) per bet.
 */
export async function runSettle(env: Env, now: EpochMs, chunk: number): Promise<SettleStats> {
  const reset = await resetDeferredBets(env, now);
  const bets = await selectSettleableBets(env, chunk, MAX_SETTLE_ATTEMPTS);
  const stuck = await selectStuckBetIds(env, MAX_SETTLE_ATTEMPTS);

  const legs = await loadLegsForBets(
    env,
    bets.map((b) => b.id),
  );
  const legsByBet = new Map<string, SettleLeg[]>();
  for (const leg of legs) {
    const list = legsByBet.get(leg.betId);
    if (list === undefined) legsByBet.set(leg.betId, [leg]);
    else list.push(leg);
  }

  let settled = 0;
  let deferred = 0;
  let won = 0;
  let lost = 0;
  let push = 0;
  let voided = 0;
  let paidCents = 0;
  let skippedAlreadySettled = 0;
  let rowsWritten = 0;
  const errors: { betId: string; error: string }[] = [];

  for (const bet of bets) {
    const runId = newId();
    try {
      const outcome = gradeSettleableBet(bet, legsByBet.get(bet.id) ?? []);
      if (outcome.status === 'pending') {
        rowsWritten += await deferBet(env, bet.id, outcome.pendingReason ?? 'not gradeable', now);
        deferred += 1;
        continue;
      }

      const applied = await settleOneBet(env, bet, outcome, runId, now);
      rowsWritten += applied.rowsWritten;
      if (applied.result === 'already-settled') {
        skippedAlreadySettled += 1;
        continue;
      }
      settled += 1;
      paidCents += outcome.payoutCents;
      switch (outcome.status) {
        case 'won':
          won += 1;
          break;
        case 'lost':
          lost += 1;
          break;
        case 'push':
          push += 1;
          break;
        case 'void':
          voided += 1;
          break;
        default:
          break;
      }
    } catch (err) {
      // One bad bet must not abort the chunk: its batch rolled back as a unit,
      // so the bet is still fully `pending` and the next run retries it.
      errors.push({ betId: bet.id, error: errorText(err) });
      console.error('[settle] failed to settle bet', bet.id, err);
    }
  }

  return {
    selected: bets.length,
    settled,
    deferred,
    reset,
    stuck,
    won,
    lost,
    push,
    void: voided,
    paidCents,
    skippedAlreadySettled,
    rowsWritten,
    errors,
  };
}

/**
 * §11.6's manual reset. Returns which of the three cases happened so the route
 * can map them to 204 / 404 / 409 without a second read of its own.
 */
export async function retrySettlement(
  env: Env,
  betId: string,
): Promise<'reset' | 'not-found' | 'not-pending'> {
  const res = await env.DB.prepare(RETRY_SETTLEMENT_SQL).bind(betId).run();
  if (changesAt([res], 0) > 0) return 'reset';
  // The guard is inside the write; this read only decides WHICH error to report.
  const row = await env.DB.prepare(`SELECT status FROM bets WHERE id = ?1`)
    .bind(betId)
    .first<{ status: string }>();
  if (row === null) return 'not-found';
  // A pending bet that matched 0 rows was already at zero: nothing to do.
  return row.status === 'pending' ? 'reset' : 'not-pending';
}

/** A short, safe rendering of a thrown value. Never carries a stack. */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return typeof err === 'string' ? err.slice(0, 500) : typeof err;
}
