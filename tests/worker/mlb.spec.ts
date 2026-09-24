/**
 * MLB against a real D1 — ingest, the postponed-game void and its race,
 * settlement of shortened games, placement. PLAN.md §23.13.
 *
 * Written FIRST as `it.todo` contracts. `'mlb'` is not a `League` until M12a
 * and migration 0009 does not exist until M12a, so nothing here can run yet.
 * The file is the permanent home of these cases, not a staging area.
 */
import { describe, it } from 'vitest';

describe('M12a — ingest and the board', () => {
  it.todo(
    'buildScoreboardUrl(base, "mlb", date) is /sports/baseball/mlb/scoreboard?dates=D&limit=100',
  );
  it.todo('buildScoreboardUrl for nfl and ncaaf is byte-identical to before the table');
  it.todo('planTargets creates exactly ONE mlb:date:<today ET> target per run, idempotently');
  it.todo(
    'planTargets on a Tuesday creates 7 + 7 + 1 = 15; on a Sunday night 9 + 9 + 1 = 19 ' +
      '(counts computed by the test from boardWindowEnd, asserted against these literals)',
  );
  it.todo('at 00:00 ET the next day’s MLB target is created and yesterday’s is NOT deleted');
  it.todo(
    'WRITE BUDGET: an MLB day of 15 games over 96 refreshes (scheduled → live with the score ' +
      'and period moving on every refresh → final) writes < 1,000 rows (§23.11; measured value ' +
      'recorded in the PR), cross-checked against an env.DB.batch probe',
  );
  it.todo('the CFB-Saturday < 5,000 regression still passes unchanged beside it');
  it.todo('GET /api/games?league=mlb defaults to now − 12 h … the end of TODAY ET');
  it.todo(
    'an MLB game with a fresh line is bettable: false while LEAGUE_BETTING_OPEN.mlb is false',
  );
  it.todo('POST /api/bets with an MLB leg → 409 GAME_NOT_BETTABLE while the gate is closed');
  it.todo('GET /api/config: leagues ends with mlb and currentSeason has an mlb key');
  it.todo(
    'runSecondary with ODDS_API_KEY set and a GAPPED scheduled MLB game makes no MLB request ' +
      'and emits no mlb entry in stats.secondary.sweeps',
  );
});

describe('M12b — the postponed void and the rain-delay race (maintenance)', () => {
  it.todo(
    'postponed MLB game, its ET-date target last fetched OK at window_end + 3 h → canceled, ' +
      'named in stats.autoVoidedGames, status_detail says why',
  );
  it.todo(
    'THE RACE: postponed (a delay) at 22:40 ET, target last fetched OK at 23:59 → NOT voided ' +
      'at 04:30; the 03:00 confirm fetch sees it final → never voided, bets grade normally',
  );
  it.todo('postponed, target last fetched at window_end + 3 h but last_status error → NOT voided');
  it.todo('postponed, no ingest_targets row covers it → NOT voided (the 7-day rule still applies)');
  it.todo('a postponed NFL / CFB game with the same evidence → NOT voided before 7 days (§7.5)');
  it.todo('the SQL instant equals postponedVoidConfirmAt("mlb", window_end_at) to the millisecond');
  it.todo(
    'computeNextRunAt: a target whose day has ended holding a postponed game is due at ' +
      'window_end + 3 h (not +6 h), and one whose games are all final is unaffected',
  );
  it.todo('the 7-day rule is unchanged for every league');
  it.todo(
    'A DAY LATE, NEVER WRONG (i): the confirm fetch at window_end + 3 h FAILS (last_status ' +
      'error) → not voided at that morning’s maintenance; a later OK fetch still saying ' +
      'postponed → voided at the NEXT maintenance run',
  );
  it.todo(
    'A DAY LATE, NEVER WRONG (ii): planTargets does NOT retire a past MLB target (window ended ' +
      '> 2 d ago) while it holds a postponed game, so the evidence can still arrive; once ' +
      'maintenance has made the game canceled, the next planTargets DOES retire it',
  );
});

describe('M12b — canceled is terminal in the ingest upsert', () => {
  it.todo(
    'an auto-voided (canceled) game re-reported by ESPN as STATUS_POSTPONED stays canceled, ' +
      'keeps its auto-void status_detail, and writes 0 rows through (A) and (B)',
  );
  it.todo('a canceled game re-reported as final stays canceled (its bets were already voided)');
  it.todo('the §8.5 rows_written table is otherwise unchanged');
});

describe('M12b — settlement', () => {
  it.todo('a 9-inning final settles every market as for football');
  it.todo('a Final/10 settles every market; extra-inning runs count toward the total');
  it.todo('a postponed game auto-voided by maintenance → the next settle run voids its legs');
  it.todo(
    'a final MLB game with period NULL defers (settle_attempts + 1), never settles — the only ' +
      'undecidable case',
  );
  it.todo(
    'the league for the action comes from bet_legs.league (the snapshot); §7.2 adds only ' +
      'g.period',
  );
  it.todo('settle.ts still imports no game_lines accessor (rule 7)');
});

describe('M12b — settlement of shortened games', () => {
  it.todo('a Final/7: moneyline graded, run line void, under 8.5 with 6 runs void, over 5.5 won');
  it.todo(
    'a Final/4: EVERY leg void — moneyline, run line and total, even a total already over ' +
      'its line — bet void, stake refunded',
  );
  it.todo(
    'cross-sport parlay: MLB total voided by a shortened game + NFL leg lost → lost; + NFL leg ' +
      'won → won at the NFL leg’s price, american_price written back',
  );
  it.todo('an open bet’s projected leg shows void for a shortened final before settle runs');
});

describe('M12b — placement', () => {
  it.todo('straight, parlay, same-game parlay (run line + total) and MLB + NFL parlay all place');
  it.todo('a same-game run line + moneyline → 409 DUPLICATE_GAME_IN_PARLAY, as for football');
  it.todo('a teaser with one MLB leg → 400 TEASER_INVALID, no statement executed, no money moved');
  it.todo('an NFL + NCAAF teaser still places');
  it.todo('an edit that adds an MLB leg to a teaser → 400 TEASER_INVALID, the old bet untouched');
  it.todo("an MLB-only parlay is labelled league 'mlb'; MLB + NFL is 'mixed'");
});
