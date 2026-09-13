/**
 * Bankroll lifecycle and summary stats. PLAN.md §4.4 and §11.5.
 *
 * `balance_cents` is ONLY ever written by the ledger trigger. Nothing in this
 * file (or anywhere else) issues `UPDATE bankrolls SET balance_cents = ...`.
 */

import type { BankrollResponse } from '../shared/api-types.js';
import type { Cents, EpochMs, League } from '../shared/types.js';
import { BOARD_LOOKBACK_MS } from '../shared/constants.js';
import type { Env } from './env.js';
import { queryOne } from './db.js';

/** Deterministic id: `<userId>:<league>:<season>`. */
export function bankrollId(_userId: string, _league: League, _season: number): string {
  throw new Error('not implemented: M5');
}

/**
 * Lazy season rollover. Two `INSERT OR IGNORE` statements with deterministic
 * keys, so it is idempotent and safe under concurrency. Returns the bankroll id.
 */
export function ensureBankroll(
  _env: Env,
  _userId: string,
  _league: League,
  _season: number,
  _now: EpochMs,
): Promise<string> {
  throw new Error('not implemented: M5');
}

/** Statements for `ensureBankroll`, for callers that need it inside their own batch. */
export function ensureBankrollStatements(
  _env: Env,
  _userId: string,
  _league: League,
  _season: number,
  _now: EpochMs,
): readonly D1PreparedStatement[] {
  throw new Error('not implemented: M5');
}

/** Balance, exposure, equity, W-L-P-V record and ROI. Semantics: PLAN.md §11.5. */
export function getBankrollSummary(
  _env: Env,
  _userId: string,
  _league: League,
  _season: number,
  _now: EpochMs,
): Promise<BankrollResponse> {
  throw new Error('not implemented: M5');
}

/** Sum of stakes on `status='pending'` bets — the "exposure" column. */
export function pendingStakeCents(_env: Env, _bankrollId: string): Promise<Cents> {
  throw new Error('not implemented: M5');
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
 * @throws AppError MIXED_LEAGUE_PARLAY | MIXED_SEASON_PARLAY | GAME_NOT_FOUND
 */
export function resolveBetScope(
  _env: Env,
  _gameIds: readonly string[],
): Promise<{ readonly league: League; readonly season: number }> {
  throw new Error('not implemented: M5');
}
