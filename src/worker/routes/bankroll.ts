/** /api/bankroll and /api/ledger. PLAN.md §11.5. */

import { Hono } from 'hono';
import type { BankrollsResponse, LedgerResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { listBalances, listLedger } from '../bankroll.js';
import type { StatsFilter } from '../bankroll.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readBetLeague, readLimit } from './games.js';

const DEFAULT_LEDGER_PAGE = 50;
const MAX_LEDGER_PAGE = 200;

export function bankrollRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('/bankroll', requireAuth());
  app.use('/ledger', requireAuth());

  /**
   * Every balance the caller owns. `?league=` is OPTIONAL and narrows
   * `record`/`roi`/`settledCount` only — the money columns are always the whole
   * balance (see `listBalances`). There is no `?season=`: the product has no
   * concept of a season (PLAN.md §19 Q5).
   *
   * This route no longer creates anything. A balance is opened in the signup
   * batch; a GET that wrote two rows was only ever there to serve the
   * per-(league, season) bankrolls this milestone deleted.
   */
  app.get('/bankroll', async (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const league = readBetLeague(c.req.query('league'));
    const filter: StatsFilter = league === undefined ? {} : { league };
    const body: BankrollsResponse = await listBalances(c.env, user.id, filter);
    return c.json(body);
  });

  app.get('/ledger', async (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const cursor = c.req.query('cursor');
    const bankrollId = c.req.query('bankrollId');
    const body: LedgerResponse = await listLedger(
      c.env,
      user.id,
      bankrollId === undefined || bankrollId === '' ? undefined : bankrollId,
      {
        limit: readLimit(c.req.query('limit'), DEFAULT_LEDGER_PAGE, MAX_LEDGER_PAGE),
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
      },
    );
    return c.json(body);
  });

  return app;
}
