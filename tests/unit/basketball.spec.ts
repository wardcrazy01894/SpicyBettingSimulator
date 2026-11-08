/**
 * Basketball, college and NBA (M13c / M13d) — the pure contracts, written FIRST
 * (PLAN.md §24.15) as `it.todo`s and discharged by the milestone named in each
 * `describe`. M13c added `'ncaab'` and `'nba'` to `LEAGUES` and discharged its
 * own: the board windows, the parser on the three committed captures, pull
 * counting, `gameAction` and `postponedVoidConfirmAt`, and the teaser refusal.
 * M13d discharged the board-filter contracts (`src/web/lib/board-filter.ts`).
 *
 * The URL contracts and the truncation warning are about `src/worker/espn.ts`,
 * which this node project cannot import (the tsconfig boundary): they are real
 * tests in `tests/worker/basketball.spec.ts`'s "ESPN URLs" describe.
 */
import { describe, expect, it } from 'vitest';

import { FULL_ACTION, gameAction, postponedVoidConfirmAt } from '../../src/shared/action.js';
import type { GameCard } from '../../src/shared/api-types.js';
import {
  CBB_CONFERENCES,
  CFB_CONFERENCES,
  MLB_POSTPONED_CONFIRM_MS,
  NBA_BOARD_ET_DAYS,
  NCAAB_BOARD_ET_DAYS,
  SECONDARY_LEAGUES,
  TEASABLE_LEAGUES,
} from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import { boardWindowEnd, etDateKey, etDayBounds, etDaysEnd } from '../../src/shared/time.js';
import { LEAGUES } from '../../src/shared/types.js';
import type { Game, League } from '../../src/shared/types.js';
import { isTeasableLeague } from '../../src/shared/validate.js';
import {
  BOARD_FILTERS,
  OTHER_CONFERENCE,
  boardFilterOptions,
  defaultBoardFilter,
  filterGames,
} from '../../src/web/lib/board-filter.js';
import { ncaabScoreboard, nbaScoreboard } from './fixtures.js';

const HOUR = 60 * 60 * 1000;
const FETCHED_AT = Date.parse('2026-11-07T07:40:00Z');

/** The end of the ET date `n` dates after `now`'s, walked by `etDayBounds` alone. */
function endOfEtDatePlus(now: number, n: number): number {
  let end = etDayBounds(now).endAt;
  for (let i = 0; i < n; i += 1) end = etDayBounds(end).endAt;
  return end - 1;
}

describe('M13c: board windows (PLAN.md §24.10)', () => {
  it("boardWindowEnd('ncaab') is the last ms of the second ET date after today (NCAAB_BOARD_ET_DAYS)", () => {
    expect(NCAAB_BOARD_ET_DAYS).toBe(3);
    // Saturday 2026-11-07, every hour of the ET day: the window ends at the
    // last millisecond of Monday 11-09 ET (EST, so 05:00Z on 11-10, minus 1).
    const day = etDayBounds(Date.parse('2026-11-07T17:00:00Z'));
    for (let now = day.startAt; now < day.endAt; now += HOUR) {
      expect(boardWindowEnd('ncaab', now)).toBe(Date.parse('2026-11-10T05:00:00Z') - 1);
      expect(boardWindowEnd('ncaab', now)).toBe(endOfEtDatePlus(now, 2));
    }
    expect(etDateKey(boardWindowEnd('ncaab', day.startAt))).toBe('20261109');
    // At ET midnight it rolls a whole date.
    expect(etDateKey(boardWindowEnd('ncaab', day.endAt))).toBe('20261110');
  });

  it("boardWindowEnd('nba') is the last ms of tomorrow's ET date (NBA_BOARD_ET_DAYS)", () => {
    expect(NBA_BOARD_ET_DAYS).toBe(2);
    const day = etDayBounds(Date.parse('2026-11-07T17:00:00Z'));
    for (let now = day.startAt; now < day.endAt; now += HOUR) {
      expect(boardWindowEnd('nba', now)).toBe(Date.parse('2026-11-09T05:00:00Z') - 1);
      expect(boardWindowEnd('nba', now)).toBe(endOfEtDatePlus(now, 1));
    }
    expect(etDateKey(boardWindowEnd('nba', day.endAt - 1))).toBe('20261108');
  });

  it('both are right across 2026-11-01 (25 h) and 2027-03-14 (23 h)', () => {
    // Fall back. Friday 10-30 noon EDT: college's third date IS the 25 h
    // Sunday, which ends at 05:00Z (EST) on 11-02.
    const fri = Date.parse('2026-10-30T16:00:00Z');
    expect(boardWindowEnd('ncaab', fri)).toBe(Date.parse('2026-11-02T05:00:00Z') - 1);
    // Saturday 10-31 noon EDT: the NBA's tomorrow is the 25 h Sunday.
    const sat = Date.parse('2026-10-31T16:00:00Z');
    expect(boardWindowEnd('nba', sat)).toBe(Date.parse('2026-11-02T05:00:00Z') - 1);
    // ON the 25 h day, 23:30 EST (04:30Z on 11-02): still Sunday's windows.
    const sunLate = Date.parse('2026-11-02T04:30:00Z');
    expect(etDateKey(sunLate)).toBe('20261101');
    expect(boardWindowEnd('nba', sunLate)).toBe(Date.parse('2026-11-03T05:00:00Z') - 1);
    expect(boardWindowEnd('ncaab', sunLate)).toBe(Date.parse('2026-11-04T05:00:00Z') - 1);

    // Spring forward. Saturday 2027-03-13 noon EST.
    const mar = Date.parse('2027-03-13T17:00:00Z');
    expect(boardWindowEnd('nba', mar)).toBe(Date.parse('2027-03-15T04:00:00Z') - 1);
    expect(boardWindowEnd('ncaab', mar)).toBe(Date.parse('2027-03-16T04:00:00Z') - 1);
    // ON the 23 h day, 23:30 EDT (03:30Z on 03-15).
    const marLate = Date.parse('2027-03-15T03:30:00Z');
    expect(etDateKey(marLate)).toBe('20270314');
    expect(boardWindowEnd('nba', marLate)).toBe(Date.parse('2027-03-16T04:00:00Z') - 1);
  });

  it("boardWindowEnd('mlb') is byte-identical to before", () => {
    // The pre-M13c arm was `etDayBounds(now).endAt - 1`; it is now
    // `etDaysEnd(now, 1)`. Every hour of a span crossing both DST days.
    const start = Date.parse('2026-10-25T00:00:00Z');
    const stop = Date.parse('2027-03-21T00:00:00Z');
    for (let now = start; now < stop; now += HOUR) {
      expect(boardWindowEnd('mlb', now)).toBe(etDayBounds(now).endAt - 1);
      expect(etDaysEnd(now, 1)).toBe(etDayBounds(now).endAt - 1);
    }
  });
});

