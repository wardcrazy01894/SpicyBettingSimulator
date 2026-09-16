/**
 * Fixtures for the `worker` project.
 *
 * workerd has no `node:fs`, and the project boundary in
 * `tsconfig.tests-worker.json` does not include `tests/unit/**`, so these are
 * SYNTHESISED payloads rather than the 1.5 MB captured samples. That is the
 * right trade: the "does it parse the real thing" guarantee belongs to the unit
 * project (tests/unit/espn.spec.ts, which reads docs/samples/ via fs); the
 * worker project needs small, precisely-shaped slates it can mutate — a game
 * going final with a specific score, a line moving, a game being cancelled.
 *
 * The builders emit the exact ESPN shape the parser expects, and
 * tests/worker/ingest.spec.ts carries a CONFORMANCE test asserting that a
 * builder output parses to the same domain object as the equivalent
 * hand-written expectation, plus a PARITY test enumerating every field path
 * docs/samples/*.json use, so the two fixture worlds cannot drift.
 */

export interface EventSpecOdds {
  readonly spreadHome?: number;
  readonly spreadHomePrice?: number;
  readonly spreadAwayPrice?: number;
  readonly total?: number;
  readonly overPrice?: number;
  readonly underPrice?: number;
  readonly mlHome?: number;
  readonly mlAway?: number;
  /**
   * Emit the market with every field set to the literal string "OFF" — the
   * shape DraftKings serves for a market it has pulled (a live capture is in
   * tests/unit/espn.spec.ts). Wins over `total` / `mlHome` when both are set.
   */
  readonly spreadOff?: true;
  readonly totalOff?: true;
  readonly moneylineOff?: true;
  /** Defaults to DraftKings / "100" — the entry `selectOddsEntry` prefers. */
  readonly providerId?: string;
  readonly providerName?: string;
}

export interface EventSpec {
  readonly eventId: string;
  readonly league: 'nfl' | 'ncaaf';
  readonly kickoffAt: number;
  readonly status: 'pre' | 'in' | 'post' | 'postponed' | 'canceled';
  readonly homeAbbr: string;
  readonly awayAbbr: string;
  readonly homeScore?: number;
  readonly awayScore?: number;
  readonly season?: number;
  readonly week?: number;
  /** ESPN `season.type`: 1 pre, 2 regular, 3 post. Defaults to 2. */
  readonly seasonType?: number;
  readonly neutralSite?: boolean;
  /** Defaults derive from `status` (see STATUS_SHAPES). */
  readonly period?: number;
  readonly displayClock?: string;
  /** `curatedRank.current`; 99 (ESPN's "unranked") is emitted when omitted. */
  readonly homeRank?: number;
  readonly awayRank?: number;
  /** `team.conferenceId`; omitted when unset (the NFL shape). */
  readonly homeConferenceId?: string;
  readonly awayConferenceId?: string;
  /**
   * Raw override for `competitors[].score`, emitted verbatim — so a test can
   * post `"0"`, `"TBD"` or a number and see what the parser does with it.
   */
  readonly homeScoreRaw?: unknown;
  readonly awayScoreRaw?: unknown;
  /** Omit `competitors[].score` entirely (a payload with no score at all). */
  readonly omitScores?: boolean;
  /** Omit to model a game with no posted line (normal for CFB early in the week). */
  readonly odds?: EventSpecOdds;
}

/* ------------------------------------------------------------------ *
 * ESPN shape
 * ------------------------------------------------------------------ */

interface StatusShape {
  readonly name: string;
  readonly state: string;
  readonly completed: boolean;
  readonly description: string;
  readonly period: number;
  readonly displayClock: string;
}

/**
 * The `status.type` shapes ESPN actually emits, keyed by EventSpec.status.
 * `state` + `completed` is what `mapEspnStatus` keys off; `name` only matters
 * for the postponed/canceled families.
 */
const STATUS_SHAPES: Readonly<Record<EventSpec['status'], StatusShape>> = {
  pre: {
    name: 'STATUS_SCHEDULED',
    state: 'pre',
    completed: false,
    description: 'Scheduled',
    period: 0,
    displayClock: '0:00',
  },
  in: {
    name: 'STATUS_IN_PROGRESS',
    state: 'in',
    completed: false,
    description: 'In Progress',
    period: 2,
    displayClock: '7:23',
  },
  post: {
    name: 'STATUS_FINAL',
    state: 'post',
    completed: true,
    description: 'Final',
    period: 4,
    displayClock: '0:00',
  },
  postponed: {
    name: 'STATUS_POSTPONED',
    state: 'post',
    completed: false,
    description: 'Postponed',
    period: 0,
    displayClock: '0:00',
  },
  canceled: {
    name: 'STATUS_CANCELED',
    state: 'post',
    completed: false,
    description: 'Canceled',
    period: 0,
    displayClock: '0:00',
  },
};

