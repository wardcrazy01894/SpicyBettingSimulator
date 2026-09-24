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
 *   espn-mlb-scoreboard-2026-09-24.json — a DATE query, 12 events
 *      9 STATUS_SCHEDULED with DraftKings odds, 3 STATUS_IN_PROGRESS without
 *   espn-mlb-scoreboard-2026-09-22.json — a DATE query, 16 events, no odds
 *     14 finals in 9, 401817038 "Final/12", 401817035 STATUS_POSTPONED
 *     (both asserted in tests/unit/mlb.spec.ts, PLAN.md §23.2)
 *
 *   espn-cfb-scoreboard.json  — a WEEK query (NOT one slate), 86 events
 *      2 STATUS_SCHEDULED (both carry odds), 16 in progress, 3 halftime, 65 final
 *      0 of those 84 started/finished events carry odds
 *     ET date buckets: { 20260910: 1, 20260911: 5, 20260912: 80 }
 *     i.e. the Saturday is 93% of the week — relevant to PLAN.md §8.1.
 *
 * The headline fact both files prove: ESPN REMOVES odds the moment a game
 * starts, which is exactly why a bet must snapshot its line at placement.
 *
 * Every accessor returns a FRESH deep clone, so a test that mutates a payload
 * cannot leak into the next test.
 */

import { readFileSync } from 'node:fs';

export interface ScoreboardOverride {
  readonly eventId: string;
  readonly status?: string;
  readonly homeScore?: string;
  readonly awayScore?: string;
  readonly date?: string;
  /** Remove the odds block, to simulate a game that has started. */
  readonly dropOdds?: boolean;
}

/* ------------------------------------------------------------------ *
 * Minimal MUTABLE views of the ESPN shape. Only the fields the
 * overrides touch are named; everything else rides along untyped.
 * ------------------------------------------------------------------ */

interface EspnStatusType {
  id?: string;
  name: string;
  state: string;
  completed: boolean;
  description?: string;
  detail?: string;
  shortDetail?: string;
}

interface EspnStatus {
  clock?: number;
  displayClock?: string;
  period?: number;
  type: EspnStatusType;
}

interface EspnCompetitor {
  id?: string;
  homeAway?: string;
  score?: string;
  team?: Record<string, unknown>;
  curatedRank?: { current?: number };
  winner?: boolean;
  linescores?: unknown;
}

interface EspnCompetition {
  id?: string;
  date?: string;
  startDate?: string;
  neutralSite?: boolean;
  competitors?: EspnCompetitor[];
  status?: EspnStatus;
  odds?: unknown[];
}

interface EspnEvent {
  id?: string;
  date?: string;
  name?: string;
  shortName?: string;
  season?: { year: number; type: number };
  week?: { number: number };
  competitions?: EspnCompetition[];
  status?: EspnStatus;
}

interface EspnScoreboard {
  season?: { year: number; type: number };
  week?: { number: number };
  events: unknown[];
}

/* ------------------------------------------------------------------ *
 * Sample loading
 * ------------------------------------------------------------------ */

const SAMPLE_FILES = {
  nfl: new URL('../../docs/samples/espn-nfl-scoreboard.json', import.meta.url),
  cfb: new URL('../../docs/samples/espn-cfb-scoreboard.json', import.meta.url),
  /** One MLB DATE slate: 12 events, 9 scheduled with DraftKings odds, 3 live without. */
  mlb0924: new URL('../../docs/samples/espn-mlb-scoreboard-2026-09-24.json', import.meta.url),
  /** One MLB DATE slate, no odds: 15 finals (one Final/12) and one postponement. */
  mlb0922: new URL('../../docs/samples/espn-mlb-scoreboard-2026-09-22.json', import.meta.url),
} as const;

export type SampleName = keyof typeof SAMPLE_FILES;

/** Parsed once per process; every caller gets a structural clone of it. */
const cache = new Map<SampleName, EspnScoreboard>();

function loadSample(name: SampleName): EspnScoreboard {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const parsed = JSON.parse(readFileSync(SAMPLE_FILES[name], 'utf8')) as EspnScoreboard;
  cache.set(name, parsed);
  return parsed;
}

function cloneSample(name: SampleName): EspnScoreboard {
  return structuredClone(loadSample(name));
}

/** Raw parsed JSON of docs/samples/espn-nfl-scoreboard.json. */
export function nflScoreboard(): unknown {
  return cloneSample('nfl');
}

/** Raw parsed JSON of docs/samples/espn-cfb-scoreboard.json. */
export function cfbScoreboard(): unknown {
  return cloneSample('cfb');
}

