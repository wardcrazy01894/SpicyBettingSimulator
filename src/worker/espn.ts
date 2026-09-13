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

import type { League } from '../shared/types.js';
import type { OddsProvider, ProviderSlate, ScoreProvider, SlateTarget } from './providers.js';
import type { Env } from './env.js';

/**
 * Build the absolute URL for a target. Exported so tests can assert it.
 * Must NOT send `seasontype` for a date target -- doing so would filter out
 * postseason games on a date inside the regular-season calendar and vice versa.
 */
export function buildScoreboardUrl(
  _baseUrl: string,
  _league: League,
  _target: SlateTarget,
): string {
  throw new Error('not implemented: M4');
}

/**
 * GET + JSON.parse, with an AbortSignal timeout. Throws ProviderError on
 * non-2xx / timeout / bad JSON. NEVER partially applies anything — the caller
 * gets a complete slate or an exception, so a bad upstream cannot corrupt rows.
 */
export function fetchScoreboard(
  _baseUrl: string,
  _league: League,
  _target: SlateTarget,
  _now: number,
): Promise<ProviderSlate> {
  throw new Error('not implemented: M4');
}

/** The v1 provider. Satisfies both interfaces from a single response. */
export class EspnProvider implements ScoreProvider, OddsProvider {
  readonly name = 'espn';

  constructor(_env: Env) {
    throw new Error('not implemented: M4');
  }

  fetchSlate(_league: League, _target: SlateTarget): Promise<ProviderSlate> {
    throw new Error('not implemented: M4');
  }

  fetchLines(
    _league: League,
    _target: SlateTarget,
  ): Promise<{
    readonly lines: ProviderSlate['lines'];
    readonly warnings: ProviderSlate['warnings'];
    readonly fetchedAt: number;
  }> {
    throw new Error('not implemented: M4');
  }
}
