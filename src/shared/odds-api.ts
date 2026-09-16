/**
 * The Odds API v4 — PURE parsing and matching. PLAN.md §21.6 / §21.7.
 *
 * Platform-free (CLAUDE.md rule 4): this file takes an already-parsed JSON value
 * and returns data. HTTP, headers and credits live in `src/worker/odds-api.ts`;
 * the split is what makes this testable against the committed
 * `docs/samples/odds-api-*.json` with no network and no Workers runtime, exactly
 * like `src/shared/espn.ts`.
 *
 * TOTALITY, same contract as espn.ts: nothing here throws on malformed input. A
 * bad event is SKIPPED with a warning; a bad market is dropped and the rest of
 * the event survives. A feed that changes shape must degrade to "no fill", never
 * to a 500 in the middle of the refresh job that already wrote the ESPN slate.
 *
 * NO FLOATS REACH A STORED NUMBER. `point` arrives as a JS number (7.5, 53,
 * -3.5) and `price` as an integer; both go through `parseLineToTenths` /
 * `parseAmericanPrice` from espn.ts, which stringify and do digit arithmetic.
 * Anything finer than a tenth is REJECTED, not rounded. eslint bans
 * Math.round/floor/ceil/trunc and parseFloat in this directory.
 *
 * M9a — every function here throws until then.
 */

import type { ParseWarning } from './espn.js';
import type { EpochMs, League, MoneylineMarket, SpreadMarket, TotalMarket } from './types.js';

/* ------------------------------------------------------------------ *
 * Parsed shapes
 * ------------------------------------------------------------------ */

/** A market plus the ONE bookmaker the whole market came from. */
export type BookedSpread = SpreadMarket & { readonly book: string };
export type BookedTotal = TotalMarket & { readonly book: string };
export type BookedMoneyline = MoneylineMarket & { readonly book: string };

/**
 * The three markets chosen for one event. Each is chosen INDEPENDENTLY, by
 * `ODDS_API_BOOKMAKERS` preference, and each is all-or-nothing: a spread with
 * one side missing, or whose two sides do not mirror (`home.point === -away.point`),
 * is dropped rather than half-taken.
 */
export interface OddsApiMarkets {
  readonly spread: BookedSpread | null;
  readonly total: BookedTotal | null;
  readonly moneyline: BookedMoneyline | null;
}

/**
 * One event from the response, normalised. `homeTeam`/`awayTeam` are the RAW
 * full names as the API sends them ("Buffalo Bills", "UMass Minutemen");
 * normalisation for matching happens in `normaliseTeamName`, not here, so a
 * warning can still name the game the way the operator will see it.
 */
export interface OddsApiEvent {
  /** The API's own event id. Shares NOTHING with ESPN's; never used as a key. */
  readonly eventId: string;
  readonly league: League;
  /** `commence_time`, an ISO-8601 UTC instant, via `parseIsoToEpochMs`. */
  readonly commenceAt: EpochMs;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly markets: OddsApiMarkets;
}

export interface ParsedOddsApi {
  readonly events: readonly OddsApiEvent[];
  /** Same cap and rendering as the ESPN parser's; surfaced in job_runs.stats. */
  readonly warnings: readonly ParseWarning[];
}

/**
 * Parse a `GET /v4/sports/{sport}/odds` body.
 *
 * Expects the documented shape: an ARRAY of events, each with `id`,
 * `commence_time`, `home_team`, `away_team` and `bookmakers[].markets[].outcomes[]`.
 * Anything else — an object, a string, null — yields zero events and one
 * structural warning.
 *
 * Per event:
 *   - `commence_time` must parse (`parseIsoToEpochMs`) or the event is skipped;
 *   - `home_team`/`away_team` must be non-empty strings or the event is skipped;
 *   - bookmakers are visited in `ODDS_API_BOOKMAKERS` order, NOT in response
 *     order, and the first book offering a complete market wins that market;
 *   - `spreads` outcomes are named by FULL TEAM NAME and must contain exactly
 *     the event's two names; `totals` outcomes are named "Over"/"Under";
 *     `h2h` outcomes are named by full team name. A name that matches neither
 *     side drops that market with a warning rather than guessing;
 *   - a spread's two `point` values must mirror exactly in TENTHS
 *     (`homeTenths === -awayTenths`); a totals pair's two `point` values must be
 *     equal. A book that disagrees with itself is not a book we quote;
 *   - bounds come from `MAX_ABS_LINE_TENTHS` and
 *     `MIN_ABS_AMERICAN_PRICE`/`MAX_ABS_AMERICAN_PRICE`, as ESPN's do.
 *
 * An event with all three markets null is still RETURNED (with its teams and
 * kickoff), because the sweep needs to distinguish "the API does not carry this
 * game" from "the API carries it with nothing we can use" — the first is a
 * matching miss, the second is a genuine dead end, and they get different stats.
 */
export function parseOddsApi(_payload: unknown, _league: League): ParsedOddsApi {
  throw new Error('not implemented (M9a: PLAN.md §21.6)');
}

/* ------------------------------------------------------------------ *
 * Matching (PLAN.md §21.7)
 * ------------------------------------------------------------------ */

