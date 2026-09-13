/**
 * ESPN scoreboard payload -> domain objects. PLAN.md §8.3.
 *
 * PURE and TOTAL. It takes an already-parsed `unknown` (the HTTP lives in
 * src/worker/espn.ts) and it NEVER THROWS on a malformed event: bad events are
 * skipped and a warning is appended. Schema drift must show up as a warning in
 * the admin job view, not as a 500 and not as corrupted rows.
 *
 * Verified payload shape (docs/samples/*.json, captured 2026-09-12):
 *   events[].id | .date | .name | .shortName | .season.{year,type} | .week.number
 *   events[].competitions[0].status.type.{name,state,completed}
 *   events[].competitions[0].competitors[].{homeAway,score,curatedRank,team{...}}
 *   events[].competitions[0].odds[0] (DraftKings, provider.id "100"), present on
 *     SCHEDULED games only — odds are REMOVED once a game starts.
 */

import type { AmericanPrice, Game, GameLines, GameStatus, LineTenths } from './types.js';

export interface ParseWarning {
  readonly eventId: string | null;
  readonly reason: string;
}

export interface ParsedScoreboard {
  readonly games: readonly Game[];
  /** One entry per game that actually had a usable odds block. */
  readonly lines: readonly GameLines[];
  readonly warnings: readonly ParseWarning[];
  /** From the payload root, useful for planning the next ingest target. */
  readonly season: number | null;
  readonly week: number | null;
}

/**
 * Parse a whole scoreboard response.
 * @param payload  the JSON value returned by ESPN (already `JSON.parse`d)
 * @param league   which league we asked for (the payload does not always say)
 * @param fetchedAt epoch ms used as `capturedAt`/`lastSeenAt` for every row
 */
export function parseScoreboard(
  _payload: unknown,
  _league: Game['league'],
  _fetchedAt: number,
): ParsedScoreboard {
  throw new Error('not implemented: M2c');
}

/** Parse one `events[i]`. Returns null (plus a warning) when unusable. */
export function parseEvent(
  _event: unknown,
  _league: Game['league'],
  _fetchedAt: number,
): { readonly game: Game; readonly lines: GameLines | null } | null {
  throw new Error('not implemented: M2c');
}

/**
 * Map ESPN's status to ours, using `state` + `completed` rather than string
 * equality on `name`, so OT/forfeit/unknown future variants degrade safely.
 *   state 'post' && completed        -> 'final'
 *   STATUS_POSTPONED                 -> 'postponed'
 *   STATUS_CANCELED | STATUS_FORFEIT -> 'canceled'
 *   state 'in'                       -> 'in_progress'  (includes STATUS_HALFTIME)
 *   state 'pre'                      -> 'scheduled'
 *   anything else                    -> 'unknown'      (never bettable, never graded)
 */
export function mapEspnStatus(_statusType: unknown): GameStatus {
  throw new Error('not implemented: M2c');
}

/**
 * Pick the odds entry to use: DraftKings (provider.id "100") if present,
 * otherwise the lowest `provider.priority`. Returns null when there is none.
 */
export function selectOddsEntry(_odds: unknown): unknown {
  throw new Error('not implemented: M2c');
}

/**
 * Parse a line string to tenths. Accepts "-3.5", "+3.5", "3.5", "o50.5",
 * "u50.5", "PK"/"pk"/"EVEN" (-> 0) and plain numbers. Returns null if unusable
 * or outside MAX_ABS_LINE_TENTHS.
 */
export function parseLineToTenths(_raw: unknown): LineTenths | null {
  throw new Error('not implemented: M2c');
}

/**
 * Parse an American price. Accepts "-110", "+164", 164, "EVEN" (-> 100).
 * Returns null if unusable or outside [MIN_ABS_AMERICAN_PRICE, MAX_ABS_AMERICAN_PRICE].
 */
export function parseAmericanPrice(_raw: unknown): AmericanPrice | null {
  throw new Error('not implemented: M2c');
}

/** ESPN `score` arrives as a string ("70"). Returns null unless a finite integer. */
export function parseScore(_raw: unknown): number | null {
  throw new Error('not implemented: M2c');
}

/** `curatedRank.current`; 99 and anything outside 1..25 becomes null. */
export function parseRank(_raw: unknown): number | null {
  throw new Error('not implemented: M2c');
}

/** Stable game id: `<league>:<espnEventId>`. */
export function makeGameId(_league: Game['league'], _providerEventId: string): string {
  throw new Error('not implemented: M2c');
}
