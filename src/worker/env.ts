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
export function readConfig(env: Env): RuntimeConfig {
  return {
    espnBaseUrl: requireUrl('ESPN_BASE_URL', env.ESPN_BASE_URL),
    cookieSecure: requireBool('COOKIE_SECURE', env.COOKIE_SECURE),
    refreshTargetsPerRun: requireInt('REFRESH_TARGETS_PER_RUN', env.REFRESH_TARGETS_PER_RUN, 1, 10),
    settleChunk: requireInt('SETTLE_CHUNK', env.SETTLE_CHUNK, 1, 100),
    appVersion: requireNonEmpty('APP_VERSION', env.APP_VERSION),
    inviteRequired: typeof env.INVITE_CODE === 'string' && env.INVITE_CODE.length > 0,
  };
}

function requireNonEmpty(name: string, raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`config: ${name} must be set`);
  }
  return raw.trim();
}

function requireUrl(name: string, raw: string | undefined): string {
  const value = requireNonEmpty(name, raw);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`config: ${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`config: ${name} must be http(s)`);
  }
  // Normalised without a trailing slash so callers can append paths.
  return value.replace(/\/+$/, '');
}

function requireBool(name: string, raw: string | undefined): boolean {
  const value = requireNonEmpty(name, raw).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`config: ${name} must be "true" or "false"`);
}

function requireInt(name: string, raw: string | undefined, min: number, max: number): number {
  const value = requireNonEmpty(name, raw);
  if (!/^\d+$/.test(value)) throw new Error(`config: ${name} must be an integer`);
  const n = Number(value);
  if (n < min || n > max)
    throw new Error(`config: ${name} must be between ${String(min)} and ${String(max)}`);
  return n;
}
