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
 * M9a.
 */

import {
  ESPN_MAX_WARNINGS_RECORDED,
  ODDS_API_BOOKMAKERS,
  SECONDARY_MATCH_WINDOW_MS,
} from './constants.js';
import { parseAmericanPrice, parseLineToTenths } from './espn.js';
import type { ParseWarning } from './espn.js';
import { parseIsoToEpochMs } from './time.js';
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

/* ------------------------------------------------------------------ *
 * Narrowing helpers (the same discipline as espn.ts: unknown in, data out)
 * ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function prop(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A short, safe rendering of a raw feed value for a warning. Never throws. */
function rawText(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      const out: unknown = JSON.stringify(value);
      text = typeof out === 'string' ? out : typeof value;
    } catch {
      text = typeof value;
    }
  }
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

interface OutcomeView {
  readonly name: string;
  readonly price: unknown;
  readonly point: unknown;
}

/** The outcomes of one market node, or null unless it is a well-formed pair. */
function outcomePair(market: unknown): readonly [OutcomeView, OutcomeView] | null {
  const outcomes = prop(market, 'outcomes');
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;
  const views: OutcomeView[] = [];
  for (const o of outcomes) {
    const name = asNonEmptyString(prop(o, 'name'));
    if (name === null) return null;
    views.push({ name, price: prop(o, 'price'), point: prop(o, 'point') });
  }
  const [first, second] = views;
  if (first === undefined || second === undefined) return null;
  return [first, second];
}

/** Book key -> market key -> market node, for one event, in the book's own words. */
function marketsByBook(event: JsonObject): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
  const byBook = new Map<string, Map<string, unknown>>();
  const books = event['bookmakers'];
  if (!Array.isArray(books)) return byBook;
  for (const book of books) {
    const key = asNonEmptyString(prop(book, 'key'));
    if (key === null) continue;
    const markets = prop(book, 'markets');
    if (!Array.isArray(markets)) continue;
    const byKey = byBook.get(key) ?? new Map<string, unknown>();
    for (const market of markets) {
      const mkey = asNonEmptyString(prop(market, 'key'));
      if (mkey !== null && !byKey.has(mkey)) byKey.set(mkey, market);
    }
    byBook.set(key, byKey);
  }
  return byBook;
}

/**
 * The two sides of a team-named market, oriented home/away by full team name.
 * Null (with a note) when an outcome names neither team, or both name the same.
 */
function sidesOf(
  pair: readonly [OutcomeView, OutcomeView],
  home: string,
  away: string,
  market: string,
  book: string,
  notes: string[],
): { readonly home: OutcomeView; readonly away: OutcomeView } | null {
  const [a, b] = pair;
  if (a.name === home && b.name === away) return { home: a, away: b };
  if (a.name === away && b.name === home) return { home: b, away: a };
  if (a.name === b.name) {
    notes.push(`${book} ${market}: both outcomes name "${a.name}"`);
    return null;
  }
  const stranger = a.name !== home && a.name !== away ? a.name : b.name;
  notes.push(`${book} ${market}: outcome "${stranger}" names neither team`);
  return null;
}

function parseSpread(
  node: unknown,
  home: string,
  away: string,
  book: string,
  notes: string[],
): SpreadMarket | null {
  const pair = outcomePair(node);
  if (pair === null) return null;
  const sides = sidesOf(pair, home, away, 'spread', book, notes);
  if (sides === null) return null;
  const homeTenths = parseLineToTenths(sides.home.point);
  const awayTenths = parseLineToTenths(sides.away.point);
  if (homeTenths === null || awayTenths === null) {
    notes.push(
      `${book} spread: unusable point ${rawText(homeTenths === null ? sides.home.point : sides.away.point)}`,
    );
    return null;
  }
  if (homeTenths !== -awayTenths) {
    notes.push(
      `${book} spread: sides do not mirror (${rawText(sides.home.point)}, ${rawText(sides.away.point)})`,
    );
    return null;
  }
  const homePrice = parseAmericanPrice(sides.home.price);
  const awayPrice = parseAmericanPrice(sides.away.price);
  if (homePrice === null || awayPrice === null) {
    notes.push(
      `${book} spread: unusable price ${rawText(homePrice === null ? sides.home.price : sides.away.price)}`,
    );
    return null;
  }
  return { homeTenths, homePrice, awayTenths, awayPrice };
}

