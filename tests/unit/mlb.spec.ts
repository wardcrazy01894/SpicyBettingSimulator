/**
 * MLB — the pure contracts, written FIRST (PLAN.md §23.13). Every `it.todo`
 * below is discharged by the milestone named in its `describe`; none of them
 * can run yet because `'mlb'` is not a `League` until M12a and every function
 * in src/shared/action.ts throws until M12b, which ships the whole §23.6 table
 * (PLAN.md §23.15).
 *
 * The decision table these name is PLAN.md §23.6's, row for row. A row added
 * there is a `todo` added here in the same PR.
 */
import { describe, it } from 'vitest';

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

describe('M12a — boardWindowEnd("mlb", now): today only (lands in time.spec.ts)', () => {
  it.todo('any instant → the last millisecond of its own ET day (etDayBounds(now).endAt − 1)');
  it.todo('23:59:59.999 ET → that same day; 00:00:00.000 ET → the NEXT day');
  it.todo('etDateKeyRange(now, boardWindowEnd("mlb", now)) is always exactly 1 key');
  it.todo('fall-back Sunday 2026-11-01 (25 h ET day): end − start of day = 25 h, one key');
  it.todo('spring-forward Sunday 2027-03-14 (23 h ET day): end − start of day = 23 h, one key');
  it.todo('the football rows of §22.2 are unchanged (both leagues, every row)');
});

describe('M12a — isTeasableLeague (validate.ts)', () => {
  it.todo('nfl and ncaaf → true; mlb → false');
  it.todo('reads TEASABLE_LEAGUES, not a literal list');
});

describe('M12a — the ESPN parser on docs/samples/espn-mlb-scoreboard-2026-09-24.json and -2026-09-22.json (espn.spec.ts)', () => {
  it.todo(
    '09-24: all 12 events parse; exactly 9 yield a DraftKings line row, the 3 live ones none',
  );
  it.todo(
    '09-22: all 16 parse with no line rows; 14 finals with period 9, MIA @ CHC 401817038 final ' +
      'with period 12, TOR @ BAL 401817035 postponed',
  );
  it.todo('09-22: the TB @ NYY makeup 401873648 and 401817034 are two distinct games');
  it.todo('week is null on every game (MLB events carry no event.week)');
  it.todo('season and seasonType come from event.season (2 regular, 3 postseason)');
  it.todo('primary provider id 100 → LINE_PROVIDER_PRIMARY, as for football');
  it.todo('run line: pointSpread "+1.5"/"-1.5" → ±15 tenths, home and away opposite');
  it.todo('whole-number totals ("o6", "o8", …) → 60, 80; half totals ("o6.5") → 65');
  it.todo('moneyline close odds parse, open is the fallback');
  it.todo('STATUS_POSTPONED (state "post", completed false) → postponed, not final');
  it.todo('an in-progress game keeps period = the inning and statusDetail "Bottom 5th"');
});
