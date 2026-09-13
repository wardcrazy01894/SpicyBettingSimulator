/**
 * The NFL / NCAAF switch. A thin wrapper over `<Segmented>` so there is exactly
 * one implementation of "row of toggle buttons" — it used to be a second,
 * subtly different copy that claimed `role="tab"` without a tabpanel.
 */
import { Segmented } from './Segmented.js';
import type { SegmentedOption } from './Segmented.js';
import { LEAGUE_LABEL } from '../lib/labels.js';
import type { ReactElement } from 'react';
import type { League } from '../../shared/types.js';

export interface LeagueTabsProps {
  readonly league: League;
  readonly leagues: readonly League[];
  readonly onChange: (league: League) => void;
}

export function LeagueTabs(props: LeagueTabsProps): ReactElement {
  const { league, leagues, onChange } = props;
  const options: readonly SegmentedOption<League>[] = leagues.map((candidate) => ({
    value: candidate,
    label: LEAGUE_LABEL[candidate],
  }));
  return <Segmented<League> label="League" value={league} options={options} onChange={onChange} />;
}
