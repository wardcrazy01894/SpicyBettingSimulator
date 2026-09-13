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
import { deleteBet } from '../api/client.js';
import { invalidate } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/datetime.js';
import {
  BET_STATUS_LABEL,
  BET_TYPE_LABEL,
  LEAGUE_LABEL,
  pickLabel,
  STATUS_TONE,
} from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import type { SlipLeg } from '../state/slip-reducer.js';
import type { BetView } from '../../shared/api-types.js';

export interface BetCardProps {
  readonly bet: BetView;
}

/** A settled bet's legs become slip legs verbatim — same game, market, side, price. */
function toSlipLegs(bet: BetView): readonly SlipLeg[] {
  return bet.legs.map((leg) => ({
    gameId: leg.gameId,
    league: bet.league,
    market: leg.market,
    side: leg.side,
    lineTenths: leg.lineTenths,
    americanPrice: leg.americanPrice,
    label: pickLabel(leg.market, leg.side, leg.lineTenths, leg.homeAbbr, leg.awayAbbr),
    kickoffAt: leg.game.kickoffAt,
  }));
}

export function BetCard(props: BetCardProps): ReactElement {
  const { bet } = props;
  const slip = useBetSlip();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const settled = bet.status !== 'pending';

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
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                slip.startEdit(bet.id, bet.league, bet.betType, toSlipLegs(bet), bet.stakeCents);
              }}
            >
              Edit
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

      {error !== null && <ErrorBanner error={error} />}
    </article>
  );
}
