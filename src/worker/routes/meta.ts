/**
 * Public routes: /api/health, /api/health/ingest, /api/config, /api/auth/kdf.
 * No auth. `/api/health` touches no DB and is always 200 (the SPA reads it on
 * every page load); `/api/health/ingest` is the uptime monitor's (PLAN.md §24.5).
 */

import { Hono } from 'hono';
import type { ConfigResponse, HealthResponse, KdfParamsResponse } from '../../shared/api-types.js';
import {
  BET_CUTOFF_BUFFER_MS,
  CLIENT_KDF,
  INITIAL_BANKROLL_CENTS,
  KDF_VERSION,
  MAX_PARLAY_LEGS,
  MAX_PAYOUT_CENTS,
  MIN_STAKE_CENTS,
  TEASER_PAYOUTS,
  TEASER_POINTS_TENTHS,
} from '../../shared/constants.js';
import { LEAGUES } from '../../shared/types.js';
import type { EpochMs } from '../../shared/types.js';
import { currentSeasonFor } from '../bankroll.js';
import { readIngestHealth } from '../ingest.js';
import type { IngestHealthReason } from '../ingest.js';
import type { AppContext } from '../middleware.js';

/**
 * `GET /api/health/ingest`'s body (PLAN.md §24.5). Local on purpose: the
 * browser never reads it, so the frozen `api-types.ts` is untouched.
 */
interface IngestHealthBody {
  readonly ok: boolean; // false ⇔ 503
  readonly now: EpochMs;
  readonly lastRefreshOkAt: EpochMs | null;
  readonly parkedTargets: number;
  readonly reasons: readonly IngestHealthReason[];
}

export function metaRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.get('/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      version: c.var.config.appVersion,
      now: c.var.now,
      inviteRequired: c.var.config.inviteRequired,
      bugReportsEnabled: c.var.config.github !== null,
    };
    return c.json(body);
  });

  // The ONE health signal that can see a refresh killed for CPU: the run that
  // died records nothing, so an outside monitor polls this and alerts on any
  // non-200 (PLAN.md §24.5, docs/OPERATIONS.md "Uptime monitor"). One read,
  // nothing written, public and unthrottled like /api/config.
  app.get('/health/ingest', async (c) => {
    const health = await readIngestHealth(c.env, c.var.now);
    const body: IngestHealthBody = {
      ok: health.reasons.length === 0,
      now: c.var.now,
      lastRefreshOkAt: health.lastRefreshOkAt,
      parkedTargets: health.parkedTargets,
      reasons: health.reasons,
    };
    return c.json(body, body.ok ? 200 : 503);
  });

  app.get('/config', async (c) => {
    const [nfl, ncaaf, mlb, ncaab, nba] = await Promise.all([
      currentSeasonFor(c.env, 'nfl', c.var.now),
      currentSeasonFor(c.env, 'ncaaf', c.var.now),
      currentSeasonFor(c.env, 'mlb', c.var.now),
      // ESPN's season year for basketball is the year the season ENDS
      // (2027 for a November 2026 game, PLAN.md §24.2); it is whatever the
      // stored games say, like every other league.
      currentSeasonFor(c.env, 'ncaab', c.var.now),
      currentSeasonFor(c.env, 'nba', c.var.now),
    ]);
    const body: ConfigResponse = {
      leagues: LEAGUES,
      currentSeason: { nfl, ncaaf, mlb, ncaab, nba },
      minStakeCents: MIN_STAKE_CENTS,
      maxParlayLegs: MAX_PARLAY_LEGS,
      cutoffBufferMs: BET_CUTOFF_BUFFER_MS,
      initialBankrollCents: INITIAL_BANKROLL_CENTS,
      maxPayoutCents: MAX_PAYOUT_CENTS,
      teaserPoints: TEASER_POINTS_TENTHS,
      // The whole card, so the slip prices a teaser from SERVER truth. Unlike a
      // parlay there is no per-leg `expected` that would catch a client whose
      // bundled copy of the table had drifted.
      teaserPayouts: TEASER_PAYOUTS,
    };
    return c.json(body);
  });

  // Public and user-independent by design: no enumeration oracle (PLAN.md §10.3).
  // Lives HERE, not in routes/auth.ts: meta routes are mounted first on '/api',
  // so a second '/kdf' handler under '/api/auth' would be unreachable dead code.
  app.get('/auth/kdf', (c) => {
    const body: KdfParamsResponse = {
      version: KDF_VERSION,
      algorithm: CLIENT_KDF.algorithm,
      hash: CLIENT_KDF.hash,
      iterations: CLIENT_KDF.iterations,
      keyLengthBytes: CLIENT_KDF.keyLengthBytes,
      saltPrefix: CLIENT_KDF.saltPrefix,
    };
    return c.json(body);
  });

  return app;
}
