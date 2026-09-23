/**
 * Login + signup. Shows a spinner during the ~300 ms browser-side PBKDF2
 * (PLAN.md §10.2) so the delay reads as "working", not "broken".
 *
 * The invite-code field appears only when `GET /api/health` says
 * `inviteRequired` — when INVITE_CODE is unset the server allows open signup and
 * asking for a code would be a lie (PLAN.md §10.5).
 *
 * A join link (`/login?invite=<code>`, built for the admin by `lib/invite.ts`)
 * opens on the "Create account" tab with the invite field prefilled, so the
 * friend only picks a name and a password.
 *
 * The plaintext password never leaves `SessionProvider.login/signup`, which
 * derives `dk` first and posts only that.
 */
import { useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import { Navigate, useSearchParams } from 'react-router-dom';

import { ErrorBanner } from '../components/ErrorBanner.js';
import { Segmented } from '../components/Segmented.js';
import { Spinner } from '../components/Spinner.js';
import { useHealth } from '../hooks/useApi.js';
import { INVITE_PARAM, inviteCodeFromParam } from '../lib/invite.js';
import { useSession } from '../state/session.js';
import { PASSWORD_MIN_LENGTH, USERNAME_MAX, USERNAME_MIN } from '../../shared/constants.js';
import { validateUsername } from '../../shared/validate.js';

type Tab = 'login' | 'signup';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'login', label: 'Sign in' },
  { value: 'signup', label: 'Create account' },
];

export function AuthPage(): ReactElement {
  const session = useSession();
  const health = useHealth();
  const [params] = useSearchParams();
  // Read once, as initial state: the link's job is to land the friend on the
  // signup form with the code filled in, not to pin the field for the visit.
  // PRESENCE of the param picks the tab (a valueless `?invite` is the open-signup
  // link); its VALUE is the prefill.
  const [tab, setTab] = useState<Tab>(() => (params.has(INVITE_PARAM) ? 'signup' : 'login'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(
    () => inviteCodeFromParam(params.get(INVITE_PARAM)) ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  if (session.status === 'authed') return <Navigate to="/" replace />;

  // `inviteRequired` unknown (health unreachable) => show the field. Asking for a
  // code that turns out to be unnecessary is recoverable; hiding a required one
  // is a dead end.
  const inviteRequired = health.data?.inviteRequired ?? true;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);

    const checked = validateUsername(username);
    if (!checked.ok) {
      setLocalProblem(checked.message);
      return;
    }
    if (tab === 'signup' && password.length < PASSWORD_MIN_LENGTH) {
      setLocalProblem(`Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`);
      return;
    }
    setLocalProblem(null);
    setBusy(true);
    const work =
      tab === 'login'
        ? session.login(username, password)
        : session.signup(username, password, inviteCode.trim() === '' ? null : inviteCode);
    void work
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <main className="auth">
      <h1 className="auth-title">Spicy Betting Simulator</h1>
      <p className="muted">Fake money. Real lines.</p>

      <Segmented
        label="Account"
        value={tab}
        options={TABS}
        onChange={(next) => {
          setTab(next);
          setError(null);
          setLocalProblem(null);
        }}
      />

      <form className="auth-form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Username</span>
          <input
            className="field-input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={USERNAME_MIN}
            maxLength={USERNAME_MAX}
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="field-input"
            type="password"
            name="password"
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>

        {tab === 'signup' && inviteRequired && (
          <label className="field">
            <span className="field-label">Invite code</span>
            <input
              className="field-input"
              name="inviteCode"
              autoComplete="off"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value);
              }}
            />
          </label>
        )}

        {localProblem !== null && <p className="field-problem">{localProblem}</p>}
        {error !== null && <ErrorBanner error={error} />}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {tab === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {busy && <Spinner label="Stretching your password…" />}
      </form>

      <p className="muted auth-note">
        Your password is stretched in this browser before it is sent — that pause is the
        210,000-round key derivation, not a slow network.
      </p>
    </main>
  );
}
