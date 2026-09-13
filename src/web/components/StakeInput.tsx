/**
 * inputMode="decimal", quick chips, `parseDollarsToCents`.
 *
 * The typed text is NEVER turned into a float: `parseDollarsToCents` (shared,
 * with its own tests for "12.345", "1,000", ".5", "12.") does pure string →
 * integer-cents arithmetic. The raw text is held in local state so a half-typed
 * "12." is not rewritten under the caret.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { formatCents, parseDollarsToCents } from '../../shared/validate.js';
import type { Cents } from '../../shared/types.js';

export interface StakeInputProps {
  readonly stakeCents: Cents;
  /** MAX chip target; also the balance used for the "more than you have" hint. */
  readonly maxCents: Cents;
  readonly minCents: Cents;
  readonly onChange: (cents: Cents) => void;
}

const QUICK_CHIPS_CENTS: readonly Cents[] = [500, 1000, 2500, 5000, 10_000];

/** Cents → the text the input should show, without a currency symbol. */
function centsToText(cents: Cents): string {
  if (cents === 0) return '';
  const whole = (cents - (cents % 100)) / 100;
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${String(whole)}.${String(frac).padStart(2, '0')}`;
}

export function StakeInput(props: StakeInputProps): ReactElement {
  const { stakeCents, maxCents, minCents, onChange } = props;
  const [text, setText] = useState(() => centsToText(stakeCents));
  const [problem, setProblem] = useState<string | null>(null);
  const [lastStake, setLastStake] = useState(stakeCents);

  // Re-sync when a chip (or a slip reset) changes the stake from OUTSIDE. This
  // is React's documented "adjust state while rendering" pattern rather than an
  // effect: an effect here would paint the stale text first and then cascade a
  // second render (react-hooks/set-state-in-effect).
  if (lastStake !== stakeCents) {
    setLastStake(stakeCents);
    const parsed = parseDollarsToCents(text);
    // Leave a half-typed "12." alone when it already means this many cents.
    if (!parsed.ok || parsed.value !== stakeCents) setText(centsToText(stakeCents));
  }

  return (
    <div className="stake">
      <label className="stake-label" htmlFor="stake-input">
        Stake
      </label>
      <div className="stake-field">
        <span className="stake-currency" aria-hidden="true">
          $
        </span>
        <input
          id="stake-input"
          className="stake-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (next.trim() === '') {
              setProblem(null);
              onChange(0);
              return;
            }
            const parsed = parseDollarsToCents(next);
            if (parsed.ok) {
              setProblem(null);
              onChange(parsed.value);
            } else {
              setProblem(parsed.message);
            }
          }}
        />
      </div>

      <div className="stake-chips">
        {QUICK_CHIPS_CENTS.map((cents) => (
          <button
            key={cents}
            type="button"
            className="chip-btn"
            onClick={() => {
              onChange(cents);
            }}
          >
            {formatCents(cents)}
          </button>
        ))}
        <button
          type="button"
          className="chip-btn"
          disabled={maxCents < minCents}
          onClick={() => {
            onChange(maxCents);
          }}
        >
          MAX
        </button>
      </div>

      {problem !== null && <p className="stake-problem">{problem}</p>}
    </div>
  );
}
