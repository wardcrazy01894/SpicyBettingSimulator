/**
 * The admin's "refill a busted account" control (PLAN.md §4.5), shared by the
 * Admin page (behind an account dropdown) and a player's own page (where the
 * admin usually arrives from the leaderboard). Dollars in, like the stake box,
 * prefilled with the default so one click re-funds a busted friend and a typed
 * amount is still honoured. The server decides whether the account is busted
 * — `409 NOT_BUSTED` otherwise — so this form never has to know the balance.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import { postAdminUserRefill } from '../api/client.js';
import { invalidate } from '../hooks/useResource.js';
import { centsToText, stakeFromText } from '../lib/stake-text.js';
import { REFILL_DEFAULT_CENTS } from '../../shared/constants.js';
import { formatCents } from '../../shared/validate.js';

export const REFILL_HINT =
  'Only for a busted account — balance under $1 with no open bet. Each refill adds a 💀 to ' +
  'their name and joins what they have bought in, so the money they lost stays lost on the board.';

export function AdminRefillForm(props: {
  readonly userId: string | null;
  readonly username: string | null;
}): ReactElement {
  const { userId, username } = props;
  const [text, setText] = useState(centsToText(REFILL_DEFAULT_CENTS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const entry = stakeFromText(text);
  const label = username === null ? 'Refill amount (dollars)' : `Refill ${username} (dollars)`;
  return (
    <div className="admin-refill">
      <div className="admin-reset">
        <label className="field">
          <span className="field-label">{label}</span>
          <input
            className="field-input"
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy || userId === null || entry.cents <= 0}
          title={REFILL_HINT}
          onClick={() => {
            if (userId === null) return;
            setBusy(true);
            setError(null);
            setDone(null);
            void postAdminUserRefill(userId, entry.cents)
              .then(() => {
                setDone(`Refilled ${formatCents(entry.cents)}. One bust badge added.`);
                invalidate('admin:users');
                invalidate('leaderboard:');
                // The dropdown lists the admin too: refilling yourself must
                // refresh the header balance and the ledger, not just the board.
                invalidate('bankroll:');
                invalidate('ledger:');
              })
              .catch((thrown: unknown) => {
                setError(thrown);
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {busy ? 'Working…' : `Refill ${formatCents(entry.cents)}`}
        </button>
      </div>
      {entry.problem !== null && <p className="muted">{entry.problem}</p>}
      <p className="muted">{REFILL_HINT}</p>
      {done !== null && <p className="muted">{done}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}
