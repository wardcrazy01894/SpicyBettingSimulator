/**
 * Bankroll lifecycle and summary stats. PLAN.md §4.4 and §11.5.
 *
 * `balance_cents` is ONLY ever written by the ledger trigger. Nothing in this
 * file (or anywhere else) issues `UPDATE bankrolls SET balance_cents = ...`.
 */

import type {
  BankrollResponse,
  BettingRecord,
  LedgerEntry,
  LedgerResponse,
} from '../shared/api-types.js';
import type { Cents, EpochMs, LedgerKind, League } from '../shared/types.js';
import { BOARD_LOOKBACK_MS, INITIAL_BANKROLL_CENTS } from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import { LEAGUES } from '../shared/types.js';
import type { Env } from './env.js';
import { newId, queryAll, queryOne, runBatch } from './db.js';

/** Deterministic id: `<userId>:<league>:<season>`. */
export function bankrollId(userId: string, league: League, season: number): string {
  return `${userId}:${league}:${String(season)}`;
}

/**
 * Lazy season rollover. Two statements with deterministic keys, so it is
 * idempotent and safe under concurrency. Returns the bankroll id.
 *
 * The `bankrolls` insert may use `OR IGNORE` — it is not the ledger, the id is
 * deterministic and a duplicate is the only failure mode. The `ledger` insert
 * may NOT: `OR IGNORE` there can swallow a value-guard abort raised from the
 * AFTER trigger and leave a row with no balance effect, permanently, in an
 * append-only table (CLAUDE.md rule 6 / PLAN.md §4.2). The idempotency is
 * therefore stated explicitly as `INSERT … SELECT … WHERE NOT EXISTS`.
 *
 * The bankroll opens at 0 and the trigger raises it to INITIAL_BANKROLL_CENTS;
 * application code never writes a balance.
 */
export async function ensureBankroll(
  env: Env,
  userId: string,
  league: League,
  season: number,
  now: EpochMs,
): Promise<string> {
  await runBatch(env.DB, ensureBankrollStatements(env, userId, league, season, now));
  return bankrollId(userId, league, season);
}

