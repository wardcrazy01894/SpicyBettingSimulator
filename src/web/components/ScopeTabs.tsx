/**
 * The All / NFL / NCAAF / MLB switch — a thin wrapper over `<Segmented>`, like
 * `<LeagueTabs>`, so My Bets, a player's page and the leaderboard offer the
 * same row in the same order (`scopeOptions`, lib/scope.ts). The leagues come
 * from `/api/config`, so a league the server does not run is never offered.
 */
import type { ReactElement } from 'react';

import { Segmented } from './Segmented.js';
import { scopeOptions } from '../lib/scope.js';
import type { Scope } from '../lib/scope.js';
import { useConfig } from '../state/config.js';

export function ScopeTabs(props: {
  readonly scope: Scope;
  readonly onChange: (scope: Scope) => void;
}): ReactElement {
  const config = useConfig();
  return (
    <Segmented<Scope>
      label="Sport"
      value={props.scope}
      options={scopeOptions(config.leagues)}
      onChange={props.onChange}
    />
  );
}
