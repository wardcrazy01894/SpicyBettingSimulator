/**
 * WHICH MARKETS OF A FINISHED GAME HAVE ACTION. PLAN.md §23.6 / §23.7.
 *
 * "No action" is the sportsbook term for a bet that is void because the event
 * did not happen as offered — a rain-shortened baseball game has action on the
 * moneyline but not on the run line. Football never needs it: an NFL or CFB
 * game that ends is a complete game, so every football game has FULL action.
 *
 * THE SEAM. `gradeLeg` (grading.ts) stays league-unaware, exactly as it stays
 * teaser-unaware (M5b). It gains one REQUIRED GAME fact — the `GameAction` this
 * module computes from the game's league, status and inning count — and applies
 * it generically, after its existing `canceled → void` / `not final → pending`
 * checks and before it reads the score:
 *
 *   'action'                  grade the leg as today
 *   'no-action'               the leg is 'void', whatever the score
 *   'no-action-unless-decided' (totals only) grade it if `totalDecided(...)`,
 *                             otherwise 'void' — DraftKings grades an over that
 *                             had already cleared the line when the game was
 *                             called, and the matching under as a loss
 *   kind 'undecidable'        the leg is 'pending' (never guess; §7.1's
 *                             settle_attempts / stuck[] path picks it up)
 *
 * CLAUDE.md rule 7 is untouched: the LINE still comes from the `bet_legs`
 * snapshot. Whether a game was official is a GAME fact, like its score, and is
 * read from `games` alongside the score in §7.2's one query.
 *
 * The daily maintenance job's postponed-game rule lives here too, as the one
 * pure function that says WHEN a postponed game's evidence counts
 * (`postponedVoidConfirmAt`). The SQL that applies it is in maintenance.ts.
 *
 * Platform-free (CLAUDE.md rule 4).
 *
 * `action` is REQUIRED on the `GradableGame` that `gradeLeg`, `gradeBet` and
 * `projectLeg` take (M12b): an optional field defaulting to `FULL_ACTION` would
 * fail OPEN — a call site that forgot it would pay an MLB Final/7's run line.
 *
 * M12b fills EVERY function here, the full §23.6 table included — betting
 * opens before the regular season ends, so a rain-shortened game is reachable.
 * Until then every function throws; nothing imports this module, and `'mlb'`
 * is not a member of `League` until M12a.
 */

import type { EpochMs, GameStatus, League, LineTenths, Market } from './types.js';

/** What one market of a final game is worth grading. */
export type MarketAction = 'action' | 'no-action' | 'no-action-unless-decided';

/**
 * The game-level verdict `gradeLeg` consumes. `graded` names a `MarketAction`
 * per market; `undecidable` means the game is final but we cannot tell whether
 * it was official, and it has exactly ONE cause: a final MLB game whose
 * `period` is NULL (unparseable; never observed). Every leg on it grades
 * `pending` rather than being guessed at. Every final with a period — 4, 7 or
 * 12 innings alike — is `graded`.
 */
export type GameAction =
  | { readonly kind: 'graded'; readonly markets: Readonly<Record<Market, MarketAction>> }
  | { readonly kind: 'undecidable'; readonly reason: string };

/** Every market graded as usual. Football, and any MLB game of 9+ innings. */
export const FULL_ACTION: GameAction = {
  kind: 'graded',
  markets: { moneyline: 'action', spread: 'action', total: 'action' },
};

/** The two `games` columns the verdict depends on, beside the league. */
export interface ActionFacts {
  readonly status: GameStatus;
  /** `games.period` — the inning for MLB. Null when ESPN sent none. */
  readonly period: number | null;
}

/**
 * The league dispatcher: `FULL_ACTION` for `nfl` / `ncaaf`, `mlbGameAction`
 * for `mlb`. Written as an exhaustive `switch` over `League` with a `never`
 * default, so a fourth league is a COMPILE error here rather than silently
 * inheriting football's "every final is complete" assumption.
 *
 * Only meaningful for a `final` game — `gradeLeg` has already returned
 * `void` for `canceled` and `pending` for everything else — and returns
 * `FULL_ACTION` for any non-final status so a caller cannot misuse it.
 *
 * M12b.
 */
