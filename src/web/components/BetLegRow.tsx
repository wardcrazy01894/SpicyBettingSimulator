import type { ReactElement } from 'react';

import { formatAmerican } from '../../shared/odds.js';
import { formatDateTime } from '../lib/datetime.js';
import { gameClockLabel, GRADE_TONE, LEG_GRADE_LABEL, pickLabel } from '../lib/labels.js';
import type { BetLegView } from '../../shared/api-types.js';

/**
 * One leg of a bet, showing the SNAPSHOT line and price (what the user actually
 * got — never the current board line, PLAN.md §14.3) plus the live game state.
 *
 * `result` is the persisted grade once the bet settles; `projected` is the live
 * read-time projection for an open bet. `result` wins when both are present.
 */
export function BetLegRow(props: { readonly leg: BetLegView }): ReactElement {
  const { leg } = props;
  const grade = leg.result ?? leg.projected;
  const score =
    leg.game.homeScore === null || leg.game.awayScore === null
      ? null
      : `${leg.awayAbbr} ${String(leg.game.awayScore)} – ${leg.homeAbbr} ${String(leg.game.homeScore)}`;

  return (
    <li className="bet-leg">
      <div className="bet-leg-main">
        <span className="bet-leg-pick">
          {pickLabel(leg.market, leg.side, leg.lineTenths, leg.homeAbbr, leg.awayAbbr)}
        </span>
        <span className="bet-leg-price">{formatAmerican(leg.americanPrice)}</span>
        {grade !== null && (
          <span className={`chip chip-${GRADE_TONE[grade]}`}>{LEG_GRADE_LABEL[grade]}</span>
        )}
      </div>
      <div className="bet-leg-sub">
        <span>{score ?? `${leg.awayAbbr} @ ${leg.homeAbbr}`}</span>
        <span className="muted">
          {leg.game.status === 'scheduled'
            ? formatDateTime(leg.game.kickoffAt)
            : gameClockLabel(leg.game.status, leg.game.statusDetail, null, null)}
        </span>
      </div>
    </li>
  );
}