/** ESPN emits `"2026-09-13T17:00Z"` — ISO 8601 with NO seconds. */
export function espnIso(at: number): string {
  return new Date(at).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

/** Deterministic numeric-looking team id, the way ESPN's ids look. */
function teamId(league: string, abbr: string): string {
  let h = 7;
  for (const ch of `${league}|${abbr}`) h = (h * 31 + ch.charCodeAt(0)) % 100_000;
  return String(h);
}

function teamLogo(league: string, abbr: string): string {
  const path = league === 'nfl' ? 'nfl' : 'ncaa';
  return `https://a.espncdn.com/i/teamlogos/${path}/500/${abbr.toLowerCase()}.png`;
}

/** `-3.5` -> "-3.5", `3.5` -> "+3.5", `0` -> "+0" (all accepted by the parser). */
function fmtLine(points: number): string {
  return points < 0 ? String(points) : `+${String(points)}`;
}

/** `-110` -> "-110", `164` -> "+164". */
function fmtPrice(american: number): string {
  return american < 0 ? String(american) : `+${String(american)}`;
}

function buildOdds(odds: EventSpecOdds): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    provider: {
      id: odds.providerId ?? '100',
      name: odds.providerName ?? 'DraftKings',
      priority: 1,
      displayName: odds.providerName ?? 'DraftKings',
    },
  };

  if (odds.spreadOff === true) {
    const off = { line: 'OFF', odds: 'OFF' };
    entry['spread'] = null;
    entry['pointSpread'] = {
      displayName: 'Spread',
      home: { close: { ...off }, open: { ...off } },
      away: { close: { ...off }, open: { ...off } },
    };
  } else if (odds.spreadHome !== undefined) {
    const homePrice = odds.spreadHomePrice ?? -110;
    const awayPrice = odds.spreadAwayPrice ?? -110;
    // `details` is deliberately a display string: PLAN §8.3 forbids parsing it.
    entry['details'] = `HOME ${fmtLine(odds.spreadHome)}`;
    entry['spread'] = odds.spreadHome;
    entry['pointSpread'] = {
      displayName: 'Spread',
      home: {
        close: { line: fmtLine(odds.spreadHome), odds: fmtPrice(homePrice) },
        open: { line: fmtLine(odds.spreadHome), odds: fmtPrice(homePrice) },
      },
      away: {
        close: { line: fmtLine(-odds.spreadHome), odds: fmtPrice(awayPrice) },
        open: { line: fmtLine(-odds.spreadHome), odds: fmtPrice(awayPrice) },
      },
    };
  }

  if (odds.totalOff === true) {
    const off = { line: 'OFF', odds: 'OFF' };
    entry['overUnder'] = null;
    entry['total'] = {
      displayName: 'Total',
      over: { close: { ...off }, open: { ...off } },
      under: { close: { ...off }, open: { ...off } },
    };
  } else if (odds.total !== undefined) {
    const overPrice = odds.overPrice ?? -110;
    const underPrice = odds.underPrice ?? -110;
    entry['overUnder'] = odds.total;
    entry['total'] = {
      displayName: 'Total',
      over: {
        close: { line: `o${String(odds.total)}`, odds: fmtPrice(overPrice) },
        open: { line: `o${String(odds.total)}`, odds: fmtPrice(overPrice) },
      },
      under: {
        close: { line: `u${String(odds.total)}`, odds: fmtPrice(underPrice) },
        open: { line: `u${String(odds.total)}`, odds: fmtPrice(underPrice) },
      },
    };
  }

  if (odds.moneylineOff === true) {
    entry['moneyline'] = {
      displayName: 'Moneyline',
      home: { close: { odds: 'OFF' }, open: { odds: 'OFF' } },
      away: { close: { odds: 'OFF' }, open: { odds: 'OFF' } },
    };
  } else if (odds.mlHome !== undefined && odds.mlAway !== undefined) {
    entry['moneyline'] = {
      displayName: 'Moneyline',
      home: { close: { odds: fmtPrice(odds.mlHome) }, open: { odds: fmtPrice(odds.mlHome) } },
      away: { close: { odds: fmtPrice(odds.mlAway) }, open: { odds: fmtPrice(odds.mlAway) } },
    };
  }

  return entry;
}

