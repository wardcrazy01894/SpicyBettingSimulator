/**
 * Request validation. Pure, so the SAME functions run in the browser (to grey out
 * an invalid bet slip) and in the Worker (as the real gate). The client copy is
 * purely for UX — the server always re-validates.
 */

import {
  BUG_REPORT_DESCRIPTION_MAX,
  BUG_REPORT_DESCRIPTION_MIN,
  BUG_REPORT_DIAGNOSTICS_MAX,
  BUG_REPORT_PAGE_MAX,
  BUG_REPORT_TITLE_MAX,
  BUG_REPORT_TITLE_MIN,
  MAX_ABS_AMERICAN_PRICE,
  MAX_ABS_LINE_TENTHS,
  MAX_PARLAY_LEGS,
  MIN_ABS_AMERICAN_PRICE,
  MIN_PARLAY_LEGS,
  MIN_STAKE_CENTS,
  MIN_TEASER_LEGS,
  TEASABLE_LEAGUES,
  TEASER_POINTS_TENTHS,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
  isTeaserPoints,
} from './constants.js';
import type { TeaserPointsTenths } from './constants.js';
import type { BugReportRequest, PlaceBetLegRequest, PlaceBetRequest } from './api-types.js';
import { LEAGUES } from './types.js';
import type {
  AmericanPrice,
  BetLeague,
  BetType,
  Cents,
  League,
  LineTenths,
  Market,
  Side,
} from './types.js';

/** A discriminated result so callers never have to catch for control flow. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly field?: string };

/** The validated leg IS the wire shape — derived, so the two can never drift. */
export type PlaceBetLegInput = PlaceBetLegRequest;

/** The wire request with `acceptLineChange` defaulted (never undefined after validation). */
export type PlaceBetInput = Omit<PlaceBetRequest, 'acceptLineChange' | 'legs'> & {
  readonly acceptLineChange: boolean;
  readonly legs: readonly PlaceBetLegInput[];
};

export interface SignupInput {
  readonly username: string;
  readonly displayName: string;
  /** 64 lowercase hex chars — the browser-derived key, see PLAN.md §10.2. */
  readonly dk: string;
  readonly inviteCode: string | null;
}

export interface LoginInput {
  readonly username: string;
  readonly dk: string;
}

/** The validated bug report: trimmed, bounded, `page` normalised to `null`. */
export interface BugReportInput {
  readonly title: string;
  readonly description: string;
  /** The SPA path the reporter was on (`/bets`), or null. Never a full URL. */
  readonly page: string | null;
  /** The browser's diagnostics log, already rendered to text; null when absent. */
  readonly diagnostics: string | null;
}

const MARKETS: readonly Market[] = ['moneyline', 'spread', 'total'];
const SIDES: readonly Side[] = ['home', 'away', 'over', 'under'];
const BET_TYPES: readonly BetType[] = ['straight', 'parlay', 'teaser'];
/** `'mixed'` is accepted on the wire but is advisory; the server re-derives it. */
const BET_LEAGUES: readonly BetLeague[] = [...LEAGUES, 'mixed'];
/** Teasers move a LINE, so there has to be one: moneyline legs are refused. */
const TEASABLE_MARKETS: readonly Market[] = ['spread', 'total'];
export const DISPLAY_NAME_MAX = 40;

/**
 * `['nfl', 'ncaaf', 'mlb']` → `"nfl, ncaaf or mlb"`. Every "league must be …"
 * message is built from `LEAGUES` through this, so a new league can never be
 * missing from the copy that tells a caller what is allowed (PLAN.md §23.1
 * item 11).
 */
