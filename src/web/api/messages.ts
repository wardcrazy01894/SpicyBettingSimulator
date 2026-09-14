/**
 * The ONE table that maps every `ErrorCode` in `src/shared/errors.ts` to copy a
 * person can act on. PLAN.md §12.
 *
 * `Readonly<Record<ErrorCode, string>>` is total, so adding a code to
 * `ERROR_CODES` fails the build here rather than shipping a raw
 * `MIXED_SEASON_PARLAY` to a user.
 *
 * The server's own `error.message` is deliberately NOT preferred: it is written
 * for an operator (and for VALIDATION it names a wire field like
 * `legs[0].expected.americanPrice`). The exceptions are VALIDATION and
 * RATE_LIMITED, where the server's detail is genuinely the useful part — see
 * `messageForError`.
 */

import { ERROR_STATUS } from '../../shared/errors.js';
import type { ErrorCode } from '../../shared/errors.js';

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION: "That doesn't look right — check the highlighted field and try again.",
  MALFORMED_JSON: 'The app sent something the server could not read. Please reload.',
  TEASER_INVALID: 'That teaser is not one we offer — pick a tier from 3 to 14 points.',

  UNAUTHENTICATED: 'Your session expired. Please sign in again.',
  INVALID_CREDENTIALS: 'Wrong username or password.',
  BAD_INVITE_CODE: 'That invite code is not valid.',
  ACCOUNT_DISABLED: 'This account has been disabled. Ask an admin to re-enable it.',
  CSRF_BLOCKED: 'That request was blocked for security. Reload the page and try again.',

  NOT_FOUND: 'Not found.',
  GAME_NOT_FOUND: 'That game is no longer on the board.',
  BET_NOT_FOUND: 'That bet no longer exists.',
  BANKROLL_NOT_FOUND: 'That balance does not exist.',

  USERNAME_TAKEN: 'That username is taken. Pick another one.',
  GAME_NOT_BETTABLE: 'That game is no longer open for betting.',
  BETTING_CLOSED: 'Betting closed on that game — it is about to kick off.',
  MARKET_UNAVAILABLE: 'That line is no longer available. Refresh the board.',
  LINE_CHANGED: 'The line moved while you were building this bet.',
  INSUFFICIENT_FUNDS: 'Not enough in your balance for that stake.',
  // DEPRECATED since M5b — the server never sends these any more (legs may span
  // leagues and seasons). Kept because `ERROR_MESSAGES` is a TOTAL record over
  // `ERROR_CODES`, and because a client this new can still be talking to a
  // server that predates the change.
  MIXED_LEAGUE_PARLAY: 'Every leg of a parlay has to be in the same league.',
  MIXED_SEASON_PARLAY: 'Every leg of a parlay has to be in the same season.',
  DUPLICATE_GAME_IN_PARLAY: 'A parlay cannot include the same game twice.',
  PAYOUT_LIMIT_EXCEEDED: 'That would pay out more than the $1,000,000 cap. Lower the stake.',
  BET_LOCKED: 'Too late — a game in this bet has already kicked off.',
  BET_NOT_PENDING: 'That bet has already been settled or cancelled.',
  ACCOUNT_HAS_PENDING_BETS:
    'That account still has open bets — cancel or settle them first, then delete it.',
  JOB_LOCKED: 'That job is already running. Give it a minute.',

  RATE_LIMITED: 'Too many attempts. Wait 15 minutes and try again.',
  UPSTREAM_UNAVAILABLE: 'Could not reach the server. Check your connection and retry.',
  INTERNAL: 'Something went wrong on our end. Try again in a moment.',
};

/** Human copy for a stable error code. */
export function messageForCode(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

/**
 * An `ApiError` recognised structurally rather than by `instanceof`.
 *
 * This module deliberately does NOT import `./client.js`: that module touches
 * `fetch`/`Response`/`URLSearchParams`, which would drag DOM lib types into the
 * DOM-free `web` test project. Duck-typing on a code that is in the frozen
 * vocabulary is enough, and it cannot be spoofed into showing a raw string —
 * the code still has to be one of ours.
 */
function codeOf(error: unknown): ErrorCode | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && code in ERROR_STATUS ? (code as ErrorCode) : null;
}

/**
 * Human copy for anything thrown by the api client (or by a pure shared helper
 * that threw a plain `Error`). Never renders a stack or a SQL fragment.
 */
export function messageForError(error: unknown): string {
  const code = codeOf(error);
  if (code !== null) {
    // For these three the server's message carries the specific, useful detail
    // (which field failed / how long the lockout is / WHICH username is in the
    // way) and is safe to show. `USERNAME_TAKEN` is here because it arrives from
    // two places with different advice: signup (the server's message says the
    // name is taken) and a soft delete whose tombstone names are both occupied
    // (PLAN §10.5), where "Pick another one" would be nonsense advice to an
    // admin deleting somebody. In both cases the server's message is shown.
    const message = error instanceof Error ? error.message : '';
    const verbatim = code === 'VALIDATION' || code === 'RATE_LIMITED' || code === 'USERNAME_TAKEN';
    if (verbatim && message !== '') return message;
    return ERROR_MESSAGES[code];
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return ERROR_MESSAGES.INTERNAL;
}
