/**
 * One bet in My Bets. Shows the SNAPSHOT line and price (what the user actually
 * got), the live per-leg projection for open bets, and cancel/edit actions that
 * disappear once the server says `cancellable: false`.
 */
import type { ReactElement } from 'react';
import type { BetView } from '../../shared/api-types.js';

export interface BetCardProps {
  readonly bet: BetView;
}

export function BetCard(_props: BetCardProps): ReactElement {
  throw new Error('not implemented: M7c');
}
