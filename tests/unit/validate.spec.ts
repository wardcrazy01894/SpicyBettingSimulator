import { describe, it } from 'vitest';

/** TDD contract for src/shared/validate.ts (M2d). */

describe('validateUsername', () => {
  it.todo('lowercases and trims');
  it.todo('rejects < 3 and > 24 characters');
  it.todo('rejects characters outside [a-z0-9_]');
});

describe('validateDerivedKeyHex', () => {
  it.todo('accepts exactly 64 lowercase hex characters');
  it.todo('rejects uppercase, wrong length, and non-hex');
});

describe('validatePlaceBet', () => {
  it.todo('rejects a stake below MIN_STAKE_CENTS');
  it.todo('rejects a non-integer or unsafe stake');
  it.todo('straight must have exactly 1 leg');
  it.todo('parlay must have 2..10 legs');
  it.todo('rejects 11 legs');
  it.todo('rejects two legs on the same gameId (correlated parlay)');
  it.todo('rejects market=total with side=home');
  it.todo('rejects market=moneyline with side=over');
  it.todo('accepts a valid 3-leg parlay');
});

describe('parseDollarsToCents', () => {
  it.todo('"12.34" -> 1234');
  it.todo('"12" -> 1200');
  it.todo('".5" -> 50');
  it.todo('"12." -> 1200');
  it.todo('"1,000" -> 100000');
  it.todo('"$5" -> 500');
  it.todo('rejects "12.345" (three decimal places)');
  it.todo('rejects negatives and NaN');
});

describe('formatters', () => {
  it.todo('formatCents(123456) -> "$1,234.56"');
  it.todo('formatLineTenths(-35, true) -> "-3.5"');
  it.todo('formatLineTenths(35, true) -> "+3.5"');
  it.todo('formatLineTenths(505, false) -> "50.5"');
});
