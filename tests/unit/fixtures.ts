/**
 * Fixtures for the `unit` project (node environment — `node:fs` is available).
 *
 * These load the REAL captured ESPN payloads from docs/samples/. They are
 * deliberately NOT importable from the `worker` project: workerd has no `fs`,
 * and bundling 1.5 MB of JSON into the test Worker would be silly. The worker
 * project has its own builder at tests/worker/fixtures.ts.
 *
 * Measured properties of the committed files (asserted in espn.spec.ts so a
 * fixture swap can never silently weaken the suite):
 *
 *   espn-nfl-scoreboard.json  — a WEEK query, 16 events
 *     14 STATUS_SCHEDULED, all 14 carry DraftKings odds
 *      2 STATUS_FINAL, neither carries odds
 *     ET date buckets: { 20260909: 1, 20260910: 1, 20260913: 13, 20260914: 1 }
 *
 *   espn-cfb-scoreboard.json  — a WEEK query (NOT one slate), 86 events
 *      2 STATUS_SCHEDULED (both carry odds), 16 in progress, 3 halftime, 65 final
 *      0 of those 84 started/finished events carry odds
 *     ET date buckets: { 20260910: 1, 20260911: 5, 20260912: 80 }
 *     i.e. the Saturday is 93% of the week — relevant to PLAN.md §8.1.
 *
 * The headline fact both files prove: ESPN REMOVES odds the moment a game
 * starts, which is exactly why a bet must snapshot its line at placement.
 */

export interface ScoreboardOverride {
  readonly eventId: string;
  readonly status?: string;
  readonly homeScore?: string;
  readonly awayScore?: string;
  readonly date?: string;
  /** Remove the odds block, to simulate a game that has started. */
  readonly dropOdds?: boolean;
}

/** Raw parsed JSON of docs/samples/espn-nfl-scoreboard.json. */
export function nflScoreboard(): unknown {
  throw new Error('not implemented: M2c');
}

/** Raw parsed JSON of docs/samples/espn-cfb-scoreboard.json. */
export function cfbScoreboard(): unknown {
  throw new Error('not implemented: M2c');
}

/**
 * Deep-clone a sample payload and apply per-event overrides, so a test can say
 * "make event 401872925 FINAL 27-24" without hand-writing 15 KB of JSON.
 */
export function makeScoreboard(
  _base: 'nfl' | 'cfb',
  _overrides: readonly ScoreboardOverride[],
): unknown {
  throw new Error('not implemented: M2c');
}

/** A payload with deliberately broken events, for the defensive-parser tests. */
export function malformedScoreboard(): unknown {
  throw new Error('not implemented: M2c');
}
