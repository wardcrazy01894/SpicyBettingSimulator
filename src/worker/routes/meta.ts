/** Public routes: /api/health, /api/config, /api/auth/kdf. No auth, no DB for health. */

import { Hono } from 'hono';
import type { ConfigResponse, HealthResponse } from '../../shared/api-types.js';
import {
  BET_CUTOFF_BUFFER_MS,
  CLIENT_KDF,
  INITIAL_BANKROLL_CENTS,
  KDF_VERSION,
  MAX_PARLAY_LEGS,
  MAX_PAYOUT_CENTS,
  MIN_STAKE_CENTS,
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
      currentSeasonFor(c.env, 'nfl'),
      currentSeasonFor(c.env, 'ncaaf'),
    ]);
    const body: ConfigResponse = {
      leagues: LEAGUES,
      currentSeason: { nfl, ncaaf },
      minStakeCents: MIN_STAKE_CENTS,
      maxParlayLegs: MAX_PARLAY_LEGS,
      cutoffBufferMs: BET_CUTOFF_BUFFER_MS,
      initialBankrollCents: INITIAL_BANKROLL_CENTS,
      maxPayoutCents: MAX_PAYOUT_CENTS,
    };
    return c.json(body);
  });

  // Public and user-independent by design: no enumeration oracle (PLAN.md §10.3).
  app.get('/auth/kdf', (c) =>
    c.json({
      version: KDF_VERSION,
      algorithm: CLIENT_KDF.algorithm,
      hash: CLIENT_KDF.hash,
      iterations: CLIENT_KDF.iterations,
      keyLengthBytes: CLIENT_KDF.keyLengthBytes,
      saltPrefix: CLIENT_KDF.saltPrefix,
    }),
  );

  return app;
}
