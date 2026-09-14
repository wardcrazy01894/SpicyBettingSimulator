/**
 * Thin D1 helpers. PLAN.md §1: D1 has NO interactive transactions, so
 * `db.batch()` is the only atomicity primitive — statements run sequentially and
 * the whole sequence rolls back if any one errors.
 *
 * Rules enforced by convention here:
 *   1. Anything that must be atomic is EXACTLY ONE batch().
 *   2. Never read-then-write; express the guard as a WHERE inside the write.
 *   3. `MAX_BATCH_STATEMENTS` (40) is the size of ONE batch() call, not a
 *      per-invocation total. See the note on that constant: ingestion is the one
 *      place that exceeds 40 statements in a single invocation, deliberately.
 */

import { DB_MESSAGES, thrownMentions } from '../shared/errors.js';
import type { Env } from './env.js';

/**
 * Run a batch and return the per-statement results IN ORDER. Callers inspect
 * `results[i].meta.changes` to learn whether a conditional write applied — that
 * is how every guard in this codebase reports success without a second read.
 */
export async function runBatch(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<readonly D1Result[]> {
  if (statements.length === 0) return [];
  if (statements.length > MAX_BATCH_STATEMENTS) {
    throw new Error(
      `runBatch: ${String(statements.length)} statements exceeds budget ${String(MAX_BATCH_STATEMENTS)}`,
    );
  }
  return db.batch([...statements]);
}

/**
 * The maximum number of statements in ONE `batch()` call. Enforced per
 * `runBatch()` call.
 *
 * PLAN.md §1 / Spike S2: the D1 limits page says 50 queries per invocation, the
 * 2026-02-11 changelog says 1000 for Cloudflare-service subrequests, and S2 (to
 * settle which applies, and whether a `batch([...n])` counts as 1 or n) is STILL
 * OPEN. Until it closes, everything that can be chunked is chunked at 40.
 *
 * THE ONE DELIBERATE EXCEPTION IS INGESTION. `upsertSlate()` issues two
 * statements per game (PLAN.md §8.5's A/B split) plus one per line, so a live
 * 86-game CFB target is ~172 statements across ~5 chunked batches in a single
 * invocation. That is intentional and cannot be reduced without either dropping
 * the write-budget levers (§8.6, a correctness concern under the hard-enforced
 * 100k rows/day cap) or splitting one ET date across invocations — the last rung
 * but one of R1's fallback ladder. Every other caller — settlement in
 * particular, chunked at 20 bets — stays at or under one 40-statement batch per
 * invocation.
 */
export const MAX_BATCH_STATEMENTS = 40;

/** `results[index].meta.changes`, defaulting to 0. */
export function changesAt(results: readonly D1Result[], index: number): number {
  const meta = results[index]?.meta as { changes?: unknown } | undefined;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

/**
 * `results[index].meta.rows_written`, which is the number that counts against
 * D1's hard-enforced 100,000-rows-per-day free-tier cap: it counts the TABLE row
 * plus every INDEX entry the statement rewrote, so it is 4 for a `games` update
 * that touches `status`/`kickoff_at`/`week` and 1 for one that does not.
 * `meta.changes`, by contrast, is only ever 0 or 1 per row matched and therefore
 * under-reports the real cost by up to 4x (PLAN.md §8.6).
 *
 * Falls back to `meta.changes` when the runtime omits the field, so a future
 * D1/miniflare that stops reporting it degrades to an under-count rather than
 * silently reporting zero.
 */
export function rowsWrittenAt(results: readonly D1Result[], index: number): number {
  const meta = results[index]?.meta as { rows_written?: unknown } | undefined;
  return typeof meta?.rows_written === 'number' ? meta.rows_written : changesAt(results, index);
}

/** `rowsWrittenAt` for a single `.run()` result. */
export function rowsWrittenOf(result: D1Result): number {
  return rowsWrittenAt([result], 0);
}

/** `SELECT` returning zero or one row. */
export async function queryOne<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

/** `SELECT` returning many rows. */
export async function queryAll<T>(stmt: D1PreparedStatement): Promise<readonly T[]> {
  const res = await stmt.all<T>();
  return res.results;
}

/**
 * True when the thrown value is the `ledger_bi_sufficient_funds` abort
 * (`'ledger: insufficient funds'`) or the belt-and-braces
 * `CHECK (balance_cents >= 0)` — i.e. a legitimate overdraft that D1 correctly
 * rolled back. Maps to `409 INSUFFICIENT_FUNDS`.
 *
 * It must NOT match `'ledger: unknown bankroll_id'`: that is an internal bug
 * (an orphan ledger row was attempted), and reporting it to the user as
 * "insufficient funds" would hide it forever. Use `isOrphanBankrollError` for
 * that and let it surface as `500 INTERNAL`. The two triggers raise distinct
 * messages precisely so this distinction is possible.
 */
export function isOverdraftError(err: unknown): boolean {
  return thrownMentions(err, DB_MESSAGES.insufficientFunds);
}

/**
 * True for the `ledger_bi_bankroll_exists` abort. Always an internal bug —
 * surface as `500 INTERNAL` and log loudly.
 */
export function isOrphanBankrollError(err: unknown): boolean {
  return thrownMentions(err, DB_MESSAGES.unknownBankroll);
}

/**
 * True when the thrown value is a UNIQUE violation on the given index. Used to
 * recognise "this bet was already paid" without a read (PLAN.md §7.4).
 */
// `hint` is matched as a plain substring of the SQLite message (e.g.
// 'ledger.bankroll_id, ledger.kind, ledger.ref_id'); pass enough of the index's
// column list to be unambiguous, not just one column name.
export function isUniqueViolation(err: unknown, hint?: string): boolean {
  if (!thrownMentions(err, DB_MESSAGES.uniqueViolation)) return false;
  return hint === undefined ? true : thrownMentions(err, [hint]);
}

/** `crypto.randomUUID()`, wrapped so tests can inject a deterministic source. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * The single source of "now" for a request or job. Captured ONCE and threaded
 * through, because Workers freezes `Date.now()` between I/O operations and we
 * want every guard in a batch to agree. Never derived from client input.
 */
export function nowMs(): number {
  return Date.now();
}

/** Handy for tests: assert `SUM(ledger.amount_cents) === bankrolls.balance_cents`. */
export interface BankrollDrift {
  readonly bankrollId: string;
  readonly balanceCents: number;
  readonly ledgerSumCents: number;
}

export interface ReconcileResult {
  /** How many bankrolls were checked — the denominator of "0 with drift". */
  readonly checked: number;
  readonly drift: readonly BankrollDrift[];
}

/**
 * PLAN.md §4.1's headline invariant, checked for every bankroll:
 * `bankrolls.balance_cents === SUM(ledger.amount_cents)`.
 *
 * READ-ONLY, and deliberately so: `balance_cents` is written by exactly one
 * thing, the `ledger_ai_apply` trigger, and the `bankrolls_b*_balance_guard`
 * triggers reject any other writer. A drift therefore means a bug in the DDL or
 * a manual write, and "repairing" it would destroy the evidence and could mask
 * a missing (or extra) ledger row. It is reported to a human instead —
 * `POST /api/admin/reconcile` and `npm run db:reconcile`.
 *
 * The comparison is done IN SQL so it never depends on this process reading
 * every ledger row: `SUM` over `idx_ledger_sum` is an index-only scan.
 */
export async function reconcileBankrolls(env: Env): Promise<ReconcileResult> {
  const res = await env.DB.prepare(
    `SELECT b.id            AS bankroll_id,
            b.balance_cents AS balance_cents,
            COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE bankroll_id = b.id), 0)
                            AS ledger_sum_cents
       FROM bankrolls b
      ORDER BY b.id`,
  ).all<{ bankroll_id: string; balance_cents: number; ledger_sum_cents: number }>();

  const drift: BankrollDrift[] = [];
  for (const row of res.results) {
    if (row.balance_cents !== row.ledger_sum_cents) {
      drift.push({
        bankrollId: row.bankroll_id,
        balanceCents: row.balance_cents,
        ledgerSumCents: row.ledger_sum_cents,
      });
    }
  }
  return { checked: res.results.length, drift };
}
