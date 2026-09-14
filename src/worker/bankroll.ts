/**
 * Account balances, their statistics and the ledger read path. PLAN.md §4 and
 * §11.5.
 *
 * A BALANCE IS AN ACCOUNT-LEVEL POT (M5b). It is not scoped to a league or a
 * season, it never rolls over, and it is NOT created lazily: the `main` balance
 * is written in the signup batch, once, and lives as long as the user does.
 * Everything that used to call `ensureBankroll` on the read path
 * (`GET /api/bankroll`, the board, placement) simply reads it now — a GET that
 * silently wrote two rows was always a wart, and with no season boundary there
 * is nothing left for it to do.
 *
 * `ensureMainBalance` is a TESTED REPAIR PRIMITIVE WITH NO ENDPOINT YET. It is
 * idempotent by construction and `tests/worker/schema.spec.ts` pins that against
 * an already-funded row, so the day an account is found without a balance the
 * fix is a route that calls it rather than an untested `INSERT` written under
 * pressure. It is deliberately not wired to one today: signup opens the balance
 * in its own batch, no account can reach production without one, and an admin
 * route nobody can demonstrate a use for is a surface, not a safety net. If you
 * add `POST /api/admin/users/:id/repair-balance`, document it in PLAN.md §11.6.
 *
 * `balance_cents` is ONLY ever written by the ledger trigger. Nothing in this
 * file (or anywhere else) issues `UPDATE bankrolls SET balance_cents = ...`.
 */

import type {
  BankrollView,
  BankrollsResponse,
  BettingRecord,
  LedgerEntry,
  LedgerResponse,
} from '../shared/api-types.js';
import type {
  BankrollKind,
  BetLeague,
  Cents,
  EpochMs,
  LedgerKind,
  League,
} from '../shared/types.js';
import { BOARD_LOOKBACK_MS, INITIAL_BANKROLL_CENTS } from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import { LEAGUES } from '../shared/types.js';
import type { Env } from './env.js';
import { changesAt, newId, queryAll, queryOne, runBatch } from './db.js';

/**
 * The two statements that open an account's `main` balance: the row, then the
 * opening deposit that funds it.
 *
 * Both are guarded `INSERT … SELECT … WHERE (NOT) EXISTS`, never `OR IGNORE`:
 *
 *   * the ledger may not use `OR IGNORE` at all — it can swallow a value-guard
 *     abort raised from the AFTER trigger and leave a row with no balance effect,
 *     permanently, in an append-only table (CLAUDE.md rule 6 / PLAN.md §4.2);
 *   * and `OR IGNORE` on `bankrolls` would be actively WRONG here even though it
 *     is allowed in general. The id is a fresh uuid, so a duplicate would not
 *     collide on the primary key — it would collide on the partial unique index
 *     `idx_bankrolls_main`, `OR IGNORE` would swallow that too, and statement 2
 *     would then insert a ledger row against a bankroll id that does not exist:
 *     `ledger_bi_bankroll_exists` would abort the whole batch. The explicit
 *     `NOT EXISTS (… kind = 'main')` states the real intent and makes a second
 *     run a silent, complete no-op.
 *
 * The balance opens at 0 and the ledger trigger raises it to
 * INITIAL_BANKROLL_CENTS; application code never writes a balance.
 */
export function mainBalanceStatements(
  env: Env,
  userId: string,
  bankrollId: string,
  now: EpochMs,
): readonly D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
       SELECT ?1, ?2, 'Main', 'main', 0, ?3, ?3
        WHERE NOT EXISTS (SELECT 1 FROM bankrolls WHERE user_id = ?2 AND kind = 'main')`,
    ).bind(bankrollId, userId, now),
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       SELECT ?2, ?1, 'deposit_initial', 'init', NULL, ?4, ?3, 'opening balance'
        WHERE EXISTS (SELECT 1 FROM bankrolls WHERE id = ?1)
          AND NOT EXISTS (SELECT 1 FROM ledger
                           WHERE bankroll_id = ?1 AND kind = 'deposit_initial' AND ref_id = 'init')`,
    ).bind(bankrollId, newId(), now, INITIAL_BANKROLL_CENTS),
  ];
}

/**
 * Repair path ONLY — an account that somehow has no `main` balance gets one.
 * Idempotent: against a user who already has one, both statements match zero
 * rows and the existing id is returned.
 *
 * NOTHING CALLS THIS IN PRODUCTION — there is no endpoint. It is kept, and
 * covered by `tests/worker/schema.spec.ts`, as a ready repair primitive; see the
 * module docblock for why it is not routed.
 */
