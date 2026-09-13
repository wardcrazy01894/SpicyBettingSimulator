import { describe, it } from 'vitest';

/** TDD contract for M1/M3/M5 routing and the asset/API boundary. */

describe('routing', () => {
  it.todo('GET /api/health returns ok without touching D1');
  it.todo('GET /api/definitely-not-a-route returns our JSON 404 envelope, NOT index.html');
  it.todo('every non-public /api route returns 401 UNAUTHENTICATED when anonymous');
  it.todo('/api/admin/* returns 404 (not 403) for a non-admin');
  it.todo('an unhandled throw becomes 500 INTERNAL with no stack in the body');
  it.todo('malformed JSON bodies return 400 MALFORMED_JSON');
});

describe('games board', () => {
  it.todo('bettable is false once now >= lockAt, even if the game is still scheduled');
  it.todo('bettable is false when the line is stale');
  it.todo('lines: null renders as "not posted", not as an error');
  it.todo('respects the BOARD_MAX_GAMES cap');
});

describe('leaderboard semantics', () => {
  it.todo('balanceCents excludes pending stakes');
  it.todo('equityCents === balanceCents + pendingStakeCents');
  it.todo('record counts settled bets only and excludes cancelled bets');
  it.todo('roi excludes push and void from BOTH numerator and denominator');
  it.todo('roi is null when there is no settled action');
  it.todo('ranks by balance desc, then roi desc, then username');
  it.todo('all-time pools the numerator and denominator rather than averaging ROIs');
});
