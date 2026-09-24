/**
 * The Odds API v4 HTTP client — the only place that knows the API's URLs and
 * credit headers exist. Parsing and matching are pure and live in
 * `src/shared/odds-api.ts`. PLAN.md §21.6.
 *
 * Endpoint (one per league sweep):
 *   {base}/v4/sports/{americanfootball_nfl|americanfootball_ncaaf}/odds
 *     ?apiKey=…&bookmakers=draftkings,fanduel,betmgm,betrivers,bovada
 *     &markets=spreads,totals,h2h&oddsFormat=american&dateFormat=iso
 *     &commenceTimeFrom=…&commenceTimeTo=…
 *
 * Probe endpoint (FREE — `x-requests-last: 0`, verified twice on 2026-09-16):
 *   {base}/v4/sports?apiKey=…      -> `fetchCredits`, the budget probe
 *
 * COST, measured 2026-09-16 from `x-requests-last`: markets × regions = 3 × 1.
 * A `bookmakers=` list of up to 10 keys counts as ONE region, so asking five
 * named books costs the same three credits as `regions=us` while cutting the
 * NCAAF body from 320 KB to 197 KB. `commenceTimeFrom/To` bound the request to
 * `boardWindowEnd(league, now)` — the board window, §22 — and cost nothing.
 *
 * WHY NOT `OddsProvider` FROM providers.ts. That interface is
 * `fetchLines(league, target: SlateTarget) -> GameLines[]`, and neither half
 * fits:
 *   - there is no `SlateTarget` here. The API is keyed by league and a time
 *     RANGE, not by an ET calendar date; forcing a date target would either
 *     throw away the "one call fills every game in the league" property or spend
 *     three credits per date.
 *   - it cannot return `GameLines[]`, because a `GameLines.gameId` is OUR id and
 *     producing one needs the `games` table. An HTTP adapter that reads D1 to
 *     shape its return value is not an adapter.
 * So this file declares its own, smaller interface. `providers.ts` keeps
 * describing the SLATE providers; PLAN §2.4 records the split.
 *
 * NEVER THROWS OUT. Every failure is a value (`OddsApiResult`), because a sweep
 * runs in the same invocation as an ESPN ingest that has already written rows
 * (`ingestTarget` isolates its own errors the same way) and a 401 from a
 * revoked key must not turn a good refresh run into a failed one.
 *
 * M9c.
 */

import { ODDS_API_BOOKMAKERS, ODDS_API_MARKETS, ODDS_API_TIMEOUT_MS } from '../shared/constants.js';
import type { ParseWarning } from '../shared/espn.js';
import { parseOddsApi } from '../shared/odds-api.js';
import type { OddsApiEvent } from '../shared/odds-api.js';
import type { SecondaryLeague } from '../shared/constants.js';

/**
 * Validated config. `readConfig(env).oddsApi` (src/worker/env.ts) is the ONE
 * accessor; `null` means the feature is OFF. There is no `readOddsApi` — an
 * earlier draft named one, and two ways to read the same env var is how one of
 * them stops validating.
 */
export interface OddsApiConfig {
  /** `ODDS_API_KEY`. Query-parameter auth; never logged, never in an error string. */
  readonly apiKey: string;
  /** `ODDS_API_BASE_URL`, normalised without a trailing slash. */
  readonly baseUrl: string;
}

/**
 * The API's sport keys for the leagues the secondary may sweep. Keyed by
 * `SecondaryLeague`: MLB has no key, so sweeping it is a compile error
 * (PLAN.md §23.10).
 */
export const ODDS_API_SPORT_KEY: Readonly<Record<SecondaryLeague, string>> = {
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
};

/**
 * Sent on every request. Unlike ESPN's, this User-Agent is NOT load-bearing —
 * the API authenticates on `apiKey` and was observed to answer a bare `curl`
 * — but it is set anyway so the provider can identify (and rate-limit) us
 * precisely rather than lumping us in with an anonymous pool.
 */
export const ODDS_API_USER_AGENT =
  'SpicyBettingSimulator/0.1 (+https://github.com/wardcrazy01894/SpicyBettingSimulator)';

/** The credit headers every response carries. */
export interface OddsApiCredits {
  /** `x-requests-remaining`. The AUTHORITY for the budget guard. */
  readonly remaining: number | null;
  /** `x-requests-used`. Informational; recorded in stats. */
  readonly used: number | null;
  /** `x-requests-last` — what THIS call cost. Should equal ODDS_API_COST_PER_SWEEP. */
  readonly last: number | null;
}

