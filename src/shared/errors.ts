/**
 * The stable error-code vocabulary. Every non-2xx API response is
 * `{ error: { code, message, details? } }` with `code` drawn from this list.
 *
 * Codes are part of the API contract: the UI switches on them to render a human
 * message. Never repurpose a code; add a new one.
 */

export const ERROR_CODES = [
  // 400
  'VALIDATION',
  'MALFORMED_JSON',
  'TEASER_INVALID',
  // 401 / 403
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'BAD_INVITE_CODE',
  'ACCOUNT_DISABLED',
  'CSRF_BLOCKED',
  // 404
  'NOT_FOUND',
  'GAME_NOT_FOUND',
  'BET_NOT_FOUND',
  'BANKROLL_NOT_FOUND',
  // 409
  'USERNAME_TAKEN',
  'GAME_NOT_BETTABLE',
  'BETTING_CLOSED',
  'MARKET_UNAVAILABLE',
  'LINE_CHANGED',
  'INSUFFICIENT_FUNDS',
  /**
   * @deprecated M5b. Legs may span leagues and seasons — a balance is no longer
   * scoped to either, so there is nothing left for these to protect. NOTHING
   * THROWS THEM ANY MORE. They stay in the vocabulary because the codes are part
   * of the wire contract and a deployed client still has copy for them; removing
   * a code would be repurposing the list, which this file forbids.
   */
  'MIXED_LEAGUE_PARLAY',
  /** @deprecated M5b — see `MIXED_LEAGUE_PARLAY`. Never thrown. */
  'MIXED_SEASON_PARLAY',
  'DUPLICATE_GAME_IN_PARLAY',
  'PAYOUT_LIMIT_EXCEEDED',
  'BET_LOCKED',
  'BET_NOT_PENDING',
  /**
   * `DELETE /api/admin/users/:id` refused because the account still has PENDING
   * bets. ADDED, never repurposed, per the rule at the top of this file: the
   * outcome is a 409 ("the account is not in a deletable state"), and no existing
   * 409 means that — `BET_NOT_PENDING` is about ONE bet's status and says the
   * opposite thing, and `VALIDATION` is a 400 about a malformed field.
   */
  'ACCOUNT_HAS_PENDING_BETS',
  'JOB_LOCKED',
  // 429 / 5xx
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** Canonical HTTP status for each code. Keeps route handlers from guessing. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  MALFORMED_JSON: 400,
  TEASER_INVALID: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  BAD_INVITE_CODE: 401,
  ACCOUNT_DISABLED: 403,
  CSRF_BLOCKED: 403,
  NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  BET_NOT_FOUND: 404,
  BANKROLL_NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  GAME_NOT_BETTABLE: 409,
  BETTING_CLOSED: 409,
  MARKET_UNAVAILABLE: 409,
  LINE_CHANGED: 409,
  INSUFFICIENT_FUNDS: 409,
  MIXED_LEAGUE_PARLAY: 409,
  MIXED_SEASON_PARLAY: 409,
  DUPLICATE_GAME_IN_PARLAY: 409,
  PAYOUT_LIMIT_EXCEEDED: 409,
  BET_LOCKED: 409,
  BET_NOT_PENDING: 409,
  ACCOUNT_HAS_PENDING_BETS: 409,
  JOB_LOCKED: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * A domain error carrying an API code. Thrown by service functions and turned
 * into a response by the Hono error handler.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  /** Canonical HTTP status for this error's code. */
  get status(): number {
    return ERROR_STATUS[this.code];
  }

  /** Serialize to the wire envelope. */
  toBody(): ApiErrorBody {
    return this.details === undefined
      ? { error: { code: this.code, message: this.message } }
      : { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/** Narrowing helper used by the Hono error handler. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Map an arbitrary thrown value (including D1 constraint failures, which arrive
 * as plain `Error`s with the SQLite message in `.message`/`.cause`) onto an
 * AppError. This is where `CHECK constraint failed: balance_cents >= 0` becomes
 * INSUFFICIENT_FUNDS and `UNIQUE constraint failed: ledger...` becomes a
 * recognised already-settled signal. See PLAN.md §4.2 and §7.4.
 */
export function fromThrown(value: unknown): AppError {
  if (isAppError(value)) return value;
  // The two ledger BEFORE INSERT triggers raise DISTINCT messages on purpose:
  // insufficient funds is a legitimate user outcome, an unknown bankroll is a
  // bug and must surface as INTERNAL (PLAN.md §4.2). db.ts::isOverdraftError /
  // isOrphanBankrollError use the same constants, so the two cannot drift.
  if (thrownMentions(value, DB_MESSAGES.insufficientFunds)) {
    return new AppError('INSUFFICIENT_FUNDS', 'Insufficient funds for this stake.');
  }
  // Deliberately generic: the original message may contain SQL or a stack.
  return new AppError('INTERNAL', 'Something went wrong.');
}

/**
 * The exact strings migrations/0001_init.sql raises. SQLite never echoes bound
 * values into these messages, so a user-controlled string cannot forge them.
 */
export const DB_MESSAGES = {
  insufficientFunds: ['ledger: insufficient funds', 'CHECK constraint failed: balance_cents >= 0'],
  unknownBankroll: ['ledger: unknown bankroll_id'],
  uniqueViolation: ['UNIQUE constraint failed'],
} as const;

/** True when the thrown value (or its `cause` chain) mentions any needle. */
export function thrownMentions(value: unknown, needles: readonly string[]): boolean {
  const text = collectMessages(value);
  return needles.some((n) => text.includes(n));
}

/** Message text of a thrown value and its `cause` chain, joined. */
function collectMessages(value: unknown): string {
  const parts: string[] = [];
  let cur: unknown = value;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    } else {
      parts.push(typeof cur === 'string' ? cur : '');
      cur = undefined;
    }
  }
  return parts.join(' | ');
}
