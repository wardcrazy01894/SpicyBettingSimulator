/**
 * MLB — the pure contracts, written FIRST (PLAN.md §23.13). Every `it.todo`
 * below is discharged by the milestone named in its `describe`. M12a's
 * describes (the board window, `isTeasableLeague`, the parser on the two
 * committed captures) are real tests; M12b's stay `it.todo` until every
 * function in src/shared/action.ts stops throwing — M12b ships the whole §23.6
 * table (PLAN.md §23.15).
 *
 * The decision table these name is PLAN.md §23.6's, row for row. A row added
 * there is a `todo` added here in the same PR.
 */
import { describe, expect, it } from 'vitest';

import { LINE_PROVIDER_PRIMARY, TEASABLE_LEAGUES } from '../../src/shared/constants.js';
import { parseScoreboard } from '../../src/shared/espn.js';
import {
  boardWindowEnd,
  etDateKey,
  etDateKeyRange,
  etDayBounds,
  MS_PER_DAY,
} from '../../src/shared/time.js';
import { LEAGUES } from '../../src/shared/types.js';
import type { Game, GameLines, League } from '../../src/shared/types.js';
import { isTeasableLeague } from '../../src/shared/validate.js';
import { makeScoreboard, mlbScoreboard } from './fixtures.js';

describe('M12b — mlbGameAction: the full-game rows', () => {
  it.todo(
    'final, period null → undecidable (every leg pending; never guessed) — the ONLY undecidable',
  );
  it.todo('final, period 9 → FULL_ACTION (moneyline, run line and total all graded)');
  it.todo('final, period 10 and 12 ("Final/10", "Final/12") → FULL_ACTION: extras count');
  it.todo(
    'non-final statuses (scheduled, in_progress, postponed, canceled, unknown) → FULL_ACTION',
  );
});

describe('M12b — mlbGameAction: the shortened-game rows', () => {
  it.todo('final, period 8 → moneyline action, run line no-action, total no-action-unless-decided');
  it.todo('final, period 5 (the official-game floor, MLB_OFFICIAL_INNINGS) → same as period 8');
  it.todo(
    'final, period 4 → moneyline, run line AND total all no-action (not official: a decided ' +
      'total is void too)',
  );
  it.todo('final, period 0 or negative → treated as < MLB_OFFICIAL_INNINGS, never as regulation');
  it.todo('the boundaries come from MLB_OFFICIAL_INNINGS / MLB_REGULATION_INNINGS, not 5 / 9');
});

describe('M12b — gameAction: the league dispatcher', () => {
  it.todo('nfl and ncaaf finals → FULL_ACTION whatever the period (a football final is complete)');
  it.todo('mlb delegates to mlbGameAction');
});

describe('M12b — totalDecided', () => {
  it.todo('7 runs against o6.5 (65) → decided (over won, under lost)');
  it.todo('6 runs against a whole-number 6 (60) → NOT decided: another run makes it an over');
  it.todo('5 runs against o6.5 → NOT decided');
  it.todo('0–0 against o0.5 (5) → NOT decided');
});

describe('M12b — gradeLeg / gradeBet with a REQUIRED GameAction (grading.spec.ts owns the set)', () => {
  it.todo(
    '`action` is required on GradableGame: a gradeBet map value or a projectLeg argument ' +
      'without it is a TYPE error (asserted with @ts-expect-error), so a missed call site ' +
      'cannot fail open',
  );
  it.todo(
    'every existing football vector passes through a test-only helper full() = FULL_ACTION ' +
      'and keeps its expected value',
  );
  it.todo('a no-action market grades void even when the score would have won it');
  it.todo('undecidable → pending, with a pendingReason naming the game');
  it.todo('canceled still beats everything (void), and not-final still beats the action (pending)');
  it.todo('MLB whole-number total (o9 → 90) with exactly 9 runs in 9 innings → push, unchanged');
});

describe('M12b — gradeLeg / gradeBet on shortened games', () => {
  it.todo('no-action-unless-decided: an over past the line wins, the under on it loses');
  it.todo('no-action-unless-decided: a total at or under the line is void');
  it.todo(
    'parlay: MLB total voided (shortened) + NFL leg LOST → lost, payout 0 (step 2 before step 3)',
  );
  it.todo(
    'parlay: MLB total voided + NFL leg won → won, re-priced from the NFL leg alone (§7.4 write-back)',
  );
  it.todo('same-game parlay on a shortened game: moneyline graded, run line void → one survivor');
  it.todo('straight run-line bet on a 7-inning final → void, payout = stake, status void');
  it.todo('Final/4 with a total already over its line → void anyway (not an official game)');
});

describe('M12b — postponedVoidConfirmAt', () => {
  it.todo('mlb: windowEndAt + MLB_POSTPONED_CONFIRM_MS');
  it.todo('nfl / ncaaf: null — football keeps §7.5 7-day rule and nothing else');
  it.todo(
    'DST: for the ET day 2026-11-01 (25 h) the result is 3 h after THAT day’s own end, as given',
  );
  it.todo(
    'the rain-delay race, pure half: a fetch at windowEndAt + 3h − 1 ms is not evidence; + 0 is',
  );
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
