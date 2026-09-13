/**
 * One game: both teams, the score/clock when live, and six market buttons.
 *
 * `lines === null` renders "line not posted yet" — a NORMAL state for CFB early
 * in the week, not an error. A stale line renders the market as unavailable
 * rather than silently omitting the button.
 *
 * BETTABILITY IS THE SERVER'S (CLAUDE.md §8). This component never compares a
 * clock to `lockAt` to decide anything; it reads `game.bettable` and only uses
 * `lockAt` for the cosmetic countdown.
 */
import type { ReactElement } from 'react';

import { MarketButton } from './MarketButton.js';
import { TeamRow } from './TeamRow.js';
import { formatCountdown, formatTime } from '../lib/datetime.js';
import { gameClockLabel, pickLabel } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import type { SlipLeg } from '../state/slip-reducer.js';
import type { GameCard as GameCardData } from '../../shared/api-types.js';
import type { AmericanPrice, LineTenths, Market, Side } from '../../shared/types.js';

export interface GameCardProps {
  readonly game: GameCardData;
  /** Ticking wall clock from the page, so 300 cards share one timer. */
  readonly now: number;
}

interface MarketCell {
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly price: AmericanPrice | null;
}

/** The six cells, in the column order spread / total / moneyline, away then home. */
function cellsFor(game: GameCardData): readonly MarketCell[] {
  const lines = game.lines;
  const spread = lines?.spread ?? null;
  const total = lines?.total ?? null;
  const moneyline = lines?.moneyline ?? null;
  return [
    {
      market: 'spread',
      side: 'away',
      lineTenths: spread?.awayTenths ?? null,
      price: spread?.awayPrice ?? null,
    },
    {
      market: 'total',
      side: 'over',
      lineTenths: total?.tenths ?? null,
      price: total?.overPrice ?? null,
    },
    { market: 'moneyline', side: 'away', lineTenths: null, price: moneyline?.awayPrice ?? null },
    {
      market: 'spread',
      side: 'home',
      lineTenths: spread?.homeTenths ?? null,
      price: spread?.homePrice ?? null,
    },
    {
      market: 'total',
      side: 'under',
      lineTenths: total?.tenths ?? null,
      price: total?.underPrice ?? null,
    },
    { market: 'moneyline', side: 'home', lineTenths: null, price: moneyline?.homePrice ?? null },
  ];
}

export function GameCard(props: GameCardProps): ReactElement {
  const { game, now } = props;
  const slip = useBetSlip();

  const final = game.status === 'final';
  const started = game.status === 'in_progress' || final;
  const homeScore = game.home.score ?? 0;
  const awayScore = game.away.score ?? 0;
  const countdown = formatCountdown(game.lockAt - now);
  const stale = game.lines?.stale ?? false;

  return (
    <article className="game-card">
      <header className="game-head">
        <span className="game-time">{formatTime(game.kickoffAt)}</span>
        {game.neutralSite && <span className="chip chip-quiet">Neutral</span>}
        <span className="game-status">
          {gameClockLabel(game.status, game.statusDetail, game.period, game.displayClock)}
        </span>
        {game.bettable && countdown !== null && (
          <span className="game-countdown">locks in {countdown}</span>
        )}
        {!game.bettable && game.status === 'scheduled' && (
          <span className="chip chip-quiet">Locked</span>
        )}
      </header>

      <div className="game-teams">
        <TeamRow team={game.away} isWinner={final && awayScore > homeScore} showScore={started} />
        <TeamRow team={game.home} isWinner={final && homeScore > awayScore} showScore={started} />
      </div>

      {game.lines === null ? (
        <p className="game-noline">Line not posted yet.</p>
      ) : (
        <>
          {stale && <p className="game-noline">Line is stale — not accepting bets right now.</p>}
          <div className="market-grid" role="group" aria-label="Markets">
            <span className="market-head">Spread</span>
            <span className="market-head">Total</span>
            <span className="market-head">Money</span>
            {cellsFor(game).map((cell) => {
              const label = pickLabel(
                cell.market,
                cell.side,
                cell.lineTenths,
                game.home.abbr,
                game.away.abbr,
              );
              const leg: SlipLeg = {
                gameId: game.id,
                league: game.league,
                market: cell.market,
                side: cell.side,
                lineTenths: cell.market === 'moneyline' ? null : cell.lineTenths,
                americanPrice: cell.price ?? 0,
                label,
                kickoffAt: game.kickoffAt,
              };
              return (
                <MarketButton
                  key={`${cell.market}:${cell.side}`}
                  gameId={game.id}
                  market={cell.market}
                  side={cell.side}
                  lineTenths={cell.lineTenths}
                  price={cell.price}
                  disabled={!game.bettable || stale}
                  selected={slip.isSelected(game.id, cell.market, cell.side)}
                  ariaLabel={label}
                  onToggle={() => {
                    slip.toggleLeg(leg);
                  }}
                />
              );
            })}
          </div>
        </>
      )}
    </article>
  );
}
