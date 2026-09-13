/**
 * Thin D1 helpers. PLAN.md §1: D1 has NO interactive transactions, so
 * `db.batch()` is the only atomicity primitive — statements run sequentially and
 * the whole sequence rolls back if any one errors.
 *
 * Rules enforced by convention here:
 *   1. Anything that must be atomic is EXACTLY ONE batch().
 *   2. Never read-then-write; express the guard as a WHERE inside the write.
 *   3. Budget <= 40 statements per Worker invocation (see Spike S2).
 */

import type { Env } from './env.js';

/**
 * Run a batch and return the per-statement results IN ORDER. Callers inspect
 * `results[i].meta.changes` to learn whether a conditional write applied — that
 * is how every guard in this codebase reports success without a second read.
 */
export function runBatch(
  _db: D1Database,
  _statements: readonly D1PreparedStatement[],
): Promise<readonly D1Result[]> {
  throw new Error('not implemented: M1');
}

/** `results[index].meta.changes`, defaulting to 0. */
export function changesAt(_results: readonly D1Result[], _index: number): number {
  throw new Error('not implemented: M1');
}

/** `SELECT` returning zero or one row. */
export function queryOne<T>(_stmt: D1PreparedStatement): Promise<T | null> {
  throw new Error('not implemented: M1');
}

/** `SELECT` returning many rows. */
export function queryAll<T>(_stmt: D1PreparedStatement): Promise<readonly T[]> {
  throw new Error('not implemented: M1');
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
export function isOverdraftError(_err: unknown): boolean {
  throw new Error('not implemented: M5');
}

/**
 * True for the `ledger_bi_bankroll_exists` abort. Always an internal bug —
 * surface as `500 INTERNAL` and log loudly.
 */
export function isOrphanBankrollError(_err: unknown): boolean {
  throw new Error('not implemented: M5');
}

/**
 * True when the thrown value is a UNIQUE violation on the given index. Used to
 * recognise "this bet was already paid" without a read (PLAN.md §7.4).
 */
export function isUniqueViolation(_err: unknown, _hint?: string): boolean {
  throw new Error('not implemented: M5');
}

/** `crypto.randomUUID()`, wrapped so tests can inject a deterministic source. */
export function newId(): string {
  throw new Error('not implemented: M1');
}

/**
 * The single source of "now" for a request or job. Captured ONCE and threaded
 * through, because Workers freezes `Date.now()` between I/O operations and we
 * want every guard in a batch to agree. Never derived from client input.
 */
export function nowMs(): number {
  throw new Error('not implemented: M1');
}

/** Handy for tests: assert `SUM(ledger.amount_cents) === bankrolls.balance_cents`. */
export interface BankrollDrift {
  readonly bankrollId: string;
  readonly balanceCents: number;
  readonly ledgerSumCents: number;
}

export function reconcileBankrolls(_env: Env): Promise<readonly BankrollDrift[]> {
  throw new Error('not implemented: M7');
}
