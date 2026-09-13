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
 * PLAN.md §1 / Spike S2: keep well under the documented 50-per-invocation
 * figure. Enforced per runBatch() CALL; callers are responsible for issuing at
 * most one such batch per invocation for anything near the limit.
 */
export const MAX_BATCH_STATEMENTS = 40;

/** `results[index].meta.changes`, defaulting to 0. */
export function changesAt(results: readonly D1Result[], index: number): number {
  const meta = results[index]?.meta as { changes?: unknown } | undefined;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
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

export function reconcileBankrolls(_env: Env): Promise<readonly BankrollDrift[]> {
  throw new Error('not implemented: M7');
}
