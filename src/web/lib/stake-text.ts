/**
 * The stake box's text <-> cents rules, kept out of the component so they are
 * testable in the DOM-free node project.
 *
 * The typed text is NEVER turned into a float: `parseDollarsToCents` (shared,
 * PLAN.md §12.4) does pure string -> integer-cents arithmetic.
 *
 * The rule that matters: text the parser REJECTS means a stake of ZERO, not
 * "keep whatever the stake used to be". Leaving the previous stake live let a
 * slip that reads `$abc` on screen stay submittable at the last good amount.
 * Zero then fails `validatePlaceBet`'s minimum, which is what greys the submit
 * button out, and `problem` says why.
 */

import { parseDollarsToCents } from '../../shared/validate.js';
import type { Cents } from '../../shared/types.js';

export interface StakeEntry {
  readonly cents: Cents;
  /** Why the text is not a dollar amount, or null when it is (or is empty). */
  readonly problem: string | null;
}

/** Cents -> the text the input should show, without a currency symbol. */
export function centsToText(cents: Cents): string {
  if (cents === 0) return '';
  const whole = (cents - (cents % 100)) / 100;
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${String(whole)}.${String(frac).padStart(2, '0')}`;
}

/** What the typed text means. Empty is a silent zero; garbage is a LOUD zero. */
export function stakeFromText(raw: string): StakeEntry {
  if (raw.trim() === '') return { cents: 0, problem: null };
  const parsed = parseDollarsToCents(raw);
  return parsed.ok ? { cents: parsed.value, problem: null } : { cents: 0, problem: parsed.message };
}
