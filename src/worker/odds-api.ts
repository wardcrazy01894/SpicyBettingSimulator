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
 * M9c — every function here throws until then.
 */

import type { League } from '../shared/types.js';
import type { OddsApiEvent } from '../shared/odds-api.js';
import type { ParseWarning } from '../shared/espn.js';

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

/** The API's sport keys for our two leagues. */
export const ODDS_API_SPORT_KEY: Readonly<Record<League, string>> = {
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
      readonly league: League;
      readonly events: readonly OddsApiEvent[];
      readonly warnings: readonly ParseWarning[];
      readonly credits: OddsApiCredits;
      readonly fetchedAt: number;
    }
  | {
      readonly ok: false;
      readonly league: League;
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
 * logged, never put in a `ProviderError` message and never echoed in stats.
 * `redactUrl` is what the log path uses.
 */
export function buildOddsUrl(
  _config: OddsApiConfig,
  _league: League,
  _window: SweepWindow,
): string {
  throw new Error('not implemented (M9c: PLAN.md §21.6)');
}

/** `…&apiKey=REDACTED&…`. The only form of the URL that may reach a log or a stat. */
export function redactUrl(_url: string): string {
  throw new Error('not implemented (M9c: PLAN.md §21.6)');
}

/**
 * The one unit of work: one league, one HTTP call, parsed. Does not touch D1,
 * does not decide whether it was allowed to run — the caller claims the credit
 * first (PLAN.md §21.5) and passes the window.
 */
export interface SecondaryOddsProvider {
  readonly name: string;
  fetchOdds(league: League, window: SweepWindow, now: number): Promise<OddsApiResult>;
}

export class TheOddsApiProvider implements SecondaryOddsProvider {
  readonly name = 'odds-api';

  constructor(_config: OddsApiConfig) {
    throw new Error('not implemented (M9c: PLAN.md §21.6)');
  }

  fetchOdds(_league: League, _window: SweepWindow, _now: number): Promise<OddsApiResult> {
    throw new Error('not implemented (M9c: PLAN.md §21.6)');
  }
}

/**
 * Read `x-requests-remaining` / `-used` / `-last`. A header that is missing or
 * not an integer is `null`, NEVER 0 — "the provider stopped sending the header"
 * and "you have no credits left" must not be the same value, because the guard
 * treats them oppositely (`null` leaves the stored balance alone; 0 stops the
 * feature).
 */
export function readCredits(_headers: Headers): OddsApiCredits {
  throw new Error('not implemented (M9c: PLAN.md §21.6)');
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
export function fetchCredits(_config: OddsApiConfig, _now: number): Promise<OddsApiCreditsResult> {
  throw new Error('not implemented (M9c: PLAN.md §21.5)');
}
