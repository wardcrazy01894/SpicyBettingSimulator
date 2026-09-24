/**
 * MLB — the pure contracts, written FIRST (PLAN.md §23.13) as `it.todo`s and
 * discharged by the milestone named in each `describe`: M12a's (the board
 * window, `isTeasableLeague`, the parser on the two committed captures) and
 * M12b's (every function in src/shared/action.ts — the whole §23.6 table —
 * and grading with a REQUIRED `GameAction`) are all real tests now.
 *
 * The decision table these name is PLAN.md §23.6's, row for row. A row added
 * there is a test added here in the same PR.
 */
import { describe, expect, it } from 'vitest';

import {
  FULL_ACTION,
  gameAction,
  mlbGameAction,
  postponedVoidConfirmAt,
  totalDecided,
} from '../../src/shared/action.js';
import type { ActionFacts, GameAction } from '../../src/shared/action.js';
import {
  LINE_PROVIDER_PRIMARY,
  MLB_OFFICIAL_INNINGS,
  MLB_POSTPONED_CONFIRM_MS,
  MLB_REGULATION_INNINGS,
  TEASABLE_LEAGUES,
} from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import {
  effectiveAmericanPrice,
  gradeBet,
  gradeLeg,
  projectLeg,
} from '../../src/shared/grading.js';
import type { GradableGame } from '../../src/shared/grading.js';
import {
  boardWindowEnd,
  etDateKey,
  etDateKeyRange,
  etDayBounds,
  MS_PER_DAY,
} from '../../src/shared/time.js';
import { LEAGUES } from '../../src/shared/types.js';
import type {
  BetLegSnapshot,
  Game,
  GameLines,
  GameResult,
  League,
} from '../../src/shared/types.js';
import { isTeasableLeague } from '../../src/shared/validate.js';
import { makeScoreboard, mlbScoreboard } from './fixtures.js';

/* ------------------------------------------------------------------ *
 * M12b — the settlement rule for unfinished games (PLAN.md §23.6/§23.7)
 * ------------------------------------------------------------------ */

const NO_ACTION_ALL: GameAction = {
  kind: 'graded',
  markets: { moneyline: 'no-action', spread: 'no-action', total: 'no-action' },
};
const SHORTENED: GameAction = {
  kind: 'graded',
  markets: { moneyline: 'action', spread: 'no-action', total: 'no-action-unless-decided' },
};

const finalAt = (period: number | null): ActionFacts => ({ status: 'final', period });

const MLB_LEG: BetLegSnapshot = {
  gameId: 'mlb:1',
  league: 'mlb',
  market: 'moneyline',
  side: 'home',
  lineTenths: null,
  americanPrice: -110,
  provider: 'espnbet',
  lineCapturedAt: 1_700_000_000_000,
  snapshotAt: 1_700_000_060_000,
  kickoffAtSnapshot: 1_700_003_600_000,
  homeAbbr: 'BAL',
  awayAbbr: 'TOR',
};
const mlbLeg = (o: Partial<BetLegSnapshot>): BetLegSnapshot => ({ ...MLB_LEG, ...o });

/** A final MLB game graded through the real dispatcher, as settle.ts builds it. */
function mlbFinal(period: number | null, home: number, away: number): GradableGame {
  return {
    status: 'final',
    homeScore: home,
    awayScore: away,
    action: gameAction('mlb', { status: 'final', period }),
  };
}
/** A football final: `full()` — the test-only FULL_ACTION helper. */
function full(result: GameResult): GradableGame {
  return { ...result, action: FULL_ACTION };
}