describe('M13c: ESPN URLs and parser (PLAN.md §24.2, §24.10)', () => {
  // The three URL todos and the truncation warning are real tests in
  // tests/worker/basketball.spec.ts (src/worker/espn.ts is outside this
  // project's tsconfig boundary).

  it('the 11-07 college capture parses 61 games with conference ids and 48 line rows', () => {
    const parsed = parseScoreboard(ncaabScoreboard(), 'ncaab', FETCHED_AT);
    expect(parsed.games).toHaveLength(61);
    expect(parsed.lines).toHaveLength(48);
    // Every game carries at least one conference id (a morning capture); the
    // 13 without two are D-I teams hosting non-D-I opponents, whose side has
    // none. 47 of the 48 line rows carry all three markets.
    expect(
      parsed.games.filter((g) => g.home.conferenceId !== null || g.away.conferenceId !== null),
    ).toHaveLength(61);
    expect(
      parsed.games.filter((g) => g.home.conferenceId !== null && g.away.conferenceId !== null),
    ).toHaveLength(48);
    expect(
      parsed.lines.filter((l) => l.spread !== null && l.total !== null && l.moneyline !== null),
    ).toHaveLength(47);
    // No warnings at all: every basketball total (140–240 points) parses since
    // MAX_ABS_LINE_TENTHS became ±400 points, and the pull is counted.
    expect(parsed.warnings).toEqual([]);
    // ESPN names the season for the year it ends, and sends no week.
    expect(new Set(parsed.games.map((g) => g.season))).toEqual(new Set([2027]));
    expect(parsed.games.every((g) => g.week === null)).toBe(true);
    expect(parsed.games.every((g) => g.status === 'scheduled' && g.period === 0)).toBe(true);
    expect(parsed.games.every((g) => g.id.startsWith('ncaab:'))).toBe(true);
    // Rank: curatedRank 1..25 kept, 99 is null.
    const lou = parsed.games.find((g) => g.shortName === 'MORE @ LOU');
    expect(lou?.home).toMatchObject({ abbr: 'LOU', rank: 11, conferenceId: '2' });
  });

  it('the 11-07 capture with conferenceId stripped (the game-day shape) parses with NULL conference ids', () => {
    const payload = ncaabScoreboard() as {
      events: { competitions: { competitors: { team: Record<string, unknown> }[] }[] }[];
    };
    for (const event of payload.events) {
      for (const c of event.competitions[0]?.competitors ?? []) delete c.team['conferenceId'];
    }
    const parsed = parseScoreboard(payload, 'ncaab', FETCHED_AT);
    expect(parsed.games).toHaveLength(61);
    expect(parsed.lines).toHaveLength(48);
    expect(parsed.warnings).toEqual([]);
    expect(
      parsed.games.every((g) => g.home.conferenceId === null && g.away.conferenceId === null),
    ).toBe(true);
  });

  it('the "OFF" moneyline is counted as pulled, not warned, and still withdraws the market', () => {
    const parsed = parseScoreboard(ncaabScoreboard(), 'ncaab', FETCHED_AT);
    expect(parsed.pulled).toBe(1);
    expect(parsed.warnings).toEqual([]);
    const lou = parsed.games.find((g) => g.shortName === 'MORE @ LOU');
    const line = parsed.lines.find((l) => l.gameId === lou?.id);
    // Louisville −36.5: the spread and total are up, the moneyline is null —
    // a row is still written, so a stored moneyline would be withdrawn.
    expect(line).toMatchObject({
      provider: 'DraftKings',
      spread: { homeTenths: -365, homePrice: -112, awayTenths: 365, awayPrice: -108 },
      total: { tenths: 1515, overPrice: -105, underPrice: -115 },
      moneyline: null,
    });
  });

  it('the 11-07 NBA capture parses 7 games, 6 priced; the top-level spread is the home line', () => {
    const parsed = parseScoreboard(nbaScoreboard('2026-11-07'), 'nba', FETCHED_AT);
    expect(parsed.games).toHaveLength(7);
    expect(parsed.lines).toHaveLength(6);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.pulled).toBe(0);
    const live = parsed.games.filter((g) => g.status === 'in_progress');
    expect(live).toHaveLength(1);
    expect(live[0]?.period).toBe(4); // quarters
    // No week, no conference, no rank.
    expect(
      parsed.games.every(
        (g) => g.week === null && g.home.rank === null && g.home.conferenceId === null,
      ),
    ).toBe(true);
    // NY @ CLE: details "NY -4.5", top-level `spread` 4.5 = the HOME (CLE) line.
    const cle = parsed.games.find((g) => g.shortName === 'NY @ CLE');
    expect(parsed.lines.find((l) => l.gameId === cle?.id)).toMatchObject({
      spread: { homeTenths: 45, homePrice: -108, awayTenths: -45, awayPrice: -112 },
      total: { tenths: 2225, overPrice: -115, underPrice: -105 },
      moneyline: { homePrice: 164, awayPrice: -197 },
    });
    // The +1 capture: lines a day AHEAD, 6 of 7 priced.
    const tomorrow = parseScoreboard(nbaScoreboard('2026-11-08'), 'nba', FETCHED_AT);
    expect(tomorrow.games).toHaveLength(7);
    expect(tomorrow.lines).toHaveLength(6);
    expect(tomorrow.warnings).toEqual([]);
  });
});

