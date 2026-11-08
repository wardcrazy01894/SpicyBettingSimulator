/**
 * The admin "Void game…" control's pure logic (F1, PLAN.md §11.6 / §24.11).
 * DOM-free, so tests/web reaches it without jsdom.
 */
import type { AdminVoidGameResponse } from '../../shared/api-types.js';
import type { GameStatus } from '../../shared/types.js';

/**
 * The game ids a Jobs-page stats entry offers a Void button for, or `null` to
 * render the entry the ordinary way. ONE key, `stuckGames`, in either job:
 * settle's names the undecidable games behind `stuck[]`, maintenance's the
 * games stuck `in_progress` it refuses to auto-void (§7.5). Both are exactly
 * the games a human was asked to decide.
 */
export function voidableGameIds(name: string, value: unknown): readonly string[] | null {
  if (name !== 'stuckGames' || !Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v): v is string => typeof v === 'string')) return null;
  return value;
}

/**
 * The game card shows the control to an admin on a FINAL game only — the
 * short-final case. The server would also void a scheduled, live or postponed
 * game; the card simply does not invite it, and the Jobs page covers a game
 * stuck live.
 */
export function cardOffersVoid(isAdmin: boolean, status: GameStatus): boolean {
  return isAdmin && status === 'final';
}

/** The confirmation line after a successful void. */
export function voidReceipt(res: AdminVoidGameResponse): string {
  if (res.affectedBets === 0) return 'Voided. No pending bets were on this game.';
  const bets =
    res.affectedBets === 1
      ? '1 pending bet settles'
      : `${String(res.affectedBets)} pending bets settle`;
  return `Voided. ${bets} on the next settle run (a straight is refunded; a parlay drops the leg).`;
}