/**
 * NFC → strip diacritics → lowercase → strip everything that is not [a-z0-9].
 *
 * MEASURED LIVE on 2026-09-16 against same-day feeds: 32/32 NFL and 69/75 NCAAF
 * events match on this key alone. The committed ESPN samples are from
 * 2026-09-10..13 and the API samples from 2026-09-17..29, so that number is NOT
 * reproducible from the repo as it stands — M9a captures
 * `docs/samples/espn-{nfl,cfb}-scoreboard-2026-09-19.json` for the SAME dates and
 * `tests/unit/odds-api.spec.ts` re-asserts the counts against those files
 * (PLAN.md §21.7). It is what makes "San José State Spartans" equal "San Jose
 * State Spartans" and "Louisiana Ragin' Cajuns" equal "Louisiana Ragin Cajuns".
 */
export function normaliseTeamName(_raw: string): string {
  throw new Error('not implemented (M9a: PLAN.md §21.7)');
}

/**
 * The normalised LAST token of a team name — "Minutemen", "Spartans",
 * "Eagles". The whole mascot for "Golden Eagles" is two tokens, but the last
 * token alone is what the six measured mismatches differ in the PREFIX of
 * ("App State" vs "Appalachian State"), so the last token is the discriminator
 * that actually does work here.
 */
export function mascotOf(_raw: string): string {
  throw new Error('not implemented (M9a: PLAN.md §21.7)');
}

/** The minimum of a `games` row the matcher is allowed to see. */
export interface MatchCandidate {
  readonly gameId: string;
  readonly league: League;
  readonly kickoffAt: EpochMs;
  /** `games.home_name` / `away_name` — ESPN's `team.displayName`. */
  readonly homeName: string;
  readonly awayName: string;
  /** `"HOU @ TTU"`, for the unmatched list in job_runs.stats. */
  readonly label: string;
}

export interface MatchOutcome {
  /** gameId -> the API event that is the same game. */
  readonly matched: ReadonlyMap<string, OddsApiEvent>;
  /** Labels of candidates nothing matched. Named in the stats, capped by the caller. */
  readonly unmatchedGames: readonly string[];
  /** API events no candidate claimed. Counted only — most are games we do not carry. */
  readonly unmatchedEvents: number;
  /**
   * Candidates whose only plausible event had home and away the OTHER WAY
   * ROUND. Refused, never matched, and counted separately so a neutral-site
   * disagreement between the two feeds is visible instead of silent — taking
   * such a match would invert every spread sign on the card.
   */
  readonly swappedCandidates: readonly string[];
}

/**
 * Match ESPN games to API events. NEVER across leagues.
 *
 * Pass 1 — EXACT, ORIENTED. Key each side on
 * `${normaliseTeamName(home)}|${normaliseTeamName(away)}`; a candidate matches
 * the event with the identical key. Orientation is part of the key on purpose
 * (see `swappedCandidates`).
 *
 * Pass 2 — MASCOT FALLBACK, for the six measured abbreviation differences
 * ("Massachusetts Minutemen" vs "UMass Minutemen"). A candidate matches an
 * unclaimed event only when ALL of:
 *   - same league;
 *   - `|kickoffAt - commenceAt| <= SECONDARY_MATCH_WINDOW_MS` (90 min);
 *   - `mascotOf(home)` and `mascotOf(away)` BOTH equal, in that orientation;
 *   - uniqueness IN BOTH DIRECTIONS: exactly one event satisfies the above for
 *     this candidate, AND exactly one candidate satisfies it for that event.
 *
 * BOTH DIRECTIONS, because one is demonstrably not enough and the counterexample
 * is committed to this repo. In docs/samples/espn-cfb-scoreboard.json, "Southern
 * Miss Golden Eagles @ Auburn Tigers" and "Georgia Southern Eagles @ Clemson
 * Tigers" are both `(eagles, tigers)` and kick off within 90 minutes of each
 * other. If the API feed carries only ONE of the two, a one-directional rule
 * lets the OTHER candidate find "exactly one unclaimed event" and take the wrong
 * game's spread onto a bettable card. Requiring the event to be unambiguous
 * about the candidate as well turns that into a refusal.
 *
 * Mascot frequencies, measured on the API side (the 75-event NCAAF sample in
 * docs/samples/odds-api-ncaaf.json): "Tigers" 5, "Eagles" 5, "Panthers" 4,
 * "Bulldogs" 4, "Bears" 4, "Wildcats" 4, biggest simultaneous kickoff bucket 12.
 * The single mascot is ambiguous; the ORDERED PAIR plus two-way uniqueness is
 * what makes a false positive impossible rather than merely unobserved.
 *
 * Eligibility keeps the candidate set small and is the other half of the
 * argument: only NFL games and top-25 CFB games are ever candidates (§21.2), so
 * pass 2 is choosing among a handful of games, not among a 75-game Saturday.
 *
 * An alias table is deliberately NOT built. All six residual mismatches are
 * UNRANKED CFB teams, which are not eligible for a fill in the first place, and
 * an alias table is a hand-maintained list that goes stale silently. If a RANKED
 * team ever turns up in `unmatchedGames`, that is the signal to add one — and
 * the stat exists so the signal is visible.
 *
 * Total: never throws; an unusable candidate or event simply does not match.
 */
export function matchOddsApiEvents(
  _candidates: readonly MatchCandidate[],
  _events: readonly OddsApiEvent[],
): MatchOutcome {
  throw new Error('not implemented (M9a: PLAN.md §21.7)');
}
