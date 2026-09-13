/** A tappable price. Real <button> with aria-pressed; >=44px tap target. */
import type { ReactElement } from 'react';
import type { AmericanPrice, LineTenths, Market, Side } from '../../shared/types.js';

export interface MarketButtonProps {
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly price: AmericanPrice | null;
  readonly disabled: boolean;
  readonly selected: boolean;
}

export function MarketButton(_props: MarketButtonProps): ReactElement {
  throw new Error('not implemented: M7b');
}
