/**
 * Columns: rank, user (with bust badges), NET, equity, balance, open exposure,
 * W-L-P, ROI. The user's name links to their bet history (`/players/:userId`,
 * §11.8) — the board says who is winning; the link is how you find out what
 * they took.
 *
 * Net leads because net profit is the RANKED column (PLAN.md §11.5, decided
 * 2026-10-05, superseding equity) — a table whose first money column is not
 * the one the order is built from reads as if the sort is broken. Equity,
 * balance and open exposure follow, so every term of the net figure is visible.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { BustBadges } from './BustBadges.js';
import { NET_HELP, ROI_HELP, formatRoi } from '../lib/labels.js';
import { formatCents, formatSignedCents } from '../../shared/validate.js';
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
              <abbr className="help" title={NET_HELP}>
                Net
              </abbr>
            </th>
            <th scope="col" className="num">
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
              <abbr className="help" title={ROI_HELP}>
                ROI
              </abbr>
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
                <BustBadges count={row.bustCount} />
              </td>
              <td className="num num-strong">{formatSignedCents(row.netCents)}</td>
              <td className="num">{formatCents(row.equityCents)}</td>
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
