/**
 * Another player's bets — `/players/:userId`, reached from their name on the
 * leaderboard. PLAN.md §11.8 / §12.1.
 *
 * Same shape as My Bets on purpose: Open / Settled tabs, grouped by football
 * week, the same `<BetCard>` — so "what did Tyler take" reads exactly like
 * "what did I take", minus the buttons. `readOnly` on the card and
 * `cancellable: false` from the server say the same thing twice, deliberately.
 *
 * The header (rank, equity, balance, exposure, record, ROI) comes from the
 * leaderboard's `all` row, which is already cached when you arrive from the
 * board and is one request otherwise. The bets endpoint carries only the
 * player's name, so the two never disagree about a number: there is one source
 * for the stats, and it is the one the board ranks on.
 *
 * `404 NOT_FOUND` is a player who is disabled, deleted or never existed — the
 * leaderboard's own visibility rule. It is shown as an empty state rather than
 * an error, because nothing went wrong that a retry would fix.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError } from '../api/client.js';
import { getPlayerBets } from '../api/client.js';
import { BetCard } from '../components/BetCard.js';
import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { LoadMore } from '../components/LoadMore.js';
import { Segmented } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { useLeaderboard, usePlayerBets } from '../hooks/useApi.js';
import { usePoll } from '../hooks/useNow.js';
import { usePages } from '../hooks/usePages.js';
import { groupBetsByWeek } from '../lib/grouping.js';
import { formatRoi } from '../lib/labels.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';
import type { BetView, LeaderboardRow } from '../../shared/api-types.js';

type Filter = 'open' | 'settled';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'settled', label: 'Settled' },
];

/** Open bets carry a live `projected` grade, so they are worth re-reading. */
const OPEN_POLL_MS = 60_000;

function PlayerStats(props: { readonly row: LeaderboardRow }): ReactElement {
  const { row } = props;
  return (
    <dl className="stat-grid">
      <div>
        <dt>Equity</dt>
        <dd>{formatCents(row.equityCents)}</dd>
      </div>
      <div>
        <dt>Balance</dt>
        <dd>{formatCents(row.balanceCents)}</dd>
      </div>
      <div>
        <dt>Open exposure</dt>
        <dd>{formatCents(row.pendingStakeCents)}</dd>
      </div>
      <div>
        <dt>Record</dt>
        <dd>
          {String(row.record.won)}-{String(row.record.lost)}-{String(row.record.push)}
          {row.record.void > 0 ? ` (${String(row.record.void)} void)` : ''}
        </dd>
      </div>
      <div>
        <dt>ROI</dt>
        <dd>{formatRoi(row.roi)}</dd>
      </div>
    </dl>
  );
}

export function PlayerBetsPage(): ReactElement {
  const { userId = '' } = useParams<{ userId: string }>();
  const session = useSession();
  const [filter, setFilter] = useState<Filter>('open');

  const bets = usePlayerBets(userId, filter);
  const board = useLeaderboard('all');
  const notFound =
    bets.data === undefined && bets.error instanceof ApiError && bets.error.code === 'NOT_FOUND';
  // A player who is not on the board stays not on the board; re-asking every
  // minute would be a 404 forever, against a free-tier request budget.
  usePoll(
    () => {
      if (!notFound) bets.refetch();
    },
    filter === 'open' ? OPEN_POLL_MS : 5 * OPEN_POLL_MS,
  );

  const paged = usePages<BetView>(
    `${userId}:${filter}`,
    bets.data === undefined
      ? undefined
      : { items: bets.data.bets, nextCursor: bets.data.nextCursor },
    (bet) => bet.id,
    async (cursor) => {
      const page = await getPlayerBets(userId, { status: filter, cursor });
      return { items: page.bets, nextCursor: page.nextCursor };
    },
  );

  const groups = groupBetsByWeek(paged.items);
  const row = board.data?.rows.find((r) => r.userId === userId);
  const isMe = session.user?.id === userId;
  const name = bets.data?.player.displayName ?? row?.displayName;

  if (notFound) {
    return (
      <section className="page">
        <EmptyState
          title="That player isn't on the board."
          hint="The account may have been disabled or deleted."
        />
        <p>
          <Link className="btn btn-quiet" to="/leaderboard">
            Back to the board
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="card">
        <div className="player-head">
          <h2 className="page-title">
            {name ?? 'Player'}
            {isMe ? ' (you)' : ''}
          </h2>
          {row !== undefined && (
            <span className="player-rank">#{String(row.rank)} on the board</span>
          )}
          <Link className="player-link" to="/leaderboard">
            Board
          </Link>
        </div>
        {row !== undefined && <PlayerStats row={row} />}
        {isMe && (
          <p className="muted">
            This is the read-only view everyone else sees. Edit or cancel from My Bets.
          </p>
        )}
      </div>

      <div className="page-controls">
        <Segmented<Filter>
          label="Bet filter"
          value={filter}
          options={FILTERS}
          onChange={setFilter}
        />
      </div>

      {bets.error !== undefined && bets.data === undefined && (
        <ErrorBanner error={bets.error} onRetry={bets.refetch} />
      )}
      {bets.loading && bets.data === undefined && <Spinner label="Loading their bets…" />}

      {bets.data !== undefined && groups.length === 0 && (
        <EmptyState
          title={
            filter === 'open'
              ? `${name ?? 'This player'} has no open bets.`
              : `${name ?? 'This player'} has nothing settled yet.`
          }
        />
      )}

      {groups.map((group) => (
        <div className="bet-group" key={group.key}>
          <h2 className="day-heading">{group.label}</h2>
          {group.bets.map((bet) => (
            <BetCard key={bet.id} bet={bet} readOnly />
          ))}
        </div>
      ))}

      <LoadMore paged={paged} label="Load older bets" />
    </section>
  );
}
