/**
 * Columns: rank, user, balance, open exposure, equity, W-L-P, ROI.
 * Ranked by BALANCE (realized). Equity is shown but not ranked — PLAN.md §11.5.
 */
import type { ReactElement } from 'react';

import { formatRoi } from '../lib/labels.js';
import { formatCents } from '../../shared/validate.js';
import type { LeaderboardRow } from '../../shared/api-types.js';

export function LeaderboardTable(props: {
  readonly rows: readonly LeaderboardRow[];
  readonly meUserId: string | null;
}): ReactElement {
  const { rows, meUserId } = props;
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Player</th>
            <th scope="col" className="num">
              Balance
            </th>
            <th scope="col" className="num">
              Open
            </th>
            <th scope="col" className="num">
              Equity
            </th>
            <th scope="col" className="num">
              W-L-P
            </th>
            <th scope="col" className="num">
              ROI
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.userId} className={row.userId === meUserId ? 'row-me' : undefined}>
              <td>{String(row.rank)}</td>
              <td>{row.displayName}</td>
              <td className="num">{formatCents(row.balanceCents)}</td>
              <td className="num">{formatCents(row.pendingStakeCents)}</td>
              <td className="num">{formatCents(row.equityCents)}</td>
              <td className="num">
                {String(row.record.won)}-{String(row.record.lost)}-{String(row.record.push)}
              </td>
              <td className="num">{formatRoi(row.roi)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
