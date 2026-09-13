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
import {
  BET_LEAGUE_LABEL,
  BET_STATUS_LABEL,
  BET_TYPE_LABEL,
  STATUS_TONE,
  teaserPointsLabel,
} from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { gameIdsToRefresh, refreshSlipLegs } from '../state/edit-bet.js';
import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import type { BetView, GameCard } from '../../shared/api-types.js';
import type { League } from '../../shared/types.js';

export interface BetCardProps {
  readonly bet: BetView;
}

/** Which league TAB an edit of this bet borrows. See the note at the call site. */
function editLeagueFor(bet: BetView): League {
  if (bet.league !== 'mixed') return bet.league;
  return bet.legs[0]?.league ?? 'nfl';
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
   *
   * `allSettled`, NOT `all`. `refreshSlipLegs` already has a documented fallback
   * for a game it was not handed — the leg keeps its placement snapshot and is
   * reported in `unrefreshed` — and `Promise.all` made that fallback
   * unreachable: ONE 404 on a 10-leg parlay (a game pruned, or a network blip)
   * rejected the whole thing and the Edit button just showed an error. Now every
   * game that did answer is used and the rest fall back, which is exactly the
   * behaviour the fallback was written and tested for.
   */
  const startEdit = (): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    void Promise.allSettled(gameIdsToRefresh(bet).map((id) => getGame(id)))
      .then((results) => {
        const games = new Map<string, GameCard>(
          results
            .filter((r) => r.status === 'fulfilled')
            .map((r) => [r.value.game.id, r.value.game]),
        );
        const refreshed = refreshSlipLegs(bet, games);
        if (refreshed.unrefreshed.length > 0) {
          setNote('One of these markets is no longer posted — that leg still shows its old price.');
        }
        slip.startEdit(
          bet.id,
          // A cross-league bet has no single league; the slip is per-league, so
          // it borrows the FIRST leg's slot. The server does not read this field
          // for scope any more, so nothing depends on the choice but the tab.
          editLeagueFor(bet),
          bet.betType,
          refreshed.legs,
          bet.stakeCents,
          bet.teaserPoints ?? undefined,
        );
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
          {/* "6-pt teaser", "Parlay · 3 legs", "Straight". */}
          {bet.teaserPoints === null
            ? BET_TYPE_LABEL[bet.betType]
            : `${teaserPointsLabel(bet.teaserPoints)} teaser`}
          {bet.betType === 'straight' ? '' : ` · ${String(bet.legs.length)} legs`}
        </span>
        <span className="bet-price">{formatAmerican(bet.americanPrice)}</span>
        {/*
         * League only. `bet.season` still exists on the wire as an internal
         * label, but the product has no concept of a season (PLAN.md §19 Q5) and
         * printing a year next to every bet implies a boundary that is not there.
         */}
        <span className="muted">{BET_LEAGUE_LABEL[bet.league]}</span>
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
