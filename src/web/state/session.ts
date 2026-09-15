/**
 * Session context object + consumer hook. PLAN.md §12.2.
 *
 * Split out of `SessionContext.tsx` so that file exports ONLY a component —
 * `react-refresh/only-export-components` warns otherwise, and a mixed module
 * breaks fast refresh for real.
 */

import { createContext, useContext } from 'react';

import type { UserSummary } from '../../shared/types.js';

export interface SessionState {
  readonly status: 'loading' | 'anon' | 'authed';
  readonly user: UserSummary | null;
}

export interface SessionApi extends SessionState {
  /** Runs the browser KDF (~300 ms) and POSTs `dk` — never the password. */
  readonly login: (username: string, password: string) => Promise<void>;
  readonly signup: (username: string, password: string, inviteCode: string | null) => Promise<void>;
  readonly logout: () => Promise<void>;
  /** Revokes every session for this user (PLAN.md §10.5). */
  readonly logoutAll: () => Promise<void>;
  /** Renames the caller; the header updates in place, no reload. */
  readonly setDisplayName: (displayName: string) => Promise<void>;
}

export const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
