/**
 * Columns: rank, user, EQUITY, balance, open exposure, W-L-P, ROI. The user's
 * name links to their bet history (`/players/:userId`, §11.8) — the board says
 * who is winning; the link is how you find out what they took.
 *
 * Equity leads because equity is the RANKED column (PLAN.md §11.5, decided
 * 2026-09-14) — a table whose first money column is not the one the order is
 * built from reads as if the sort is broken. Balance and open exposure follow,
 * so the two halves of the equity figure are both visible.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

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
            <th scope="col" className="num" aria-sort="descending">
              Equity
            </th>
            <th scope="col" className="num">
              Balance
            </th>
            <th scope="col" className="num">
              Open
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
              <td>
                <Link className="player-link" to={`/players/${encodeURIComponent(row.userId)}`}>
                  {row.displayName}
                </Link>
              </td>
              <td className="num num-strong">{formatCents(row.equityCents)}</td>
              <td className="num">{formatCents(row.balanceCents)}</td>
              <td className="num">{formatCents(row.pendingStakeCents)}</td>
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
