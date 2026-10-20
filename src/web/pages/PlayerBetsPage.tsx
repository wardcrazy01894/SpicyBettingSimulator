/**
 * Another player's bets — `/players/:userId`, reached from their name on the
 * leaderboard. PLAN.md §11.8 / §12.1.
 *
 * Same shape as My Bets on purpose: Open / Settled tabs, grouped by football
 * week, the same `<BetCard>` — so "what did Tyler take" reads exactly like
 * "what did I take", minus the buttons. `readOnly` on the card and
 * `cancellable: false` from the server say the same thing twice, deliberately.
 *
 * The header comes from the leaderboard. Rank, the money (net, equity,
 * balance, exposure) and the bust badges are from the `all` row — already
 * cached when you arrive from the board, and the rank is the WHOLE-ACCOUNT
 * one: a league's board breaks net ties on that league's ROI, so "#2 on the
 * board" must not turn into "#1" when you tap NFL. Record, profit and ROI are
 * from the row under the SAME sport switch as the list. The bets endpoint
 * carries only the player's name, so no two numbers can disagree: there is
 * one source for the stats, and it is the one the board ranks on. (PLAN.md
 * §11.5, §11.8.)
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
import { RecordStats, ScopeNote } from '../components/RecordStats.js';
import { ScopeTabs } from '../components/ScopeTabs.js';
import { Segmented } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { useLeaderboard, usePlayerBets, usePlayerBusts } from '../hooks/useApi.js';
import { usePoll } from '../hooks/useNow.js';
import { usePages } from '../hooks/usePages.js';
import { formatDateTime } from '../lib/datetime.js';
import { groupBetsByWeek } from '../lib/grouping.js';
import { betsEmptyTitle, scopeLeague } from '../lib/scope.js';
import type { Scope } from '../lib/scope.js';
import { AdminRefillForm } from '../components/AdminRefillForm.js';
import { BustBadges } from '../components/BustBadges.js';
import { BOUGHT_IN_HELP, NET_HELP, NET_HINT, bustSummary } from '../lib/labels.js';

import { useSession } from '../state/session.js';
import { formatCents, formatSignedCents } from '../../shared/validate.js';
import type { BetView, BustView, LeaderboardRow } from '../../shared/api-types.js';

type Filter = 'open' | 'settled';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'settled', label: 'Settled' },
];

/** Open bets carry a live `projected` grade, so they are worth re-reading. */
const OPEN_POLL_MS = 60_000;

/**
 * `row` is the `all` row (money, never per sport); `stats` is the row under
 * the chosen sport, undefined while that board loads or after it fails — the
 * money stays put and only the three record slots wait, so a tab switch never
 * blanks the header and never moves the cells around it.
 */