function parseTotal(node: unknown, book: string, notes: string[]): TotalMarket | null {
  const pair = outcomePair(node);
  if (pair === null) return null;
  const [a, b] = pair;
  const over = a.name.toLowerCase() === 'over' ? a : b.name.toLowerCase() === 'over' ? b : null;
  const under = a.name.toLowerCase() === 'under' ? a : b.name.toLowerCase() === 'under' ? b : null;
  if (over === null || under === null || over === under) {
    notes.push(`${book} total: outcomes are not Over/Under (${a.name}, ${b.name})`);
    return null;
  }
  const overTenths = parseLineToTenths(over.point);
  const underTenths = parseLineToTenths(under.point);
  if (overTenths === null || underTenths === null) {
    notes.push(
      `${book} total: unusable point ${rawText(overTenths === null ? over.point : under.point)}`,
    );
    return null;
  }
  if (overTenths !== underTenths) {
    notes.push(`${book} total: sides disagree (${rawText(over.point)}, ${rawText(under.point)})`);
    return null;
  }
  const overPrice = parseAmericanPrice(over.price);
  const underPrice = parseAmericanPrice(under.price);
  if (overPrice === null || underPrice === null) {
    notes.push(
      `${book} total: unusable price ${rawText(overPrice === null ? over.price : under.price)}`,
    );
    return null;
  }
  return { tenths: overTenths, overPrice, underPrice };
}

function parseMoneyline(
  node: unknown,
  home: string,
  away: string,
  book: string,
  notes: string[],
): MoneylineMarket | null {
  const pair = outcomePair(node);
  if (pair === null) return null;
  const sides = sidesOf(pair, home, away, 'moneyline', book, notes);
  if (sides === null) return null;
  const homePrice = parseAmericanPrice(sides.home.price);
  const awayPrice = parseAmericanPrice(sides.away.price);
  if (homePrice === null || awayPrice === null) {
    notes.push(
      `${book} moneyline: unusable price ${rawText(homePrice === null ? sides.home.price : sides.away.price)}`,
    );
    return null;
  }
  return { homePrice, awayPrice };
}

/** Diagnostics kept PER MARKET, so a note is attributed to the market it is about. */
interface MarketNotes {
  readonly spread: string[];
  readonly total: string[];
  readonly moneyline: string[];
}

/**
 * The three markets for one event, each chosen INDEPENDENTLY: books in
 * `ODDS_API_BOOKMAKERS` order (never response order), first complete market
 * wins. A book that fails a market is noted and the next book is tried; a book
 * outside the preference list is never consulted.
 */
function chooseMarkets(
  event: JsonObject,
  home: string,
  away: string,
  notes: MarketNotes,
): OddsApiMarkets {
  const byBook = marketsByBook(event);
  let spread: BookedSpread | null = null;
  let total: BookedTotal | null = null;
  let moneyline: BookedMoneyline | null = null;
  for (const book of ODDS_API_BOOKMAKERS) {
    const markets = byBook.get(book);
    if (markets === undefined) continue;
    if (spread === null) {
      const node = markets.get('spreads');
      const parsed = node === undefined ? null : parseSpread(node, home, away, book, notes.spread);
      if (parsed !== null) spread = { ...parsed, book };
    }
    if (total === null) {
      const node = markets.get('totals');
      const parsed = node === undefined ? null : parseTotal(node, book, notes.total);
      if (parsed !== null) total = { ...parsed, book };
    }
    if (moneyline === null) {
      const node = markets.get('h2h');
      const parsed =
        node === undefined ? null : parseMoneyline(node, home, away, book, notes.moneyline);
      if (parsed !== null) moneyline = { ...parsed, book };
    }
    if (spread !== null && total !== null && moneyline !== null) break;
  }
  return { spread, total, moneyline };
}

