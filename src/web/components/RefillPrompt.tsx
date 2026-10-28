/**
 * "Run out of money?" — the player's OWN bust refill (PLAN.md §4.5, 2026-10-28).
 *
 * Shown in two places, both this component: a banner under the nav on every
 * page (so a busted player cannot miss it) and the main balance's card on
 * /account. It appears only while the account is busted — `isBusted`, the
 * same rule the server applies inside the ledger INSERT — and offers exactly
 * one thing: `REFILL_DEFAULT_CENTS`, one click, no confirm step. The copy says
 * what the click costs (a 💀, and the loss staying on the board) because that
 * IS the confirm.
 *
 * It cannot be hit twice. The button disables on the first click and a ref
 * blocks a second handler that races the re-render; and even a second tab is
 * harmless, because the server's guard is a WHERE clause inside the INSERT —
 * the second request finds a funded balance and gets `409 NOT_BUSTED`, never a
 * second badge. On success the balances, ledger and leaderboard are refetched,
 * which hides the offer; the receipt survives that so the player sees it land.
 */
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import { postBankrollRefill } from '../api/client.js';
import { invalidate } from '../hooks/useResource.js';
import { REFILL_DEFAULT_CENTS } from '../../shared/constants.js';
import { formatCents, isBusted } from '../../shared/validate.js';
import type { BankrollView } from '../../shared/api-types.js';

export const REFILL_TITLE = 'Run out of money?';
export const REFILL_RECEIPT = `Refilled ${formatCents(REFILL_DEFAULT_CENTS)}. One 💀 added beside your name.`;

export function RefillPrompt(props: {
  readonly balance: BankrollView | undefined;
  readonly variant: 'banner' | 'card';
}): ReactElement | null {
  const { balance, variant } = props;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const amount = formatCents(REFILL_DEFAULT_CENTS);
  const eligible = balance?.kind === 'main' && isBusted(balance);

  if (!eligible) {
    // The refetch that follows a refill makes the account un-busted, and a
    // plain `return null` would take the receipt with it — the one
    // confirmation the player gets. So the receipt outlives the offer.
    if (!done) return null;
    return (
      <div className={`refill-prompt refill-${variant}`} role="status">
        <p className="refill-text">{REFILL_RECEIPT}</p>
        {variant === 'banner' && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setDone(false);
            }}
          >
            OK
          </button>
        )}
      </div>
    );
  }

  const refill = (): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void postBankrollRefill()
      .then(() => {
        setDone(true);
      })
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        // Either way the balance may have moved (ours, or a settlement that
        // made us un-busted under the button), so refetch what the offer
        // depends on.
        invalidate('bankroll:');
        invalidate('ledger:');
        invalidate('leaderboard:');
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <div className={`refill-prompt refill-${variant}`} role="status">
      <div className="refill-body">
        <p className="refill-title">{REFILL_TITLE}</p>
        <p className="refill-text">
          You are at {formatCents(balance.equityCents)} with nothing open. Take a{' '}
          <strong>{amount}</strong> refill: it adds a 💀 beside your name on the leaderboard and
          joins what you have bought in, so what you lost stays on the board.
        </p>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={refill}>
        {busy ? 'Refilling…' : `Refill ${amount} now`}
      </button>
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}
