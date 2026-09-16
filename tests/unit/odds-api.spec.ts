import { describe, expect, it } from 'vitest';

import { ODDS_API_BOOKMAKERS, SECONDARY_MATCH_WINDOW_MS } from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import {
  mascotOf,
  matchOddsApiEvents,
  normaliseTeamName,
  parseOddsApi,
} from '../../src/shared/odds-api.js';
import type { MatchCandidate, OddsApiEvent } from '../../src/shared/odds-api.js';
import type { League } from '../../src/shared/types.js';
import { cfbScoreboard, espnCfbRange, espnNflRange, oddsApiNcaaf, oddsApiNfl } from './fixtures.js';

/** TDD contract for src/shared/odds-api.ts (M9a). PLAN.md §21.6 / §21.7. */

const FETCHED_AT = Date.parse('2026-09-16T20:00:00Z');
const MIN = 60_000;

/* ------------------------------------------------------------------ *
 * A small builder in the API's documented shape
 * ------------------------------------------------------------------ */

interface Outcome {
  readonly name: string;
  readonly price: unknown;
  readonly point?: unknown;
}
interface BookSpec {
  readonly key: string;
  readonly spreads?: readonly Outcome[];
  readonly totals?: readonly Outcome[];
  readonly h2h?: readonly Outcome[];
}
interface EventSpec {
  readonly id?: string;
  readonly commence_time?: unknown;
  readonly home_team?: unknown;
  readonly away_team?: unknown;
  readonly books?: readonly BookSpec[];
}

const HOME = 'Tampa Bay Buccaneers';
const AWAY = 'Dallas Cowboys';

/** DraftKings offering the full, mirrored, well-formed three markets. */
const DK_SPREADS: readonly Outcome[] = [
  { name: AWAY, price: -109, point: 6.5 },
  { name: HOME, price: -112, point: -6.5 },
];
const DK_TOTALS: readonly Outcome[] = [
  { name: 'Over', price: -110, point: 48.5 },
  { name: 'Under', price: -110, point: 48.5 },
];
const DK_H2H: readonly Outcome[] = [
  { name: AWAY, price: 240 },
  { name: HOME, price: -305 },
];
const DK_FULL: BookSpec = {
  key: 'draftkings',
  spreads: [
    { name: AWAY, price: -109, point: 6.5 },
    { name: HOME, price: -112, point: -6.5 },
  ],
  totals: [
    { name: 'Over', price: -110, point: 48.5 },
    { name: 'Under', price: -110, point: 48.5 },
  ],
  h2h: [
    { name: AWAY, price: 240 },
    { name: HOME, price: -305 },
  ],
};

function apiEvent(spec: EventSpec = {}): unknown {
  const books = spec.books ?? [DK_FULL];
  return {
    id: spec.id ?? 'e1',
    sport_key: 'americanfootball_nfl',
    sport_title: 'NFL',
    commence_time: 'commence_time' in spec ? spec.commence_time : '2026-09-20T17:00:00Z',
    home_team: 'home_team' in spec ? spec.home_team : HOME,
    away_team: 'away_team' in spec ? spec.away_team : AWAY,
    bookmakers: books.map((b) => ({
      key: b.key,
      title: b.key,
      last_update: '2026-09-16T19:00:00Z',
      markets: (['h2h', 'spreads', 'totals'] as const)
        .filter((m) => b[m] !== undefined)
        .map((m) => ({ key: m, last_update: '2026-09-16T19:00:00Z', outcomes: b[m] })),
    })),
  };
}

const parseOne = (spec: EventSpec = {}, league: League = 'nfl'): OddsApiEvent | undefined =>
  parseOddsApi([apiEvent(spec)], league).events[0];

/* ------------------------------------------------------------------ *
 * parseOddsApi — real samples
 * ------------------------------------------------------------------ */