export function parseOddsApi(payload: unknown, league: League): ParsedOddsApi {
  const collected: ParseWarning[] = [];
  const capped = (): readonly ParseWarning[] => collected.slice(0, ESPN_MAX_WARNINGS_RECORDED);
  if (!Array.isArray(payload)) {
    collected.push({ eventId: null, label: null, reason: 'payload is not an array of events' });
    return { events: [], warnings: capped() };
  }
  const events: OddsApiEvent[] = [];
  for (const raw of payload) {
    const eventId = asNonEmptyString(prop(raw, 'id'));
    const warn = (reason: string, label: string | null = null): void => {
      collected.push({ eventId, label, reason });
    };
    if (!isObject(raw)) {
      warn('event is not an object');
      continue;
    }
    const homeTeam = asNonEmptyString(raw['home_team']);
    const awayTeam = asNonEmptyString(raw['away_team']);
    if (homeTeam === null || awayTeam === null) {
      warn('event has no home_team / away_team');
      continue;
    }
    const label = `${awayTeam} @ ${homeTeam}`;
    if (eventId === null) {
      warn('event has no id', label);
      continue;
    }
    const commenceAt = parseIsoToEpochMs(raw['commence_time']);
    if (commenceAt === null) {
      warn(
        `commence_time is not a parseable ISO timestamp: ${rawText(raw['commence_time'])}`,
        label,
      );
      continue;
    }
    // Market notes are informational (the event survives). A market's notes
    // are recorded only when THAT market ended up empty: a book that failed
    // but was out-voted by the next book is not a problem the operator needs
    // to see, and a note about a market that was filled must not be pinned on
    // one that was not. (M9c's per-book failure counter is where "DraftKings
    // failed every spread this sweep" becomes visible; see PLAN.md §21.6.)
    const notes: MarketNotes = { spread: [], total: [], moneyline: [] };
    const markets = chooseMarkets(raw, homeTeam, awayTeam, notes);
    const dropped = [
      ...(markets.spread === null ? notes.spread : []),
      ...(markets.total === null ? notes.total : []),
      ...(markets.moneyline === null ? notes.moneyline : []),
    ];
    if (dropped.length > 0) warn(dropped.join('; '), label);
    events.push({ eventId, league, commenceAt, homeTeam, awayTeam, markets });
  }
  return { events, warnings: capped() };
}

/* ------------------------------------------------------------------ *
 * Matching (PLAN.md §21.7)
 * ------------------------------------------------------------------ */

/**
 * NFC → strip diacritics → lowercase → strip everything that is not [a-z0-9].
 *
 * MEASURED, and reproduced by `tests/unit/odds-api.spec.ts` against the
 * committed same-date captures (`docs/samples/espn-{nfl,cfb}-scoreboard-2026-09-17..*.json`):
 * 32/32 NFL and 68/75 NCAAF events match on this key alone; the mascot
 * fallback then recovers all five abbreviation misses (73/75), and the two
 * remaining events are neutral-site games the two feeds orient the other way
 * round, refused on purpose (PLAN.md §21.7). It is what makes "San José State
 * Spartans" equal "San Jose State Spartans" and "Louisiana Ragin' Cajuns" equal
 * "Louisiana Ragin Cajuns".
 */
export function normaliseTeamName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The normalised LAST token of a team name — "Minutemen", "Spartans",
 * "Eagles". The whole mascot for "Golden Eagles" is two tokens, but the last
 * token alone is what the six measured mismatches differ in the PREFIX of
 * ("App State" vs "Appalachian State"), so the last token is the discriminator
 * that actually does work here.
 */