describe('M12b — mlbGameAction: the full-game rows', () => {
  it('final, period null → undecidable (every leg pending; never guessed) — the ONLY undecidable', () => {
    const a = mlbGameAction(finalAt(null));
    expect(a.kind).toBe('undecidable');
    // Every other period, from absurd to extras, is graded.
    for (const p of [-3, 0, 1, 4, 5, 7, 8, 9, 10, 12, 19]) {
      expect(mlbGameAction(finalAt(p)).kind, String(p)).toBe('graded');
    }
  });

  it('final, period 9 → FULL_ACTION (moneyline, run line and total all graded)', () => {
    expect(mlbGameAction(finalAt(9))).toEqual(FULL_ACTION);
  });

  it('final, period 10 and 12 ("Final/10", "Final/12") → FULL_ACTION: extras count', () => {
    expect(mlbGameAction(finalAt(10))).toEqual(FULL_ACTION);
    expect(mlbGameAction(finalAt(12))).toEqual(FULL_ACTION);
  });

  it('non-final statuses (scheduled, in_progress, postponed, canceled, unknown) → FULL_ACTION', () => {
    for (const status of [
      'scheduled',
      'in_progress',
      'postponed',
      'canceled',
      'unknown',
    ] as const) {
      for (const period of [null, 1, 4, 7]) {
        expect(mlbGameAction({ status, period }), `${status}/${String(period)}`).toEqual(
          FULL_ACTION,
        );
      }
    }
  });
});

describe('M12b — mlbGameAction: the shortened-game rows', () => {
  it('final, period 8 → moneyline action, run line no-action, total no-action-unless-decided', () => {
    expect(mlbGameAction(finalAt(8))).toEqual(SHORTENED);
  });

  it('final, period 5 (the official-game floor, MLB_OFFICIAL_INNINGS) → same as period 8', () => {
    expect(mlbGameAction(finalAt(5))).toEqual(SHORTENED);
    expect(mlbGameAction(finalAt(6))).toEqual(SHORTENED);
    expect(mlbGameAction(finalAt(7))).toEqual(SHORTENED);
  });

  it(
    'final, period 4 → moneyline, run line AND total all no-action (not official: a decided ' +
      'total is void too)',
    () => {
      expect(mlbGameAction(finalAt(4))).toEqual(NO_ACTION_ALL);
      expect(mlbGameAction(finalAt(1))).toEqual(NO_ACTION_ALL);
    },
  );

  it('final, period 0 or negative → treated as < MLB_OFFICIAL_INNINGS, never as regulation', () => {
    expect(mlbGameAction(finalAt(0))).toEqual(NO_ACTION_ALL);
    expect(mlbGameAction(finalAt(-1))).toEqual(NO_ACTION_ALL);
  });

  it('the boundaries come from MLB_OFFICIAL_INNINGS / MLB_REGULATION_INNINGS, not 5 / 9', () => {
    expect(MLB_OFFICIAL_INNINGS).toBe(5);
    expect(MLB_REGULATION_INNINGS).toBe(9);
    expect(mlbGameAction(finalAt(MLB_OFFICIAL_INNINGS - 1))).toEqual(NO_ACTION_ALL);
    expect(mlbGameAction(finalAt(MLB_OFFICIAL_INNINGS))).toEqual(SHORTENED);
    expect(mlbGameAction(finalAt(MLB_REGULATION_INNINGS - 1))).toEqual(SHORTENED);
    expect(mlbGameAction(finalAt(MLB_REGULATION_INNINGS))).toEqual(FULL_ACTION);
  });
});

describe('M12b — gameAction: the league dispatcher', () => {
  it('nfl and ncaaf finals → FULL_ACTION whatever the period (a football final is complete)', () => {
    for (const league of ['nfl', 'ncaaf'] as const) {
      for (const period of [null, 1, 4, 5, 7]) {
        expect(gameAction(league, finalAt(period)), `${league}/${String(period)}`).toEqual(
          FULL_ACTION,
        );
      }
    }
  });

  it('mlb delegates to mlbGameAction', () => {
    for (const period of [null, 0, 4, 5, 8, 9, 12]) {
      expect(gameAction('mlb', finalAt(period))).toEqual(mlbGameAction(finalAt(period)));
    }
    expect(gameAction('mlb', { status: 'in_progress', period: 3 })).toEqual(FULL_ACTION);
  });

  it('is exhaustive over LEAGUES (every league returns a verdict, none throws)', () => {
    for (const league of LEAGUES) expect(gameAction(league, finalAt(9)).kind).toBe('graded');
  });
});

describe('M12b — totalDecided', () => {
  it('7 runs against o6.5 (65) → decided (over won, under lost)', () => {
    expect(totalDecided(4, 3, 65)).toBe(true);
  });
  it('6 runs against a whole-number 6 (60) → NOT decided: another run makes it an over', () => {
    expect(totalDecided(3, 3, 60)).toBe(false);
    expect(totalDecided(4, 3, 60)).toBe(true);
  });
  it('5 runs against o6.5 → NOT decided', () => {
    expect(totalDecided(5, 0, 65)).toBe(false);
  });
  it('0–0 against o0.5 (5) → NOT decided', () => {
    expect(totalDecided(0, 0, 5)).toBe(false);
  });
});