/** Statements for `ensureBankroll`, for callers that need it inside their own batch. */
export function ensureBankrollStatements(
  env: Env,
  userId: string,
  league: League,
  season: number,
  now: EpochMs,
): readonly D1PreparedStatement[] {
  const id = bankrollId(userId, league, season);
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO bankrolls (id, user_id, league, season, balance_cents, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`,
    ).bind(id, userId, league, season, now),
    env.DB.prepare(
      `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
       SELECT ?2, ?1, 'deposit_initial', 'init', NULL, ?4, ?3, 'season opening balance'
        WHERE NOT EXISTS (SELECT 1 FROM ledger
                           WHERE bankroll_id = ?1 AND kind = 'deposit_initial' AND ref_id = 'init')`,
    ).bind(id, newId(), now, INITIAL_BANKROLL_CENTS),
  ];
}

/** One `(status)` aggregate row over a bankroll's SETTLED bets. */
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

/** The per-status aggregate for one bankroll (or every bankroll of one user). */
export async function settledStatusRows(
  env: Env,
  where: 'bankroll' | 'user',
  key: string,
): Promise<readonly SettledStatusRow[]> {
  const column = where === 'bankroll' ? 'bankroll_id' : 'user_id';
  return queryAll<SettledStatusRow>(
    env.DB.prepare(
      `SELECT status AS status, COUNT(*) AS n,
              COALESCE(SUM(stake_cents), 0) AS stake,
              COALESCE(SUM(payout_cents), 0) AS payout
         FROM bets
        WHERE ${column} = ?1 AND status IN ('won','lost','push','void')
        GROUP BY status`,
    ).bind(key),
  );
}

/** Balance, exposure, equity, W-L-P-V record and ROI. Semantics: PLAN.md §11.5. */
export async function getBankrollSummary(
  env: Env,
  userId: string,
  league: League,
  season: number,
  now: EpochMs,
): Promise<BankrollResponse> {
  const id = await ensureBankroll(env, userId, league, season, now);
  const [balanceRow, pending, statusRows] = await Promise.all([
    queryOne<{ balance_cents: number }>(
      env.DB.prepare(`SELECT balance_cents FROM bankrolls WHERE id = ?1`).bind(id),
    ),
    pendingStakeCents(env, id),
    settledStatusRows(env, 'bankroll', id),
  ]);
  const balanceCents = balanceRow?.balance_cents ?? 0;
  const settled = summariseSettled(statusRows);
  return {
    league,
    season,
    balanceCents,
    pendingStakeCents: pending,
    equityCents: balanceCents + pending,
    record: settled.record,
    roi: settled.roi,
    settledCount: settled.settledCount,
  };
}

/** Sum of stakes on `status='pending'` bets — the "exposure" column. */
export async function pendingStakeCents(env: Env, id: string): Promise<Cents> {
  const row = await queryOne<{ total: number }>(
    env.DB.prepare(
      `SELECT COALESCE(SUM(stake_cents), 0) AS total
         FROM bets WHERE bankroll_id = ?1 AND status = 'pending'`,
    ).bind(id),
  );
  return row?.total ?? 0;
}

/**
 * The season a user is currently *playing*, for defaulting the board and the
 * bankroll view.
 *
 * NOT `MAX(games.season)` -- once 2027 preseason games land in August 2027, a
 * January-2027 bowl would resolve to the 2027 bankroll. It is the season of the
 * NEXT game to kick off (the smallest `kickoff_at >= now - BOARD_LOOKBACK_MS`),
 * falling back to the most recent game's season when nothing is upcoming.
 *
 * This is a DEFAULT only. `bets.season` is never taken from here -- it is
 * derived from the legs' own game rows (see `placeBet`), so a bet can never be
 * charged to a bankroll its games do not belong to.
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

/**
 * The single (league, season) shared by every leg, read from the `games` rows.
 *
 * This is the ONLY source of `bets.season` (CLAUDE.md rule 8c): a wall-clock
 * guess would charge a January bowl to the following season's bankroll.
 *
 * @throws AppError MIXED_LEAGUE_PARLAY | MIXED_SEASON_PARLAY | GAME_NOT_FOUND
 */
export async function resolveBetScope(
  env: Env,
  gameIds: readonly string[],
): Promise<{ readonly league: League; readonly season: number }> {
  if (gameIds.length === 0) {
    throw new AppError('VALIDATION', 'A bet must have at least one leg.');
  }
  const rows = await queryAll<{ id: string; league: string; season: number }>(
    env.DB.prepare(
      `SELECT id, league, season FROM games WHERE id IN (${placeholders(gameIds.length)})`,
    ).bind(...gameIds),
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = gameIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('GAME_NOT_FOUND', 'One or more games do not exist.', {
      gameIds: missing,
    });
  }
  const leagues = [...new Set(rows.map((r) => r.league))];
  if (leagues.length > 1) {
    throw new AppError('MIXED_LEAGUE_PARLAY', 'Every leg must be in the same league.', {
      leagues,
    });
  }
  const seasons = [...new Set(rows.map((r) => r.season))];
  if (seasons.length > 1) {
    throw new AppError('MIXED_SEASON_PARLAY', 'Every leg must be in the same season.', {
      seasons,
    });
  }
  const league = leagues[0];
  const season = seasons[0];
  if (league === undefined || season === undefined || !isLeague(league)) {
    // Unreachable: `games.league` carries a CHECK constraint.
    throw new AppError('INTERNAL', 'Unrecognised league on a game row.');
  }
  return { league, season };
}

/** `?1, ?2, …, ?n` — an IN list of positional placeholders. */
export function placeholders(count: number, from = 1): string {
  return Array.from({ length: count }, (_v, i) => `?${String(from + i)}`).join(', ');
}

export function isLeague(value: string): value is League {
  return (LEAGUES as readonly string[]).includes(value);
}

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
 * One bankroll's cash history, newest first. Paginated on `(created_at, id)`,
 * which is stable because `ledger` is append-only — no row can move between
 * pages under us.
 */
export async function listLedger(
  env: Env,
  userId: string,
  league: League,
  season: number,
  opts: { readonly limit: number; readonly cursor?: string },
  now: EpochMs,
): Promise<LedgerResponse> {
  const id = await ensureBankroll(env, userId, league, season, now);
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
