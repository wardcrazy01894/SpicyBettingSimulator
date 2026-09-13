import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_CODES,
  ERROR_STATUS,
  fromThrown,
  isAppError,
} from '../../src/shared/errors.js';

describe('AppError', () => {
  it('has a canonical status for every code', () => {
    for (const code of ERROR_CODES) {
      const e = new AppError(code, 'x');
      expect(e.status).toBe(ERROR_STATUS[code]);
      expect(e.status).toBeGreaterThanOrEqual(400);
      expect(e.status).toBeLessThan(600);
    }
  });

  it('serialises to the wire envelope, omitting details when absent', () => {
    expect(new AppError('NOT_FOUND', 'nope').toBody()).toEqual({
      error: { code: 'NOT_FOUND', message: 'nope' },
    });
    expect(new AppError('VALIDATION', 'bad', { field: 'stake' }).toBody()).toEqual({
      error: { code: 'VALIDATION', message: 'bad', details: { field: 'stake' } },
    });
  });

  it('isAppError narrows correctly, including across a lost prototype', () => {
    expect(isAppError(new AppError('INTERNAL', 'x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ code: 'INTERNAL', message: 'x' })).toBe(false);
  });
});

describe('fromThrown', () => {
  it('passes an AppError through unchanged', () => {
    const e = new AppError('BET_LOCKED', 'locked');
    expect(fromThrown(e)).toBe(e);
  });

  it('maps the overdraft trigger message to INSUFFICIENT_FUNDS', () => {
    const e = fromThrown(new Error('D1_ERROR: ledger: insufficient funds: SQLITE_CONSTRAINT'));
    expect(e.code).toBe('INSUFFICIENT_FUNDS');
    expect(e.status).toBe(409);
  });

  it('maps the belt-and-braces balance CHECK to INSUFFICIENT_FUNDS', () => {
    const e = fromThrown(new Error('D1_ERROR: CHECK constraint failed: balance_cents >= 0'));
    expect(e.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('does NOT map the orphan-bankroll trigger to a user-facing code', () => {
    const e = fromThrown(new Error('D1_ERROR: ledger: unknown bankroll_id'));
    expect(e.code).toBe('INTERNAL');
  });

  it('wraps anything else as INTERNAL without leaking the message', () => {
    const e = fromThrown(new Error('stack trace with secrets'));
    expect(e.code).toBe('INTERNAL');
    expect(e.message).not.toContain('secrets');
    expect(fromThrown('a string').code).toBe('INTERNAL');
    expect(fromThrown(undefined).code).toBe('INTERNAL');
  });

  it('reads a nested cause (D1 wraps SQLite errors)', () => {
    const inner = new Error('ledger: insufficient funds');
    const outer = new Error('D1_ERROR', { cause: inner });
    expect(fromThrown(outer).code).toBe('INSUFFICIENT_FUNDS');
  });
});
