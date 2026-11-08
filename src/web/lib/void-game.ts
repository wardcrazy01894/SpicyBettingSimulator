/**
 * The admin "Void game…" control's pure logic (F1, PLAN.md §11.6 / §24.11).
 * DOM-free, so tests/web reaches it without jsdom.
 */
import { gameAction } from '../../shared/action.js';
import type { AdminVoidGameResponse } from '../../shared/api-types.js';
import type { GameStatus, League } from '../../shared/types.js';

/**
 * The game ids a Jobs-page stats entry offers a Void button for, or `null` to
 * render the entry the ordinary way. ONLY a SETTLE run's `stuckGames` — the
 * undecidable games behind `stuck[]`, the games a human was asked to decide.
 * Maintenance has a `stuckGames` key too, but those are games stuck
 * `in_progress` (§7.5): usually ESPN lag that posts a real final later, and a
 * void cannot be undone (`canceled` is terminal in ingest), so no button there.
 */
export function voidableGameIds(
  job: string,
  name: string,
  value: unknown,
): readonly string[] | null {
  if (job !== 'settle' || name !== 'stuckGames') return null;
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v): v is string => typeof v === 'string')) return null;
  return value;
}

/**
 * The game card shows the control to an admin ONLY on the short-final case —
 * a final `gameAction` calls `undecidable` (PLAN.md §24.11) — never on an
 * ordinary final, whose bets have graded or are still riding in a parlay. The
 * server would also void a scheduled, live, postponed or ordinary final game;
 * the card does not invite it, and the API stays available for an admin who
 * means it.
 */
export function cardOffersVoid(
  isAdmin: boolean,
  league: League,
  status: GameStatus,
  period: number | null,
): boolean {
  return (
    isAdmin && status === 'final' && gameAction(league, { status, period }).kind === 'undecidable'
  );
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