/**
 * Why a sweep produced nothing. Each maps to a different durable reaction, and
 * the mapping is the whole point of not using exceptions here:
 *
 *   'unauthorized'  401/403 — key revoked or wrong. Feature OFF for this run,
 *                   one warning, budget row untouched. Do NOT cool down: a
 *                   cooldown would hide a config error behind a timer.
 *   'rate_limited'  429 — set `cooldown_until = now + ODDS_API_COOLDOWN_MS`.
 *   'unavailable'   5xx, timeout, DNS/TLS — same cooldown. The pre-debited
 *                   credit is NOT refunded: we cannot know whether the provider
 *                   counted it, and over-counting is the safe direction.
 *   'malformed'     2xx whose body is not JSON, or not an array. Cooldown, and
 *                   a warning loud enough to notice a schema change.
 */
export type OddsApiFailureKind = 'unauthorized' | 'rate_limited' | 'unavailable' | 'malformed';

export type OddsApiResult =
  | {
      readonly ok: true;
      readonly league: SecondaryLeague;
      readonly events: readonly OddsApiEvent[];
      readonly warnings: readonly ParseWarning[];
      readonly credits: OddsApiCredits;
      readonly fetchedAt: number;
    }
  | {
      readonly ok: false;
      readonly league: SecondaryLeague;
      readonly kind: OddsApiFailureKind;
      /** HTTP status when there was one. Null for a timeout or a transport error. */
      readonly status: number | null;
      /** Short, safe text. NEVER contains the api key or a stack. */
      readonly error: string;
      /** Headers are read even on a non-2xx — a 429 still tells us the balance. */
      readonly credits: OddsApiCredits;
    };

/**
 * What the caller wants covered. Bounds the payload; costs no extra credits.
 *
 * It is the SAME window the board and the ingest planner use —
 * `boardWindowEnd(league, now)` (PLAN.md §22) — so the sweep can never pay for
 * events that no candidate could match. There is no separate secondary horizon
 * constant, and adding one would immediately be a second definition of "what the
 * app shows".
 */
export interface SweepWindow {
  /** `commenceTimeFrom`, ISO seconds, UTC. In practice the run's `now`. */
  readonly fromAt: number;
  /** `commenceTimeTo`, ISO seconds, UTC: `boardWindowEnd(league, now)`. */
  readonly toAt: number;
}

/**
 * Build the absolute URL. Exported so a test can assert the parameter list
 * WITHOUT the key: the returned string CONTAINS the api key, so it must never be
 * logged, never put in an error message and never echoed in stats. Nothing in
 * this module logs a URL at all; `redactUrl` exists for anything that ever does.
 */
export function buildOddsUrl(
  config: OddsApiConfig,
  league: SecondaryLeague,
  window: SweepWindow,
): string {
  const url = new URL(`${config.baseUrl}/v4/sports/${ODDS_API_SPORT_KEY[league]}/odds`);
  url.searchParams.set('apiKey', config.apiKey);
  url.searchParams.set('bookmakers', ODDS_API_BOOKMAKERS.join(','));
  url.searchParams.set('markets', ODDS_API_MARKETS.join(','));
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('commenceTimeFrom', isoSeconds(window.fromAt));
  url.searchParams.set('commenceTimeTo', isoSeconds(window.toAt));
  return url.toString();
}

/** ISO-8601 to the second, UTC — the API rejects fractional seconds. */
function isoSeconds(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `…&apiKey=REDACTED&…`. The only form of the URL that may reach a log or a stat. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]apiKey=)[^&]*/g, '$1REDACTED');
}

/**
 * The one unit of work: one league, one HTTP call, parsed. Does not touch D1,
 * does not decide whether it was allowed to run — the caller claims the credit
 * first (PLAN.md §21.5) and passes the window.
 */
export interface SecondaryOddsProvider {
  readonly name: string;
  fetchOdds(league: SecondaryLeague, window: SweepWindow, now: number): Promise<OddsApiResult>;
}

export class TheOddsApiProvider implements SecondaryOddsProvider {
  readonly name = 'odds-api';
  readonly #config: OddsApiConfig;

  constructor(config: OddsApiConfig) {
    this.#config = config;
  }

