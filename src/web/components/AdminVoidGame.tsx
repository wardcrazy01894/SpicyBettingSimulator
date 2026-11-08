/**
 * Admin-only "Void game…" (F1, PLAN.md §11.6 / §24.11): cancel ONE game so the
 * next settle run voids every leg on it — a straight is refunded, a parlay
 * drops the leg and reprices. The remedy for a bet parked in `stuck[]` on an
 * abandoned game (a basketball final short of regulation).
 *
 * An INLINE two-step confirm with a reason field, like the Users tab's Delete:
 * never `window.confirm`, which is unstyleable, untestable and blocks the tab.
 * Shown on a final game's card (GameCard.tsx) and beside each `stuckGames`
 * entry on the admin Jobs page. The server is the authority on whether the
 * game may be voided (an already-canceled one is a 400); this only asks.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import { postAdminGameVoid } from '../api/client.js';
import { invalidate } from '../hooks/useResource.js';
import { voidReceipt } from '../lib/void-game.js';
import { VOID_REASON_MAX, validateVoidGame } from '../../shared/validate.js';

export function AdminVoidGame(props: {
  readonly gameId: string;
  /** Shown in the confirm line; the game id when the caller has nothing better. */
  readonly label: string;
}): ReactElement {
  const { gameId, label } = props;
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const check = validateVoidGame({ reason });

  return (
    <span className="admin-void">
      {!confirming && (
        <button
          type="button"
          className="btn btn-quiet game-refresh"
          disabled={busy || done !== null}
          title="Admin: cancel this game so its bets void on the next settle run"
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          Void game…
        </button>
      )}
      {confirming && (
        <span className="admin-void-confirm">
          <span className="muted">
            Void {label}? Every pending leg on it voids on the next settle run. This cannot be
            undone.
          </span>
          <label className="field">
            <span className="field-label">Reason (optional)</span>
            <input
              className="field-input"
              type="text"
              maxLength={VOID_REASON_MAX}
              placeholder="abandoned game"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </label>
          <span className="row-actions">
            <button
              type="button"
              className="btn btn-quiet tone-loss"
              disabled={busy || !check.ok}
              onClick={() => {
                setBusy(true);
                setError(null);
                void postAdminGameVoid(gameId, reason)
                  .then((res) => {
                    setDone(voidReceipt(res));
                    setConfirming(false);
                    invalidate('games:');
                    invalidate('admin:jobs');
                  })
                  .catch((thrown: unknown) => {
                    setError(thrown);
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Voiding…' : 'Yes, void'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </span>
          {!check.ok && <span className="field-problem">{check.message}</span>}
        </span>
      )}
      {done !== null && <span className="muted">{done}</span>}
      {error !== null && <ErrorBanner error={error} />}
    </span>
  );
}
