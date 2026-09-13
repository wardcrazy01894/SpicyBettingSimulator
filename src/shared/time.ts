/**
 * Time helpers. Everything in the system is epoch MILLISECONDS, UTC.
 *
 * US Eastern appears in exactly ONE place: ESPN's `dates=YYYYMMDD` parameter
 * buckets by the US Eastern calendar day (an 8:20pm ET Saturday kickoff has a
 * `date` of 00:20Z on Sunday but belongs to Saturday's bucket). See PLAN.md §8.2
 * and Spike S4.
 */

import type { EpochMs } from './types.js';

export const ET_TIME_ZONE = 'America/New_York';
export const MS_PER_DAY = 86_400_000;

/** ESPN `dates=` key for a moment in time, in US Eastern. e.g. "20260913". */
export function etDateKey(_at: EpochMs): string {
  throw new Error('not implemented: M2c');
}

/** Midnight-to-midnight ET bounds of the day containing `at`, as epoch ms. */
export function etDayBounds(_at: EpochMs): { readonly startAt: EpochMs; readonly endAt: EpochMs } {
  throw new Error('not implemented: M2c');
}

/** Inclusive list of ET date keys covering [from, to]. Used by the ingest planner. */
export function etDateKeyRange(_from: EpochMs, _to: EpochMs): readonly string[] {
  throw new Error('not implemented: M2c');
}

/** Parse an ESPN ISO timestamp ("2026-09-13T17:00Z") to epoch ms, or null. */
export function parseIsoToEpochMs(_iso: unknown): EpochMs | null {
  throw new Error('not implemented: M2c');
}

/** `kickoffAt - BET_CUTOFF_BUFFER_MS`. The single definition of "locked". */
export function lockAtFor(_kickoffAt: EpochMs): EpochMs {
  throw new Error('not implemented: M2c');
}
