/** /api/leaderboard and /api/leaderboard/all-time. PLAN.md §11.5. */

import { Hono } from 'hono';
import type { LeaderboardResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { currentSeasonFor } from '../bankroll.js';
import { leaderboardAllTime, leaderboardFor } from '../leaderboard.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readInt, readLeague } from './games.js';

export function leaderboardRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  // Registered BEFORE '/' only for readability — Hono matches the literal path
  // exactly, so there is no shadowing either way.
  app.get('/all-time', async (c) => {
    const body: LeaderboardResponse = await leaderboardAllTime(c.env);
    return c.json(body);
  });

  app.get('/', async (c) => {
    const league = readLeague(c.req.query('league'));
    const requested = readInt(c.req.query('season'), 'season');
    const season = requested ?? (await currentSeasonFor(c.env, league, c.var.now));
    if (season === null) {
      throw new AppError('VALIDATION', 'No season is in play yet; pass ?season=', {
        field: 'season',
      });
    }
    const body: LeaderboardResponse = await leaderboardFor(c.env, league, season);
    return c.json(body);
  });

  return app;
}
