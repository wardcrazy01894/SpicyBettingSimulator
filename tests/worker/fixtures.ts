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

  if (odds.spreadHome !== undefined) {
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

  if (odds.total !== undefined) {
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

  if (odds.mlHome !== undefined && odds.mlAway !== undefined) {
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
    restore() {
      globalThis.fetch = original;
      urls.length = 0;
    },
  };
}
