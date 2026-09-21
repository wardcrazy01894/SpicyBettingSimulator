/** /api/users — what one signed-in player may see of another. PLAN.md §11.8. */

import { Hono } from 'hono';
import type { PlayerBetsResponse } from '../../shared/api-types.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { listPlayerBets } from '../players.js';
import { readBetListFilter } from './bets.js';

export function usersRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  /**
   * Another player's bets, open or settled, read-only. The query string is
   * `GET /api/bets`'s exactly — one reader, so the two can never disagree — and
   * an account that is not on the leaderboard is `404 NOT_FOUND`, the same as an
   * id that never existed (see `players.ts`).
   */
  app.get('/:id/bets', async (c) => {
    const filter = readBetListFilter((name) => c.req.query(name));
    const body: PlayerBetsResponse = await listPlayerBets(
      c.env,
      c.req.param('id'),
      filter,
      c.var.now,
    );
    return c.json(body);
  });

  return app;
}
