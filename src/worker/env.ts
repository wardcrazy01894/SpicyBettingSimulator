/**
 * Worker bindings, vars and secrets.
 *
 * ADDITIVE ONLY — each track appends its own entries; nobody rewrites this file
 * (PLAN.md §16). Keep it in sync with `wrangler.jsonc` and `.dev.vars.example`.
 *
 * Optionally regenerate the runtime half with `npm run cf-typegen`; this
 * hand-written file is the committed source of truth so CI never depends on
 * codegen.
 */

export interface Env {
  // --- bindings -----------------------------------------------------------
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;

  // --- vars (wrangler.jsonc "vars") --------------------------------------
  /** e.g. "https://site.api.espn.com"; pointed at the fixture server in dev. */
  readonly ESPN_BASE_URL: string;
  /** "true" | "false" — the Secure flag on the session cookie. */
  readonly COOKIE_SECURE: string;
  /** Integer as a string. See Spike S1 before raising above 2. */
  readonly REFRESH_TARGETS_PER_RUN: string;
  /** Integer as a string. See Spike S2 before raising above 20. */
  readonly SETTLE_CHUNK: string;
  readonly APP_VERSION: string;

  // --- secrets (wrangler secret put) -------------------------------------
  /** Shared signup gate. When unset, signup is open (reported by /api/health). */
  readonly INVITE_CODE?: string;
  /** Salt for hashing client IPs before they are written to auth_throttle. */
  readonly IP_HASH_SALT?: string;
}

/** Typed, validated view of the numeric/boolean vars. */
export interface RuntimeConfig {
  readonly espnBaseUrl: string;
  readonly cookieSecure: boolean;
  readonly refreshTargetsPerRun: number;
  readonly settleChunk: number;
  readonly appVersion: string;
  readonly inviteRequired: boolean;
}

/**
 * Parse and bounds-check `env`. Throws at startup on a misconfiguration rather
 * than silently defaulting, EXCEPT for optional secrets.
 */
export function readConfig(_env: Env): RuntimeConfig {
  throw new Error('not implemented: M1');
}
