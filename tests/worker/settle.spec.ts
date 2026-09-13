import { describe, it } from 'vitest';

/** TDD contract for M6. */

describe('runSettle — outcomes', () => {
  it.todo('a straight win pays stake + profit and writes one bet_payout row');
  it.todo('a straight loss writes NO ledger row (the stake already debited it)');
  it.todo('a straight push returns the stake');
  it.todo('a canceled game voids the leg and returns the stake');
  it.todo('a parlay with a pushed leg is re-priced from the remaining legs');
  it.todo('a parlay with a loss and pushes LOSES');
  it.todo('persists per-leg results only when the whole bet settles');
});

describe('runSettle — partial and pending', () => {
  it.todo('a parlay with 3 final and 2 in-progress legs stays pending');
  it.todo('...and writes NOTHING: no leg results, no status change, no ledger row');
  it.todo('a postponed game keeps the bet pending (it may still be played)');
  it.todo('a final game with a null score leaves the bet pending');
});

describe('runSettle — head-of-line blocking', () => {
  it.todo('a selected-but-ungradeable bet increments settle_attempts and records settle_error');
  it.todo('...and stamps settle_attempted_at');
  it.todo('...and changes no money, no bet status and no leg results');
  it.todo('selection orders by settle_attempts ASC, so fresh bets are never starved');
  it.todo(
    '20 undecidable bets at the head of the queue do NOT prevent a settleable ' +
      'bet behind them from settling on the very next run',
  );
  it.todo('a bet at MAX_SETTLE_ATTEMPTS (96 = 24h) is skipped and reported in stats.stuck[]');
});

describe('runSettle — deferred-bet reset (no permanent parking)', () => {
  it.todo('resetDeferredBets zeroes settle_attempts when a leg game updated_at advanced');
  it.todo('...and leaves settle_attempts alone when no leg game changed');
  it.todo('a bet parked at 96 attempts recovers on the next run once ESPN republishes a score');
  it.todo('POST /api/admin/bets/:id/retry-settlement clears the counter manually');
  it.todo('the reset never changes status, payout or any ledger row');
});

describe('runSettle — effective price write-back', () => {
  // Without this, the canonical §5.4 example pays 3644c while still displaying
  // the 3-leg +811 it was placed at.
  it.todo('a parlay with a pushed leg has american_price REWRITTEN to the surviving legs');
  it.todo('  -110/-110/+150 with leg 3 pushed: pays 3644 AND displays +264, not +811');
  it.todo('a push/void outcome writes american_price = 100 (even money) and payout = stake');
  it.todo('a losing bet KEEPS its placement price');
  it.todo('a fully-won parlay keeps its placement price');
  it.todo('BetView.decimalOdds is derived from the stored americanPrice');
  it.todo(
    'payout_cents <= potential_payout_cents always (re-pricing can only shrink ' +
      'the product; min legal decimal odds is 1.001 at -100000), so the ' +
      'MAX_PAYOUT_CENTS CHECK can never abort a settlement batch',
  );
});

describe('runSettle — price recomputation', () => {
  it.todo('the payout is computed from bet_legs.american_price, not from any stored rational');
  it.todo('bets has no price_num/price_den columns at all');
  it.todo('a 10-leg parlay payout is exact and never touches a REAL value');
  it.todo('a payout that would exceed MAX_PAYOUT_CENTS cannot occur (rejected at placement)');
});

describe('runSettle — idempotency', () => {
  it.todo('running twice pays exactly once (ledger row count and balance unchanged)');
  it.todo('a second run reports skippedAlreadySettled, not an error');
  it.todo('a concurrent run losing the settle_run_id race writes nothing');
  it.todo('the ledger UNIQUE(bankroll_id, kind, ref_id) is the final backstop');
});

describe('runSettle — snapshot immutability', () => {
  it.todo('mutating game_lines AFTER placement does not change the payout');
  it.todo('deleting the game_lines row entirely does not prevent settlement');
  it.todo('settle.ts never reads game_lines (module-boundary assertion)');
});

describe('runSettle — invariants', () => {
  it.todo('SUM(ledger.amount_cents) === bankrolls.balance_cents after every scenario');
  it.todo('balance never goes negative');
  it.todo('chunking at SETTLE_CHUNK leaves the remainder for the next run');
});

describe('maintenance', () => {
  it.todo('a game postponed > 7 days past original_kickoff_at becomes canceled');
  it.todo('a game postponed 2 days is left alone');
  it.todo('a game missing from the feed > 7 days past kickoff becomes canceled');
  it.todo('a stuck in_progress game is REPORTED but not auto-voided');
  it.todo('prunes expired sessions, old throttle rows and old job_runs');
});