export async function ensureMainBalance(env: Env, userId: string, now: EpochMs): Promise<string> {
  const existing = await mainBalanceId(env, userId);
  if (existing !== null) return existing;
  const id = newId();
  await runBatch(env.DB, mainBalanceStatements(env, userId, id, now));
  // Re-read rather than trusting `id`: a concurrent repair may have won the
  // `NOT EXISTS`, in which case OUR insert matched nothing and the real id is
  // the other one.
  const settled = await mainBalanceId(env, userId);
  if (settled === null) throw new AppError('INTERNAL', 'The main balance could not be opened.');
  return settled;
}

/** The caller's `main` balance id, or null when they have none. */
export async function mainBalanceId(env: Env, userId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    env.DB.prepare(`SELECT id FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`).bind(userId),
  );
  return row?.id ?? null;
}

/**
 * The balance a bet is staked against: the caller's `main` unless they named
 * another one of their own.
 *
 * A balance that exists but belongs to somebody else is `404
 * BANKROLL_NOT_FOUND`, identical to one that does not exist — a balance id must
 * not be an existence oracle, for the same reason `GET /api/bets/:id` is a 404
 * (PLAN.md §11.4).
 *
 * This read does NOT replace the in-batch ownership guard. `betInsertSql` also
 * carries `AND EXISTS (SELECT 1 FROM bankrolls WHERE id = ?3 AND user_id = ?2)`,
 * because a read here followed by a write there is exactly the read-then-write
 * CLAUDE.md rule 5 forbids. This one exists to produce a SPECIFIC error.
 *
 * @throws AppError BANKROLL_NOT_FOUND
 */
export async function resolveBankrollId(
  env: Env,
  userId: string,
  requested: string | undefined,
): Promise<string> {
  if (requested === undefined) {
    const main = await mainBalanceId(env, userId);
    if (main === null) {
      throw new AppError('BANKROLL_NOT_FOUND', 'This account has no balance.');
    }
    return main;
  }
  const row = await queryOne<{ id: string }>(
    env.DB.prepare(`SELECT id FROM bankrolls WHERE id = ?1 AND user_id = ?2`).bind(
      requested,
      userId,
    ),
  );
  if (row === null) throw new AppError('BANKROLL_NOT_FOUND', 'No such balance.');
  return row.id;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** One `(status)` aggregate row over a balance's SETTLED bets. */
export interface SettledStatusRow {
  readonly status: string;
  readonly n: number;
  readonly stake: number;
  readonly payout: number;
}

export interface SettledSummary {
  readonly record: BettingRecord;
  readonly roi: number | null;
  readonly settledCount: number;
}

/**
 * Which bets a `record`/`roi` figure is computed over.
 *
 * `league` matches `bets.league` EXACTLY, so a cross-league bet (`'mixed'`) is
 * counted in the unfiltered view and in neither single-league view. That is the
 * honest answer — a mixed bet is not an NFL bet — and it matches how
 * `GET /api/bets?league=` already filters.
 *
 * THERE IS NO SEASON FILTER (decided 2026-09-14, PLAN.md §19 Q5). The product has
 * no concept of a season: a balance never rolls over, so a per-season slice of it
 * would describe a reset that never happened. `bets.season` is kept internally as
 * a label for ingestion and the board's week default, and is simply not exposed.
 */
export interface StatsFilter {
  readonly league?: BetLeague;
}

/**
 * PLAN.md §11.5's statistics, from per-status aggregates.
 *
 *   record  counts over SETTLED bets only; `cancelled` is excluded entirely.
 *   roi     (Σ payout − Σ stake) / Σ stake over `won` + `lost` ONLY. Push and
 *           void are excluded from BOTH sides — a push is a no-action bet — and
 *           the result is `null` when the denominator is 0.
 *
 * The division is an ordinary float because `roi` is a display-only statistic
 * (it is typed `number | null` in the wire contract); no cent is derived from it.
 */
export function summariseSettled(rows: readonly SettledStatusRow[]): SettledSummary {
  const record = { won: 0, lost: 0, push: 0, void: 0 };
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    switch (row.status) {
      case 'won':
        record.won += row.n;
        break;
      case 'lost':
        record.lost += row.n;
        break;
      case 'push':
        record.push += row.n;
        break;
      case 'void':
        record.void += row.n;
        break;
      default:
        continue;
    }
    if (row.status === 'won' || row.status === 'lost') {
      numerator += row.payout - row.stake;
      denominator += row.stake;
    }
  }
  return {
    record,
    roi: denominator === 0 ? null : numerator / denominator,
    settledCount: record.won + record.lost + record.push + record.void,
  };
}