describe('M12b — gradeLeg / gradeBet with a REQUIRED GameAction (grading.spec.ts owns the set)', () => {
  it(
    '`action` is required on GradableGame: a gradeBet map value or a projectLeg argument ' +
      'without it is a TYPE error (asserted with @ts-expect-error), so a missed call site ' +
      'cannot fail open',
    () => {
      const bare: GameResult = { status: 'final', homeScore: 3, awayScore: 2 };
      // @ts-expect-error — a GameResult is not a GradableGame: `action` is required.
      const g: GradableGame = bare;
      // @ts-expect-error — nor can a GameResult map be handed to gradeBet.
      const m: ReadonlyMap<string, GradableGame> = new Map<string, GameResult>([['x', bare]]);
      // @ts-expect-error — projectLeg takes a GradableGame too.
      const call = (): unknown => projectLeg(MLB_LEG, bare);
      expect([g, m].length).toBe(2);
      // And if a cast ever smuggled one past the compiler, it fails CLOSED: a
      // throw (the settle chunk's per-bet error path), never a grade.
      expect(call).toThrow(TypeError);
    },
  );

  it(
    'every existing football vector passes through a test-only helper full() = FULL_ACTION ' +
      'and keeps its expected value',
    () => {
      // grading.spec.ts wraps every vector; here, one of each market for the record.
      const nfl = mlbLeg({ gameId: 'nfl:1', league: 'nfl' });
      const g = full({ status: 'final', homeScore: 28, awayScore: 24 });
      expect(gradeLeg({ ...nfl, market: 'spread', lineTenths: -35 }, g)).toBe('win');
      expect(gradeLeg({ ...nfl, market: 'total', side: 'over', lineTenths: 525 }, g)).toBe('loss');
      expect(gradeLeg(nfl, g)).toBe('win');
    },
  );

  it('a no-action market grades void even when the score would have won it', () => {
    const g = mlbFinal(7, 5, 1); // home by 4 in 7 innings
    expect(gradeLeg(mlbLeg({ market: 'spread', side: 'home', lineTenths: -15 }), g)).toBe('void');
    expect(gradeLeg(mlbLeg({ market: 'moneyline', side: 'home' }), mlbFinal(4, 5, 1))).toBe('void');
  });

  it('a no-action market is void even when the score is garbage (no score needed)', () => {
    const g: GradableGame = {
      status: 'final',
      homeScore: null,
      awayScore: null,
      action: NO_ACTION_ALL,
    };
    expect(gradeLeg(MLB_LEG, g)).toBe('void');
    // ...but a market WITH action on the same garbage score still waits.
    expect(gradeLeg(MLB_LEG, { ...g, action: SHORTENED })).toBe('pending');
  });

  it('undecidable → pending, with a pendingReason naming the game', () => {
    const g = mlbFinal(null, 5, 1);
    expect(gradeLeg(MLB_LEG, g)).toBe('pending');
    const out = gradeBet(1000, [MLB_LEG], new Map([[MLB_LEG.gameId, g]]));
    expect(out.status).toBe('pending');
    expect(out.pendingReason).toContain('leg 0: game mlb:1');
    expect(out.pendingReason).toContain('period');
  });

  it('canceled still beats everything (void), and not-final still beats the action (pending)', () => {
    const undecidable: GameAction = { kind: 'undecidable', reason: 'x' };
    const base = { homeScore: null, awayScore: null };
    expect(gradeLeg(MLB_LEG, { status: 'canceled', ...base, action: undecidable })).toBe('void');
    expect(gradeLeg(MLB_LEG, { status: 'canceled', ...base, action: FULL_ACTION })).toBe('void');
    for (const status of ['scheduled', 'in_progress', 'postponed', 'unknown'] as const) {
      expect(gradeLeg(MLB_LEG, { status, ...base, action: NO_ACTION_ALL }), status).toBe('pending');
    }
  });

  it('MLB whole-number total (o9 → 90) with exactly 9 runs in 9 innings → push, unchanged', () => {
    const g = mlbFinal(9, 5, 4);
    expect(gradeLeg(mlbLeg({ market: 'total', side: 'over', lineTenths: 90 }), g)).toBe('push');
    expect(gradeLeg(mlbLeg({ market: 'total', side: 'under', lineTenths: 90 }), g)).toBe('push');
  });
});

