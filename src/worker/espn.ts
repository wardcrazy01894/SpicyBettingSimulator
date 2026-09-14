/**
 * ESPN HTTP client — the only place that knows ESPN URLs exist.
 * Parsing lives in src/shared/espn.ts (pure, fixture-testable).
 *
 * Endpoints (v1 -- both leagues fetched by US Eastern DATE):
 *   NFL   {base}/apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD&limit=100
 *   NCAAF {base}/apis/site/v2/sports/football/college-football/scoreboard
 *           ?groups=80&limit=300&dates=YYYYMMDD
 *
 * Date targets, not week targets, because:
 *   1. `<season>-<week>` collides between regular season and postseason, so a
 *      week-keyed target makes bowls/playoffs unreachable without also keying
 *      seasontype and teaching the planner the league calendar (PLAN.md §8.2).
 *   2. Refresh granularity: an NFL Sunday and an NFL Thursday do not want the
 *      same cadence, and a week target forces the Sunday cadence onto all five
 *      days -- which costs D1 writes, our scarcest metered resource.
 * The cost is ~4 NFL requests per week instead of 1, against a 50-subrequest
 * budget per invocation. Measured ET buckets for the committed samples:
 *   NFL   {0909:1, 0910:1, 0913:13, 0914:1}
 *   NCAAF {0910:1, 0911:5, 0912:80}
 *
 * NOTE `groups=80` is the FBS group and also covers bowls; Spike S4 confirms the
 * `dates=` bucket timezone and that NFL `dates=` works without `seasontype`.
 */

import { ESPN_TIMEOUT_MS } from '../shared/constants.js';
import { parseScoreboard } from '../shared/espn.js';
import type { League } from '../shared/types.js';
import { ProviderError } from './providers.js';
import type { OddsProvider, ProviderSlate, ScoreProvider, SlateTarget } from './providers.js';
import type { Env } from './env.js';
import { readConfig } from './env.js';

/** The path segment ESPN uses for each of our leagues. */
const LEAGUE_PATH: Readonly<Record<League, string>> = {
  nfl: 'nfl',
  ncaaf: 'college-football',
};

/**
 * Build the absolute URL for a target. Exported so tests can assert it.
 * Must NOT send `seasontype` for a date target -- doing so would filter out
 * postseason games on a date inside the regular-season calendar and vice versa.
 *
 * The query string is assembled by hand rather than through `URLSearchParams`
 * so the parameter ORDER is pinned exactly as PLAN.md §8.1 documents it; that
 * makes the URL assertable, and ESPN is order-insensitive anyway.
 */
/** See the fetch below: ESPN rejects empty/bot-style UAs. */
export const ESPN_USER_AGENT =
  'SpicyBettingSimulator/0.1 (+https://github.com/wardcrazy01894/SpicyBettingSimulator)';

export function buildScoreboardUrl(baseUrl: string, league: League, target: SlateTarget): string {
  if (target.kind !== 'date') {
    // v1 never constructs a week target (PLAN.md §8.2); the union member only
    // exists so a later optimisation needs no schema migration.
    throw new ProviderError(`week targets are not supported in v1 (league ${league})`, false, null);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const path = `${base}/apis/site/v2/sports/football/${LEAGUE_PATH[league]}/scoreboard`;
  return league === 'nfl'
    ? `${path}?dates=${target.dateKey}&limit=100`
    : `${path}?groups=80&limit=300&dates=${target.dateKey}`;
}

/**
 * GET + JSON.parse, with an AbortSignal timeout. Throws ProviderError on
 * non-2xx / timeout / bad JSON. NEVER partially applies anything — the caller
 * gets a complete slate or an exception, so a bad upstream cannot corrupt rows.
 */
export async function fetchScoreboard(
  baseUrl: string,
  league: League,
  target: SlateTarget,
  now: number,
): Promise<ProviderSlate> {
  const url = buildScoreboardUrl(baseUrl, league, target);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      // ESPN's edge returns 403 for an EMPTY User-Agent (Workers send none by
      // default) and for "Mozilla/5.0 (compatible; …)" style bot UAs; a plain
      // product token passes. Verified 2026-09-14 from the deployed Worker.
      headers: { accept: 'application/json', 'user-agent': ESPN_USER_AGENT },
      // A hung upstream must not burn the job's wall clock; the lease TTL is
      // only 5 minutes and two targets share one invocation (PLAN.md §14.8).
      signal: AbortSignal.timeout(ESPN_TIMEOUT_MS),
    });
  } catch (err) {
    // An abort, a DNS failure and a TLS failure are all retryable: none of them
    // says anything about the shape of the data.
    throw new ProviderError(`espn: request failed (${describe(err)})`, true, null);
  }

  if (!response.ok) {
    // 5xx and 429 are transient; a 4xx probably means we built a bad URL, but we
    // still back off rather than hammering.
    throw new ProviderError(
      `espn: HTTP ${String(response.status)} for ${url}`,
      response.status >= 500 || response.status === 429,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new ProviderError(`espn: response was not JSON (${describe(err)})`, true, 200);
  }

  // Parse FULLY into memory before anyone writes a row. The parser is total: it
  // skips malformed events with a warning rather than throwing (PLAN.md §8.3).
  const parsed = parseScoreboard(payload, league, now);
  return {
    games: parsed.games,
    lines: parsed.lines,
    warnings: parsed.warnings,
    fetchedAt: now,
    season: parsed.season,
    week: parsed.week,
  };
}

/** A short, safe rendering of a thrown value for an error message. */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name === '' ? 'Error' : err.name;
    return `${name}: ${err.message}`.slice(0, 200);
  }
  return typeof err;
}

/** The v1 provider. Satisfies both interfaces from a single response. */
export class EspnProvider implements ScoreProvider, OddsProvider {
  readonly name = 'espn';

  readonly #baseUrl: string;
  readonly #now: number | null;

  /**
   * `now` pins `ProviderSlate.fetchedAt` to the job's single captured clock
   * (Workers freezes `Date.now()` between I/O anyway, but a job must not read it
   * twice). It is only advisory: `upsertSlate` stamps every row from the `now`
   * it is handed, never from the slate.
   */
  constructor(env: Env, now?: number) {
    // `readConfig` validates and normalises (no trailing slash); a broken
    // ESPN_BASE_URL must fail loudly at construction, not silently at fetch.
    this.#baseUrl = readConfig(env).espnBaseUrl;
    this.#now = now ?? null;
  }

  fetchSlate(league: League, target: SlateTarget): Promise<ProviderSlate> {
    return fetchScoreboard(this.#baseUrl, league, target, this.#now ?? Date.now());
  }

  async fetchLines(
    league: League,
    target: SlateTarget,
  ): Promise<{
    readonly lines: ProviderSlate['lines'];
    readonly warnings: ProviderSlate['warnings'];
    readonly fetchedAt: number;
  }> {
    // ESPN satisfies both interfaces from one response; a dedicated odds feed
    // would implement only this half and be composed with a ScoreProvider.
    const slate = await this.fetchSlate(league, target);
    return { lines: slate.lines, warnings: slate.warnings, fetchedAt: slate.fetchedAt };
  }
}