/**
 * Raw parsed JSON of an MLB date slate (PLAN.md §23.2): `'2026-09-24'`
 * (docs/samples/espn-mlb-scoreboard-2026-09-24.json) or `'2026-09-22'`.
 */
export function mlbScoreboard(date: '2026-09-24' | '2026-09-22'): unknown {
  return cloneSample(date === '2026-09-24' ? 'mlb0924' : 'mlb0922');
}

/**
 * The `status.type` shapes ESPN actually emits, so an override can name a status
 * by string and still get a coherent `state`/`completed` pair. An unrecognised
 * name is deliberately allowed through with a non-committal `state`, which is
 * how the parser's `unknown` branch gets exercised.
 */
const STATUS_TYPES: Readonly<Record<string, Omit<EspnStatusType, 'name'>>> = {
  STATUS_SCHEDULED: { id: '1', state: 'pre', completed: false, description: 'Scheduled' },
  STATUS_IN_PROGRESS: { id: '2', state: 'in', completed: false, description: 'In Progress' },
  STATUS_HALFTIME: { id: '23', state: 'in', completed: false, description: 'Halftime' },
  STATUS_END_PERIOD: { id: '22', state: 'in', completed: false, description: 'End of Period' },
  STATUS_FINAL: { id: '3', state: 'post', completed: true, description: 'Final' },
  STATUS_POSTPONED: { id: '6', state: 'post', completed: false, description: 'Postponed' },
  STATUS_CANCELED: { id: '5', state: 'post', completed: false, description: 'Canceled' },
  STATUS_FORFEIT: { id: '9', state: 'post', completed: false, description: 'Forfeit' },
};

/** Build a `status` block for a status name, preserving period/clock if given. */
export function makeStatus(name: string, period = 0, displayClock = '0:00'): EspnStatus {
  const known = STATUS_TYPES[name] ?? { state: 'unknown', completed: false, description: name };
  return {
    clock: 0,
    displayClock,
    period,
    type: {
      ...known,
      name,
      detail: known.description ?? name,
      shortDetail: known.description ?? name,
    },
  };
}

/**
 * Deep-clone a sample payload and apply per-event overrides, so a test can say
 * "make event 401872925 FINAL 27-24" without hand-writing 15 KB of JSON.
 *
 * An `eventId` that is not in the sample is a test bug, so it throws rather than
 * silently doing nothing.
 */
