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
 *
 * NO FLOAT EVER TOUCHES A LINE OR A PRICE. "-3.5" becomes -35 by string
 * surgery on its digits, not by `Number(raw) * 10` (PLAN.md §5, CLAUDE.md
 * convention 2); `Math.round/floor/ceil/trunc` and `parseFloat` are
 * eslint-banned in this file, and nothing here rounds anything.
 */

import {
  ESPN_DRAFTKINGS_PROVIDER_ID,
  ESPN_MAX_WARNINGS_RECORDED,
  MAX_ABS_AMERICAN_PRICE,
  MAX_ABS_LINE_TENTHS,
  MIN_ABS_AMERICAN_PRICE,
} from './constants.js';
import { parseIsoToEpochMs } from './time.js';
import type {
  AmericanPrice,
  Game,
  GameLines,
  GameStatus,
  GameTeam,
  LineTenths,
  MoneylineMarket,
  SpreadMarket,
  TotalMarket,
} from './types.js';

export interface ParseWarning {
  readonly eventId: string | null;
  /**
   * The matchup as ESPN abbreviates it ("HOU @ TTU"), so an operator reading
   * `GET /api/admin/jobs` does not have to look the event id up. Null for a
   * structural warning raised before the teams could be parsed.
   */
  readonly label: string | null;
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

/* ------------------------------------------------------------------ *
 * Narrowing helpers. Everything below walks `unknown` and gives up
 * quietly; nothing in this file may throw.
 * ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One property of a value that may not be an object at all. */
function prop(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A string OR a number rendered as one — ESPN is inconsistent about ids. */
function asIdString(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return asString(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asIntegerNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n === null || !Number.isInteger(n) ? null : n;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * Scalars
 * ------------------------------------------------------------------ */

/** Lines that mean "no points either way". */
const PICKEM_TOKENS = new Set(['PK', 'PICK', "PICK'EM", 'PICKEM', 'EVEN', 'EV']);
/** Price tokens that mean +100. "PK" is deliberately NOT one of them. */
const EVEN_PRICE_TOKENS = new Set(['EVEN', 'EV']);
/**
 * The book has PULLED the market. DraftKings marks every field of a suspended
 * market with the literal string "OFF" (line and price alike; `close` and
 * `open` alike), typically over an injury or QB question, weather, or a number
 * under review. ESPN passes it through verbatim and says nothing about why.
 */
const OFF_BOARD_TOKEN = 'OFF';

function isOffBoard(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim().toUpperCase() === OFF_BOARD_TOKEN;
}

/** `-3.5` / `o50.5` / `+7` etc., already stripped of any over/under prefix. */
const SIGNED_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const SIGNED_INTEGER = /^([+-]?)(\d+)$/;

/**
 * Parse a line string to tenths. Accepts "-3.5", "+3.5", "3.5", "o50.5",
 * "u50.5", "PK"/"pk"/"EVEN" (-> 0) and plain numbers. Returns null if unusable
 * or outside MAX_ABS_LINE_TENTHS.
 *
 * A number input is stringified first (`String(-3.5)` === "-3.5") so the tenths
 * come out of digit arithmetic, keeping this on the same side of the line as
 * the rest of the money code (CLAUDE.md convention 2). Anything with more
 * precision than a tenth (".55") is REJECTED rather than rounded — this layer
 * is not allowed to round, and a real book never posts one.
 */
export function parseLineToTenths(raw: unknown): LineTenths | null {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    return null;
  }
  if (text === '') return null;

  const upper = text.toUpperCase();
  if (PICKEM_TOKENS.has(upper)) return 0;

  // Totals arrive prefixed: "o50.5" / "u50.5". Both are the same number; the
  // over/under sense is carried by which market slot the value lands in.
  const body = /^[OU]/.test(upper) ? text.slice(1).trim() : text;

  const match = SIGNED_DECIMAL.exec(body);
  if (match === null) return null;
  const [, sign = '', whole = '', frac] = match;
  if (whole.length > 6) return null; // absurd; also keeps Number() exact

  let tenthsDigit = 0;
  if (frac !== undefined && frac !== '') {
    // Only one tenth of precision survives; trailing zeros are fine ("3.50").
    const first = frac.slice(0, 1);
    const rest = frac.slice(1);
    if (rest !== '' && /[^0]/.test(rest)) return null;
    tenthsDigit = Number(first);
  }

  const magnitude = Number(whole) * 10 + tenthsDigit;
  if (magnitude > MAX_ABS_LINE_TENTHS) return null;
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Parse an American price. Accepts "-110", "+164", 164, "EVEN" (-> 100).
 * Returns null if unusable or outside [MIN_ABS_AMERICAN_PRICE, MAX_ABS_AMERICAN_PRICE].
 *
 * "EVEN"/"EV" mean even money, i.e. risk 100 to win 100, i.e. **+100**.
 */
export function parseAmericanPrice(raw: unknown): AmericanPrice | null {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    return null;
  }
  if (text === '') return null;

  if (EVEN_PRICE_TOKENS.has(text.toUpperCase())) return 100;

  const match = SIGNED_INTEGER.exec(text);
  if (match === null) return null;
  const [, sign = '', digits = ''] = match;
  if (digits.length > 7) return null;
  const magnitude = Number(digits);
  if (magnitude < MIN_ABS_AMERICAN_PRICE || magnitude > MAX_ABS_AMERICAN_PRICE) return null;
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * ESPN `score` arrives as a string ("70"). Returns null unless a finite integer.
 *
 * A pre-game score is the STRING "0", not an absent field, so `Number(x) || null`
 * would map a genuine 0-0 scoreline to null and make a 0-0 final permanently
 * ungradeable. PLAN.md §8.3.
 */
export function parseScore(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return asIntegerNumber(raw);
}

/**
 * `curatedRank.current`; 99 and anything outside 1..25 becomes null.
 *
 * Accepts either the bare `current` value or the whole `curatedRank` object, so
 * neither call site can get the nesting subtly wrong.
 */
export function parseRank(raw: unknown): number | null {
  const value = isObject(raw) ? raw['current'] : raw;
  const n = asIntegerNumber(value);
  if (n === null || n < 1 || n > 25) return null;
  return n;
}

/** Stable game id: `<league>:<espnEventId>`. */
export function makeGameId(league: Game['league'], providerEventId: string): string {
  return `${league}:${providerEventId}`;
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

const CANCELED_NAMES = new Set(['STATUS_CANCELED', 'STATUS_CANCELLED', 'STATUS_FORFEIT']);
const POSTPONED_NAMES = new Set(['STATUS_POSTPONED', 'STATUS_DELAYED', 'STATUS_SUSPENDED']);

/**
 * Map ESPN's status to ours, using `state` + `completed` rather than string
 * equality on `name`, so OT/forfeit/unknown future variants degrade safely.
 *   STATUS_POSTPONED | STATUS_SUSPENDED | STATUS_DELAYED -> 'postponed'
 *     (a rain delay that resumes flips back to in_progress on the next refresh;
 *      §7.5's 7-day auto-void is harmless for a resumed game)
 *   STATUS_CANCELED | STATUS_CANCELLED | STATUS_FORFEIT  -> 'canceled'
 *   state 'post' && completed            -> 'final'
 *   state 'in'                           -> 'in_progress'  (includes STATUS_HALFTIME)
 *   state 'pre'                          -> 'scheduled'
 *   anything else                        -> 'unknown'      (never bettable, never graded)
 *
 * DELIBERATE DEVIATION FROM §8.3's ORDERING: the plan lists the `final` rule
 * first. We check the two "terminal but never played" names FIRST, because if
 * ESPN ever reported `completed: true` alongside STATUS_CANCELED the plan's
 * order would grade a game that was never played — settling real bets off a
 * 0-0 scoreline. Cancelled/postponed must win; the two orders are otherwise
 * indistinguishable on every status ESPN actually emits.
 */
export function mapEspnStatus(statusType: unknown): GameStatus {
  const name = asString(prop(statusType, 'name'))?.toUpperCase() ?? '';
  const state = asString(prop(statusType, 'state'))?.toLowerCase() ?? '';
  const completed = prop(statusType, 'completed') === true;

  if (POSTPONED_NAMES.has(name)) return 'postponed';
  if (CANCELED_NAMES.has(name)) return 'canceled';
  if (state === 'post' && completed) return 'final';
  if (state === 'in') return 'in_progress';
  if (state === 'pre') return 'scheduled';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Odds
 * ------------------------------------------------------------------ */

/**
 * Pick the odds entry to use: DraftKings (provider.id "100") if present,
 * otherwise the lowest `provider.priority`. Returns null when there is none.
 */
export function selectOddsEntry(odds: unknown): unknown {
  const list = asArray(odds);
  if (list === null) return null;
  const entries = list.filter(isObject);
  if (entries.length === 0) return null;

  const draftKings = entries.find(
    (e) => asIdString(prop(prop(e, 'provider'), 'id')) === ESPN_DRAFTKINGS_PROVIDER_ID,
  );
  if (draftKings !== undefined) return draftKings;

  let best: JsonObject | null = null;
  let bestPriority: number | null = null;
  for (const entry of entries) {
    const priority = asFiniteNumber(prop(prop(entry, 'provider'), 'priority'));
    if (priority === null) continue;
    if (bestPriority === null || priority < bestPriority) {
      best = entry;
      bestPriority = priority;
    }
  }
  // No usable priority anywhere: ESPN orders the array best-first, so take [0].
  return best ?? entries[0] ?? null;
}

/**
 * `close` preferred, `open` as fallback — chosen as a WHOLE SNAPSHOT, not field
 * by field. Blending a closing line with an opening price would manufacture a
 * quote no book ever posted, and that quote is what a bet snapshots (§14.3).
 */
function sideSnapshot(node: unknown): { readonly line: unknown; readonly odds: unknown } | null {
  for (const key of ['close', 'open'] as const) {
    const source = prop(node, key);
    if (!isObject(source)) continue;
    const line = source['line'];
    const odds = source['odds'];
    if (line !== undefined || odds !== undefined) return { line, odds };
  }
  return null;
}

/** A short, safe rendering of a raw feed value for a warning message. */
function rawText(value: unknown): string {
  // JSON.stringify is typed as returning string but yields undefined for
  // undefined/functions/symbols/toJSON→undefined and THROWS on BigInt or
  // cycles. This module never throws (PLAN §14.8), so fall back to typeof.
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      // Typed unknown on purpose: the lib signature says string, reality says
      // string | undefined.
      const out: unknown = JSON.stringify(value);
      text = typeof out === 'string' ? out : typeof value;
    } catch {
      text = typeof value;
    }
  }
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/**
 * Market parsers push a human-readable reason into `notes` whenever they drop
 * a market or fall back, so an operator reading `GET /api/admin/jobs` can tell
 * a Unicode-minus regression from a bounds violation (PLAN §14.8).
 */
function parseSpreadMarket(entry: unknown, notes: string[]): SpreadMarket | null {
  const pointSpread = prop(entry, 'pointSpread');
  const home = sideSnapshot(prop(pointSpread, 'home'));
  const away = sideSnapshot(prop(pointSpread, 'away'));
  if (home === null || away === null) return null;

  // A pulled market is a book decision, not a parse failure, and it is named as
  // such so the operator does not chase a feed regression. Checked before the
  // top-level `spread` fallback on purpose: that number can lag the pull, and
  // a bet must never snapshot a line the book has withdrawn.
  if ([home.line, home.odds, away.line, away.odds].some(isOffBoard)) {
    notes.push('spread: off the board');
    return null;
  }

  // Cross-check per §8.3: the top-level `spread` NUMBER is a valid fallback for
  // a missing line (home perspective). `details` ("CIN -3.5") never is — it is
  // display text keyed on an abbreviation.
  const homeTenths = parseLineToTenths(home.line) ?? parseLineToTenths(prop(entry, 'spread'));
  if (homeTenths === null) {
    notes.push(`spread: unusable home line ${rawText(home.line)}`);
    return null;
  }
  let awayTenths = parseLineToTenths(away.line);
  if (awayTenths === null) {
    if (away.line !== undefined) {
      notes.push(`spread: unusable away line ${rawText(away.line)}, mirrored home`);
    }
    awayTenths = -homeTenths;
  } else if (awayTenths !== -homeTenths) {
    // Spreads MUST mirror. A feed that put the favourite's number on both sides
    // would snapshot a wrong line into every away leg, so drop the market.
    notes.push(
      `spread: sides do not mirror (home ${rawText(home.line)}, away ${rawText(away.line)})`,
    );
    return null;
  }
  const homePrice = parseAmericanPrice(home.odds);
  const awayPrice = parseAmericanPrice(away.odds);
  if (homePrice === null || awayPrice === null) {
    notes.push(`spread: unusable price ${rawText(homePrice === null ? home.odds : away.odds)}`);
    return null;
  }
  return { homeTenths, homePrice, awayTenths, awayPrice };
}

function parseTotalMarket(entry: unknown, notes: string[]): TotalMarket | null {
  const total = prop(entry, 'total');
  const over = sideSnapshot(prop(total, 'over'));
  const under = sideSnapshot(prop(total, 'under'));
  if (over === null || under === null) return null;

  if ([over.line, over.odds, under.line, under.odds].some(isOffBoard)) {
    notes.push('total: off the board');
    return null;
  }

  const overTenths = parseLineToTenths(over.line);
  const underTenths = parseLineToTenths(under.line);
  const tenths = overTenths ?? underTenths ?? parseLineToTenths(prop(entry, 'overUnder'));
  if (tenths === null) {
    notes.push(
      `total: unusable line ${rawText(over.line ?? under.line ?? prop(entry, 'overUnder'))}`,
    );
    return null;
  }
  // Same drift insurance as the spread: one `tenths` serves both sides, so a
  // disagreeing pair would snapshot the over's number onto every under leg.
  if (overTenths !== null && underTenths !== null && overTenths !== underTenths) {
    notes.push(`total: sides disagree (over ${rawText(over.line)}, under ${rawText(under.line)})`);
    return null;
  }
  const overPrice = parseAmericanPrice(over.odds);
  const underPrice = parseAmericanPrice(under.odds);
  if (overPrice === null || underPrice === null) {
    notes.push(`total: unusable price ${rawText(overPrice === null ? over.odds : under.odds)}`);
    return null;
  }
  return { tenths, overPrice, underPrice };
}

function parseMoneylineMarket(entry: unknown, notes: string[]): MoneylineMarket | null {
  const moneyline = prop(entry, 'moneyline');
  const home = sideSnapshot(prop(moneyline, 'home'));
  const away = sideSnapshot(prop(moneyline, 'away'));
  if (home === null || away === null) return null;
  if ([home.odds, away.odds].some(isOffBoard)) {
    notes.push('moneyline: off the board');
    return null;
  }
  const homePrice = parseAmericanPrice(home.odds);
  const awayPrice = parseAmericanPrice(away.odds);
  if (homePrice === null || awayPrice === null) {
    notes.push(`moneyline: unusable price ${rawText(homePrice === null ? home.odds : away.odds)}`);
    return null;
  }
  return { homePrice, awayPrice };
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/** Both competitors, or null when the shape is anything other than one of each. */
function splitCompetitors(
  competitors: readonly unknown[],
): { readonly home: unknown; readonly away: unknown } | null {
  const homes = competitors.filter((c) => asString(prop(c, 'homeAway'))?.toLowerCase() === 'home');
  const aways = competitors.filter((c) => asString(prop(c, 'homeAway'))?.toLowerCase() === 'away');
  if (homes.length !== 1 || aways.length !== 1) return null;
  return { home: homes[0], away: aways[0] };
}

/** `team.{id, abbreviation, displayName}` are REQUIRED; `logo` is nullable. */
function parseTeam(competitor: unknown): GameTeam | null {
  const team = prop(competitor, 'team');
  const teamId = asIdString(prop(team, 'id'));
  const abbr = asString(prop(team, 'abbreviation'));
  const name = asString(prop(team, 'displayName'));
  if (teamId === null || abbr === null || name === null) return null;
  return {
    teamId,
    abbr,
    name,
    logo: asString(prop(team, 'logo')),
    rank: parseRank(prop(competitor, 'curatedRank')),
    conferenceId: asIdString(prop(team, 'conferenceId')),
    score: parseScore(prop(competitor, 'score')),
  };
}

/**
 * Parse one `events[i]`. Returns null (plus a warning) when unusable.
 *
 * `warnings` is an optional sink: `parseScoreboard` passes its own array so the
 * reason survives, and a direct caller that does not care can omit it. The three
 * required parameters keep the signature the M2c stub declared.
 */
export function parseEvent(
  event: unknown,
  league: Game['league'],
  fetchedAt: number,
  warnings?: ParseWarning[],
): { readonly game: Game; readonly lines: GameLines | null } | null {
  const eventId = asIdString(prop(event, 'id'));
  const warn = (reason: string): null => {
    warnings?.push({ eventId, label: null, reason });
    return null;
  };

  if (!isObject(event)) return warn('event is not an object');
  if (eventId === null) return warn('event has no id');

  const competitions = asArray(event['competitions']);
  const competition = competitions?.[0];
  if (!isObject(competition)) return warn('event has no competitions[0]');

  const competitors = asArray(competition['competitors']);
  if (competitors === null) return warn('competition has no competitors[]');
  const sides = splitCompetitors(competitors);
  if (sides === null) {
    return warn(
      `expected exactly one home and one away competitor, got ${String(competitors.length)}`,
    );
  }

  const home = parseTeam(sides.home);
  const away = parseTeam(sides.away);
  if (home === null || away === null) {
    return warn('a competitor is missing team.id / abbreviation / displayName');
  }

  const kickoffAt = parseIsoToEpochMs(event['date'] ?? competition['date']);
  if (kickoffAt === null) return warn('event.date is not a parseable ISO timestamp');

  // Season and week come from the EVENT, never the payload root: a date query
  // can span two weeks and, in January, two season types (PLAN.md §8.3).
  const season = asIntegerNumber(prop(event['season'], 'year'));
  const seasonType = asIntegerNumber(prop(event['season'], 'type'));
  if (season === null || seasonType === null) {
    return warn('event.season.{year,type} is missing — cannot place the game in a season');
  }

  const status = isObject(competition['status']) ? competition['status'] : event['status'];
  const statusType = prop(status, 'type');
  const fallbackName = `${away.abbr} @ ${home.abbr}`;

  const game: Game = {
    id: makeGameId(league, eventId),
    league,
    season,
    seasonType,
    week: asIntegerNumber(prop(event['week'], 'number')),
    name: asString(event['name']) ?? fallbackName,
    shortName: asString(event['shortName']) ?? fallbackName,
    kickoffAt,
    // Only ever INSERTed, never updated (§8.5); a reschedule keeps the original.
    originalKickoffAt: kickoffAt,
    status: mapEspnStatus(statusType),
    statusDetail:
      asString(prop(statusType, 'detail')) ??
      asString(prop(statusType, 'shortDetail')) ??
      asString(prop(statusType, 'description')),
    period: asIntegerNumber(prop(status, 'period')),
    displayClock: asString(prop(status, 'displayClock')),
    neutralSite: competition['neutralSite'] === true,
    home,
    away,
  };

  return {
    game,
    lines: parseLines(game.id, competition['odds'], fetchedAt, eventId, game.shortName, warnings),
  };
}

/**
 * A `GameLines` row, or null when there is no usable odds block.
 *
 * A market is dropped (and warned about) only when its container node EXISTS but
 * fails to produce a coherent quote — an out-of-range line or price, say. A
 * market that is simply absent is normal and silent: big favourites often have
 * no moneyline, and every market is independently nullable (PLAN.md §14.9).
 * An odds block that yields no market at all is reported as `null` rather than
 * an all-null row, so ingestion never writes an empty line.
 */
function parseLines(
  gameId: string,
  odds: unknown,
  fetchedAt: number,
  eventId: string | null,
  label: string | null,
  warnings?: ParseWarning[],
): GameLines | null {
  const entry = selectOddsEntry(odds);
  if (entry === null) return null;

  const provider = asString(prop(prop(entry, 'provider'), 'name')) ?? 'unknown';
  const notes: string[] = [];
  const spread = parseSpreadMarket(entry, notes);
  const total = parseTotalMarket(entry, notes);
  const moneyline = parseMoneylineMarket(entry, notes);

  // Present-but-unusable markets warn with the parser's diagnostic; a market
  // whose container node is simply absent is silent (normal for ESPN).
  const generic: string[] = [];
  if (spread === null && isObject(prop(entry, 'pointSpread'))) generic.push('spread');
  if (total === null && isObject(prop(entry, 'total'))) generic.push('total');
  if (moneyline === null && isObject(prop(entry, 'moneyline'))) generic.push('moneyline');
  if (notes.length > 0 || generic.length > 0) {
    // Both lists: a market dropped at the "one side missing" early return pushes
    // no note, and must not be hidden by another market's diagnostic.
    const parts = [...notes];
    const silent = generic.filter((m) => !notes.some((n) => n.startsWith(`${m}:`)));
    if (silent.length > 0) parts.push(`dropped unusable ${silent.join(', ')}`);
    warnings?.push({ eventId, label, reason: `${provider}: ${parts.join('; ')}` });
  }

  if (spread === null && total === null && moneyline === null) return null;
  return { gameId, provider, capturedAt: fetchedAt, spread, total, moneyline };
}

/**
 * Parse a whole scoreboard response.
 * @param payload  the JSON value returned by ESPN (already `JSON.parse`d)
 * @param league   which league we asked for (the payload does not always say)
 * @param fetchedAt epoch ms used as `capturedAt`/`lastSeenAt` for every row
 */
export function parseScoreboard(
  payload: unknown,
  league: Game['league'],
  fetchedAt: number,
): ParsedScoreboard {
  const games: Game[] = [];
  const lines: GameLines[] = [];
  // Every warning is collected, then TRUNCATED to the cap on the way out. The
  // cap governs what is recorded in job_runs.stats, never which events are
  // skipped — a 300-event CFB payload must parse identically either way.
  const collected: ParseWarning[] = [];
  const capped = (): readonly ParseWarning[] => collected.slice(0, ESPN_MAX_WARNINGS_RECORDED);

  const season = asIntegerNumber(prop(prop(payload, 'season'), 'year'));
  const week = asIntegerNumber(prop(prop(payload, 'week'), 'number'));

  const events = asArray(prop(payload, 'events'));
  if (events === null) {
    collected.push({ eventId: null, label: null, reason: 'payload has no events[] array' });
    return { games, lines, warnings: capped(), season, week };
  }

  for (const event of events) {
    const parsed = parseEvent(event, league, fetchedAt, collected);
    if (parsed === null) continue;
    games.push(parsed.game);
    if (parsed.lines !== null) lines.push(parsed.lines);
  }

  return { games, lines, warnings: capped(), season, week };
}