/** `AND league = ?n` for a filter, appending its bind value to `values`. */
export function statsFilterClauses(filter: StatsFilter, values: unknown[]): string {
  if (filter.league === undefined) return '';
  values.push(filter.league);
  return ` AND league = ?${String(values.length)}`;
}

interface BalanceRow {
  id: string;
  name: string;
  kind: string;
  balance_cents: number;
}

/**
 * Every balance the caller owns, `main` first, with its statistics.
 *
 * WHAT THE FILTER DOES AND DOES NOT TOUCH, stated because it is the one place
 * this endpoint could be misread: `balanceCents`, `pendingStakeCents` and
 * `equityCents` are ALWAYS the whole balance. Only `record`, `roi` and
 * `settledCount` respect `?league=`. Filtering the money would publish a
 * "balance" that appears nowhere in the ledger, and would break
 * `equityCents === balanceCents + pendingStakeCents`.
 */
export async function listBalances(
  env: Env,
  userId: string,
  filter: StatsFilter = {},
): Promise<BankrollsResponse> {
  const rows = await queryAll<BalanceRow>(
    env.DB.prepare(
      `SELECT id, name, kind, balance_cents
         FROM bankrolls WHERE user_id = ?1
        ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, name ASC`,
    ).bind(userId),
  );
  if (rows.length === 0) return { balances: [] };

  const values: unknown[] = [userId];
  const extra = statsFilterClauses(filter, values);
  const [pending, stats] = await Promise.all([
    // Deliberately UNFILTERED — see the note above.
    queryAll<{ bankroll_id: string; total: number }>(
      env.DB.prepare(
        `SELECT bankroll_id, COALESCE(SUM(stake_cents), 0) AS total
           FROM bets WHERE user_id = ?1 AND status = 'pending'
          GROUP BY bankroll_id`,
      ).bind(userId),
    ),
    queryAll<SettledStatusRow & { bankroll_id: string }>(
      env.DB.prepare(
        `SELECT bankroll_id, status AS status, COUNT(*) AS n,
                COALESCE(SUM(stake_cents), 0) AS stake,
                COALESCE(SUM(payout_cents), 0) AS payout
           FROM bets
          WHERE user_id = ?1 AND status IN ('won','lost','push','void')${extra}
          GROUP BY bankroll_id, status`,
      ).bind(...values),
    ),
  ]);

  const pendingBy = new Map(pending.map((r) => [r.bankroll_id, r.total]));
  const statsBy = new Map<string, SettledStatusRow[]>();
  for (const row of stats) {
    const list = statsBy.get(row.bankroll_id);
    if (list === undefined) statsBy.set(row.bankroll_id, [row]);
    else list.push(row);
  }

  return {
    balances: rows.map((row): BankrollView => {
      const settled = summariseSettled(statsBy.get(row.id) ?? []);
      const pendingStakeCents = pendingBy.get(row.id) ?? 0;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind as BankrollKind,
        balanceCents: row.balance_cents,
        pendingStakeCents,
        equityCents: row.balance_cents + pendingStakeCents,
        record: settled.record,
        roi: settled.roi,
        settledCount: settled.settledCount,
      };
    }),
  };
}

/**
 * The season a user is currently *playing*, used to DEFAULT the board and the
 * stats filters. It no longer selects a bankroll — there is only one — so this
 * is purely a convenience.
 *
 * NOT `MAX(games.season)`: once 2027 preseason games land in August 2027, a
 * January-2027 bowl would resolve to 2027. It is the season of the NEXT game to
 * kick off (the smallest `kickoff_at >= now - BOARD_LOOKBACK_MS`), falling back
 * to the most recent game's season when nothing is upcoming.
 */
export async function currentSeasonFor(
  env: Env,
  league: League,
  now: EpochMs,
): Promise<number | null> {
  const upcoming = await queryOne<{ season: number }>(
    env.DB.prepare(
      `SELECT season FROM games
        WHERE league = ?1 AND kickoff_at >= ?2
        ORDER BY kickoff_at ASC LIMIT 1`,
    ).bind(league, now - BOARD_LOOKBACK_MS),
  );
  if (upcoming) return upcoming.season;
  const latest = await queryOne<{ season: number }>(
    env.DB.prepare(
      `SELECT season FROM games WHERE league = ?1 ORDER BY kickoff_at DESC LIMIT 1`,
    ).bind(league),
  );
  return latest?.season ?? null;
}

/** `?1, ?2, …, ?n` — an IN list of positional placeholders. */
export function placeholders(count: number, from = 1): string {
  return Array.from({ length: count }, (_v, i) => `?${String(from + i)}`).join(', ');
}

