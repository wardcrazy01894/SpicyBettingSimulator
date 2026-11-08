import { describe, expect, it } from 'vitest';
import type { AdminVoidGameResponse } from '../../src/shared/api-types.js';
import { cardOffersVoid, voidReceipt, voidableGameIds } from '../../src/web/lib/void-game.js';

describe('voidableGameIds (the Jobs page Void buttons, PLAN.md §11.6)', () => {
  it('reads a `stuckGames` list of strings — settle (behind stuck[]) and maintenance alike', () => {
    expect(voidableGameIds('stuckGames', ['ncaab:1', 'nba:2'])).toEqual(['ncaab:1', 'nba:2']);
  });

  it('is null for an empty list, any other key, or a list that is not all strings', () => {
    expect(voidableGameIds('stuckGames', [])).toBeNull();
    expect(voidableGameIds('stuck', ['bet-1'])).toBeNull();
    expect(voidableGameIds('stuckGames', ['ncaab:1', 7])).toBeNull();
    expect(voidableGameIds('stuckGames', 'ncaab:1')).toBeNull();
    expect(voidableGameIds('stuckGames', null)).toBeNull();
  });
});

describe('cardOffersVoid (the game card control)', () => {
  it('only for an admin, and only on a final game', () => {
    expect(cardOffersVoid(true, 'final')).toBe(true);
    expect(cardOffersVoid(false, 'final')).toBe(false);
    for (const status of ['scheduled', 'in_progress', 'postponed', 'canceled', 'unknown'] as const) {
      expect(cardOffersVoid(true, status), status).toBe(false);
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