export function gameAction(_league: League, _game: ActionFacts): GameAction {
  throw new Error('not implemented (M12b: PLAN.md §23.6)');
}

/**
 * MLB's verdict for a FINAL game, from its inning count (PLAN.md §23.6's
 * decision table, which `tests/unit/mlb.spec.ts` asserts row by row):
 *
 *   period null                                   → undecidable
 *   period >= MLB_REGULATION_INNINGS (9, extras)  → FULL_ACTION
 *   MLB_OFFICIAL_INNINGS (5) <= period < 9         → moneyline action,
 *                                                   run line no-action,
 *                                                   total no-action-unless-decided
 *   period < 5                                    → moneyline no-action,
 *                                                   run line no-action,
 *                                                   total no-action — NOT "unless
 *                                                   decided": DraftKings requires
 *                                                   the game to be OFFICIAL too
 *
 * A non-final status returns `FULL_ACTION` (see `gameAction`).
 *
 * M12b ships every row. (A postseason final always has period >= 9; the
 * shortened rows matter for the regular season's last weekend and after.)
 */
export function mlbGameAction(_game: ActionFacts): GameAction {
  throw new Error('not implemented (M12b: PLAN.md §23.6)');
}

/**
 * True when a total was already DECIDED by the final score of a game that
 * stopped early: more runs than the line means no further play could have
 * changed the result (the over has won, the under has lost). Runs EQUAL to a
 * whole-number line are NOT decided — another run would have made it an over —
 * and neither is anything under the line. Integer tenths, like every line.
 *
 * `(homeScore + awayScore) * 10 > lineTenths`. Scores are the gradeable
 * integers `gradeLeg` has already validated. Consulted only for the
 * `5 … 8`-inning row: a game under five innings is not official, so its total
 * is void however decided.
 *
 * M12b.
 */
export function totalDecided(
  _homeScore: number,
  _awayScore: number,
  _lineTenths: LineTenths,
): boolean {
  throw new Error('not implemented (M12b: PLAN.md §23.6)');
}

/**
 * The earliest instant at which a successful ingest of a postponed game's ET
 * date counts as EVIDENCE that it will not be played that day, or `null` when
 * the league has no next-day void rule (football keeps §7.5's 7-day rule only).
 *
 * `windowEndAt` is the date target's `ingest_targets.window_end_at` — the
 * EXCLUSIVE end of that ET day, computed by `etDayBounds`, so the 23 h and
 * 25 h DST days are already right and nothing here adds `MS_PER_DAY`. The
 * result for `mlb` is `windowEndAt + MLB_POSTPONED_CONFIRM_MS` (03:00 ET the
 * next morning; 02:00 EST on the fall-back night, which is immaterial).
 *
 * Two readers, one constant (PLAN.md §23.7):
 *   - ingest.ts `computeNextRunAt` calls THIS, and caps a target holding an
 *     unfinished game at the instant it returns, so the evidence exists before
 *     the 08:30 UTC maintenance run instead of whenever the +6 h discovery tier
 *     next comes round;
 *   - maintenance.ts states the same instant in SQL, per row, as
 *     `t.window_end_at + :confirmMs` bound to `MLB_POSTPONED_CONFIRM_MS` — a
 *     postponed game is voided only if its target's `last_run_at` is at or past
 *     it with `last_status = 'ok'`. SQL cannot call this function; the shared
 *     constant is the single definition, and `tests/worker/mlb.spec.ts` pins
 *     the two to the same millisecond.
 *
 * M12b.
 */
export function postponedVoidConfirmAt(_league: League, _windowEndAt: EpochMs): EpochMs | null {
  throw new Error('not implemented (M12b: PLAN.md §23.7)');
}
