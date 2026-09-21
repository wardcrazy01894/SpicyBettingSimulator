/**
 * Worker entry point: Hono API under /api/*, plus the cron `scheduled` handler.
 *
 * Static assets are served by the assets binding and NEVER reach this code:
 * `wrangler.jsonc` sets `run_worker_first: ["/api/*"]`, so a page load costs zero
 * Worker invocations and an unknown `/api` path still returns our JSON 404
 * instead of index.html.
 *
 * ROUTE TABLE OWNERSHIP (PLAN.md §16): each track adds exactly ONE
 * `app.route(...)` line for its own file, so merges stay one-line:
 *
 *     app.route('/api', metaRoutes());
 *     app.route('/api/auth', authRoutes());
 *     app.route('/api/games', gamesRoutes());
 *     app.route('/api/bets', betsRoutes());
 *     app.route('/api', bankrollRoutes());
 *     app.route('/api/leaderboard', leaderboardRoutes());
 *     app.route('/api/admin', adminRoutes());
 *     app.route('/api/bugs', bugsRoutes());
 *     app.route('/api/users', usersRoutes());
 */

import { Hono } from 'hono';
import { AppError } from '../shared/errors.js';
import type { Env } from './env.js';
import { nowMs } from './db.js';
import { jobForCron, runJob } from './jobs.js';
import {
  contextMiddleware,
  csrfMiddleware,
  errorHandler,
  requestLogMiddleware,
  sessionMiddleware,
} from './middleware.js';
import type { AppContext } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { bankrollRoutes } from './routes/bankroll.js';
import { betsRoutes } from './routes/bets.js';
import { bugsRoutes } from './routes/bugs.js';
import { gamesRoutes } from './routes/games.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { metaRoutes } from './routes/meta.js';
import { usersRoutes } from './routes/users.js';

/**
 * Build the app. A function rather than a module-level singleton so tests can
 * construct one against a test Env with no import-time side effects.
 *
 * Middleware order: request log (outermost) -> context (seeds `now` + `config`)
 * -> session -> csrf -> routes.
 * `now` is captured ONCE per request and threaded through every guard, because
 * Workers freezes `Date.now()` between I/O operations.
 */
export function buildApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.onError(errorHandler());
  app.use('*', requestLogMiddleware());
  app.use('*', contextMiddleware());
  app.use('*', sessionMiddleware());
  app.use('*', csrfMiddleware());

  app.route('/api', metaRoutes());
  app.route('/api/auth', authRoutes());
  app.route('/api/games', gamesRoutes());
  app.route('/api/bets', betsRoutes());
  app.route('/api', bankrollRoutes());
  app.route('/api/leaderboard', leaderboardRoutes());
  app.route('/api/admin', adminRoutes());
  app.route('/api/bugs', bugsRoutes());
  app.route('/api/users', usersRoutes());

  // Anything under /api that no route claimed is OUR 404, never index.html.
  app.notFound((c) => {
    throw new AppError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`);
  });
  return app;
}

const app = buildApp();

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },

  /**
   * Cron dispatch. `event.cron` selects the job (PLAN.md §9.1):
   *   "*\/15 * * * *"    -> refresh
   *   "5-59/15 * * * *"  -> settle
   *   "30 8 * * *"       -> maintenance
   *
   * Each job takes a lease first (job_locks) so two runs can never overlap, and
   * errors are recorded in `job_runs` rather than rethrown, so one bad job cannot
   * take the scheduled handler down.
   */
  async scheduled(controller, env, _ctx): Promise<void> {
    const job = jobForCron(controller.cron);
    if (job === null) {
      console.warn('[cron] no job for expression', controller.cron);
      return;
    }
    try {
      const run = await runJob(env, job, 'cron', nowMs());
      console.warn('[cron]', job, run.status, run.error ?? '');
    } catch (err) {
      // runJob is specified to record errors rather than throw (PLAN.md §9);
      // this is the last line of defence so the scheduled handler never dies.
      console.error('[cron] job crashed outside withJobRun', job, err);
    }
  },
};

export default handler;
