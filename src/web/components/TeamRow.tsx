import type { ReactElement } from 'react';
import type { GameTeamView } from '../../shared/api-types.js';

export interface TeamRowProps {
  readonly team: GameTeamView;
  readonly isWinner: boolean;
}

export function TeamRow(_props: TeamRowProps): ReactElement {
  throw new Error('not implemented: M7b');
}