describe('M13c: settlement (PLAN.md §24.11)', () => {
  it('gameAction gives FULL_ACTION for a final in both leagues, overtime included, period NULL included', () => {
    // College: 2 = regulation, 3 = OT, 4 = 2OT. NBA: 4 = regulation, 5, 6 = OT.
    for (const [league, periods] of [
      ['ncaab', [2, 3, 4, 5, null]],
      ['nba', [4, 5, 6, null]],
    ] as const) {
      for (const period of periods) {
        expect(gameAction(league, { status: 'final', period }), `${league} ${String(period)}`).toBe(
          FULL_ACTION,
        );
      }
      // Any other status: FULL_ACTION too (gradeLeg has already decided).
      for (const status of ['in_progress', 'scheduled', 'postponed'] as const) {
        expect(gameAction(league, { status, period: 1 })).toBe(FULL_ACTION);
      }
    }
  });

  it('postponedVoidConfirmAt is windowEndAt + MLB_POSTPONED_CONFIRM_MS for both leagues', () => {
    const windowEnd = etDayBounds(Date.parse('2026-11-07T17:00:00Z')).endAt;
    for (const league of ['ncaab', 'nba', 'mlb'] as const) {
      expect(postponedVoidConfirmAt(league, windowEnd)).toBe(windowEnd + MLB_POSTPONED_CONFIRM_MS);
    }
    // 03:00 EST on 11-08 = 08:00Z.
    expect(postponedVoidConfirmAt('nba', windowEnd)).toBe(Date.parse('2026-11-08T08:00:00Z'));
    expect(postponedVoidConfirmAt('nfl', windowEnd)).toBeNull();
    expect(postponedVoidConfirmAt('ncaaf', windowEnd)).toBeNull();
  });

  it('basketball legs cannot be teased (TEASABLE_LEAGUES)', () => {
    expect(isTeasableLeague('ncaab')).toBe(false);
    expect(isTeasableLeague('nba')).toBe(false);
    // The football-only lists are UNCHANGED and still type-check as League[].
    const teasable: readonly League[] = TEASABLE_LEAGUES;
    const secondary: readonly League[] = SECONDARY_LEAGUES;
    expect(teasable).toEqual(['nfl', 'ncaaf']);
    expect(secondary).toEqual(['nfl', 'ncaaf']);
    expect(LEAGUES).toEqual(['nfl', 'ncaaf', 'mlb', 'ncaab', 'nba']);
  });
});

