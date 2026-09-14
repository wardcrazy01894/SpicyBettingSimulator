/** A tappable price. Real <button> with aria-pressed; >=44px tap target. */
import type { ReactElement } from 'react';

import { formatAmerican } from '../../shared/odds.js';
import { formatLineTenths } from '../../shared/validate.js';
import type { AmericanPrice, LineTenths, Market, Side } from '../../shared/types.js';

export interface MarketButtonProps {
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly price: AmericanPrice | null;
  readonly disabled: boolean;
  readonly selected: boolean;
  /** Screen-reader text, e.g. "Miami Dolphins spread -3.5 at -110". */
  readonly ariaLabel: string;
  /**
   * Why the button is disabled, when the reason is worth saying out loud — e.g.
   * "moneylines cannot be teased". Rendered as the native `title` AND appended
   * to the accessible name, because a disabled button gets no tooltip on touch
   * and a screen reader would otherwise just find an unexplained dead control.
   */
  readonly disabledReason?: string;
  readonly onToggle: () => void;
}

/**
 * The top line is the LINE (spread/total) and the bottom line is the PRICE.
 * Moneyline has no line, so the price sits alone and the slot is kept for
 * vertical rhythm.
 */
export function MarketButton(props: MarketButtonProps): ReactElement {
  const { market, lineTenths, price, disabled, selected, ariaLabel, disabledReason, onToggle } =
    props;
  const unavailable = price === null;
  const off = disabled || unavailable;
  const reason = off && disabledReason !== undefined ? disabledReason : undefined;
  return (
    <button
      type="button"
      className="market-btn"
      aria-pressed={selected}
      aria-label={reason === undefined ? ariaLabel : `${ariaLabel} — ${reason}`}
      {...(reason === undefined ? {} : { title: reason })}
      disabled={off}
      onClick={onToggle}
    >
      <span className="market-line">
        {unavailable
          ? '—'
          : market === 'moneyline' || lineTenths === null
            ? ' '
            : formatLineTenths(lineTenths, market === 'spread')}
      </span>
      <span className="market-price">{price === null ? 'n/a' : formatAmerican(price)}</span>
    </button>
  );
}