describe('parseOddsApi — real samples', () => {
  it('NFL: 32 events, every one with a kickoff, two names, and a DraftKings-preferred full line', () => {
    const parsed = parseOddsApi(oddsApiNfl(), 'nfl');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.events).toHaveLength(32);
    for (const e of parsed.events) {
      expect(e.league).toBe('nfl');
      expect(Number.isFinite(e.commenceAt)).toBe(true);
      expect(e.homeTeam.length).toBeGreaterThan(0);
      expect(e.awayTeam.length).toBeGreaterThan(0);
      expect(e.markets.spread?.book).toBe('draftkings');
      expect(e.markets.total?.book).toBe('draftkings');
      expect(e.markets.moneyline?.book).toBe('draftkings');
    }
  });

  it('NCAAF: 75 events, zero warnings, zero throws; 15 have no moneyline from any book', () => {
    const parsed = parseOddsApi(oddsApiNcaaf(), 'ncaaf');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.events).toHaveLength(75);
    expect(parsed.events.filter((e) => e.markets.moneyline === null)).toHaveLength(15);
    expect(parsed.events.every((e) => e.markets.spread !== null && e.markets.total !== null)).toBe(
      true,
    );
  });

  it('parses the Texas Tech – Houston line the ESPN feed showed as OFF: DK total 53.5 −105/−115', () => {
    const parsed = parseOddsApi(oddsApiNcaaf(), 'ncaaf');
    const ttu = parsed.events.find((e) => e.homeTeam === 'Texas Tech Red Raiders');
    expect(ttu?.awayTeam).toBe('Houston Cougars');
    expect(ttu?.markets.total).toEqual({
      tenths: 535,
      overPrice: -105,
      underPrice: -115,
      book: 'draftkings',
    });
    expect(ttu?.markets.spread).toEqual({
      homeTenths: -75,
      homePrice: -105,
      awayTenths: 75,
      awayPrice: -115,
      book: 'draftkings',
    });
    expect(ttu?.markets.moneyline).toEqual({ homePrice: -290, awayPrice: 235, book: 'draftkings' });
  });
});

/* ------------------------------------------------------------------ *
 * parseOddsApi — the rules, one at a time
 * ------------------------------------------------------------------ */

describe('parseOddsApi — bookmaker preference and whole-market rule', () => {
  it("draftkings lacking a total picks fanduel's total; the other two markets stay draftkings'", () => {
    const dkNoTotal: BookSpec = { key: 'draftkings', spreads: DK_SPREADS, h2h: DK_H2H };
    const fd: BookSpec = {
      key: 'fanduel',
      spreads: [
        { name: AWAY, price: -105, point: 7 },
        { name: HOME, price: -115, point: -7 },
      ],
      totals: [
        { name: 'Over', price: -114, point: 47.5 },
        { name: 'Under', price: -106, point: 47.5 },
      ],
    };
    // Response order is fanduel FIRST; preference order still wins.
    const e = parseOne({ books: [fd, dkNoTotal] });
    expect(e?.markets.spread).toMatchObject({ book: 'draftkings', homeTenths: -65 });
    expect(e?.markets.moneyline).toMatchObject({ book: 'draftkings', homePrice: -305 });
    expect(e?.markets.total).toEqual({
      tenths: 475,
      overPrice: -114,
      underPrice: -106,
      book: 'fanduel',
    });
  });

  it('a book outside ODDS_API_BOOKMAKERS is never chosen, even when it is the only one', () => {
    const e = parseOne({ books: [{ ...DK_FULL, key: 'mybookieag' }] });
    expect(e?.markets).toEqual({ spread: null, total: null, moneyline: null });
    expect(ODDS_API_BOOKMAKERS).not.toContain('mybookieag');
  });

  it('a whole market comes from ONE book: a half-usable draftkings spread falls through to fanduel entirely', () => {
    const dkHalf: BookSpec = {
      key: 'draftkings',
      spreads: [{ name: AWAY, price: -109, point: 6.5 }], // one side only
      totals: DK_TOTALS,
    };
    const fd: BookSpec = {
      key: 'fanduel',
      spreads: [
        { name: AWAY, price: -101, point: 7 },
        { name: HOME, price: -119, point: -7 },
      ],
    };
    const e = parseOne({ books: [dkHalf, fd] });
    expect(e?.markets.spread).toEqual({
      homeTenths: -70,
      homePrice: -119,
      awayTenths: 70,
      awayPrice: -101,
      book: 'fanduel',
    });
    expect(e?.markets.total?.book).toBe('draftkings');
  });
});

