import { describe, expect, it } from 'vitest';
import type { AdminVoidGameResponse } from '../../src/shared/api-types.js';
import { cardOffersVoid, voidReceipt, voidableGameIds } from '../../src/web/lib/void-game.js';

describe('voidableGameIds (the Jobs page Void buttons, PLAN.md §11.6)', () => {
  it("reads a SETTLE run's `stuckGames` list of strings (the undecidable games behind stuck[])", () => {
    expect(voidableGameIds('settle', 'stuckGames', ['ncaab:1', 'nba:2'])).toEqual([
      'ncaab:1',
      'nba:2',
    ]);
  });

  it("never offers a void on MAINTENANCE's `stuckGames` (games stuck live — a void cannot be undone)", () => {
    expect(voidableGameIds('maintenance', 'stuckGames', ['nfl:1'])).toBeNull();
    expect(voidableGameIds('refresh', 'stuckGames', ['nfl:1'])).toBeNull();
  });

  it('is null for an empty list, any other key, or a list that is not all strings', () => {
    expect(voidableGameIds('settle', 'stuckGames', [])).toBeNull();
    expect(voidableGameIds('settle', 'stuck', ['bet-1'])).toBeNull();
    expect(voidableGameIds('settle', 'stuckGames', ['ncaab:1', 7])).toBeNull();
    expect(voidableGameIds('settle', 'stuckGames', 'ncaab:1')).toBeNull();
    expect(voidableGameIds('settle', 'stuckGames', null)).toBeNull();
  });
});

describe('cardOffersVoid (the game card control)', () => {
  it('only for an admin, and only on a SHORT final (the undecidable case), never an ordinary final', () => {
    // College: a final after 1 half is undecidable; after 2 (or OT) it graded.
    expect(cardOffersVoid(true, 'ncaab', 'final', 1)).toBe(true);
    expect(cardOffersVoid(true, 'ncaab', 'final', 2)).toBe(false);
    expect(cardOffersVoid(true, 'ncaab', 'final', 3)).toBe(false);
    // NBA: short of 4 quarters.
    expect(cardOffersVoid(true, 'nba', 'final', 3)).toBe(true);
    expect(cardOffersVoid(true, 'nba', 'final', 4)).toBe(false);
    // A NULL period graded (PLAN.md §24.11), so no button.
    expect(cardOffersVoid(true, 'ncaab', 'final', null)).toBe(false);
    // Football finals are never undecidable; an MLB final with a NULL period IS
    // undecidable, but its remedy is correcting the period, so no button.
    expect(cardOffersVoid(true, 'nfl', 'final', 4)).toBe(false);
    expect(cardOffersVoid(true, 'mlb', 'final', 9)).toBe(false);
    expect(cardOffersVoid(true, 'mlb', 'final', null)).toBe(false);
    // Not an admin, or not a final: never.
    expect(cardOffersVoid(false, 'ncaab', 'final', 1)).toBe(false);
    for (const status of [
      'scheduled',
      'in_progress',
      'postponed',
      'canceled',
      'unknown',
    ] as const) {
      expect(cardOffersVoid(true, 'ncaab', status, 1), status).toBe(false);
    }
  });
});

describe('voidReceipt', () => {
  const res = (affectedBets: number): AdminVoidGameResponse => ({
    id: 'ncaab:1',
    status: 'canceled',
    statusDetail: 'admin void: abandoned game',
    affectedBets,
  });

  it('counts the pending bets the next settle run will void or reprice', () => {
    expect(voidReceipt(res(0))).toBe('Voided. No pending bets were on this game.');
    expect(voidReceipt(res(1))).toBe(
      'Voided. 1 pending bet settles on the next settle run (a straight is refunded; a parlay drops the leg).',
    );
    expect(voidReceipt(res(3))).toBe(
      'Voided. 3 pending bets settle on the next settle run (a straight is refunded; a parlay drops the leg).',
    );
  });
});
