import type { ReactElement } from 'react';

import { formatDateTime } from '../lib/datetime.js';
import { LEDGER_KIND_LABEL } from '../lib/labels.js';
import { formatCents } from '../../shared/validate.js';
import type { LedgerEntry } from '../../shared/api-types.js';

/**
 * The append-only money history. `amountCents` is signed: a stake is negative, a
 * payout positive, and the running total is always `SUM(ledger)` by construction
 * (CLAUDE.md §6), so nothing is recomputed here.
 */
export function LedgerList(props: { readonly entries: readonly LedgerEntry[] }): ReactElement {
  return (
    <ul className="ledger">
      {props.entries.map((entry) => (
        <li className="ledger-row" key={entry.id}>
          <div className="ledger-main">
            <span className="ledger-kind">{LEDGER_KIND_LABEL[entry.kind]}</span>
            {entry.memo !== null && <span className="muted"> {entry.memo}</span>}
          </div>
          <span className="muted">{formatDateTime(entry.createdAt)}</span>
          <span className={entry.amountCents < 0 ? 'num tone-loss' : 'num tone-win'}>
            {entry.amountCents > 0 ? '+' : ''}
            {formatCents(entry.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}