  async fetchOdds(
    league: SecondaryLeague,
    window: SweepWindow,
    now: number,
  ): Promise<OddsApiResult> {
    const url = buildOddsUrl(this.#config, league, window);
    const outcome = await request(url, this.#config.apiKey);
    if (!outcome.ok) return { ok: false, league, ...outcome.failure };
    if (!Array.isArray(outcome.body)) {
      // The schema-drift alarm: a 2xx that is not the documented array.
      return {
        ok: false,
        league,
        kind: 'malformed',
        status: 200,
        error: 'body is not an array of events',
        credits: outcome.credits,
      };
    }
    const parsed = parseOddsApi(outcome.body, league);
    return {
      ok: true,
      league,
      events: parsed.events,
      warnings: parsed.warnings,
      credits: outcome.credits,
      fetchedAt: now,
    };
  }
}

/* ------------------------------------------------------------------ *
 * The one HTTP path, shared by the sweep and the probe. Never throws.
 * ------------------------------------------------------------------ */

interface Failure {
  readonly kind: OddsApiFailureKind;
  readonly status: number | null;
  readonly error: string;
  readonly credits: OddsApiCredits;
}

type RequestOutcome =
  | { readonly ok: true; readonly body: unknown; readonly credits: OddsApiCredits }
  | { readonly ok: false; readonly failure: Failure };

const NO_CREDITS: OddsApiCredits = { remaining: null, used: null, last: null };

/** A short, safe rendering of a thrown value: no stack, and never the api key. */
function safeError(err: unknown, apiKey: string): string {
  const text =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : typeof err;
  return text.split(apiKey).join('REDACTED').slice(0, 200);
}

async function request(url: string, apiKey: string): Promise<RequestOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': ODDS_API_USER_AGENT },
      signal: AbortSignal.timeout(ODDS_API_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'unavailable',
        status: null,
        error: safeError(err, apiKey),
        credits: NO_CREDITS,
      },
    };
  }
  // Headers are read even on a non-2xx: a 429 still tells us the balance.
  const credits = readCredits(res.headers);
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      failure: {
        kind: 'unauthorized',
        status: res.status,
        error: `HTTP ${String(res.status)}`,
        credits,
      },
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      failure: { kind: 'rate_limited', status: 429, error: 'HTTP 429', credits },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      failure: {
        kind: 'unavailable',
        status: res.status,
        error: `HTTP ${String(res.status)}`,
        credits,
      },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'malformed',
        status: res.status,
        error: `body is not JSON: ${safeError(err, apiKey)}`,
        credits,
      },
    };
  }
  return { ok: true, body, credits };
}

/**
 * Read `x-requests-remaining` / `-used` / `-last`. A header that is missing or
 * not an integer is `null`, NEVER 0 — "the provider stopped sending the header"
 * and "you have no credits left" must not be the same value, because the guard
 * treats them oppositely (`null` leaves the stored balance alone; 0 stops the
 * feature).
 */
export function readCredits(headers: Headers): OddsApiCredits {
  const read = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || !/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : null;
  };
  return {
    remaining: read('x-requests-remaining'),
    used: read('x-requests-used'),
    last: read('x-requests-last'),
  };
}

/* ------------------------------------------------------------------ *
 * The FREE credit probe (PLAN.md §21.5, spike S5 — RESOLVED)
 * ------------------------------------------------------------------ */

/** `GET /v4/sports`. The probe endpoint; no sport key, no markets, no cost. */
export const ODDS_API_SPORTS_PATH = '/v4/sports';

export type OddsApiCreditsResult =
  | { readonly ok: true; readonly credits: OddsApiCredits; readonly fetchedAt: number }
  | {
      readonly ok: false;
      readonly kind: OddsApiFailureKind;
      readonly status: number | null;
      readonly error: string;
      readonly credits: OddsApiCredits;
    };

/**
 * Ask the provider what the balance is, for FREE.
 *
 * MEASURED against the live API on 2026-09-16, twice: `GET /v4/sports?apiKey=…`
 * answers 200 with `x-requests-last: 0` and both `x-requests-used` and
 * `x-requests-remaining` present. So learning the balance costs nothing, which
 * is what makes two things possible:
 *
 *   (a) THE RESET PROBE. While `ODDS_API_CREDIT_RESERVE` is blocking sweeps we
 *       would otherwise never make another request and never notice the monthly
 *       reset. One probe per `ODDS_API_BUDGET_PROBE_MS` fixes that — and,
 *       because it is free, its claim `UPDATE` MUST NOT decrement
 *       `remaining_credits`; it writes `checked_at`, `last_attempt_at` and
 *       `updated_at` only. Spending three credits to learn the balance was the
 *       previous design and is now simply wrong.
 *   (b) UN-DEBITING A FAILED SWEEP. A sweep debits pessimistically before the
 *       request; after a 5xx or a timeout we do not know whether the provider
 *       counted it. A probe right afterwards replaces the guess with the
 *       provider's own number, for free, so an outage no longer burns the month.
 *
 * Failures are values, never exceptions, exactly as `fetchOdds`'s are — a probe
 * that cannot reach the provider must not fail the refresh run around it.
 */
export async function fetchCredits(
  config: OddsApiConfig,
  now: number,
): Promise<OddsApiCreditsResult> {
  const url = new URL(`${config.baseUrl}${ODDS_API_SPORTS_PATH}`);
  url.searchParams.set('apiKey', config.apiKey);
  const outcome = await request(url.toString(), config.apiKey);
  if (!outcome.ok) return { ok: false, ...outcome.failure };
  return { ok: true, credits: outcome.credits, fetchedAt: now };
}