describe('parseOddsApi — points and prices', () => {
  it('point 7.5 → 75 tenths, 53 → 530, -3.5 → -35', () => {
    const e = parseOne({
      books: [
        {
          key: 'draftkings',
          spreads: [
            { name: AWAY, price: -110, point: 3.5 },
            { name: HOME, price: -110, point: -3.5 },
          ],
          totals: [
            { name: 'Over', price: -110, point: 53 },
            { name: 'Under', price: -110, point: 53 },
          ],
        },
      ],
    });
    expect(e?.markets.spread).toMatchObject({ homeTenths: -35, awayTenths: 35 });
    expect(e?.markets.total?.tenths).toBe(530);
    expect(
      parseOne({
        books: [
          {
            key: 'draftkings',
            spreads: [
              { name: AWAY, price: -110, point: 7.5 },
              { name: HOME, price: -110, point: -7.5 },
            ],
          },
        ],
      })?.markets.spread?.awayTenths,
    ).toBe(75);
  });

  it('point 7.55 is DROPPED with a warning, never rounded', () => {
    const parsed = parseOddsApi(
      [
        apiEvent({
          books: [
            {
              key: 'draftkings',
              spreads: [
                { name: AWAY, price: -110, point: 7.55 },
                { name: HOME, price: -110, point: -7.55 },
              ],
              totals: DK_TOTALS,
            },
          ],
        }),
      ],
      'nfl',
    );
    expect(parsed.events[0]?.markets.spread).toBeNull();
    expect(parsed.events[0]?.markets.total).not.toBeNull();
    expect(parsed.warnings.some((w) => w.reason.includes('spread'))).toBe(true);
  });

  it('a spread whose two points do not mirror is dropped with a warning', () => {
    const parsed = parseOddsApi(
      [
        apiEvent({
          books: [
            {
              key: 'draftkings',
              spreads: [
                { name: AWAY, price: -110, point: 6.5 },
                { name: HOME, price: -110, point: -7.5 },
              ],
            },
          ],
        }),
      ],
      'nfl',
    );
    expect(parsed.events[0]?.markets.spread).toBeNull();
    expect(parsed.warnings.some((w) => w.reason.includes('mirror'))).toBe(true);
  });

  it('a total whose two points differ is dropped with a warning', () => {
    const parsed = parseOddsApi(
      [
        apiEvent({
          books: [
            {
              key: 'draftkings',
              totals: [
                { name: 'Over', price: -110, point: 48.5 },
                { name: 'Under', price: -110, point: 49.5 },
              ],
            },
          ],
        }),
      ],
      'nfl',
    );
    expect(parsed.events[0]?.markets.total).toBeNull();
    expect(parsed.warnings.some((w) => w.reason.includes('total'))).toBe(true);
  });

  it('a market with one outcome is dropped', () => {
    const e = parseOne({ books: [{ key: 'draftkings', h2h: [{ name: HOME, price: -305 }] }] });
    expect(e?.markets.moneyline).toBeNull();
  });

  it('prices of -99, 0 and 100001 are out of bounds and drop the market', () => {
    for (const bad of [-99, 0, 100_001]) {
      const e = parseOne({
        books: [
          {
            key: 'draftkings',
            h2h: [
              { name: AWAY, price: bad },
              { name: HOME, price: -305 },
            ],
          },
        ],
      });
      expect(e?.markets.moneyline, String(bad)).toBeNull();
    }
  });

  it('an outcome named neither team drops that market with a warning; other markets survive', () => {
    const parsed = parseOddsApi(
      [
        apiEvent({
          books: [
            {
              key: 'draftkings',
              h2h: [
                { name: 'Buffalo Bills', price: 240 },
                { name: HOME, price: -305 },
              ],
              totals: DK_TOTALS,
            },
          ],
        }),
      ],
      'nfl',
    );
    expect(parsed.events[0]?.markets.moneyline).toBeNull();
    expect(parsed.events[0]?.markets.total).not.toBeNull();
    expect(parsed.warnings.some((w) => w.reason.includes('Buffalo Bills'))).toBe(true);
  });

  it('a spread outcome named by the wrong team keeps the OTHER books in play', () => {
    const dkBad: BookSpec = {
      key: 'draftkings',
      spreads: [
        { name: 'Buffalo Bills', price: -110, point: 6.5 },
        { name: HOME, price: -110, point: -6.5 },
      ],
    };
    const e = parseOne({ books: [dkBad, { key: 'betmgm', spreads: DK_SPREADS }] });
    expect(e?.markets.spread?.book).toBe('betmgm');
  });
});