function PlayerStats(props: {
  readonly row: LeaderboardRow;
  readonly stats: LeaderboardRow | undefined;
  readonly statsFailed: boolean;
  readonly busts: readonly BustView[] | undefined;
}): ReactElement {
  const { row, stats, statsFailed, busts } = props;
  return (
    <dl className="stat-grid" aria-busy={stats === undefined && !statsFailed}>
      <div>
        <dt>
          <abbr className="help" title={NET_HELP}>
            Net
          </abbr>
        </dt>
        <dd>
          {formatSignedCents(row.netCents)}
          <small className="stat-hint">{NET_HINT}</small>
        </dd>
      </div>
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
      {stats === undefined ? (
        <RecordStatsPlaceholder value={statsFailed ? '—' : '…'} />
      ) : (
        <RecordStats stats={stats} />
      )}
      <div>
        <dt>
          <abbr className="help" title={BOUGHT_IN_HELP}>
            Bought in
          </abbr>
        </dt>
        <dd>{formatCents(row.depositedCents)}</dd>
      </div>
      <div>
        <dt>Busts</dt>
        <dd>
          {busts === undefined
            ? row.bustCount === 0
              ? '—'
              : bustSummary(row.bustCount, 0)
            : bustSummary(busts.length, busts.filter((b) => b.boughtOutAt !== null).length)}
          {row.bustCount > 0 && <BustBadges count={row.bustCount} />}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The history behind the skulls (PLAN.md §4.5): one line per bust — when the
 * house refilled the account and for how much, and when the badge was bought
 * off, or that it is still on the name. Renders nothing for a player who has
 * never busted; the stat cell above already says "—".
 */
function BustHistory(props: { readonly busts: readonly BustView[] }): ReactElement | null {
  if (props.busts.length === 0) return null;
  return (
    <ul className="ledger bust-history" aria-label="Bust history">
      {props.busts.map((bust, i) => (
        <li className="ledger-row" key={bust.refillId}>
          <div className="ledger-main">
            <span className="ledger-kind">
              💀 Bust #{String(i + 1)} — refilled {formatCents(bust.amountCents)}
            </span>
          </div>
          <span className="muted">{formatDateTime(bust.refilledAt)}</span>
          {bust.boughtOutAt === null ? (
            <span className="num tone-loss">badge still on</span>
          ) : (
            <span className="num tone-win">
              bought off {formatDateTime(bust.boughtOutAt)}
              {bust.buyoutCents === null ? '' : ` for ${formatCents(bust.buyoutCents)}`}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The same three cells `<RecordStats>` fills, holding "…" or "—" for now. */
function RecordStatsPlaceholder(props: { readonly value: string }): ReactElement {
  return (
    <>
      <div>
        <dt>Record</dt>
        <dd>{props.value}</dd>
      </div>
      <div>
        <dt>Profit</dt>
        <dd>{props.value}</dd>
      </div>
      <div>
        <dt>ROI</dt>
        <dd>{props.value}</dd>
      </div>
    </>
  );
}

export function PlayerBetsPage(): ReactElement {
  const { userId = '' } = useParams<{ userId: string }>();
  const session = useSession();
  const [filter, setFilter] = useState<Filter>('open');
  const [scope, setScope] = useState<Scope>('all');

  const bets = usePlayerBets(userId, filter, scope);
  // The `all` board is the header's source for rank and money; the scoped
  // board (the same request when scope is 'all') is the source for the record.
  const board = useLeaderboard('all');
  const scoped = useLeaderboard(scope);
  const busts = usePlayerBusts(userId);
  const notFound =
    bets.data === undefined && bets.error instanceof ApiError && bets.error.code === 'NOT_FOUND';
  // A player who is not on the board stays not on the board; re-asking every
  // minute would be a 404 forever, against a free-tier request budget. The
  // header polls with the list: a bet that settles leaves Open within a
  // minute, and the record above it has to move at the same time.
  usePoll(
    () => {
      if (notFound) return;
      bets.refetch();
      board.refetch();
      busts.refetch();
      if (scope !== 'all') scoped.refetch();
    },
    filter === 'open' ? OPEN_POLL_MS : 5 * OPEN_POLL_MS,
  );

  const paged = usePages<BetView>(
    `${userId}:${filter}:${scope}`,
    bets.data === undefined
      ? undefined
      : { items: bets.data.bets, nextCursor: bets.data.nextCursor },
    (bet) => bet.id,
    async (cursor) => {
      const page = await getPlayerBets(userId, {
        status: filter,
        league: scopeLeague(scope) ?? null,
        cursor,
      });
      return { items: page.bets, nextCursor: page.nextCursor };
    },
  );

  const groups = groupBetsByWeek(paged.items);
  const row = board.data?.rows.find((r) => r.userId === userId);
  const stats = scoped.data?.rows.find((r) => r.userId === userId);
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
            {row !== undefined && <BustBadges count={row.bustCount} />}
          </h2>
          {row !== undefined && (
            <span className="player-rank">#{String(row.rank)} on the board</span>
          )}
          <Link className="player-link" to="/leaderboard">
            Board
          </Link>
        </div>
        <div className="stats-head">
          <span className="muted">Stats</span>
          <ScopeTabs scope={scope} onChange={setScope} />
        </div>
        {row !== undefined && (
          <PlayerStats
            row={row}
            stats={stats}
            statsFailed={scoped.error !== undefined}
            busts={busts.data?.busts}
          />
        )}
        <ScopeNote scope={scope} />
        {busts.data !== undefined && <BustHistory busts={busts.data.busts} />}

        {session.user?.isAdmin === true && !isMe && (
          <details className="admin-refill-details">
            <summary className="muted">Admin: refill this account</summary>
            <AdminRefillForm userId={userId} username={row?.username ?? null} />
          </details>
        )}
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
        <EmptyState title={betsEmptyTitle(filter, scope, name ?? 'This player')} />
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