describe('M12b — gradeLeg / gradeBet on shortened games', () => {
  const over = (line: number): BetLegSnapshot =>
    mlbLeg({ market: 'total', side: 'over', lineTenths: line });
  const under = (line: number): BetLegSnapshot =>
    mlbLeg({ market: 'total', side: 'under', lineTenths: line });

  it('no-action-unless-decided: an over past the line wins, the under on it loses', () => {
    const g = mlbFinal(7, 4, 3); // 7 runs
    expect(gradeLeg(over(65), g)).toBe('win');
    expect(gradeLeg(under(65), g)).toBe('loss');
    expect(gradeLeg(over(60), g)).toBe('win');
  });

  it('no-action-unless-decided: a total at or under the line is void', () => {
    const g = mlbFinal(7, 3, 3); // 6 runs
    expect(gradeLeg(over(60), g)).toBe('void'); // equal to a whole number: not decided
    expect(gradeLeg(under(60), g)).toBe('void');
    expect(gradeLeg(over(85), g)).toBe('void');
    expect(gradeLeg(under(85), g)).toBe('void'); // under "winning" is not decided either
  });

  it('parlay: MLB total voided (shortened) + NFL leg LOST → lost, payout 0 (step 2 before step 3)', () => {
    const mlb = under(85);
    const nfl = mlbLeg({ gameId: 'nfl:1', league: 'nfl', market: 'spread', lineTenths: -35 });
    const games = new Map<string, GradableGame>([
      [mlb.gameId, mlbFinal(7, 3, 3)],
      [nfl.gameId, full({ status: 'final', homeScore: 24, awayScore: 28 })],
    ]);
    const out = gradeBet(1000, [mlb, nfl], games);
    expect(out.legs.map((l) => l.grade)).toEqual(['void', 'loss']);
    expect(out.status).toBe('lost');
    expect(out.payoutCents).toBe(0);
  });

  it('parlay: MLB total voided + NFL leg won → won, re-priced from the NFL leg alone (§7.4 write-back)', () => {
    const mlb = over(85);
    const nfl = mlbLeg({ gameId: 'nfl:1', league: 'nfl', market: 'spread', lineTenths: -35 });
    const games = new Map<string, GradableGame>([
      [mlb.gameId, mlbFinal(7, 3, 3)],
      [nfl.gameId, full({ status: 'final', homeScore: 28, awayScore: 24 })],
    ]);
    const out = gradeBet(1000, [mlb, { ...nfl, americanPrice: -110 }], games);
    expect(out.legs.map((l) => l.grade)).toEqual(['void', 'win']);
    expect(out.status).toBe('won');
    // One surviving -110 leg at 1000¢ → 1909 (the canonical BigInt vector).
    expect(out.payoutCents).toBe(1909);
    expect(effectiveAmericanPrice(out)).toBe(-110);
  });

  it('same-game parlay on a shortened game: moneyline graded, run line void → one survivor', () => {
    const g = mlbFinal(7, 5, 2);
    const ml = mlbLeg({ market: 'moneyline', side: 'home', americanPrice: -110 });
    const rl = mlbLeg({ market: 'spread', side: 'home', lineTenths: -15, americanPrice: 150 });
    // Two legs on one game: rule 8f allows a side pick plus a total; for the
    // grading layer the map holds one entry per game id.
    const tot = mlbLeg({ market: 'total', side: 'over', lineTenths: 85, americanPrice: 150 });
    const games = new Map([['mlb:1', g]]);
    const a = gradeBet(1000, [ml, tot], games);
    expect(a.legs.map((l) => l.grade)).toEqual(['win', 'void']);
    expect(a.status).toBe('won');
    expect(a.payoutCents).toBe(1909);
    const b = gradeBet(1000, [rl, tot], games);
    expect(b.legs.map((l) => l.grade)).toEqual(['void', 'void']);
    expect(b.status).toBe('void');
    expect(b.payoutCents).toBe(1000);
  });

  it('straight run-line bet on a 7-inning final → void, payout = stake, status void', () => {
    const rl = mlbLeg({ market: 'spread', side: 'away', lineTenths: 15 });
    const out = gradeBet(2500, [rl], new Map([['mlb:1', mlbFinal(7, 5, 2)]]));
    expect(out.status).toBe('void');
    expect(out.payoutCents).toBe(2500);
    expect(effectiveAmericanPrice(out)).toBe(100);
  });

  it('Final/4 with a total already over its line → void anyway (not an official game)', () => {
    const g = mlbFinal(4, 8, 3); // 11 runs against 8.5
    expect(gradeLeg(over(85), g)).toBe('void');
    expect(gradeLeg(under(85), g)).toBe('void');
  });
});