describe('parseOddsApi — totality', () => {
  it('commence_time unparseable or absent skips the event with a warning', () => {
    for (const bad of [undefined, 'yesterday', 42, null]) {
      const parsed = parseOddsApi([apiEvent({ commence_time: bad })], 'nfl');
      expect(parsed.events).toHaveLength(0);
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]?.eventId).toBe('e1');
    }
  });

  it('a missing or empty team name skips the event', () => {
    expect(parseOddsApi([apiEvent({ home_team: '' })], 'nfl').events).toHaveLength(0);
    expect(parseOddsApi([apiEvent({ away_team: 7 })], 'nfl').events).toHaveLength(0);
  });

  it('a payload that is not an array yields zero events and one structural warning', () => {
    for (const junk of [{}, null, 'x', 7, undefined]) {
      const parsed = parseOddsApi(junk, 'nfl');
      expect(parsed.events).toEqual([]);
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]?.eventId).toBeNull();
    }
  });

  it('an array of nulls and garbage yields zero events, one warning each, no throw', () => {
    const parsed = parseOddsApi([null, 'garbage', 3, []], 'nfl');
    expect(parsed.events).toEqual([]);
    expect(parsed.warnings).toHaveLength(4);
  });

  it('an event with all three markets unusable is still RETURNED', () => {
    const e = parseOne({ books: [] });
    expect(e).toBeDefined();
    expect(e?.markets).toEqual({ spread: null, total: null, moneyline: null });
    expect(e?.homeTeam).toBe(HOME);
  });

  it('never throws on values JSON.stringify cannot serialise', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() =>
      parseOddsApi(
        [
          apiEvent({
            books: [
              {
                key: 'draftkings',
                h2h: [
                  { name: AWAY, price: circular },
                  { name: HOME, price: 10n },
                ],
              },
            ],
          }),
        ],
        'nfl',
      ),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * normaliseTeamName / mascotOf
 * ------------------------------------------------------------------ */

describe('normaliseTeamName', () => {
  it('collapses exactly the two measured pairs that differ only in accents / punctuation', () => {
    expect(normaliseTeamName('San José State Spartans')).toBe(
      normaliseTeamName('San Jose State Spartans'),
    );
    expect(normaliseTeamName("Louisiana Ragin' Cajuns")).toBe(
      normaliseTeamName('Louisiana Ragin Cajuns'),
    );
  });

  it("does NOT collapse the six measured prefix abbreviations — that is pass 2's job", () => {
    const pairs: [string, string][] = [
      ['Massachusetts Minutemen', 'UMass Minutemen'],
      ['App State Mountaineers', 'Appalachian State Mountaineers'],
      ['Sam Houston Bearkats', 'Sam Houston State Bearkats'],
      ['Southern Miss Golden Eagles', 'Southern Mississippi Golden Eagles'],
      ['Nicholls Colonels', 'Nicholls State Colonels'],
      ['SE Louisiana Lions', 'Southeastern Louisiana Lions'],
    ];
    for (const [a, b] of pairs) expect(normaliseTeamName(a), a).not.toBe(normaliseTeamName(b));
  });

  it('is lowercase alphanumerics only', () => {
    expect(normaliseTeamName("  Hawai'i Rainbow Warriors ")).toBe('hawaiirainbowwarriors');
    expect(normaliseTeamName('Miami (OH) RedHawks')).toBe('miamiohredhawks');
    expect(normaliseTeamName('Texas A&M Aggies')).toBe('texasamaggies');
  });
});

describe('mascotOf', () => {
  it('is the normalised LAST token', () => {
    expect(mascotOf('Southern Miss Golden Eagles')).toBe('eagles');
    expect(mascotOf('Southern Mississippi Golden Eagles')).toBe('eagles');
    expect(mascotOf('UMass Minutemen')).toBe('minutemen');
    expect(mascotOf("Louisiana Ragin' Cajuns")).toBe('cajuns');
    expect(mascotOf('')).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * matchOddsApiEvents
 * ------------------------------------------------------------------ */

function candidatesOf(payload: unknown, league: League): MatchCandidate[] {
  return parseScoreboard(payload, league, FETCHED_AT).games.map((g) => ({
    gameId: g.id,
    league: g.league,
    kickoffAt: g.kickoffAt,
    homeName: g.home.name,
    awayName: g.away.name,
    label: g.shortName,
  }));
}

const cand = (over: Partial<MatchCandidate> & { gameId: string }): MatchCandidate => ({
  league: 'nfl',
  kickoffAt: Date.parse('2026-09-20T17:00:00Z'),
  homeName: HOME,
  awayName: AWAY,
  label: 'DAL @ TB',
  ...over,
});
const ev = (over: Partial<OddsApiEvent> & { eventId: string }): OddsApiEvent => ({
  league: 'nfl',
  commenceAt: Date.parse('2026-09-20T17:00:00Z'),
  homeTeam: HOME,
  awayTeam: AWAY,
  markets: { spread: null, total: null, moneyline: null },
  ...over,
});

describe('matchOddsApiEvents — the measured counts, reproduced from the committed captures', () => {
  const exactKey = (h: string, a: string): string =>
    `${normaliseTeamName(h)}|${normaliseTeamName(a)}`;

  it('NFL: pass 1 alone matches 32/32, and the full matcher agrees', () => {
    const events = parseOddsApi(oddsApiNfl(), 'nfl').events;
    const candidates = candidatesOf(espnNflRange(), 'nfl');
    const keys = new Set(candidates.map((c) => exactKey(c.homeName, c.awayName)));
    expect(events.filter((e) => keys.has(exactKey(e.homeTeam, e.awayTeam)))).toHaveLength(32);
    const out = matchOddsApiEvents(candidates, events);
    expect(out.matched.size).toBe(32);
    expect(out.unmatchedEvents).toBe(0);
    expect(out.swappedCandidates).toEqual([]);
  });

  it('NCAAF: pass 1 alone matches 68/75; pass 2 recovers all five abbreviation misses (73/75); the two neutral-site swaps are refused', () => {
    const events = parseOddsApi(oddsApiNcaaf(), 'ncaaf').events;
    const candidates = candidatesOf(espnCfbRange(), 'ncaaf');
    const keys = new Set(candidates.map((c) => exactKey(c.homeName, c.awayName)));
    expect(events.filter((e) => keys.has(exactKey(e.homeTeam, e.awayTeam)))).toHaveLength(68);
    const out = matchOddsApiEvents(candidates, events);
    expect(out.matched.size).toBe(73);
    expect(out.unmatchedEvents).toBe(2);
    // ESPN names both as neutral-site "VS" games with the teams the other way
    // round from the API. Refused on purpose: a swapped match would put the
    // wrong sign on every spread (PLAN.md §21.7).
    expect(out.swappedCandidates).toEqual(['ASU VS KU', 'WVU VS UVA']);
    // Every match is the same two teams by mascot, in orientation.
    for (const [gameId, e] of out.matched) {
      const c = candidates.find((x) => x.gameId === gameId);
      expect(mascotOf(c?.homeName ?? '')).toBe(mascotOf(e.homeTeam));
      expect(mascotOf(c?.awayName ?? '')).toBe(mascotOf(e.awayTeam));
    }
  });

  it('kickoffs agree: over the matched pairs the median |diff| is 0 and the max ≤ 30 min (sizes SECONDARY_MATCH_WINDOW_MS)', () => {
    const diffs: number[] = [];
    for (const [league, api, espn] of [
      ['nfl', oddsApiNfl(), espnNflRange()],
      ['ncaaf', oddsApiNcaaf(), espnCfbRange()],
    ] as const) {
      const candidates = candidatesOf(espn, league);
      const out = matchOddsApiEvents(candidates, parseOddsApi(api, league).events);
      for (const [gameId, e] of out.matched) {
        const c = candidates.find((x) => x.gameId === gameId);
        diffs.push(Math.abs((c?.kickoffAt ?? 0) - e.commenceAt));
      }
    }
    diffs.sort((a, b) => a - b);
    expect(diffs.length).toBeGreaterThanOrEqual(101);
    expect(diffs[diffs.length >> 1]).toBe(0);
    expect(diffs[diffs.length - 1]).toBeLessThanOrEqual(30 * MIN);
    expect(30 * MIN).toBeLessThan(SECONDARY_MATCH_WINDOW_MS);
  });
});

describe('matchOddsApiEvents — pass 2, the mascot fallback', () => {
  it('fires for "Massachusetts Minutemen" vs "UMass Minutemen"', () => {
    const c = cand({
      gameId: 'ncaaf:1',
      league: 'ncaaf',
      homeName: 'Massachusetts Minutemen',
      awayName: 'Stonehill Skyhawks',
    });
    const e = ev({
      eventId: 'x',
      league: 'ncaaf',
      homeTeam: 'UMass Minutemen',
      awayTeam: 'Stonehill Skyhawks',
    });
    const out = matchOddsApiEvents([c], [e]);
    expect(out.matched.get('ncaaf:1')).toBe(e);
    expect(out.unmatchedGames).toEqual([]);
  });

  it('REFUSES when two events within 90 min share both mascots', () => {
    const c = cand({
      gameId: 'ncaaf:1',
      league: 'ncaaf',
      homeName: 'Auburn Tigers',
      awayName: 'Southern Miss Golden Eagles',
    });
    const e1 = ev({
      eventId: 'a',
      league: 'ncaaf',
      homeTeam: 'Auburn Tigers',
      awayTeam: 'Southern Mississippi Golden Eagles',
    });
    const e2 = ev({
      eventId: 'b',
      league: 'ncaaf',
      homeTeam: 'Clemson Tigers',
      awayTeam: 'Georgia Southern Eagles',
      commenceAt: e1.commenceAt + 40 * MIN,
    });
    const out = matchOddsApiEvents([c], [e1, e2]);
    expect(out.matched.size).toBe(0);
    expect(out.unmatchedGames).toEqual([c.label]);
    expect(out.unmatchedEvents).toBe(2);
  });

  it('REFUSES in the other direction too: the committed Auburn / Clemson pair plus ONE event', () => {
    // Driven from docs/samples/espn-cfb-scoreboard.json, not synthesised.
    const candidates = candidatesOf(cfbScoreboard(), 'ncaaf');
    const auburn = candidates.find((c) => c.homeName === 'Auburn Tigers');
    const clemson = candidates.find((c) => c.homeName === 'Clemson Tigers');
    expect(auburn?.awayName).toBe('Southern Miss Golden Eagles');
    expect(clemson?.awayName).toBe('Georgia Southern Eagles');
    expect(Math.abs((auburn?.kickoffAt ?? 0) - (clemson?.kickoffAt ?? 0))).toBeLessThanOrEqual(
      90 * MIN,
    );
    // The API carries only Auburn's game, under the un-abbreviated name.
    const e = ev({
      eventId: 'a',
      league: 'ncaaf',
      homeTeam: 'Auburn Tigers',
      awayTeam: 'Southern Mississippi Golden Eagles',
      commenceAt: auburn?.kickoffAt ?? 0,
    });
    const out = matchOddsApiEvents([auburn!, clemson!], [e]);
    expect(out.matched.size).toBe(0);
    expect(out.unmatchedEvents).toBe(1);
    expect(out.unmatchedGames).toHaveLength(2);
  });

  it('refuses at 91 minutes and accepts at 90', () => {
    const base = Date.parse('2026-09-19T20:00:00Z');
    const c = cand({
      gameId: 'ncaaf:1',
      league: 'ncaaf',
      homeName: 'Massachusetts Minutemen',
      awayName: 'Stonehill Skyhawks',
      kickoffAt: base,
    });
    const far = ev({
      eventId: 'x',
      league: 'ncaaf',
      homeTeam: 'UMass Minutemen',
      awayTeam: 'Stonehill Skyhawks',
      commenceAt: base + 91 * MIN,
    });
    expect(matchOddsApiEvents([c], [far]).matched.size).toBe(0);
    const near = { ...far, commenceAt: base + 90 * MIN };
    expect(matchOddsApiEvents([c], [near]).matched.size).toBe(1);
  });

  it('an oriented swap is refused and named in swappedCandidates', () => {
    const c = cand({ gameId: 'nfl:1' });
    const swapped = ev({ eventId: 'x', homeTeam: AWAY, awayTeam: HOME });
    const out = matchOddsApiEvents([c], [swapped]);
    expect(out.matched.size).toBe(0);
    expect(out.swappedCandidates).toEqual([c.label]);
    expect(out.unmatchedGames).toEqual([c.label]);
  });

  it('never matches across leagues, even on identical names and kickoffs', () => {
    const c = cand({ gameId: 'ncaaf:1', league: 'ncaaf' });
    const e = ev({ eventId: 'x', league: 'nfl' });
    expect(matchOddsApiEvents([c], [e]).matched.size).toBe(0);
  });

  it('a rescheduled candidate (kickoff moved 6 h) still matches in pass 1', () => {
    const c = cand({ gameId: 'nfl:1', kickoffAt: Date.parse('2026-09-20T23:00:00Z') });
    const e = ev({ eventId: 'x' });
    expect(matchOddsApiEvents([c], [e]).matched.get('nfl:1')).toBe(e);
  });

  it('unmatched events are counted, unmatched candidates are named', () => {
    const c = cand({
      gameId: 'nfl:1',
      homeName: 'Buffalo Bills',
      awayName: 'New York Jets',
      label: 'NYJ @ BUF',
    });
    const out = matchOddsApiEvents(
      [c],
      [ev({ eventId: 'x' }), ev({ eventId: 'y', homeTeam: 'Miami Dolphins' })],
    );
    expect(out.matched.size).toBe(0);
    expect(out.unmatchedEvents).toBe(2);
    expect(out.unmatchedGames).toEqual(['NYJ @ BUF']);
  });

  it('never throws on empty inputs', () => {
    expect(matchOddsApiEvents([], []).matched.size).toBe(0);
  });
});
