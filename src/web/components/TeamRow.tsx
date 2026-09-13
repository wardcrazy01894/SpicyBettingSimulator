import type { ReactElement } from 'react';

import type { GameTeamView } from '../../shared/api-types.js';

export interface TeamRowProps {
  readonly team: GameTeamView;
  readonly isWinner: boolean;
  /** Hide the score column entirely before kickoff. */
  readonly showScore: boolean;
}

export function TeamRow(props: TeamRowProps): ReactElement {
  const { team, isWinner, showScore } = props;
  return (
    <div className={isWinner ? 'team-row team-row-winner' : 'team-row'}>
      {team.logo === null ? (
        <span className="team-logo team-logo-empty" aria-hidden="true" />
      ) : (
        <img className="team-logo" src={team.logo} alt="" width={24} height={24} loading="lazy" />
      )}
      {team.rank !== null && <span className="team-rank">#{String(team.rank)}</span>}
      <span className="team-abbr">{team.abbr}</span>
      <span className="team-name">{team.name}</span>
      {showScore && (
        <span className="team-score">{team.score === null ? '—' : String(team.score)}</span>
      )}
    </div>
  );
}
