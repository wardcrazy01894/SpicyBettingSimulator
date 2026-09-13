import { describe, it } from 'vitest';

/** TDD contract for src/shared/time.ts (M2c). See also Spike S4. */

describe('etDateKey', () => {
  it.todo('a 00:20Z Sunday kickoff maps to the SATURDAY ET date key');
  it.todo('a 17:00Z Sunday kickoff maps to that Sunday');
  it.todo('is correct across the November DST transition');
  it.todo('is correct across UTC midnight in both directions');
});

describe('etDateKeyRange', () => {
  it.todo('a 10-day window yields 10 or 11 keys, inclusive of both ends');
  it.todo('handles a range that crosses a DST boundary without duplicating a key');
});

describe('parseIsoToEpochMs', () => {
  it.todo('parses "2026-09-13T17:00Z" (no seconds, as ESPN emits it)');
  it.todo('returns null for a non-string or an unparseable string');
});

describe('lockAtFor', () => {
  it.todo('subtracts exactly BET_CUTOFF_BUFFER_MS');
});
