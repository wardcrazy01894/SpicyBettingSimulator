import { describe, it } from 'vitest';

/** TDD contract for M5. Every case here is a reviewer question answered. */

describe('placeBet — happy path', () => {
  it.todo('lazily creates the bankroll with a 100000 deposit_initial ledger row');
  it.todo('debits exactly the stake and snapshots market/side/line/price/provider/times');
  it.todo('stores the exact rational price, not a float');
  it.todo('SUM(ledger.amount_cents) === bankrolls.balance_cents afterwards');
});

describe('placeBet — the kickoff lock', () => {
  it.todo('accepts a bet at lockAt - 1ms');
  it.todo('rejects at lockAt with 409 BETTING_CLOSED');
  it.todo('rejects a game whose status is in_progress with 409 GAME_NOT_BETTABLE');
  it.todo('rejects when ESPN has moved the kickoff EARLIER than the cutoff');
  it.todo('uses the DB kickoff, never a client-supplied timestamp');
  it.todo('rejects an unknown gameId with 404 GAME_NOT_FOUND');
});

describe('placeBet — lines', () => {
  it.todo('rejects a market with no line (409 MARKET_UNAVAILABLE)');
  it.todo('rejects a line older than LINE_STALE_MS');
  it.todo('409 LINE_CHANGED when `expected` disagrees, with details.legs[].current');
  it.todo('places anyway when acceptLineChange is true');
  it.todo('the client-sent price is IGNORED — the server always uses game_lines');
});

describe('placeBet — money and atomicity', () => {
  it.todo('409 INSUFFICIENT_FUNDS when the stake exceeds the balance');
  it.todo('a rejected bet leaves NO bets row, NO bet_legs rows and NO ledger row');
  it.todo('rejects a stake below MIN_STAKE_CENTS');
  it.todo('an all-in bet for exactly the balance succeeds and leaves 0');
  it.todo('two concurrent all-in bets: exactly one succeeds');
});

describe('placeBet — parlays', () => {
  it.todo('2..10 legs are accepted; 1 and 11 are rejected');
  it.todo('two legs on the same game are rejected (validation AND the DB UNIQUE)');
  it.todo('mixed-league legs are rejected with 409 MIXED_LEAGUE_PARLAY');
  it.todo('the stored bet price is the product of the leg prices');
  it.todo('a 10-leg parlay stays under the 100-bound-parameter limit per statement');
});

describe('cancelBet', () => {
  it.todo('refunds the full stake exactly once');
  // The naive refund `INSERT ... SELECT ... WHERE status='cancelled'` matches on
  // the SECOND call and hits UNIQUE(bankroll_id,'bet_refund',betId), aborting
  // the batch with a 500. The guard must be `cancelled_at = :now` plus a
  // NOT EXISTS on the ledger row.
  it.todo('a second cancel is a clean no-op — 409 BET_NOT_PENDING, never a 500');
  it.todo('a second cancel writes no second bet_refund row and does not move the balance');
  it.todo('409 BET_LOCKED after the earliest leg locks');
  // MUST-FIX: earliest_kickoff_at is a PLACEMENT-TIME snapshot that ingestion
  // never updates. Without the leg->game join, a rescheduled game that has
  // already kicked off could still be cancelled for a full refund.
  it.todo(
    'ESPN moves a game EARLIER and it kicks off: cancel is rejected even though ' +
      'bets.earliest_kickoff_at is still in the future',
  );
  it.todo('a leg whose game is in_progress blocks cancel');
  it.todo('a leg whose game is final blocks cancel');
  it.todo("another user's bet id returns 404 BET_NOT_FOUND, not 403");
});

describe('editBet', () => {
  it.todo('cancels the old bet and places the new one in ONE batch');
  it.todo('prices the new bet from the CURRENT line, not the old snapshot');
  it.todo('a failure in the placement half leaves the old bet pending and unrefunded');
  it.todo('a locked bet is rejected and nothing is written');
  it.todo('a bet whose game was rescheduled earlier and has started cannot be edited');
  it.todo('links the two bets via replaces_bet_id / replaced_by_bet_id');
});

describe('season and league scope', () => {
  it.todo('bets.season comes from the LEGS games, never from a wall-clock guess');
  it.todo('a January bowl (season 2026, played 2027) charges the 2026 bankroll');
  it.todo('...even after 2027 preseason games have been ingested');
  it.todo('legs from two different seasons are rejected with 409 MIXED_SEASON_PARLAY');
  it.todo('legs from two different leagues are rejected with 409 MIXED_LEAGUE_PARLAY');
});

describe('payout cap', () => {
  it.todo('a bet whose potential payout exceeds MAX_PAYOUT_CENTS is 409 PAYOUT_LIMIT_EXCEEDED');
  it.todo('nothing is written when the cap rejects the bet');
  it.todo('potential_payout_cents is always an exact INTEGER, never REAL');
  it.todo(
    'a 10-leg long-odds parlay never stores a rational — the price is recomputed ' +
      'from bet_legs.american_price and matches the value used at placement',
  );
});

describe('ledger safety', () => {
  // RAISE(ABORT) in the BEFORE INSERT trigger is NOT suppressed by OR IGNORE
  // (verified in sqlite3), unlike a CHECK raised from the AFTER trigger.
  it.todo('INSERT OR IGNORE of an overdrafting ledger row ABORTS, it is not silently dropped');
  it.todo('INSERT OR IGNORE against an unknown bankroll_id ABORTS (negative amount)');
  // Distinct messages: an orphan bankroll is an INTERNAL bug, not a user state.
  it.todo('an orphan-bankroll abort maps to 500 INTERNAL, never 409 INSUFFICIENT_FUNDS');
  it.todo('an overdraft abort maps to 409 INSUFFICIENT_FUNDS');
  it.todo('isOverdraftError and isOrphanBankrollError never both match the same error');
  // A COALESCE(...,-1) sentinel guard would let this one through (-1 + 100000 >= 0),
  // landing an orphan ledger row whose AFTER trigger updates nothing. The guard
  // uses an explicit NOT EXISTS. OR IGNORE also suppresses the FOREIGN KEY.
  it.todo('INSERT OR IGNORE against an unknown bankroll_id ABORTS (POSITIVE amount)');
  it.todo('INSERT OR IGNORE of a DUPLICATE (bankroll, kind, ref_id) is silently skipped');
  it.todo('...and in that case the balance does not move');
  it.todo('SUM(ledger.amount_cents) === bankrolls.balance_cents holds after all of the above');
});