describe('M12b — postponedVoidConfirmAt', () => {
  const END = etDayBounds(Date.parse('2026-09-22T16:00:00Z')).endAt;

  it('mlb: windowEndAt + MLB_POSTPONED_CONFIRM_MS', () => {
    expect(postponedVoidConfirmAt('mlb', END)).toBe(END + MLB_POSTPONED_CONFIRM_MS);
    // 03:00 EDT on the 23rd is 07:00 UTC.
    expect(postponedVoidConfirmAt('mlb', END)).toBe(Date.parse('2026-09-23T07:00:00Z'));
  });

  it('nfl / ncaaf: null — football keeps §7.5 7-day rule and nothing else', () => {
    expect(postponedVoidConfirmAt('nfl', END)).toBeNull();
    expect(postponedVoidConfirmAt('ncaaf', END)).toBeNull();
  });

  it('DST: for the ET day 2026-11-01 (25 h) the result is 3 h after THAT day’s own end, as given', () => {
    const b = etDayBounds(Date.parse('2026-11-01T16:00:00Z'));
    expect(b.endAt - b.startAt).toBe(25 * HOUR_MS);
    // The day ends at 00:00 EST on 11-02 = 05:00 UTC; +3 h = 08:00 UTC (03:00 EST).
    expect(b.endAt).toBe(Date.parse('2026-11-02T05:00:00Z'));
    expect(postponedVoidConfirmAt('mlb', b.endAt)).toBe(Date.parse('2026-11-02T08:00:00Z'));
  });

  it('the rain-delay race, pure half: a fetch at windowEndAt + 3h − 1 ms is not evidence; + 0 is', () => {
    const confirm = postponedVoidConfirmAt('mlb', END);
    if (confirm === null) throw new Error('mlb must have a confirm instant');
    const isEvidence = (fetchedAt: number): boolean => fetchedAt >= confirm;
    expect(isEvidence(END + 3 * HOUR_MS - 1)).toBe(false);
    expect(isEvidence(END + 3 * HOUR_MS)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * M12a — the board window (PLAN.md §23.5)
 * ------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;

/** The ET day containing noon UTC of `key` (YYYYMMDD) — noon UTC is inside it. */
const etDayOf = (key: string): { readonly startAt: number; readonly endAt: number } =>
  etDayBounds(
    Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), 12),
  );

/** Every whole hour of the ET day plus its two edges — the instants we probe. */
const instantsOf = (day: { readonly startAt: number; readonly endAt: number }): number[] => {
  const out: number[] = [];
  for (let t = day.startAt; t < day.endAt; t += HOUR_MS) out.push(t);
  out.push(day.endAt - 1);
  return out;
};

describe('M12a — boardWindowEnd("mlb", now): today only', () => {
  it('any instant → the last millisecond of its own ET day (etDayBounds(now).endAt − 1)', () => {
    for (const key of ['20260924', '20260929', '20261031', '20270101', '20270704']) {
      const day = etDayOf(key);
      for (const now of instantsOf(day)) {
        const end = boardWindowEnd('mlb', now);
        expect(end, `${key} @ ${String(now)}`).toBe(etDayBounds(now).endAt - 1);
        expect(end).toBe(day.endAt - 1);
        expect(etDateKey(end)).toBe(key);
      }
    }
  });

  it('23:59:59.999 ET → that same day; 00:00:00.000 ET → the NEXT day', () => {
    const day = etDayOf('20260929');
    expect(etDateKey(boardWindowEnd('mlb', day.endAt - 1))).toBe('20260929');
    expect(boardWindowEnd('mlb', day.endAt - 1)).toBe(day.endAt - 1);
    const next = boardWindowEnd('mlb', day.endAt);
    expect(etDateKey(next)).toBe('20260930');
    expect(next).toBe(etDayBounds(day.endAt).endAt - 1);
  });

  it('etDateKeyRange(now, boardWindowEnd("mlb", now)) is always exactly 1 key', () => {
    // Every hour from 2026-09-01 to 2027-04-01 ET — both DST transitions inside.
    const from = etDayOf('20260901').startAt;
    const to = etDayOf('20270401').startAt;
    for (let now = from; now < to; now += HOUR_MS) {
      const keys = etDateKeyRange(now, boardWindowEnd('mlb', now));
      expect(keys, String(now)).toEqual([etDateKey(now)]);
    }
  });

  it('fall-back Sunday 2026-11-01 (25 h ET day): end − start of day = 25 h, one key', () => {
    const day = etDayOf('20261101');
    expect(day.endAt - day.startAt).toBe(25 * HOUR_MS);
    for (const now of instantsOf(day)) {
      const end = boardWindowEnd('mlb', now);
      expect(end + 1 - day.startAt).toBe(25 * HOUR_MS);
      expect(end + 1).not.toBe(day.startAt + MS_PER_DAY); // never now + 24 h arithmetic
      expect(etDateKeyRange(now, end)).toEqual(['20261101']);
    }
  });

  it('spring-forward Sunday 2027-03-14 (23 h ET day): end − start of day = 23 h, one key', () => {
    const day = etDayOf('20270314');
    expect(day.endAt - day.startAt).toBe(23 * HOUR_MS);
    for (const now of instantsOf(day)) {
      const end = boardWindowEnd('mlb', now);
      expect(end + 1 - day.startAt).toBe(23 * HOUR_MS);
      expect(etDateKeyRange(now, end)).toEqual(['20270314']);
    }
  });

  it('the football rows of §22.2 are unchanged (both leagues, every row)', () => {
    // The full table, with its span/count checks, is time.spec.ts's; this pins
    // the end keys again beside the MLB rows so the switch cannot have moved them.
    const rows: [string, number, League, string][] = [
      ['20260918', 12, 'nfl', '20260921'],
      ['20260918', 12, 'ncaaf', '20260921'],
      ['20260919', 12, 'nfl', '20260921'],
      ['20260919', 12, 'ncaaf', '20260921'],
      ['20260920', 0, 'ncaaf', '20260928'],
      ['20260920', 0, 'nfl', '20260921'],
      ['20260920', 20, 'nfl', '20260928'],
      ['20260921', 12, 'nfl', '20260928'],
      ['20260921', 12, 'ncaaf', '20260928'],
      ['20260922', 12, 'nfl', '20260928'],
      ['20260923', 12, 'ncaaf', '20260928'],
    ];
    for (const [key, hour, league, endKey] of rows) {
      // No DST transition in these September days, so startAt + h is the ET wall clock.
      const now = etDayOf(key).startAt + hour * HOUR_MS;
      expect(etDateKey(boardWindowEnd(league, now)), `${league} ${key} ${String(hour)}`).toBe(
        endKey,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * M12a — isTeasableLeague (PLAN.md §23.8)
 * ------------------------------------------------------------------ */

describe('M12a — isTeasableLeague (validate.ts)', () => {
  it('nfl and ncaaf → true; mlb → false', () => {
    expect(isTeasableLeague('nfl')).toBe(true);
    expect(isTeasableLeague('ncaaf')).toBe(true);
    expect(isTeasableLeague('mlb')).toBe(false);
  });

  it('reads TEASABLE_LEAGUES, not a literal list', () => {
    expect(LEAGUES.filter((l) => isTeasableLeague(l))).toEqual([...TEASABLE_LEAGUES]);
    for (const league of LEAGUES) {
      expect(isTeasableLeague(league)).toBe(
        (TEASABLE_LEAGUES as readonly string[]).includes(league),
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * M12a — the ESPN parser on the two committed MLB captures (§23.2 / §23.4).
 * NO parser change: these prove the league-parameterised parser already
 * reads MLB's football-shaped payload.
 * ------------------------------------------------------------------ */

const FETCHED_AT = 1_790_280_000_000;

const gameById = (games: readonly Game[], eventId: string): Game => {
  const game = games.find((g) => g.id === `mlb:${eventId}`);
  if (game === undefined) throw new Error(`no game mlb:${eventId}`);
  return game;
};
const linesById = (lines: readonly GameLines[], eventId: string): GameLines => {
  const row = lines.find((l) => l.gameId === `mlb:${eventId}`);
  if (row === undefined) throw new Error(`no line row for mlb:${eventId}`);
  return row;
};

describe('M12a — the ESPN parser on docs/samples/espn-mlb-scoreboard-2026-09-24.json and -2026-09-22.json', () => {
  const sep24 = parseScoreboard(mlbScoreboard('2026-09-24'), 'mlb', FETCHED_AT);
  const sep22 = parseScoreboard(mlbScoreboard('2026-09-22'), 'mlb', FETCHED_AT);

  it('09-24: all 12 events parse; exactly 9 yield a DraftKings line row, the 3 live ones none', () => {
    expect(sep24.warnings).toEqual([]);
    expect(sep24.games).toHaveLength(12);
    expect(sep24.lines).toHaveLength(9);
    const live = sep24.games.filter((g) => g.status === 'in_progress');
    const scheduled = sep24.games.filter((g) => g.status === 'scheduled');
    expect(live).toHaveLength(3);
    expect(scheduled).toHaveLength(9);
    const priced = new Set(sep24.lines.map((l) => l.gameId));
    for (const g of scheduled) expect(priced.has(g.id), g.id).toBe(true);
    for (const g of live) expect(priced.has(g.id), g.id).toBe(false);
    for (const g of sep24.games) {
      expect(g.league).toBe('mlb');
      expect(g.id).toMatch(/^mlb:\d+$/);
      expect(etDateKey(g.kickoffAt)).toBe('20260924');
    }
  });

  it(
    '09-22: all 16 parse with no line rows; 14 finals with period 9, MIA @ CHC 401817038 final ' +
      'with period 12, TOR @ BAL 401817035 postponed',
    () => {
      expect(sep22.warnings).toEqual([]);
      expect(sep22.games).toHaveLength(16);
      expect(sep22.lines).toHaveLength(0);
      const finals = sep22.games.filter((g) => g.status === 'final');
      expect(finals).toHaveLength(15);
      expect(finals.filter((g) => g.period === 9)).toHaveLength(14);
      const extras = gameById(sep22.games, '401817038');
      expect(extras.shortName).toBe('MIA @ CHC');
      expect(extras.status).toBe('final');
      expect(extras.period).toBe(12);
      expect(extras.statusDetail).toBe('Final/12');
      const rainout = gameById(sep22.games, '401817035');
      expect(rainout.shortName).toBe('TOR @ BAL');
      expect(rainout.status).toBe('postponed');
      expect(rainout.period).toBe(1);
    },
  );

  it('09-22: the TB @ NYY makeup 401873648 and 401817034 are two distinct games', () => {
    const makeup = gameById(sep22.games, '401873648');
    const regular = gameById(sep22.games, '401817034');
    expect(makeup.id).not.toBe(regular.id);
    expect(makeup.shortName).toBe('TB @ NYY');
    expect(regular.shortName).toBe('TB @ NYY');
    expect(new Set(sep22.games.map((g) => g.id)).size).toBe(16);
  });

  it('week is null on every game (MLB events carry no event.week)', () => {
    for (const g of [...sep24.games, ...sep22.games]) expect(g.week, g.id).toBeNull();
    expect(sep24.week).toBeNull();
    expect(sep22.week).toBeNull();
  });

  it('season and seasonType come from event.season (2 regular, 3 postseason)', () => {
    for (const g of [...sep24.games, ...sep22.games]) {
      expect(g.season).toBe(2026);
      expect(g.seasonType).toBe(2);
    }
    // The payload root carries no season (§23.2); a postseason event says type 3.
    expect(sep24.season).toBeNull();
    const payload = mlbScoreboard('2026-09-24') as { events: { season: unknown }[] };
    for (const e of payload.events) e.season = { year: 2026, type: 3, slug: 'post-season' };
    const post = parseScoreboard(payload, 'mlb', FETCHED_AT);
    expect(post.games).toHaveLength(12);
    for (const g of post.games) expect(g.seasonType).toBe(3);
  });

  it('primary provider id 100 → LINE_PROVIDER_PRIMARY, as for football', () => {
    for (const l of sep24.lines) expect(l.provider).toBe(LINE_PROVIDER_PRIMARY);
  });

  it('run line: pointSpread "+1.5"/"-1.5" → ±15 tenths, home and away opposite', () => {
    for (const l of sep24.lines) {
      expect(l.spread, l.gameId).not.toBeNull();
      expect(Math.abs(l.spread?.homeTenths ?? 0)).toBe(15);
      expect(l.spread?.awayTenths).toBe(-(l.spread?.homeTenths ?? 0));
    }
    // CLE @ BOS: BOS -1.5 at +168, CLE +1.5 at -206 (the capture, verbatim).
    expect(linesById(sep24.lines, '401817061').spread).toEqual({
      homeTenths: -15,
      homePrice: 168,
      awayTenths: 15,
      awayPrice: -206,
    });
    // ARI @ COL: the home underdog takes the +1.5.
    expect(linesById(sep24.lines, '401817068').spread?.homeTenths).toBe(15);
  });

  it('whole-number totals ("o6", "o8", …) → 60, 80; half totals ("o6.5") → 65', () => {
    const totals = sep24.lines.map((l) => l.total?.tenths).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(totals).toEqual([60, 65, 70, 80, 80, 80, 85, 100, 105]);
    expect(linesById(sep24.lines, '401817064').total).toEqual({
      tenths: 60,
      overPrice: -110,
      underPrice: -110,
    });
    expect(linesById(sep24.lines, '401817061').total?.tenths).toBe(65);
  });

  it('moneyline close odds parse, open is the fallback', () => {
    for (const l of sep24.lines) expect(l.moneyline, l.gameId).not.toBeNull();
    expect(linesById(sep24.lines, '401817064').moneyline).toEqual({
      homePrice: -156,
      awayPrice: 129,
    });
    // Remove `close` on both moneyline sides and move `open`: the parser must
    // take the open snapshot (whole, never blended).
    const payload = mlbScoreboard('2026-09-24') as {
      events: { id: string; competitions: { odds: { moneyline: Record<string, unknown> }[] }[] }[];
    };
    const event = payload.events.find((e) => e.id === '401817064');
    const ml = event?.competitions[0]?.odds[0]?.moneyline;
    if (ml === undefined) throw new Error('capture changed: no moneyline on 401817064');
    ml['home'] = { open: { odds: '-140' } };
    ml['away'] = { open: { odds: '+120' } };
    const reparsed = parseScoreboard(payload, 'mlb', FETCHED_AT);
    expect(linesById(reparsed.lines, '401817064').moneyline).toEqual({
      homePrice: -140,
      awayPrice: 120,
    });
  });

  it('STATUS_POSTPONED (state "post", completed false) → postponed, not final', () => {
    const rainout = gameById(sep22.games, '401817035');
    expect(rainout.status).toBe('postponed');
    expect(rainout.statusDetail).toBe('Postponed');
    // And the override helper's STATUS_POSTPONED on a 09-24 game agrees.
    const forced = parseScoreboard(
      makeScoreboard('mlb0924', [{ eventId: '401817061', status: 'STATUS_POSTPONED' }]),
      'mlb',
      FETCHED_AT,
    );
    expect(gameById(forced.games, '401817061').status).toBe('postponed');
  });

  it('an in-progress game keeps period = the inning and its statusDetail ("Top 7th")', () => {
    // The capture has no "Bottom 5th" (the §23.2 prose quotes an earlier pull);
    // STL @ PIT was in the top of the 7th and CHW @ KC in the bottom of the 1st.
    const stl = gameById(sep24.games, '401817063');
    expect(stl.status).toBe('in_progress');
    expect(stl.period).toBe(7);
    expect(stl.statusDetail).toBe('Top 7th');
    // displayClock never moves for baseball (§23.11's write-budget premise).
    for (const g of sep24.games) expect(g.displayClock).toBe('0:00');
    const kc = gameById(sep24.games, '401817065');
    expect(kc.period).toBe(1);
    expect(kc.statusDetail).toBe('Bottom 1st');
  });
});
