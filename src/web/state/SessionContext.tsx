/**
 * Session state: { status: 'loading' | 'anon' | 'authed', user }.
 * Bootstraps from GET /api/auth/me. A 401 from any call dispatches
 * SESSION_EXPIRED, which bounces the user to /login.
 */

import type { ReactElement, ReactNode } from 'react';

import type { UserSummary } from '../../shared/types.js';

export interface SessionState {
  readonly status: 'loading' | 'anon' | 'authed';
  readonly user: UserSummary | null;
}

export interface SessionApi extends SessionState {
  login(username: string, password: string): Promise<void>;
  signup(username: string, password: string, inviteCode: string | null): Promise<void>;
  logout(): Promise<void>;
}

export function SessionProvider(_props: { children: ReactNode }): ReactElement {
  throw new Error('not implemented: M7a');
}

export function useSession(): SessionApi {
  throw new Error('not implemented: M7a');
}
