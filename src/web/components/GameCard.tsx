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
import { MARKET_CELLS, quoteFor } from '../lib/lines.js';
import { useBetSlip } from '../state/bet-slip.js';
import type { GameCard as GameCardData } from '../../shared/api-types.js';

export interface GameCardProps {
  readonly game: GameCardData;
  /** Ticking wall clock from the page, so 300 cards share one timer. */
  readonly now: number;
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
            {MARKET_CELLS.map((cell) => {
              const quote = quoteFor(game.lines, cell.market, cell.side);
              const lineTenths = quote?.lineTenths ?? null;
              const label = pickLabel(
                cell.market,
                cell.side,
                lineTenths,
                game.home.abbr,
                game.away.abbr,
              );
              // NO leg object when the cell is not tappable. The old code built
              // one eagerly with `americanPrice: cell.price ?? 0` — a price of
              // ZERO, which is not a legal American price at all — for all six
              // cells of every card on the board.
              const disabled = !game.bettable || stale || quote === null;
              return (
                <MarketButton
                  key={`${cell.market}:${cell.side}`}
                  gameId={game.id}
                  market={cell.market}
                  side={cell.side}
                  lineTenths={lineTenths}
                  price={quote?.americanPrice ?? null}
                  disabled={disabled}
                  selected={slip.isSelected(game.id, cell.market, cell.side)}
                  ariaLabel={label}
                  onToggle={() => {
                    if (quote === null) return;
                    slip.toggleLeg({
                      gameId: game.id,
                      league: game.league,
                      market: cell.market,
                      side: cell.side,
                      lineTenths: cell.market === 'moneyline' ? null : quote.lineTenths,
                      americanPrice: quote.americanPrice,
                      label,
                      kickoffAt: game.kickoffAt,
                      homeAbbr: game.home.abbr,
                      awayAbbr: game.away.abbr,
                    });
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
