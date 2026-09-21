/**
 * Another player's bet history. PLAN.md §11.8.
 *
 * The product is a few friends finding out who knows football, and "what did
 * Tyler take this week, and how did it go" is half of that conversation. So any
 * signed-in user may read any PLAYING account's bets — open ones with their live
 * projection, settled ones with what they paid — through the same query that
 * feeds My Bets, over a different owner.
 *
 * TWO RULES, both borrowed rather than invented:
 *
 *   WHO IS VISIBLE is the leaderboard's predicate, `users.is_disabled = 0 AND
 *   users.deleted_at IS NULL` (§11.5). An account off the board is `404
 *   NOT_FOUND` here, indistinguishable from an id that never existed — the same
 *   answer the admin routes give for a soft-deleted account, and for the same
 *   reason: a disabled account is not playing and cannot answer for its bets.
 *   Nothing is deleted; re-enabling puts the history straight back.
 *
 *   EVERY BET IS `cancellable: false`, whoever asks. The page is read-only by
 *   contract. The viewer could not act on the bet anyway — `DELETE`/`PUT
 *   /api/bets/:id` are scoped to the owner and answer `404 BET_NOT_FOUND` to
 *   anybody else — but a `true` here would tell the client to draw Edit and
 *   Cancel buttons it cannot honour. Uniform, even when you look at yourself:
 *   My Bets is where you act on your own bets, and one flag with two meanings
 *   depending on who is asking is exactly the kind of thing that gets misread.
 *
 * `BetView.bankrollId` is on the wire unchanged. It names the owner's balance,
 * which is harmless: every endpoint that accepts a `bankrollId` resolves it
 * against the CALLER (`resolveBankrollId`, and the `EXISTS` inside placement's
 * INSERT), so knowing somebody else's id buys nothing.
 */

import type { PlayerBetsResponse, PlayerView } from '../shared/api-types.js';
import type { EpochMs } from '../shared/types.js';
import { AppError } from '../shared/errors.js';
import { listBets } from './bets.js';
import { queryOne } from './db.js';
import type { Env } from './env.js';

interface PlayerRow {
  id: string;
  username: string;
  display_name: string;
}

/**
 * The player, if they are on the board. `null` for an unknown id AND for a
 * disabled or soft-deleted account — the caller turns both into one 404.
 */
export async function findPlayer(env: Env, userId: string): Promise<PlayerView | null> {
  const row = await queryOne<PlayerRow>(
    env.DB.prepare(
      `SELECT id, username, display_name
         FROM users
        WHERE id = ?1 AND is_disabled = 0 AND deleted_at IS NULL`,
    ).bind(userId),
  );
  if (row === null) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

/**
 * `GET /api/users/:id/bets`. The filter is `GET /api/bets`'s, unchanged
 * (`status` partitions open/settled, `league` matches `bets.league` exactly,
 * cursor paging), so the two lists can never disagree about what a query means.
 *
 * @throws AppError NOT_FOUND when the account is unknown, disabled or deleted.
 */
export async function listPlayerBets(
  env: Env,
  userId: string,
  filter: Parameters<typeof listBets>[2],
  now: EpochMs,
): Promise<PlayerBetsResponse> {
  const player = await findPlayer(env, userId);
  if (player === null) throw new AppError('NOT_FOUND', 'No such player.');
  const page = await listBets(env, player.id, filter, now);
  return {
    player,
    bets: page.bets.map((bet) => ({ ...bet, cancellable: false })),
    nextCursor: page.nextCursor,
  };
}