export function listWithOr(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1] ?? ''}`;
}

/**
 * Whether a leg from `league` may be part of a TEASER — reads `TEASABLE_LEAGUES`
 * (football only; MLB is refused with the existing `TEASER_INVALID`, PLAN.md
 * §23.8). One definition for the server's gate and the slip's pre-check.
 */
export function isTeasableLeague(league: League): boolean {
  return (TEASABLE_LEAGUES as readonly League[]).includes(league);
}

function bad<T>(message: string, field?: string): ValidationResult<T> {
  return field === undefined ? { ok: false, message } : { ok: false, message, field };
}
function good<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isIn<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/**
 * The prefix a soft-deleted account's username is rewritten to (`auth.ts`
 * `deleteUser`, PLAN.md §10.5). NOBODY MAY REGISTER IT.
 *
 * `deleted_<hex>` is a perfectly legal username under the charset and length
 * rules below, and every authenticated user can read every other user's uuid off
 * `GET /api/leaderboard`. Without this reservation a squatter could register the
 * exact tombstone name of an account they want to protect, and the admin's
 * `DELETE /api/admin/users/:id` would then collide on `users.username` forever —
 * an unfixable 500 driven entirely by attacker-chosen input. `deleteUser` has a
 * retry and a coded error for the collision it can still hit (a DIFFERENT
 * deleted account whose id shares the first 12 hex digits); this closes the half
 * that is reachable on purpose.
 *
 * Shared, not worker-local, because the browser validates the same field before
 * it spends ~1s deriving a key for a signup that cannot succeed.
 */
export const RESERVED_USERNAME_PREFIX = 'deleted_';

/** Lowercase, trim, and check length + charset. */
export function validateUsername(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return bad('username must be a string', 'username');
  const u = raw.trim().toLowerCase();
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) {
    return bad(
      `username must be ${String(USERNAME_MIN)}-${String(USERNAME_MAX)} characters`,
      'username',
    );
  }
  if (!USERNAME_PATTERN.test(u)) {
    return bad('username may only contain a-z, 0-9 and _', 'username');
  }
  if (u.startsWith(RESERVED_USERNAME_PREFIX)) {
    return bad(
      `username may not start with "${RESERVED_USERNAME_PREFIX}" — that prefix is reserved`,
      'username',
    );
  }
  return good(u);
}

/** Exactly 64 lowercase hex characters. */
export function validateDerivedKeyHex(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) {
    return bad('dk must be exactly 64 lowercase hex characters', 'dk');
  }
  return good(raw);
}

/**
 * Control characters (C0/C1), Unicode format characters (bidi overrides,
 * zero-width joiners, etc.) and unassigned/surrogate/private-use code points
 * are rejected — they render invisibly and are the classic leaderboard
 * spoofing tools. \p{C} covers Cc, Cf, Cs, Co and Cn — EXCEPT U+200D (ZWJ) and
 * U+FE0E/U+FE0F (variation selectors), which are how family/profession/flag
 * emoji are composed and must stay allowed. Line/paragraph separators (Zl/Zp)
 * are rejected too.
 */
const FORBIDDEN_NAME_CHARS = /\p{C}|\p{Zl}|\p{Zp}/u;
/** Emoji joiners/selectors are format chars but legitimate; removed before the check. */
const EMOJI_JOINERS = /\u200d|\ufe0e|\ufe0f/gu;

function validateDisplayName(raw: unknown, fallback: string): ValidationResult<string> {
  if (raw === undefined || raw === null) return good(fallback);
  if (typeof raw !== 'string') return bad('displayName must be a string', 'displayName');
  const d = raw.trim();
  if (d.length === 0) return good(fallback);
  if (FORBIDDEN_NAME_CHARS.test(d.replace(EMOJI_JOINERS, ''))) {
    return bad('displayName contains control or invisible characters', 'displayName');
  }
  // Count code points, not UTF-16 units, so 40 emoji are 40 characters.
  if (Array.from(d).length > DISPLAY_NAME_MAX) {
    return bad(`displayName must be at most ${String(DISPLAY_NAME_MAX)} characters`, 'displayName');
  }
  return good(d);
}

export function validateSignup(body: unknown): ValidationResult<SignupInput> {
  if (!isRecord(body)) return bad('body must be a JSON object');
  const username = validateUsername(body['username']);
  if (!username.ok) return username;
  const dk = validateDerivedKeyHex(body['dk']);
  if (!dk.ok) return dk;
  // Display name defaults to the username AS TYPED (trimmed), preserving case.
  const typed = typeof body['username'] === 'string' ? body['username'].trim() : username.value;
  const displayName = validateDisplayName(body['displayName'], typed);
  if (!displayName.ok) return displayName;
  const rawInvite = body['inviteCode'];
  let inviteCode: string | null = null;
  if (rawInvite !== undefined && rawInvite !== null) {
    if (typeof rawInvite !== 'string') return bad('inviteCode must be a string', 'inviteCode');
    inviteCode = rawInvite.trim() === '' ? null : rawInvite.trim();
  }
  return good({
    username: username.value,
    displayName: displayName.value,
    dk: dk.value,
    inviteCode,
  });
}

export interface DisplayNameInput {
  readonly displayName: string;
}

/**
 * `POST /api/auth/display-name`. The same character rules as signup, but NO
 * fallback: signup defaults a blank name to the username, whereas an update
 * that arrives blank is a mistake and is a 400, not a silent reset.
 */
export function validateDisplayNameUpdate(body: unknown): ValidationResult<DisplayNameInput> {
  if (!isRecord(body)) return bad('body must be a JSON object');
  const raw = body['displayName'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return bad('displayName is required', 'displayName');
  }
  const name = validateDisplayName(raw, '');
  if (!name.ok) return name;
  return good({ displayName: name.value });
}

export function validateLogin(body: unknown): ValidationResult<LoginInput> {
  if (!isRecord(body)) return bad('body must be a JSON object');
  const username = validateUsername(body['username']);
  if (!username.ok) return username;
  const dk = validateDerivedKeyHex(body['dk']);
  if (!dk.ok) return dk;
  return good({ username: username.value, dk: dk.value });
}

/** True iff the market/side pair is coherent. */
export function isCoherentMarketSide(market: Market, side: Side): boolean {
  return market === 'total'
    ? side === 'over' || side === 'under'
    : side === 'home' || side === 'away';
}

function validateExpected(
  raw: unknown,
  market: Market,
  field: string,
): ValidationResult<{ americanPrice: AmericanPrice; lineTenths: LineTenths | null } | undefined> {
  if (raw === undefined) return good(undefined);
  if (!isRecord(raw)) return bad('expected must be an object', field);
  const price = raw['americanPrice'];
  if (
    typeof price !== 'number' ||
    !Number.isSafeInteger(price) ||
    Math.abs(price) < MIN_ABS_AMERICAN_PRICE ||
    Math.abs(price) > MAX_ABS_AMERICAN_PRICE
  ) {
    return bad(
      'expected.americanPrice must be an integer American price',
      `${field}.americanPrice`,
    );
  }
  const line = raw['lineTenths'];
  if (market === 'moneyline') {
    if (line !== null && line !== undefined) {
      return bad('moneyline has no line', `${field}.lineTenths`);
    }
    return good({ americanPrice: price, lineTenths: null });
  }
  if (
    typeof line !== 'number' ||
    !Number.isSafeInteger(line) ||
    Math.abs(line) > MAX_ABS_LINE_TENTHS
  ) {
    return bad('expected.lineTenths must be an integer (tenths of a point)', `${field}.lineTenths`);
  }
  return good({ americanPrice: price, lineTenths: line });
}

function validateLeg(raw: unknown, index: number): ValidationResult<PlaceBetLegInput> {
  const f = `legs[${String(index)}]`;
  if (!isRecord(raw)) return bad('leg must be an object', f);
  const gameId = raw['gameId'];
  if (typeof gameId !== 'string' || gameId.trim() === '') {
    return bad('gameId is required', `${f}.gameId`);
  }
  const market = raw['market'];
  if (!isIn(MARKETS, market))
    return bad('market must be moneyline, spread or total', `${f}.market`);
  const side = raw['side'];
  if (!isIn(SIDES, side)) return bad('side must be home, away, over or under', `${f}.side`);
  if (!isCoherentMarketSide(market, side)) {
    return bad(`side ${side} is not valid for market ${market}`, `${f}.side`);
  }
  const expected = validateExpected(raw['expected'], market, `${f}.expected`);
  if (!expected.ok) return expected;
  return good(
    expected.value === undefined
      ? { gameId, market, side }
      : { gameId, market, side, expected: expected.value },
  );
}

/** `teaserPoints`: required iff the bet is a teaser, rejected otherwise. */
function validateTeaserPoints(
  raw: unknown,
  betType: BetType,
): ValidationResult<TeaserPointsTenths | undefined> {
  const value = raw ?? undefined; // null behaves like absent, as inviteCode does
  if (betType !== 'teaser') {
    return value === undefined
      ? good(undefined)
      : bad('teaserPoints is only valid on a teaser', 'teaserPoints');
  }
  if (!isTeaserPoints(value)) {
    return bad(
      `teaserPoints must be one of ${TEASER_POINTS_TENTHS.join(', ')} (tenths of a point)`,
      'teaserPoints',
    );
  }
  return good(value);
}

/**
 * Validate a bet request body. Checks, in order:
 *   - stakeCents is a safe integer >= MIN_STAKE_CENTS
 *   - betType 'straight' => exactly 1 leg; 'parlay'/'teaser' => 2..MAX_PARLAY_LEGS
 *   - teaserPoints is present iff betType is 'teaser', and is one of TEASER_POINTS_TENTHS
 *   - a teaser's legs are spread or total only — a moneyline has no line to move
 *   - each leg's market/side combination is coherent
 *     (total <=> over/under; moneyline/spread <=> home/away)
 *   - no two legs occupy the same SLOT of one game (`sameGameConflict`): a game
 *     may contribute one side pick (spread OR moneyline) and one total. The DB
 *     backs it with UNIQUE(bet_id, game_id, market) and the
 *     `bet_legs_bi_one_side_per_game` trigger (migration 0008)
 *   - gameIds are non-empty strings
 *
 * WHAT THIS DELIBERATELY NO LONGER CHECKS (M5b): that the legs share a league or
 * a season. They may mix freely — a balance is not scoped to either — so the
 * server reads the legs' real leagues from `games` and labels the bet `'mixed'`
 * when they differ. `league` on the request is advisory and is only checked for
 * being a legal value. Game membership is still a server-side DB check, not here.
 */
export function validatePlaceBet(body: unknown): ValidationResult<PlaceBetInput> {
  if (!isRecord(body)) return bad('body must be a JSON object');
  const league = body['league'];
  if (!isIn(BET_LEAGUES, league)) {
    return bad(`league must be ${listWithOr(BET_LEAGUES)}`, 'league');
  }
  const betType = body['betType'];
  if (!isIn(BET_TYPES, betType)) {
    return bad('betType must be straight, parlay or teaser', 'betType');
  }
  const stake = body['stakeCents'];
  if (typeof stake !== 'number' || !Number.isSafeInteger(stake) || stake < MIN_STAKE_CENTS) {
    return bad(`stakeCents must be an integer >= ${String(MIN_STAKE_CENTS)}`, 'stakeCents');
  }
  const alc = body['acceptLineChange'] ?? undefined; // null behaves like absent, as inviteCode does
  if (alc !== undefined && typeof alc !== 'boolean') {
    return bad('acceptLineChange must be a boolean', 'acceptLineChange');
  }
  const teaserPoints = validateTeaserPoints(body['teaserPoints'], betType);
  if (!teaserPoints.ok) return teaserPoints;
  const rawBankrollId = body['bankrollId'] ?? undefined;
  if (rawBankrollId !== undefined && (typeof rawBankrollId !== 'string' || rawBankrollId === '')) {
    return bad('bankrollId must be a non-empty string', 'bankrollId');
  }
  const rawLegs = body['legs'];
  if (!Array.isArray(rawLegs)) return bad('legs must be an array', 'legs');
  if (betType === 'straight' && rawLegs.length !== 1) {
    return bad('a straight bet has exactly one leg', 'legs');
  }
  if (betType === 'parlay' && outsideRange(rawLegs.length, MIN_PARLAY_LEGS, MAX_PARLAY_LEGS)) {
    return bad(`a parlay has ${String(MIN_PARLAY_LEGS)}-${String(MAX_PARLAY_LEGS)} legs`, 'legs');
  }
  if (betType === 'teaser' && outsideRange(rawLegs.length, MIN_TEASER_LEGS, MAX_PARLAY_LEGS)) {
    return bad(`a teaser has ${String(MIN_TEASER_LEGS)}-${String(MAX_PARLAY_LEGS)} legs`, 'legs');
  }
  const legs: PlaceBetLegInput[] = [];
  for (const [i, rawLeg] of rawLegs.entries()) {
    const leg = validateLeg(rawLeg, i);
    if (!leg.ok) return leg;
    if (betType === 'teaser' && !isIn(TEASABLE_MARKETS, leg.value.market)) {
      // Field is `legs[i].market`, per the spec: the offending leg is the one
      // the slip has to grey out, and "market" is what the user would change.
      return bad('a teaser leg must be a spread or a total', `legs[${String(i)}].market`);
    }
    // Same-game legs are legal (M11) up to one per slot; the LATER leg is the
    // one named, on `market`, because the market is what the user would change.
    const conflict = sameGameConflict(legs, leg.value);
    if (conflict !== null) return bad(conflict, `legs[${String(i)}].market`);
    legs.push(leg.value);
  }
  return good({
    league,
    betType,
    stakeCents: stake,
    acceptLineChange: alc ?? false,
    legs,
    ...(teaserPoints.value === undefined ? {} : { teaserPoints: teaserPoints.value }),
    ...(rawBankrollId === undefined ? {} : { bankrollId: rawBankrollId }),
  });
}

/**
 * The two SLOTS a game offers a bet. A bet may hold one leg in each slot per
 * game: a side pick — the spread OR the moneyline, which are the same question
 * ("does this team win by enough?") asked twice and therefore correlated — and
 * a total, which asks something else. Same-game parlays (M11, PLAN.md §5.2c)
 * are priced as ordinary parlays; this slot rule is the whole correlation
 * guard, and the schema mirrors it (UNIQUE(bet_id, game_id, market) plus the
 * `bet_legs_bi_one_side_per_game` trigger).
 */
export type LegSlot = 'side' | 'total';

/** Just enough of a leg to judge whether two of them may share a bet. */
export interface LegRef {
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
}

/**
 * The legs' game ids with repeats removed, first occurrence first. The one
 * definition of "which games is this bet on" now that a game may repeat: the
 * placement guard counts these, the edit re-price fetches these, and the UI
 * says "Same game" when there are fewer of them than legs.
 */
export function distinctGameIds(legs: readonly { readonly gameId: string }[]): readonly string[] {
  return [...new Set(legs.map((leg) => leg.gameId))];
}

export function legSlot(market: Market): LegSlot {
  return market === 'total' ? 'total' : 'side';
}

/**
 * Whether two legs cannot be in one bet together: the same game AND the same
 * slot. The identical pick counts too — it is the same slot.
 */
export function legsConflict(a: LegRef, b: LegRef): boolean {
  return a.gameId === b.gameId && legSlot(a.market) === legSlot(b.market);
}

/**
 * The validation message for adding `leg` to `legs`, or `null` when it fits.
 * Two messages, because they call for different fixes: the same market twice
 * ("pick a side") and a spread beside a moneyline ("pick one of them").
 */
export function sameGameConflict(legs: readonly LegRef[], leg: LegRef): string | null {
  const clash = legs.find((other) => legsConflict(other, leg));
  if (clash === undefined) return null;
  if (clash.market === leg.market) {
    return `a bet cannot take the ${leg.market} on one game twice`;
  }
  return 'a bet cannot pair a spread with a moneyline on one game';
}

/** `value < min || value > max`, named so the leg-count checks read as one idea. */
function outsideRange(value: number, min: number, max: number): boolean {
  return value < min || value > max;
}

/**
 * Parse a user-typed dollar string to integer cents.
 * Handles "12.34", "12", ".5", "12.", "1,000", "$5". Rejects >2 decimal places,
 * negatives, NaN and anything above MAX_SAFE_INTEGER cents.
 *
 * Pure string/integer arithmetic: the text is never turned into a float.
 */
export function parseDollarsToCents(raw: string): ValidationResult<Cents> {
  const cleaned = raw.replace(/[\s$]/g, '');
  // Thousands separators must be well-formed groups of three, or absent.
  const m = /^(\d{1,3}(?:,\d{3})*|\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (m === null) return bad('enter a dollar amount like 12.34');
  const whole = (m[1] ?? '').replace(/,/g, '');
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (whole === '' && (m[2] ?? '') === '') return bad('enter a dollar amount like 12.34');
  const digits = `${whole === '' ? '0' : whole}${frac}`;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents)) return bad('amount is too large');
  return good(cents);
}

/** Cents -> "$1,234.56". */
export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String((abs - (abs % 100)) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${frac}`;
}