function buildCompetitor(spec: EventSpec, side: 'home' | 'away'): Record<string, unknown> {
  const abbr = side === 'home' ? spec.homeAbbr : spec.awayAbbr;
  const id = teamId(spec.league, abbr);
  const rank = side === 'home' ? spec.homeRank : spec.awayRank;
  const conferenceId = side === 'home' ? spec.homeConferenceId : spec.awayConferenceId;
  const raw = side === 'home' ? spec.homeScoreRaw : spec.awayScoreRaw;
  const score = side === 'home' ? spec.homeScore : spec.awayScore;

  const competitor: Record<string, unknown> = {
    id,
    uid: `s:20~l:28~t:${id}`,
    type: 'team',
    order: side === 'home' ? 0 : 1,
    homeAway: side,
    team: {
      id,
      uid: `s:20~l:28~t:${id}`,
      abbreviation: abbr,
      name: `${abbr} Team`,
      displayName: `${abbr} Full Name`,
      shortDisplayName: abbr,
      logo: teamLogo(spec.league, abbr),
      ...(conferenceId === undefined ? {} : { conferenceId }),
    },
    // ESPN's "unranked" sentinel; the parser maps 99 -> null.
    curatedRank: { current: rank ?? 99 },
  };

  // Score is a STRING in all 204 competitors across both committed samples, and
  // BEFORE KICKOFF IT IS "0", NOT ABSENT (PLAN.md §8.3).
  if (spec.omitScores !== true) {
    competitor['score'] = raw === undefined ? String(score ?? 0) : raw;
  }
  return competitor;
}

function buildEvent(spec: EventSpec): Record<string, unknown> {
  const shape = STATUS_SHAPES[spec.status];
  const iso = espnIso(spec.kickoffAt);
  const status = {
    clock: 0,
    displayClock: spec.displayClock ?? shape.displayClock,
    period: spec.period ?? shape.period,
    type: {
      id: '1',
      name: shape.name,
      state: shape.state,
      completed: shape.completed,
      description: shape.description,
      detail: shape.description,
      shortDetail: shape.description,
    },
  };

  const competition: Record<string, unknown> = {
    id: spec.eventId,
    date: iso,
    neutralSite: spec.neutralSite ?? false,
    competitors: [buildCompetitor(spec, 'home'), buildCompetitor(spec, 'away')],
    status,
  };
  if (spec.odds !== undefined) competition['odds'] = [buildOdds(spec.odds)];

  return {
    id: spec.eventId,
    uid: `s:20~l:28~e:${spec.eventId}`,
    date: iso,
    name: `${spec.awayAbbr} Full Name at ${spec.homeAbbr} Full Name`,
    shortName: `${spec.awayAbbr} @ ${spec.homeAbbr}`,
    season: { year: spec.season ?? 2026, type: spec.seasonType ?? 2, slug: 'regular-season' },
    week: { number: spec.week ?? 1 },
    competitions: [competition],
    // Real ESPN keeps event.status and competitions[0].status in lock-step.
    status: JSON.parse(JSON.stringify(status)) as unknown,
  };
}

/** Build a scoreboard payload in ESPN's shape from a list of specs. */
export function buildScoreboard(events: readonly EventSpec[]): unknown {
  const first = events[0];
  return {
    leagues: [{ id: '28', abbreviation: first?.league.toUpperCase() ?? 'NFL' }],
    season: { year: first?.season ?? 2026, type: first?.seasonType ?? 2 },
    week: { number: first?.week ?? 1 },
    events: events.map(buildEvent),
  };
}

/* ------------------------------------------------------------------ *
 * fetch stub
 * ------------------------------------------------------------------ */

/** What the stub should do for one `dates=` key. */
export type EspnResponder = () => Response | Promise<Response>;

export interface EspnStub {
  /** Replace the slate served for one `dates=` key. */
  set(dateKey: string, events: readonly EventSpec[]): void;
  /** Serve an arbitrary response (or throw) for one `dates=` key. */
  setResponder(dateKey: string, responder: EspnResponder): void;
  /** Clear every configured key back to "no games on that date". */
  clear(): void;
  /** Number of upstream requests made, so tests can assert the request budget. */
  readonly callCount: number;
  /** Every URL the Worker asked for, in order. */
  readonly urls: readonly string[];
  restore(): void;
  /** Lower-cased request headers, one entry per upstream call. */
  readonly requestHeaders: readonly Record<string, string>[];
}

