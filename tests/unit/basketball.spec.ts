/**
 * Basketball, college and NBA (M13c / M13d) — the pure contracts, written FIRST
 * (PLAN.md §24.15) as `it.todo`s and discharged by the milestone named in each
 * `describe`. `'ncaab'` and `'nba'` are not yet members of `LEAGUES`, so
 * nothing here can be a real test until M13c.
 */
import { describe, it } from 'vitest';

describe('M13c: board windows (PLAN.md §24.10)', () => {
  it.todo(
    "boardWindowEnd('ncaab') is the last ms of the second ET date after today (NCAAB_BOARD_ET_DAYS)",
  );
  it.todo("boardWindowEnd('nba') is the last ms of tomorrow's ET date (NBA_BOARD_ET_DAYS)");
  it.todo('both are right across 2026-11-01 (25 h) and 2027-03-14 (23 h)');
  it.todo("boardWindowEnd('mlb') is byte-identical to before");
});

describe('M13c: ESPN URLs and parser (PLAN.md §24.2, §24.10)', () => {
  it.todo('the ncaab URL is groups=50&limit=500&dates=…, and groups=<id> for a conference target');
  it.todo('the nba URL is dates=…&limit=100');
  it.todo('the four existing URLs are byte-identical');
  it.todo('the 11-07 college capture parses 61 games with conference ids and 48 line rows');
  it.todo('the evening capture parses with NULL conference ids');
  it.todo('the "OFF" moneyline is counted as pulled, not warned, and still withdraws the market');
  it.todo('the 11-07 NBA capture parses 7 games, 6 priced; the top-level spread is the home line');
  it.todo('a payload of exactly `limit` events adds the truncation warning');
});

describe('M13c: settlement (PLAN.md §24.11)', () => {
  it.todo(
    'gameAction gives FULL_ACTION for a final in both leagues, overtime included, period NULL included',
  );
  it.todo('postponedVoidConfirmAt is windowEndAt + MLB_POSTPONED_CONFIRM_MS for both leagues');
  it.todo('basketball legs cannot be teased (TEASABLE_LEAGUES)');
});

describe('M13d: the board filter (PLAN.md §24.14)', () => {
  it.todo('ncaab offers CBB_CONFERENCES with default top25');
  it.todo('"Other" includes games with no conference id');
  it.todo('nba, nfl and mlb have no filter; ncaaf keeps CFB_CONFERENCES with default all');
});
