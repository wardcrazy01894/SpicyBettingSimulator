/** /api/leaderboard. PLAN.md §11.5. */

import { Hono } from 'hono';
import type { LeaderboardResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { LEAGUES } from '../../shared/types.js';
import { listWithOr } from '../../shared/validate.js';
import { leaderboardFor } from '../leaderboard.js';
import type { LeaderboardFilter } from '../leaderboard.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { isLeague } from '../bankroll.js';

export function leaderboardRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  /**
   * `/all-time` is kept as an ALIAS of the unfiltered board, not deleted.
   *
   * With one balance per account there is nothing left to sum across bankrolls,
   * so "all-time" and "no filter" are the same query — but the path is in the
   * shipped client's api surface and a 404 there would be a worse answer than a
   * redundant route. Registered BEFORE '/' only for readability; Hono matches
   * literal paths exactly.
   */
  app.get('/all-time', async (c) => {
    const body: LeaderboardResponse = await leaderboardFor(c.env, { league: 'all' });
    return c.json(body);
  });

  /**
   * `?league=all|nfl|ncaaf` — OPTIONAL, and it narrows `record` and `roi` only.
   * The money columns are always the whole account, so the default view needs no
   * parameters and never 400s for want of one (which the M5 version did, from a
   * `currentSeasonFor` that could legitimately be null).
   *
   * There is no `?season=`: the product has no concept of a season, and a
   * per-season slice of a balance that never rolls over would describe a reset
   * that never happened (PLAN.md §19 Q5). An unknown query parameter is ignored,
   * as everywhere else, so a stale client sending one still gets a board.
   */
  app.get('/', async (c) => {
    const filter: LeaderboardFilter = { league: readScope(c.req.query('league')) };
    const body: LeaderboardResponse = await leaderboardFor(c.env, filter);
    return c.json(body);
  });

  return app;
}

function readScope(raw: string | undefined): LeaderboardFilter['league'] {
  if (raw === undefined || raw === '' || raw === 'all') return 'all';
  if (isLeague(raw)) return raw;
  throw new AppError('VALIDATION', `league must be ${listWithOr(['all', ...LEAGUES])}`, {
    field: 'league',
  });
}
