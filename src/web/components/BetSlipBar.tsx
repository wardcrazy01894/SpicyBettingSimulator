/** Collapsed sticky bar: "3 legs · +811 · tap to open". */
import type { ReactElement } from 'react';

import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import { useBetSlip } from '../state/bet-slip.js';

export function BetSlipBar(): ReactElement {
  const slip = useBetSlip();
  if (slip.legs.length === 0 || slip.open) return <></>;

  const count = slip.legs.length;
  const price = slip.preview.americanPrice;
  return (
    <div className="slip-bar">
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
        {price !== null && <span className="slip-bar-price">{formatAmerican(price)}</span>}
        <span className="slip-bar-towin">
          {slip.stakeCents === 0 ? 'Set stake' : `To win ${formatCents(slip.preview.toWinCents)}`}
        </span>
      </button>
    </div>
  );
}
