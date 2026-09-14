/** Public routes: /api/health, /api/config, /api/auth/kdf. No auth, no DB for health. */

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
import { currentSeasonFor } from '../bankroll.js';
import type { AppContext } from '../middleware.js';

export function metaRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.get('/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      version: c.var.config.appVersion,
      now: c.var.now,
      inviteRequired: c.var.config.inviteRequired,
    };
    return c.json(body);
  });

  app.get('/config', async (c) => {
    const [nfl, ncaaf] = await Promise.all([
      currentSeasonFor(c.env, 'nfl', c.var.now),
      currentSeasonFor(c.env, 'ncaaf', c.var.now),
    ]);
    const body: ConfigResponse = {
      leagues: LEAGUES,
      currentSeason: { nfl, ncaaf },
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
