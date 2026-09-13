/**
 * One game: both teams, the score/clock when live, and six market buttons.
 *
 * `lines === null` renders "line not posted yet" — a NORMAL state for CFB early
 * in the week, not an error. A stale line renders the market as unavailable
 * rather than silently omitting the button.
 */
import type { ReactElement } from 'react';
import type { GameCard as GameCardData } from '../../shared/api-types.js';

export interface GameCardProps {
  readonly game: GameCardData;
}

export function GameCard(_props: GameCardProps): ReactElement {
  throw new Error('not implemented: M7b');
}
