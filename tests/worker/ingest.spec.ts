import { describe, it } from 'vitest';

/** TDD contract for M4. */

describe('planTargets', () => {
  it.todo('creates one DATE target per ET calendar day in the window, for BOTH leagues');
  it.todo('a 10-day window yields 11 dates x 2 leagues = 22 targets');
  // Measured against live ESPN 2026-09-13 (Spike S4): dates= buckets by ET day.
  it.todo('a Sunday-night 00:20Z kickoff is planned under the SUNDAY ET date key');
  it.todo('a Monday-night 00:15Z kickoff is planned under the MONDAY ET date key');
  it.todo('target ids are <league>:date:YYYYMMDD and never collide');
  it.todo('needs no league calendar — NFL postseason dates are planned like any other day');
  it.todo('a January bowl date is planned without any seasontype knowledge');
  it.todo('is idempotent — a second run creates nothing new');
  it.todo('retires targets whose window ended > 2 days ago with no non-final games');
});

describe('write budget levers (PLAN.md §8.6)', () => {
  // D1 free: 100,000 rows written per UTC day, HARD-ENFORCED since 2026-09-01.
  // Blowing it returns errors, which blocks bet placement and settlement.
  it.todo('L1: re-ingesting an UNCHANGED slate writes ZERO rows (meta.changes === 0)');
  it.todo('L1: only the games whose score/status/kickoff actually changed are written');
  it.todo('L2: a slate of in_progress/final games writes ZERO game_lines rows');
  it.todo('L3: last_seen_at is only bumped when older than GAME_SEEN_TOUCH_MS');
  it.todo('L3: game_lines.seen_at is only bumped when older than LINE_SEEN_TOUCH_MS');
  it.todo('captured_at moves ONLY when a price changed; seen_at moves on confirmation');
  it.todo('a stale seen_at makes the market unbettable even though captured_at is old');
  it.todo(
    'BUDGET: 96 live refreshes of an 86-game CFB Saturday write < 5,000 rows, ' +
      'not ~45,000 (regression guard on the whole lever set)',
  );
});

describe('ingestTarget', () => {
  it.todo('upserts games and one game_lines row per game that has odds');
  it.todo('a second run changes only last_seen_at and captured_at');
  it.todo('a line that disappears leaves the game_lines row in place, going stale');
  it.todo('NEVER regresses a final game back to scheduled');
  it.todo('NEVER nulls out an existing score when the payload omits it');
  it.todo('writes original_kickoff_at once and never updates it');
  it.todo('updates kickoff_at when ESPN reschedules');
  it.todo('a malformed event is skipped and recorded as a warning');
  it.todo('a pre-game score of the STRING "0" is stored as 0, not nulled');
  it.todo('a missing score field is stored as NULL');
  it.todo('a non-numeric score string is stored as NULL and warned');
  it.todo('neutralSite true/false/absent all map correctly');
  it.todo('a team missing abbreviation or displayName skips the event with a warning');
  it.todo('a non-200 response leaves the database completely untouched');
  it.todo('a timeout leaves the database completely untouched');
  it.todo('garbage JSON leaves the database completely untouched');
});

describe('computeNextRunAt', () => {
  it.todo('live or < 3h out -> +15 min');
  it.todo('< 48h out -> +60 min');
  it.todo('far out -> +6h');
  it.todo('all final -> +24h');
  it.todo('failure -> exponential backoff capped at 6h');
});

describe('slot fairness (PLAN.md §8.4)', () => {
  it.todo('slot 1 takes the most-due target overall');
  it.todo('slot 2 is RESERVED for the most-overdue target with no in-progress game');
  it.todo(
    'with a live CFB target AND a live NFL target, line-discovery targets still ' +
      'get refreshed — they are not starved across 96 consecutive runs',
  );
  it.todo('two simultaneously-live targets alternate in slot 1 (30-minute cadence each)');
  it.todo('the reserved slot falls through to the general queue when no non-live target is due');
});

describe('request budget', () => {
  it.todo('a refresh run makes at most REFRESH_TARGETS_PER_RUN upstream calls');
  it.todo('20 discovery targets at +6h need 80 slot-uses/day against a supply of 96');
  it.todo('builds ...nfl/scoreboard?dates=YYYYMMDD&limit=100');
  it.todo('builds ...college-football/scoreboard?groups=80&limit=300&dates=YYYYMMDD');
  it.todo('NEVER sends seasontype — that would hide postseason games on a given date');
});