export function isLeague(value: string): value is League {
  return (LEAGUES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Admin adjustment
// ---------------------------------------------------------------------------

/**
 * `POST /api/admin/users/:id/adjust` — move money into or out of a user's main
 * balance.
 *
 * One `admin_adjust` ledger row with a fresh uuid `ref_id`, so repeated
 * adjustments of the same amount are distinct events rather than idempotent
 * ones: an admin who types "+5000" twice means it twice.
 *
 * There is NO overdraft branch in this code. A negative adjustment larger than
 * the balance is refused by `ledger_bi_sufficient_funds`, which rolls the batch
 * back, and the caller maps that to `409 INSUFFICIENT_FUNDS` (§4.2) — the guard
 * lives in the schema, not here.
 *
 * A SOFT-DELETED ACCOUNT IS A 404, like `/password` and `/disabled` (PLAN §11.6).
 * Nobody can reach that balance again, so money moved into it is money nobody can
 * ever bet or see, and money moved out of it silently rewrites the history
 * `db:reconcile` is there to vouch for. The guard is a `WHERE EXISTS` INSIDE the
 * INSERT rather than a read before it (CLAUDE.md rule 5) — a read-then-write on
 * a money path would let a delete land in between — and `INSERT … SELECT … WHERE`
 * rather than `INSERT OR IGNORE`, which rule 6 bans from `ledger` outright.
 *
 * @throws AppError BANKROLL_NOT_FOUND when the user has no balance;
 *                  NOT_FOUND when the account is deleted.
 */
export async function adminAdjust(
  env: Env,
  userId: string,
  amountCents: Cents,
  memo: string | null,
  now: EpochMs,
): Promise<void> {
  const bankrollId = await mainBalanceId(env, userId);
  if (bankrollId === null) {
    throw new AppError('BANKROLL_NOT_FOUND', 'That user has no balance.');
  }
  const results = await runBatch(env.DB, [
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       SELECT ?1, ?2, 'admin_adjust', ?1, NULL, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?6 AND deleted_at IS NULL)`,
    ).bind(newId(), bankrollId, amountCents, now, memo, userId),
  ]);
  // The only guard in that WHERE is the account's state, so zero rows means
  // exactly one thing. Diagnosing a completed write, not gating one.
  if (changesAt(results, 0) === 0) throw new AppError('NOT_FOUND', 'No such user.');
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  kind: string;
  bet_id: string | null;
  amount_cents: number;
  created_at: number;
  memo: string | null;
}

/** `(createdAt, id)` packed into one opaque token; ledger rows are never updated. */
function encodeCursor(createdAt: number, id: string): string {
  return `${String(createdAt)}|${id}`;
}

function decodeCursor(raw: string): { createdAt: number; id: string } {
  const at = raw.indexOf('|');
  const createdAt = Number(raw.slice(0, at));
  if (at < 0 || !Number.isSafeInteger(createdAt)) {
    throw new AppError('VALIDATION', 'cursor is not a valid pagination token', {
      field: 'cursor',
    });
  }
  return { createdAt, id: raw.slice(at + 1) };
}

/**
 * One balance's cash history, newest first. Paginated on `(created_at, id)`,
 * which is stable because `ledger` is append-only — no row can move between
 * pages under us.
 *
 * `bankrollId` is resolved against the caller first, so this can never page
 * through somebody else's ledger.
 */
export async function listLedger(
  env: Env,
  userId: string,
  requestedBankrollId: string | undefined,
  opts: { readonly limit: number; readonly cursor?: string },
): Promise<LedgerResponse> {
  const id = await resolveBankrollId(env, userId, requestedBankrollId);
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  // One extra row tells us whether another page exists without a COUNT query.
  const probe = opts.limit + 1;
  const rows =
    cursor === null
      ? await queryAll<LedgerRow>(
          env.DB.prepare(
            `SELECT id, kind, bet_id, amount_cents, created_at, memo
               FROM ledger WHERE bankroll_id = ?1
              ORDER BY created_at DESC, id DESC LIMIT ?2`,
          ).bind(id, probe),
        )
      : await queryAll<LedgerRow>(
          env.DB.prepare(
            `SELECT id, kind, bet_id, amount_cents, created_at, memo
               FROM ledger
              WHERE bankroll_id = ?1
                AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
              ORDER BY created_at DESC, id DESC LIMIT ?4`,
          ).bind(id, cursor.createdAt, cursor.id, probe),
        );
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    entries: page.map(toLedgerEntry),
    nextCursor:
      rows.length > opts.limit && last !== undefined
        ? encodeCursor(last.created_at, last.id)
        : null,
  };
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    kind: row.kind as LedgerKind,
    betId: row.bet_id,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
    memo: row.memo,
  };
}