export function makeScoreboard(
  base: SampleName,
  overrides: readonly ScoreboardOverride[],
): unknown {
  const payload = cloneSample(base);
  const events = payload.events as EspnEvent[];
  for (const override of overrides) {
    const event = events.find((e) => e.id === override.eventId);
    if (event === undefined) {
      throw new Error(`makeScoreboard: no event ${override.eventId} in the ${base} sample`);
    }
    const competition = event.competitions?.[0];
    if (competition === undefined) {
      throw new Error(`makeScoreboard: event ${override.eventId} has no competition`);
    }

    if (override.status !== undefined) {
      const status = makeStatus(
        override.status,
        competition.status?.period ?? 0,
        competition.status?.displayClock ?? '0:00',
      );
      competition.status = status;
      // Real ESPN keeps event.status and competitions[0].status in lock-step.
      event.status = structuredClone(status);
    }

    if (override.date !== undefined) {
      event.date = override.date;
      competition.date = override.date;
      competition.startDate = override.date;
    }

    const competitors = competition.competitors ?? [];
    if (override.homeScore !== undefined) {
      const home = competitors.find((c) => c.homeAway === 'home');
      if (home !== undefined) home.score = override.homeScore;
    }
    if (override.awayScore !== undefined) {
      const away = competitors.find((c) => c.homeAway === 'away');
      if (away !== undefined) away.score = override.awayScore;
    }

    if (override.dropOdds === true) delete competition.odds;
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Malformed payload — one deliberately broken event per failure mode.
 * ------------------------------------------------------------------ */

function team(id: string, abbr: string, name: string): Record<string, unknown> {
  return {
    id,
    abbreviation: abbr,
    displayName: name,
    shortDisplayName: abbr,
    logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`,
  };
}

function competitor(homeAway: string, id: string, abbr: string, score: string): EspnCompetitor {
  return {
    id,
    homeAway,
    score,
    team: team(id, abbr, `${abbr} Team`),
    curatedRank: { current: 99 },
  };
}

/** The one event in `malformedScoreboard()` that is fully well-formed. */
export const MALFORMED_GOOD_EVENT_ID = 'good-1';

/**
 * Ids of the broken events in `malformedScoreboard()`, in payload order. Each is
 * expected to be skipped with exactly one warning.
 */
export const MALFORMED_BROKEN_EVENT_IDS = [
  'no-competitions',
  'one-competitor',
  'three-competitors',
  'two-home-teams',
  'no-abbreviation',
  'bad-date',
  'no-season',
] as const;

/** A payload with deliberately broken events, for the defensive-parser tests. */
export function malformedScoreboard(): unknown {
  const good: EspnEvent = {
    id: MALFORMED_GOOD_EVENT_ID,
    date: '2026-09-13T17:00Z',
    name: 'Away Team at Home Team',
    shortName: 'AWY @ HOM',
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    competitions: [
      {
        id: MALFORMED_GOOD_EVENT_ID,
        date: '2026-09-13T17:00Z',
        neutralSite: false,
        status: makeStatus('STATUS_SCHEDULED'),
        competitors: [competitor('home', '1', 'HOM', '0'), competitor('away', '2', 'AWY', '0')],
      },
    ],
  };

  const withCompetitors = (id: string, competitors: EspnCompetitor[]): EspnEvent => ({
    id,
    date: '2026-09-13T17:00Z',
    name: 'Broken Game',
    shortName: 'BRK',
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    competitions: [
      { id, date: '2026-09-13T17:00Z', status: makeStatus('STATUS_SCHEDULED'), competitors },
    ],
  });

  const noAbbr = withCompetitors('no-abbreviation', [
    competitor('home', '1', 'HOM', '0'),
    competitor('away', '2', 'AWY', '0'),
  ]);
  const noAbbrTeam = noAbbr.competitions?.[0]?.competitors?.[1]?.team;
  if (noAbbrTeam !== undefined) delete noAbbrTeam['abbreviation'];

  const badDate = withCompetitors('bad-date', [
    competitor('home', '1', 'HOM', '0'),
    competitor('away', '2', 'AWY', '0'),
  ]);
  badDate.date = 'not-a-date';

  const noSeason = withCompetitors('no-season', [
    competitor('home', '1', 'HOM', '0'),
    competitor('away', '2', 'AWY', '0'),
  ]);
  delete noSeason.season;

  return {
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    events: [
      good,
      { id: 'no-competitions', date: '2026-09-13T17:00Z', season: { year: 2026, type: 2 } },
      withCompetitors('one-competitor', [competitor('home', '1', 'HOM', '0')]),
      withCompetitors('three-competitors', [
        competitor('home', '1', 'HOM', '0'),
        competitor('away', '2', 'AWY', '0'),
        competitor('away', '3', 'XTR', '0'),
      ]),
      withCompetitors('two-home-teams', [
        competitor('home', '1', 'HOM', '0'),
        competitor('home', '2', 'AWY', '0'),
      ]),
      noAbbr,
      badDate,
      noSeason,
      null,
      'garbage',
      42,
    ],
  };
}

/* ------------------------------------------------------------------ *
 * The Odds API samples, and the SAME-DATE ESPN captures (PLAN.md §21.7)
 * ------------------------------------------------------------------ */

const ODDS_API_FILES = {
  nfl: new URL('../../docs/samples/odds-api-nfl.json', import.meta.url),
  ncaaf: new URL('../../docs/samples/odds-api-ncaaf.json', import.meta.url),
  /** ESPN, every ET date the NFL API sample spans, merged by scripts/capture-espn-range.mjs. */
  espnNflRange: new URL(
    '../../docs/samples/espn-nfl-scoreboard-2026-09-17..28.json',
    import.meta.url,
  ),
  espnCfbRange: new URL(
    '../../docs/samples/espn-cfb-scoreboard-2026-09-17..26.json',
    import.meta.url,
  ),
} as const;

const oddsCache = new Map<keyof typeof ODDS_API_FILES, unknown>();
function loadOdds(name: keyof typeof ODDS_API_FILES): unknown {
  const cached = oddsCache.get(name);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(ODDS_API_FILES[name], 'utf8'));
  oddsCache.set(name, parsed);
  return parsed;
}

/** Raw parsed JSON of docs/samples/odds-api-nfl.json (32 events, captured 2026-09-16). */
export function oddsApiNfl(): unknown {
  return structuredClone(loadOdds('nfl'));
}
/** Raw parsed JSON of docs/samples/odds-api-ncaaf.json (75 events, captured 2026-09-16). */
export function oddsApiNcaaf(): unknown {
  return structuredClone(loadOdds('ncaaf'));
}
/**
 * ESPN scoreboards MERGED over the six ET dates the NFL API sample spans. The
 * root `season`/`week` describe the first date only — never assert them.
 */
export function espnNflRange(): unknown {
  return structuredClone(loadOdds('espnNflRange'));
}
/** ESPN scoreboards MERGED over the four ET dates the NCAAF API sample spans. */
export function espnCfbRange(): unknown {
  return structuredClone(loadOdds('espnCfbRange'));
}
