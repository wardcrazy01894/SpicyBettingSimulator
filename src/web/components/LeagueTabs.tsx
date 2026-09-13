import type { ReactElement } from 'react';
import type { League } from '../../shared/types.js';

export interface LeagueTabsProps {
  readonly league: League;
  onChange(league: League): void;
}

export function LeagueTabs(_props: LeagueTabsProps): ReactElement {
  throw new Error('not implemented: M7b');
}
