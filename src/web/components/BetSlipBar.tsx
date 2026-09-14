/** Collapsed sticky bar: "3 legs · NFL + CFB · +811 · tap to open". */
import type { ReactElement } from 'react';

import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import { LEAGUE_BADGE } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import type { SlipLeg } from '../state/slip-reducer.js';

/**
 * "NFL", "CFB" or "NFL + CFB" for the collapsed bar.
 *
 * The sheet badges every leg; the bar has room for one line, so it says only
 * WHETHER the slip spans both — which is the fact a user cannot otherwise see
 * without opening it, and the one that changes what the bet is called.
 */
function leagueSummary(legs: readonly SlipLeg[]): string {
  const present = [...new Set(legs.map((leg) => leg.league))];
  return present.map((league) => LEAGUE_BADGE[league]).join(' + ');
}

export function BetSlipBar(): ReactElement {
  const slip = useBetSlip();
  if (slip.open) return <></>;
  // A refused tap (parlay already full) must say so even when there is nothing
  // else in the bar — it is the only feedback that the tap was not a dead one.
  if (slip.legs.length === 0 && slip.notice === null) return <></>;

  const count = slip.legs.length;
  const price = slip.preview.americanPrice;
  return (
    <div className="slip-bar">
      {slip.notice !== null && (
        <div className="slip-bar-notice" role="status">
          <span>{slip.notice}</span>
          <button
            type="button"
            className="btn btn-quiet"
            aria-label="Dismiss"
            onClick={slip.dismissNotice}
          >
            ✕
          </button>
        </div>
      )}
      {count > 0 && (
        <button
          type="button"
          className="slip-bar-btn"
          onClick={() => {
            slip.setOpen(true);
          }}
        >
          <span className="slip-bar-count">
            {String(count)} {count === 1 ? 'leg' : 'legs'}
          </span>
          <span className="slip-bar-leagues">{leagueSummary(slip.legs)}</span>
          {price !== null && <span className="slip-bar-price">{formatAmerican(price)}</span>}
          <span className="slip-bar-towin">
            {slip.stakeCents === 0 ? 'Set stake' : `To win ${formatCents(slip.preview.toWinCents)}`}
          </span>
        </button>
      )}
    </div>
  );
}
