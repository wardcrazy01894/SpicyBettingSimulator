/**
 * One bet in My Bets. Shows the SNAPSHOT line and price (what the user actually
 * got), the live per-leg projection for open bets, and cancel/edit actions that
 * disappear once the server says `cancellable: false`.
 *
 * `americanPrice` is the EFFECTIVE price (§11.4): while pending it is the
 * placement price; once settled, settlement has written back the price of the
 * surviving legs, so a push-repriced parlay shows what it actually paid.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { BetLegRow } from './BetLegRow.js';
import { ErrorBanner } from './ErrorBanner.js';
import { deleteBet, getGame } from '../api/client.js';
import { invalidate } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/datetime.js';
import { BET_STATUS_LABEL, BET_TYPE_LABEL, LEAGUE_LABEL, STATUS_TONE } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { gameIdsToRefresh, refreshSlipLegs } from '../state/edit-bet.js';
import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import type { BetView, GameCard } from '../../shared/api-types.js';

export interface BetCardProps {
  readonly bet: BetView;
}

export function BetCard(props: BetCardProps): ReactElement {
  const { bet } = props;
  const slip = useBetSlip();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const settled = bet.status !== 'pending';

  /**
   * Seed the edit slip from TODAY'S prices, not the placement snapshot.
   *
   * The snapshot is what the bet was booked at; resubmitting it as `expected`
   * made a stake-only edit fail `409 LINE_CHANGED` on any leg whose line had
   * moved, while the sheet went on displaying the old odds. Each leg's game is
   * re-read (§11.3) and the slip is built from the current quote, so the sheet
   * shows what the edit would actually cost.
   */
  const startEdit = (): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    void Promise.all(gameIdsToRefresh(bet).map((id) => getGame(id)))
      .then((responses) => {
        const games = new Map<string, GameCard>(responses.map((r) => [r.game.id, r.game]));
        const refreshed = refreshSlipLegs(bet, games);
        if (refreshed.unrefreshed.length > 0) {
          setNote('One of these markets is no longer posted — that leg still shows its old price.');
        }
        slip.startEdit(bet.id, bet.league, bet.betType, refreshed.legs, bet.stakeCents);
      })
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <article className="bet-card">
      <header className="bet-head">
        <span className={`chip chip-${STATUS_TONE[bet.status]}`}>
          {BET_STATUS_LABEL[bet.status]}
        </span>
        <span className="bet-type">
          {BET_TYPE_LABEL[bet.betType]}
          {bet.betType === 'parlay' ? ` · ${String(bet.legs.length)} legs` : ''}
        </span>
        <span className="bet-price">{formatAmerican(bet.americanPrice)}</span>
        <span className="muted">
          {LEAGUE_LABEL[bet.league]} {String(bet.season)}
        </span>
      </header>

      <ul className="bet-legs">
        {bet.legs.map((leg) => (
          <BetLegRow key={leg.id} leg={leg} />
        ))}
      </ul>

      <dl className="bet-money">
        <div>
          <dt>Stake</dt>
          <dd>{formatCents(bet.stakeCents)}</dd>
        </div>
        <div>
          <dt>{settled ? 'Paid' : 'To win'}</dt>
          <dd>{formatCents(settled ? (bet.payoutCents ?? 0) : bet.toWinCents)}</dd>
        </div>
        <div>
          <dt>{settled ? 'Odds' : 'Payout'}</dt>
          <dd>{settled ? bet.decimalOdds : formatCents(bet.potentialPayoutCents)}</dd>
        </div>
      </dl>

      <footer className="bet-foot">
        <span className="muted">Placed {formatDateTime(bet.placedAt)}</span>
        {bet.cancellable && (
          <div className="bet-actions">
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={startEdit}>
              {busy ? 'Working…' : 'Edit'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void deleteBet(bet.id)
                  .then(() => {
                    invalidate('bets');
                    invalidate('bankroll');
                    invalidate('leaderboard');
                  })
                  .catch((thrown: unknown) => {
                    setError(thrown);
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Working…' : 'Cancel'}
            </button>
          </div>
        )}
      </footer>

      {note !== null && <p className="muted">{note}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </article>
  );
}
