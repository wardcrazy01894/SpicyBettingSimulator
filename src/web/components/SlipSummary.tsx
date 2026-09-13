/**
 * Price / to-win / payout for the current slip.
 *
 * American AND exact decimal odds are both shown: the American integer is the
 * price the bet is booked at, the decimal string is `formatDecimalOdds` of the
 * exact BigInt rational (PLAN.md §5). Money is rendered only by `formatCents`.
 */
import type { ReactElement } from 'react';

import { formatAmerican } from '../../shared/odds.js';
import { formatCents } from '../../shared/validate.js';
import type { SlipPreview } from '../state/slip-preview.js';
import type { Cents } from '../../shared/types.js';

export function SlipSummary(props: {
  readonly preview: SlipPreview;
  readonly stakeCents: Cents;
}): ReactElement {
  const { preview, stakeCents } = props;
  return (
    <dl className="slip-summary">
      <div className="slip-summary-row">
        <dt>Price</dt>
        <dd>
          {preview.americanPrice === null ? '—' : formatAmerican(preview.americanPrice)}
          {preview.decimalOdds !== null && (
            <span className="slip-decimal"> · {preview.decimalOdds}</span>
          )}
        </dd>
      </div>
      <div className="slip-summary-row">
        <dt>Stake</dt>
        <dd>{formatCents(stakeCents)}</dd>
      </div>
      <div className="slip-summary-row">
        <dt>To win</dt>
        <dd>{formatCents(preview.toWinCents)}</dd>
      </div>
      <div className="slip-summary-row slip-summary-total">
        <dt>Payout</dt>
        <dd>{formatCents(preview.payoutCents)}</dd>
      </div>
    </dl>
  );
}
