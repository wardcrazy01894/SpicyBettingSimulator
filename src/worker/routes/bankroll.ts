/** /api/bankroll and /api/ledger. PLAN.md §11.5. */

import { Hono } from 'hono';
import type { BankrollResponse, LedgerResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { currentSeasonFor, getBankrollSummary, listLedger } from '../bankroll.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readInt, readLeague, readLimit } from './games.js';

const DEFAULT_LEDGER_PAGE = 50;
const MAX_LEDGER_PAGE = 200;

export function bankrollRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('/bankroll', requireAuth());
  app.use('/ledger', requireAuth());

  app.get('/bankroll', async (c) => {
    const league = readLeague(c.req.query('league'));
    const season = await resolveSeason(c, league);
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    // Reading the bankroll is one of PLAN.md §4.4's lazy-creation points.
    const body: BankrollResponse = await getBankrollSummary(
      c.env,
      user.id,
      league,
      season,
      c.var.now,
    );
    return c.json(body);
  });

  app.get('/ledger', async (c) => {
    const league = readLeague(c.req.query('league'));
    const season = await resolveSeason(c, league);
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const cursor = c.req.query('cursor');
    const body: LedgerResponse = await listLedger(
      c.env,
      user.id,
      league,
      season,
      {
        limit: readLimit(c.req.query('limit'), DEFAULT_LEDGER_PAGE, MAX_LEDGER_PAGE),
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
      },
      c.var.now,
    );
    return c.json(body);
  });

  return app;
}

/**
 * `season` is optional on the wire; absent means "the one I am playing", which
 * `currentSeasonFor` derives from the NEXT game to kick off rather than from a
 * wall clock or `MAX(games.season)` (PLAN.md §4.4).
 */
async function resolveSeason(
  c: {
    env: AppContext['Bindings'];
    var: AppContext['Variables'];
    req: { query: (k: string) => string | undefined };
  },
  league: 'nfl' | 'ncaaf',
): Promise<number> {
  const requested = readInt(c.req.query('season'), 'season');
  if (requested !== undefined) return requested;
  const current = await currentSeasonFor(c.env, league, c.var.now);
  if (current === null) {
    throw new AppError('VALIDATION', 'No season is in play yet; pass ?season=', {
      field: 'season',
    });
  }
  return current;
}
