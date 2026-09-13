/** /api/bets — place, list, get, cancel (DELETE), edit (PUT). PLAN.md §11.4. */

import { Hono } from 'hono';
import type { BetResponse, BetsResponse } from '../../shared/api-types.js';
import { AppError } from '../../shared/errors.js';
import { validatePlaceBet } from '../../shared/validate.js';
import {
  DEFAULT_BET_PAGE,
  MAX_BET_PAGE,
  cancelBet,
  editBet,
  getBet,
  listBets,
  placeBet,
} from '../bets.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readInt, readLimit } from './games.js';
import { readJson, validationError } from './auth.js';

const BET_FILTERS = ['open', 'settled', 'all'] as const;
type BetFilter = (typeof BET_FILTERS)[number];

interface BetListFilter {
  status: BetFilter;
  league?: 'nfl' | 'ncaaf';
  season?: number;
  limit: number;
  cursor?: string;
}

export function betsRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  app.post('/', async (c) => {
    const parsed = validatePlaceBet(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    const result = await placeBet(c.env, userId(c.var.user), parsed.value, c.var.now);
    const out: BetResponse = { bet: result.bet };
    return c.json(out, 201);
  });

  app.get('/', async (c) => {
    // `exactOptionalPropertyTypes` is on, so an absent filter must be an absent
    // KEY, not a key holding `undefined`.
    const filter: BetListFilter = {
      status: readFilter(c.req.query('status')),
      limit: readLimit(c.req.query('limit'), DEFAULT_BET_PAGE, MAX_BET_PAGE),
    };
    const league = c.req.query('league');
    if (league !== undefined && league !== '') filter.league = readLeagueFilter(league);
    const season = readInt(c.req.query('season'), 'season');
    if (season !== undefined) filter.season = season;
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && cursor !== '') filter.cursor = cursor;

    const page = await listBets(c.env, userId(c.var.user), filter, c.var.now);
    const out: BetsResponse = { bets: page.bets, nextCursor: page.nextCursor };
    return c.json(out);
  });

  app.get('/:id', async (c) => {
    const bet = await getBet(c.env, userId(c.var.user), c.req.param('id'), c.var.now);
    // 404, never 403: a bet id must not be an existence oracle (PLAN.md §11.4).
    if (bet === null) throw new AppError('BET_NOT_FOUND', 'No such bet.');
    const out: BetResponse = { bet };
    return c.json(out);
  });

  app.delete('/:id', async (c) => {
    const result = await cancelBet(c.env, userId(c.var.user), c.req.param('id'), c.var.now);
    const out: BetResponse = { bet: result.bet };
    return c.json(out);
  });

  app.put('/:id', async (c) => {
    const parsed = validatePlaceBet(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    const result = await editBet(
      c.env,
      userId(c.var.user),
      c.req.param('id'),
      parsed.value,
      c.var.now,
    );
    const out: BetResponse = { bet: result.bet, replacedBetId: result.replacedBetId };
    return c.json(out);
  });

  return app;
}

/** `requireAuth()` has already run; this narrows the type without a cast. */
function userId(user: { readonly id: string } | null): string {
  if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return user.id;
}

function readFilter(raw: string | undefined): BetFilter {
  if (raw === undefined || raw === '') return 'open';
  if (!(BET_FILTERS as readonly string[]).includes(raw)) {
    throw new AppError('VALIDATION', 'status must be open, settled or all', { field: 'status' });
  }
  return raw as BetFilter;
}

function readLeagueFilter(raw: string): 'nfl' | 'ncaaf' {
  if (raw !== 'nfl' && raw !== 'ncaaf') {
    throw new AppError('VALIDATION', 'league must be nfl or ncaaf', { field: 'league' });
  }
  return raw;
}
