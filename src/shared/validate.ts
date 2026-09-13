/**
 * Request validation. Pure, so the SAME functions run in the browser (to grey out
 * an invalid bet slip) and in the Worker (as the real gate). The client copy is
 * purely for UX — the server always re-validates.
 */

import type { AmericanPrice, Cents, League, LineTenths, Market, Side } from './types.js';

/** A discriminated result so callers never have to catch for control flow. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly field?: string };

export interface PlaceBetLegInput {
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
  readonly expected?: {
    readonly americanPrice: AmericanPrice;
    readonly lineTenths: LineTenths | null;
  };
}

export interface PlaceBetInput {
  readonly league: League;
  readonly betType: 'straight' | 'parlay';
  readonly stakeCents: Cents;
  readonly acceptLineChange: boolean;
  readonly legs: readonly PlaceBetLegInput[];
}

export interface SignupInput {
  readonly username: string;
  readonly displayName: string;
  /** 64 lowercase hex chars — the browser-derived key, see PLAN.md §10.2. */
  readonly dk: string;
  readonly inviteCode: string | null;
}

export interface LoginInput {
  readonly username: string;
  readonly dk: string;
}

/** Lowercase, trim, and check length + charset. */
export function validateUsername(_raw: unknown): ValidationResult<string> {
  throw new Error('not implemented: M2d');
}

/** Exactly 64 lowercase hex characters. */
export function validateDerivedKeyHex(_raw: unknown): ValidationResult<string> {
  throw new Error('not implemented: M2d');
}

export function validateSignup(_body: unknown): ValidationResult<SignupInput> {
  throw new Error('not implemented: M2d');
}

export function validateLogin(_body: unknown): ValidationResult<LoginInput> {
  throw new Error('not implemented: M2d');
}

/**
 * Validate a bet request body. Checks, in order:
 *   - stakeCents is a safe integer >= MIN_STAKE_CENTS
 *   - betType 'straight' => exactly 1 leg; 'parlay' => 2..MAX_PARLAY_LEGS legs
 *   - each leg's market/side combination is coherent
 *     (total <=> over/under; moneyline/spread <=> home/away)
 *   - no two legs share a gameId (correlated parlay guard; the DB also enforces
 *     it via UNIQUE(bet_id, game_id))
 *   - gameIds are non-empty strings
 * League membership of each game is checked server-side against the DB, not here.
 */
export function validatePlaceBet(_body: unknown): ValidationResult<PlaceBetInput> {
  throw new Error('not implemented: M2d');
}

/** True iff the market/side pair is coherent. */
export function isCoherentMarketSide(_market: Market, _side: Side): boolean {
  throw new Error('not implemented: M2d');
}

/**
 * Parse a user-typed dollar string to integer cents.
 * Handles "12.34", "12", ".5", "12.", "1,000", "$5". Rejects >2 decimal places,
 * negatives, NaN and anything above MAX_SAFE_INTEGER cents.
 */
export function parseDollarsToCents(_raw: string): ValidationResult<Cents> {
  throw new Error('not implemented: M2d');
}

/** Cents -> "$1,234.56". */
export function formatCents(_cents: Cents): string {
  throw new Error('not implemented: M2d');
}

/** Tenths -> "-3.5" / "+3.5" / "50.5". `signed` controls the leading plus. */
export function formatLineTenths(_tenths: LineTenths, _signed: boolean): string {
  throw new Error('not implemented: M2d');
}
