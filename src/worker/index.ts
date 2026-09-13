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
 */

import type { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppContext } from './middleware.js';

/**
 * Build the app. A function rather than a module-level singleton so tests can
 * construct one against a test Env with no import-time side effects.
 *
 * Middleware order: context (seeds `now` + `config`) -> session -> csrf -> routes.
 * `now` is captured ONCE per request and threaded through every guard, because
 * Workers freezes `Date.now()` between I/O operations.
 */
export function buildApp(): Hono<AppContext> {
  throw new Error('not implemented: M1');
}

const handler: ExportedHandler<Env> = {
  fetch(_request, _env, _ctx): Promise<Response> {
    throw new Error('not implemented: M1');
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
  scheduled(_controller, _env, _ctx): Promise<void> {
    throw new Error('not implemented: M1');
  },
};

export default handler;