export function mascotOf(raw: string): string {
  const tokens = raw.trim().split(/\s+/);
  return normaliseTeamName(tokens[tokens.length - 1] ?? '');
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
  candidates: readonly MatchCandidate[],
  events: readonly OddsApiEvent[],
): MatchOutcome {
  const matched = new Map<string, OddsApiEvent>();
  const claimed = new Set<OddsApiEvent>();
  // A name that normalises to NOTHING has no key: two such names must never
  // "match" each other on the strength of both being empty.
  const key = (league: League, home: string, away: string): string | null => {
    const h = normaliseTeamName(home);
    const a = normaliseTeamName(away);
    return h === '' || a === '' ? null : `${league}|${h}|${a}`;
  };

  // Pass 1 — exact, oriented, per league. First event with the key wins; a
  // duplicate event (same two teams twice) cannot claim a second candidate.
  const byKey = new Map<string, OddsApiEvent>();
  for (const e of events) {
    const k = key(e.league, e.homeTeam, e.awayTeam);
    if (k !== null && !byKey.has(k)) byKey.set(k, e);
  }
  const leftover: MatchCandidate[] = [];
  for (const c of candidates) {
    const k = key(c.league, c.homeName, c.awayName);
    const e = k === null ? undefined : byKey.get(k);
    if (e !== undefined && !claimed.has(e)) {
      matched.set(c.gameId, e);
      claimed.add(e);
    } else {
      leftover.push(c);
    }
  }

  // Pass 2 — mascot fallback, unique in BOTH directions among the unclaimed.
  // Mascots are computed once per side (the comparison is O(leftover ×
  // unclaimed), and every normalisation is a string pass), and an EMPTY mascot
  // never matches anything: two names with no alphanumeric last token would
  // otherwise compare equal.
  const unclaimed = events.filter((e) => !claimed.has(e));
  const cm = new Map(leftover.map((c) => [c, [mascotOf(c.homeName), mascotOf(c.awayName)]]));
  const em = new Map(unclaimed.map((e) => [e, [mascotOf(e.homeTeam), mascotOf(e.awayTeam)]]));
  const near = (c: MatchCandidate, e: OddsApiEvent): boolean =>
    c.league === e.league && Math.abs(c.kickoffAt - e.commenceAt) <= SECONDARY_MATCH_WINDOW_MS;
  const fallbackOk = (c: MatchCandidate, e: OddsApiEvent): boolean => {
    const [ch, ca] = cm.get(c) ?? ['', ''];
    const [eh, ea] = em.get(e) ?? ['', ''];
    return ch !== '' && ca !== '' && ch === eh && ca === ea && near(c, e);
  };
  // The same test with the event's sides the other way round — and, like the
  // fallback, only inside the kickoff window: a swap AND a >90-min move is
  // simply unmatched, not "swapped".
  const swappedOk = (c: MatchCandidate, e: OddsApiEvent): boolean => {
    const [ch, ca] = cm.get(c) ?? ['', ''];
    const [eh, ea] = em.get(e) ?? ['', ''];
    return ch !== '' && ca !== '' && ch === ea && ca === eh && near(c, e);
  };

  const unmatchedGames: string[] = [];
  const swappedCandidates: string[] = [];
  for (const c of leftover) {
    const fits = unclaimed.filter((e) => !claimed.has(e) && fallbackOk(c, e));
    const only = fits.length === 1 ? fits[0] : undefined;
    if (only !== undefined) {
      const rivals = leftover.filter(
        (o) => o !== c && !matched.has(o.gameId) && fallbackOk(o, only),
      );
      if (rivals.length === 0) {
        matched.set(c.gameId, only);
        claimed.add(only);
        continue;
      }
    }
    unmatchedGames.push(c.label);
    if (fits.length === 0 && unclaimed.some((e) => !claimed.has(e) && swappedOk(c, e))) {
      swappedCandidates.push(c.label);
    }
  }

  return {
    matched,
    unmatchedGames,
    unmatchedEvents: events.length - claimed.size,
    swappedCandidates,
  };
}
