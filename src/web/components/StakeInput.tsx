/**
 * inputMode="decimal", quick chips, `parseDollarsToCents`.
 *
 * The text <-> cents rules live in `lib/stake-text.ts` so they are unit-tested
 * without a DOM. The raw text is held in local state so a half-typed "12." is
 * not rewritten under the caret.
 *
 * Text the parser REJECTS reports a stake of ZERO (it used to leave the previous
 * stake live, so a box reading "$abc" stayed submittable at the last good
 * amount). Zero fails `validatePlaceBet`'s minimum, which greys out the submit
 * button, and `problem` says why.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { centsToText, stakeFromText } from '../lib/stake-text.js';
import { formatCents } from '../../shared/validate.js';
import type { Cents } from '../../shared/types.js';

export interface StakeInputProps {
  readonly stakeCents: Cents;
  /**
   * MAX chip target; also the balance used for the "more than you have" hint.
   *
   * **THE WHOLE AVAILABLE BALANCE, and nothing may cap it lower** (decided
   * 2026-09-14, PLAN.md §19 Q7): going all-in is allowed, the balance already
   * excludes stakes riding on open bets, and the only other limit in the system
   * is `MAX_PAYOUT_CENTS` — which bites on the PAYOUT, not the stake. The slip
   * passes `availableCents` straight through; if a house limit is ever wanted it
   * belongs in `constants.ts` and in the server's validation, not in this chip.
   */
  readonly maxCents: Cents;
  readonly minCents: Cents;
  readonly onChange: (cents: Cents) => void;
}

const QUICK_CHIPS_CENTS: readonly Cents[] = [500, 1000, 2500, 5000, 10_000];

export function StakeInput(props: StakeInputProps): ReactElement {
  const { stakeCents, maxCents, minCents, onChange } = props;
  const [text, setText] = useState(() => centsToText(stakeCents));
  const [problem, setProblem] = useState<string | null>(null);
  const [lastStake, setLastStake] = useState(stakeCents);
  /** The cents WE last reported; anything else is an outside change. */
  const [reported, setReported] = useState<Cents | null>(null);

  // Re-sync when a chip (or a slip reset) changes the stake from OUTSIDE. This
  // is React's documented "adjust state while rendering" pattern rather than an
  // effect: an effect here would paint the stale text first and then cascade a
  // second render (react-hooks/set-state-in-effect).
  //
  // `reported` is what keeps invalid text on screen: rejecting "abc" reports 0,
  // and without this guard the resync would immediately blank the box the user
  // is still typing in.
  if (lastStake !== stakeCents) {
    setLastStake(stakeCents);
    if (reported !== stakeCents) {
      setReported(null);
      setProblem(null);
      setText(centsToText(stakeCents));
    }
  }

  /** A chip: the text and the stake are both set from the outside, together. */
  const commit = (cents: Cents): void => {
    setReported(cents);
    setProblem(null);
    setText(centsToText(cents));
    onChange(cents);
  };

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
          aria-invalid={problem !== null}
          {...(problem === null ? {} : { 'aria-describedby': 'stake-problem' })}
          onChange={(event) => {
            const next = event.target.value;
            const entry = stakeFromText(next);
            setText(next);
            setProblem(entry.problem);
            setReported(entry.cents);
            onChange(entry.cents);
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
              commit(cents);
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
            commit(maxCents);
          }}
        >
          MAX
        </button>
      </div>

      {problem !== null && (
        <p className="stake-problem" id="stake-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
