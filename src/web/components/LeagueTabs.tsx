import type { ReactElement } from 'react';

import { LEAGUE_LABEL } from '../lib/labels.js';
import type { League } from '../../shared/types.js';

export interface LeagueTabsProps {
  readonly league: League;
  readonly leagues: readonly League[];
  readonly onChange: (league: League) => void;
}

export function LeagueTabs(props: LeagueTabsProps): ReactElement {
  const { league, leagues, onChange } = props;
  return (
    <div className="segmented" role="tablist" aria-label="League">
      {leagues.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="tab"
          className="segment"
          aria-selected={candidate === league}
          aria-pressed={candidate === league}
          onClick={() => {
            onChange(candidate);
          }}
        >
          {LEAGUE_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}