describe('M13d: the board filter (PLAN.md §24.14)', () => {
  const captured = parseScoreboard(ncaabScoreboard, 'ncaab', FETCHED_AT).games;

  /** A board card for a parsed capture game (GameTeamView is GameTeam's shape). */
  function toCard(game: Game): GameCard {
    const { name: _name, shortName: _short, originalKickoffAt: _orig, ...rest } = game;
    return { ...rest, lockAt: game.kickoffAt, bettable: false, lines: null };
  }

  /** A card from the committed capture, conference ids and ranks overridden per side. */
  function cbbCard(
    id: string,
    home: { conf: string | null; rank?: number },
    away: { conf: string | null; rank?: number },
  ): GameCard {
    const base = toCard(captured[0] ?? fail());
    return {
      ...base,
      id,
      home: { ...base.home, conferenceId: home.conf, rank: home.rank ?? null },
      away: { ...base.away, conferenceId: away.conf, rank: away.rank ?? null },
    };
  }

  it('ncaab offers CBB_CONFERENCES with default top25', () => {
    const spec = BOARD_FILTERS.ncaab;
    expect(spec).not.toBeNull();
    expect(spec?.conferences).toBe(CBB_CONFERENCES);
    expect(spec?.defaultFilter).toBe('top25');
    expect(defaultBoardFilter('ncaab')).toBe('top25');
    expect(CBB_CONFERENCES).toHaveLength(32);
    const values = boardFilterOptions(BOARD_FILTERS.ncaab ?? fail()).map((o) => o.value);
    expect(values).toEqual([
      'all',
      'top25',
      ...CBB_CONFERENCES.map((c) => `conf:${c.id}`),
      OTHER_CONFERENCE,
    ]);
    // BASKETBALL ids: the SEC is 23 here (8 in football, where 8 is the Big 12).
    const sec = cbbCard('sec', { conf: '23' }, { conf: '23' });
    const b12 = cbbCard('b12', { conf: '8', rank: 4 }, { conf: '8' });
    expect(filterGames('ncaab', [sec, b12], 'conf:23').map((g) => g.id)).toEqual(['sec']);
    expect(filterGames('ncaab', [sec, b12], 'top25').map((g) => g.id)).toEqual(['b12']);
  });

  it('"Other" includes games with no conference id', () => {
    const noId = cbbCard('none', { conf: null }, { conf: null });
    const unlisted = cbbCard('indy', { conf: '999' }, { conf: '999' });
    const acc = cbbCard('acc', { conf: '2' }, { conf: '2' });
    expect(filterGames('ncaab', [noId, unlisted, acc], OTHER_CONFERENCE).map((g) => g.id)).toEqual(
      ['none', 'indy'],
    );
    // The real capture: games first seen on their own ET day carry no
    // conference id (§24.2), and every one of them lands in "Other".
    const cards = captured.map(toCard);
    const unfiled = cards.filter(
      (g) => g.home.conferenceId === null || g.away.conferenceId === null,
    );
    expect(unfiled.length).toBeGreaterThan(0);
    const other = filterGames('ncaab', cards, OTHER_CONFERENCE);
    for (const g of unfiled) expect(other).toContain(g);
  });

  it('nba, nfl and mlb have no filter; ncaaf keeps CFB_CONFERENCES with default all', () => {
    for (const league of ['nba', 'nfl', 'mlb'] as const) {
      expect(BOARD_FILTERS[league]).toBeNull();
      expect(defaultBoardFilter(league)).toBe('all');
      // No filter means the slate is untouched, whatever filter value is held.
      const slate = [cbbCard('x', { conf: null }, { conf: null })];
      expect(filterGames(league, slate, 'top25')).toBe(slate);
    }
    expect(BOARD_FILTERS.ncaaf?.conferences).toBe(CFB_CONFERENCES);
    expect(BOARD_FILTERS.ncaaf?.defaultFilter).toBe('all');
    expect(defaultBoardFilter('ncaaf')).toBe('all');
    expect(Object.keys(BOARD_FILTERS).sort()).toEqual([...LEAGUES].sort());
  });
});

function fail(): never {
  throw new Error('expected a board filter spec');
}