/**
 * Install a fetch stub for `https://espn.test/**` that serves `buildScoreboard`
 * output keyed by the `dates=` query parameter. Returns a handle so a test can
 * change the slate mid-run (kick a game off, move a line, cancel a game) and
 * then re-run the refresh job.
 *
 * A `dates=` key with no configured slate is served as an EMPTY but well-formed
 * scoreboard, which is what real ESPN returns for a day with no games. Anything
 * that is not an `https://espn.test/**` URL is forwarded to the original
 * `fetch`, so an unrelated subrequest in a test still behaves normally.
 */
export function stubEspn(slates: Readonly<Record<string, readonly EventSpec[]>> = {}): EspnStub {
  const responders = new Map<string, EspnResponder>();
  const urls: string[] = [];
  const requestHeaders: Record<string, string>[] = [];
  const original = globalThis.fetch;

  const jsonResponder =
    (events: readonly EventSpec[]): EspnResponder =>
    () =>
      new Response(JSON.stringify(buildScoreboard(events)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

  for (const [key, events] of Object.entries(slates)) responders.set(key, jsonResponder(events));

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://espn.test/')) {
      return original(input, init);
    }
    urls.push(url);
    // Record the headers the Worker actually sends (ESPN's edge filters on
    // User-Agent — see src/worker/espn.ts), so a test can assert them.
    const sent: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      sent[key.toLowerCase()] = value;
    });
    requestHeaders.push(sent);
    const dateKey = new URL(url).searchParams.get('dates') ?? '';
    const responder = responders.get(dateKey);
    if (responder === undefined) return jsonResponder([])();
    return responder();
  };

  globalThis.fetch = stub;

  return {
    set(dateKey, events) {
      responders.set(dateKey, jsonResponder(events));
    },
    setResponder(dateKey, responder) {
      responders.set(dateKey, responder);
    },
    clear() {
      responders.clear();
    },
    get callCount() {
      return urls.length;
    },
    get urls() {
      return urls;
    },
    get requestHeaders() {
      return requestHeaders;
    },
    restore() {
      globalThis.fetch = original;
      urls.length = 0;
      requestHeaders.length = 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The Odds API (PLAN.md §21) — a builder in the v4 /odds shape and a stub
 * server with `x-requests-*` header injection, so M9c's sweep tests can drive
 * credits, 401/429/5xx and timeouts without the network.
 * ------------------------------------------------------------------ */

export interface OddsApiOutcomeSpec {
  readonly name: string;
  readonly price: number;
  readonly point?: number;
}

export interface OddsApiBookSpec {
  readonly key: string;
  readonly spreads?: readonly OddsApiOutcomeSpec[];
  readonly totals?: readonly OddsApiOutcomeSpec[];
  readonly h2h?: readonly OddsApiOutcomeSpec[];
}

export interface OddsApiEventSpec {
  readonly id: string;
  readonly sportKey?: 'americanfootball_nfl' | 'americanfootball_ncaaf';
  /** ISO-8601 UTC, as the API sends it. */
  readonly commenceTime: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  /**
   * Books in RESPONSE order. Omit to get a full DraftKings line (spread ±3.5
   * at -110, total 47.5 at -110, moneyline -180/+155), which is what most
   * tests want.
   */
  readonly books?: readonly OddsApiBookSpec[];
}

/** A complete DraftKings line for `spec`, mirrored and well-formed. */
export function draftKingsLine(spec: {
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly spreadHome?: number;
  readonly total?: number;
  readonly mlHome?: number;
  readonly mlAway?: number;
}): OddsApiBookSpec {
  const spreadHome = spec.spreadHome ?? -3.5;
  const total = spec.total ?? 47.5;
  return {
    key: 'draftkings',
    spreads: [
      { name: spec.awayTeam, price: -110, point: -spreadHome },
      { name: spec.homeTeam, price: -110, point: spreadHome },
    ],
    totals: [
      { name: 'Over', price: -110, point: total },
      { name: 'Under', price: -110, point: total },
    ],
    h2h: [
      { name: spec.awayTeam, price: spec.mlAway ?? 155 },
      { name: spec.homeTeam, price: spec.mlHome ?? -180 },
    ],
  };
}

/** One event in the documented v4 shape. */
export function buildOddsApiEvent(spec: OddsApiEventSpec): Record<string, unknown> {
  const books = spec.books ?? [draftKingsLine(spec)];
  return {
    id: spec.id,
    sport_key: spec.sportKey ?? 'americanfootball_nfl',
    sport_title: spec.sportKey === 'americanfootball_ncaaf' ? 'NCAAF' : 'NFL',
    commence_time: spec.commenceTime,
    home_team: spec.homeTeam,
    away_team: spec.awayTeam,
    bookmakers: books.map((b) => ({
      key: b.key,
      title: b.key,
      last_update: spec.commenceTime,
      markets: (['h2h', 'spreads', 'totals'] as const)
        .filter((m) => b[m] !== undefined)
        .map((m) => ({
          key: m,
          last_update: spec.commenceTime,
          outcomes: (b[m] ?? []).map((o) =>
            o.point === undefined
              ? { name: o.name, price: o.price }
              : { name: o.name, price: o.price, point: o.point },
          ),
        })),
    })),
  };
}

/** The whole body of `GET /v4/sports/{sport}/odds`: an array of events. */
export function buildOddsApiPayload(events: readonly OddsApiEventSpec[]): unknown[] {
  return events.map(buildOddsApiEvent);
}

export type OddsApiResponder = () => Response | Promise<Response>;

export interface OddsApiCredits {
  readonly last: number;
  readonly used: number;
  readonly remaining: number;
}

export interface OddsApiStub {
  /** Serve these events for one sport key's `/odds` call, with the credit headers. */
  set(
    sportKey: string,
    events: readonly OddsApiEventSpec[],
    credits?: Partial<OddsApiCredits>,
  ): void;
  /** Serve an arbitrary response (or throw) for one sport key's `/odds` call. */
  setResponder(sportKey: string, responder: OddsApiResponder): void;
  /** What `GET /v4/sports` (the FREE probe) answers with; defaults to 200 + headers, cost 0. */
  setProbe(responder: OddsApiResponder): void;
  /** The credit headers every default response carries; a sweep response overrides `last`. */
  setCredits(credits: Partial<OddsApiCredits>): void;
  readonly callCount: number;
  /** Every URL asked for, in order, api key INCLUDED — tests assert it never leaks. */
  readonly urls: readonly string[];
  readonly requestHeaders: readonly Record<string, string>[];
  restore(): void;
}

export const ODDS_API_STUB_BASE = 'https://odds.test';

/**
 * Intercepts `fetch` for `https://odds.test/…`, the way `stubEspn` does for
 * ESPN. A sport with no configured events answers `[]` with the credit
 * headers, which is what the real API does for a league with nothing upcoming.
 */
export function stubOddsApi(): OddsApiStub {
  const responders = new Map<string, OddsApiResponder>();
  const urls: string[] = [];
  const requestHeaders: Record<string, string>[] = [];
  const original = globalThis.fetch;
  let credits: OddsApiCredits = { last: 3, used: 3, remaining: 497 };

  const headersFor = (over: Partial<OddsApiCredits> = {}): Record<string, string> => {
    const c = { ...credits, ...over };
    return {
      'content-type': 'application/json',
      'x-requests-last': String(c.last),
      'x-requests-used': String(c.used),
      'x-requests-remaining': String(c.remaining),
    };
  };
  const jsonResponder =
    (body: unknown, over: Partial<OddsApiCredits> = {}): OddsApiResponder =>
    () =>
      new Response(JSON.stringify(body), { status: 200, headers: headersFor(over) });

  let probe: OddsApiResponder = () =>
    new Response(JSON.stringify([{ key: 'americanfootball_nfl', active: true }]), {
      status: 200,
      headers: headersFor({ last: 0 }),
    });

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${ODDS_API_STUB_BASE}/`)) return original(input, init);
    urls.push(url);
    const sent: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      sent[key.toLowerCase()] = value;
    });
    requestHeaders.push(sent);
    const path = new URL(url).pathname;
    const sport = /^\/v4\/sports\/([^/]+)\/odds$/.exec(path)?.[1];
    if (sport === undefined) {
      if (path === '/v4/sports') return probe();
      return new Response('not found', { status: 404, headers: headersFor({ last: 0 }) });
    }
    const responder = responders.get(sport);
    if (responder === undefined) return jsonResponder([])();
    return responder();
  };
  globalThis.fetch = stub;

  return {
    set(sportKey, events, over = {}) {
      // A sweep response that reports a new balance moves the stub's balance
      // too, so a probe issued afterwards agrees with it — as the real API's does.
      credits = { ...credits, ...over };
      responders.set(sportKey, jsonResponder(buildOddsApiPayload(events), over));
    },
    setResponder(sportKey, responder) {
      responders.set(sportKey, responder);
    },
    setProbe(responder) {
      probe = responder;
    },
    setCredits(over) {
      credits = { ...credits, ...over };
    },
    get callCount() {
      return urls.length;
    },
    urls,
    requestHeaders,
    restore() {
      globalThis.fetch = original;
    },
  };
}
