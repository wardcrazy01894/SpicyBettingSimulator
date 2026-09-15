/**
 * Session state: { status: 'loading' | 'anon' | 'authed', user }.
 * Bootstraps from GET /api/auth/me. A 401 from ANY call dispatches
 * SESSION_EXPIRED, which flips the status to 'anon'; `AppShell` renders the
 * redirect to /login (no imperative navigation from the api layer).
 *
 * Login and signup run the 210k-iteration browser KDF first (PLAN.md §10.2) and
 * POST only the derived key. The plaintext password never leaves this module.
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  ApiError,
  getMe,
  postLogin,
  postLogout,
  postDisplayName,
  postLogoutAll,
  postSignup,
  setUnauthenticatedHandler,
} from '../api/client.js';
import { deriveKey } from '../api/kdf.js';
import { diagnostics, setBeaconEnabled } from '../diagnostics.js';
import { clearCache, invalidate } from '../hooks/useResource.js';
import { SessionContext } from './session.js';
import type { SessionApi, SessionState } from './session.js';
import type { LoginRequest, SignupRequest } from '../../shared/api-types.js';
import type { UserSummary } from '../../shared/types.js';

type Action = { readonly type: 'AUTHED'; readonly user: UserSummary } | { readonly type: 'ANON' };

function reducer(_state: SessionState, action: Action): SessionState {
  return action.type === 'AUTHED'
    ? { status: 'authed', user: action.user }
    : { status: 'anon', user: null };
}

const INITIAL: SessionState = { status: 'loading', user: null };

export function SessionProvider(props: { children: ReactNode }): ReactElement {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Bootstrap. A 401 here is the NORMAL anonymous case, not an error, and the
  // routes may 404 entirely on a branch where M3 has not landed — both mean
  // "not signed in" and must not wedge the app on a spinner.
  useEffect(() => {
    // An AbortController rather than a `let cancelled` flag: `signal.aborted` is
    // a getter, so TypeScript cannot narrow it to a literal across the await.
    const ac = new AbortController();
    void (async () => {
      try {
        const { user } = await getMe();
        if (!ac.signal.aborted) dispatch({ type: 'AUTHED', user });
      } catch {
        if (!ac.signal.aborted) dispatch({ type: 'ANON' });
      }
    })();
    return () => {
      ac.abort();
    };
  }, []);

  // The diagnostics log follows the session: cleared the moment it ends, so a
  // shared browser cannot carry one person's activity into the next person's
  // public bug report; the crash beacon only fires while signed in.
  useEffect(() => {
    if (state.status === 'anon') diagnostics.clear();
    setBeaconEnabled(state.status === 'authed');
  }, [state.status]);

  // Any 401 anywhere expires the session exactly once.
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      dispatch({ type: 'ANON' });
    });
    return () => {
      setUnauthenticatedHandler(null);
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const body: LoginRequest = {
      username: username.trim().toLowerCase(),
      dk: await deriveKey(username, password),
    };
    const { user } = await postLogin(body);
    clearCache();
    dispatch({ type: 'AUTHED', user });
  }, []);

  const signup = useCallback(
    async (username: string, password: string, inviteCode: string | null): Promise<void> => {
      const normalised = username.trim().toLowerCase();
      const dk = await deriveKey(username, password);
      const body: SignupRequest =
        inviteCode === null || inviteCode === ''
          ? { username: normalised, dk }
          : { username: normalised, dk, inviteCode };
      const { user } = await postSignup(body);
      clearCache();
      dispatch({ type: 'AUTHED', user });
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await postLogout();
    } catch (error) {
      // A logout that 401s has already achieved its purpose.
      if (!(error instanceof ApiError)) throw error;
    }
    clearCache();
    dispatch({ type: 'ANON' });
  }, []);

  const logoutAll = useCallback(async (): Promise<void> => {
    await postLogoutAll();
    clearCache();
    dispatch({ type: 'ANON' });
  }, []);

  const setDisplayName = useCallback(async (displayName: string): Promise<void> => {
    const { user } = await postDisplayName({ displayName });
    // The name is read by two other pages; drop their cached copies rather than
    // the whole cache — the board and the ledger did not change.
    invalidate('leaderboard:');
    invalidate('admin:users');
    dispatch({ type: 'AUTHED', user });
  }, []);

  const value = useMemo<SessionApi>(
    () => ({ ...state, login, signup, logout, logoutAll, setDisplayName }),
    [state, login, signup, logout, logoutAll, setDisplayName],
  );

  return <SessionContext value={value}>{props.children}</SessionContext>;
}