/** Tenths -> "-3.5" / "+3.5" / "50.5". `signed` controls the leading plus. */
export function formatLineTenths(tenths: LineTenths, signed: boolean): string {
  if (tenths === 0) return signed ? 'PK' : '0';
  const sign = tenths < 0 ? '-' : signed ? '+' : '';
  const abs = Math.abs(tenths);
  const tenth = abs % 10;
  const whole = (abs - tenth) / 10;
  return `${sign}${String(whole)}${tenth === 0 ? '' : `.${String(tenth)}`}`;
}

/**
 * `POST /api/bugs` body. Whitespace is trimmed before the length checks so a
 * title of spaces cannot pass. `page` is optional and must look like an SPA
 * path — it is echoed into a GitHub issue, so a full URL or anything with a
 * newline is refused rather than sanitised.
 */
export function validateBugReport(body: unknown): ValidationResult<BugReportInput> {
  if (!isRecord(body)) return bad('Body must be a JSON object.');
  const raw: Partial<BugReportRequest> = body;

  if (typeof raw.title !== 'string') return bad('title is required.', 'title');
  const title = raw.title.trim();
  if (title.length < BUG_REPORT_TITLE_MIN) {
    return bad(`title must be at least ${String(BUG_REPORT_TITLE_MIN)} characters.`, 'title');
  }
  if (title.length > BUG_REPORT_TITLE_MAX) {
    return bad(`title must be at most ${String(BUG_REPORT_TITLE_MAX)} characters.`, 'title');
  }
  if (/[\r\n]/.test(title)) return bad('title must be a single line.', 'title');

  if (typeof raw.description !== 'string') {
    return bad('description is required.', 'description');
  }
  const description = raw.description.trim();
  if (description.length < BUG_REPORT_DESCRIPTION_MIN) {
    return bad(
      `description must be at least ${String(BUG_REPORT_DESCRIPTION_MIN)} characters.`,
      'description',
    );
  }
  if (description.length > BUG_REPORT_DESCRIPTION_MAX) {
    return bad(
      `description must be at most ${String(BUG_REPORT_DESCRIPTION_MAX)} characters.`,
      'description',
    );
  }

  let page: string | null = null;
  if (raw.page !== undefined && raw.page !== null) {
    if (typeof raw.page !== 'string') return bad('page must be a string.', 'page');
    const trimmed = raw.page.trim();
    if (trimmed !== '') {
      if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
        return bad('page must be a path starting with /.', 'page');
      }
      if (trimmed.length > BUG_REPORT_PAGE_MAX) {
        return bad(`page must be at most ${String(BUG_REPORT_PAGE_MAX)} characters.`, 'page');
      }
      if (/[\s`]/.test(trimmed)) {
        return bad('page must not contain whitespace or backticks.', 'page');
      }
      page = trimmed;
    }
  }

  let diagnostics: string | null = null;
  if (raw.diagnostics !== undefined && raw.diagnostics !== null) {
    if (typeof raw.diagnostics !== 'string') {
      return bad('diagnostics must be a string.', 'diagnostics');
    }
    const trimmed = raw.diagnostics.trim();
    if (trimmed.length > BUG_REPORT_DIAGNOSTICS_MAX) {
      return bad(
        `diagnostics must be at most ${String(BUG_REPORT_DIAGNOSTICS_MAX)} characters.`,
        'diagnostics',
      );
    }
    if (trimmed !== '') diagnostics = trimmed;
  }

  return good({ title, description, page, diagnostics });
}
