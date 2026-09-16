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

import type { OddsApiConfig } from './odds-api.js';

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
  /** `owner/name` of the GitHub repo that `POST /api/bugs` files issues in. */
  readonly GITHUB_REPO: string;
  /** GitHub REST base, e.g. "https://api.github.com"; a stub host in tests. */
  readonly GITHUB_API_BASE_URL: string;
  /**
   * The Odds API base, e.g. "https://api.the-odds-api.com"; the fixture server
   * in dev and a stub host in tests. Only read when ODDS_API_KEY is set.
   */
  readonly ODDS_API_BASE_URL: string;

  // --- secrets (wrangler secret put) -------------------------------------
  /** Shared signup gate. When unset, signup is open (reported by /api/health). */
  readonly INVITE_CODE?: string;
  /** Salt for hashing client IPs before they are written to auth_throttle. */
  readonly IP_HASH_SALT?: string;
  /**
   * Fine-grained PAT with Issues: read+write on `GITHUB_REPO` only. When unset,
   * bug reporting is OFF: `/api/health` says so and `POST /api/bugs` is 503.
   */
  readonly GITHUB_TOKEN?: string;
  /**
   * The Odds API key (free Starter tier). When unset the secondary odds
   * provider is OFF: no sweep, no candidate scan, no request (PLAN.md §21).
   */
  readonly ODDS_API_KEY?: string;
}

/** Where and how `POST /api/bugs` files issues. `null` = feature off. */
export interface GitHubConfig {
  readonly repo: string;
  readonly apiBaseUrl: string;
  readonly token: string;
}

/** Typed, validated view of the numeric/boolean vars. */
export interface RuntimeConfig {
  readonly espnBaseUrl: string;
  readonly cookieSecure: boolean;
  readonly refreshTargetsPerRun: number;
  readonly settleChunk: number;
  readonly appVersion: string;
  readonly inviteRequired: boolean;
  readonly github: GitHubConfig | null;
  /** The secondary odds provider. `null` = feature off (no `ODDS_API_KEY`). */
  readonly oddsApi: OddsApiConfig | null;
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
    github: readGitHub(env),
    oddsApi: readOddsApiConfig(env),
  };
}

/**
 * Same contract as `readGitHub`: optional, and a half-configuration (key set,
 * base URL missing or malformed) turns the feature OFF with a logged reason
 * rather than 500ing every request. The key itself is never logged.
 */
function readOddsApiConfig(env: Env): OddsApiConfig | null {
  if (typeof env.ODDS_API_KEY !== 'string' || env.ODDS_API_KEY.trim() === '') return null;
  try {
    return {
      apiKey: env.ODDS_API_KEY.trim(),
      baseUrl: requireUrl('ODDS_API_BASE_URL', env.ODDS_API_BASE_URL),
    };
  } catch (err) {
    console.error('[config] ODDS_API_KEY is set but the secondary provider is OFF:', String(err));
    return null;
  }
}

/**
 * The bug-report feature is OPTIONAL, so a broken half-configuration must not
 * take the app down: `readConfig` runs on every request, and `wrangler secret
 * put GITHUB_TOKEN` takes effect immediately against whatever vars are live. If
 * the secret lands before the deploy that ships `GITHUB_REPO`, throwing here
 * would 500 every request including /api/health. Instead the feature stays OFF
 * and the reason is logged, so `wrangler tail` says why the button is missing.
 */
function readGitHub(env: Env): GitHubConfig | null {
  if (typeof env.GITHUB_TOKEN !== 'string' || env.GITHUB_TOKEN.trim() === '') return null;
  try {
    return {
      repo: requireRepo('GITHUB_REPO', env.GITHUB_REPO),
      apiBaseUrl: requireUrl('GITHUB_API_BASE_URL', env.GITHUB_API_BASE_URL),
      token: env.GITHUB_TOKEN.trim(),
    };
  } catch (err) {
    console.error('[config] GITHUB_TOKEN is set but bug reports are OFF:', String(err));
    return null;
  }
}

/**
 * `owner/name`, each a GitHub-legal slug: owners are alphanumerics and hyphens,
 * repo names may also carry `_` and `.`, and neither may START with a dot or a
 * hyphen — which is also what keeps `../x` out of the URL path this is
 * interpolated into.
 */
function requireRepo(name: string, raw: string | undefined): string {
  const value = requireNonEmpty(name, raw);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`config: ${name} must be "owner/name"`);
  }
  return value;
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
