/**
 * Four tabs — Jobs, Ledger, Users, Bug reports — with the active one in the URL
 * (`/admin?tab=users`) so a reload or a pasted link lands on the same section.
 * Users opens with "Invite a friend": the join link that prefills the invite code.
 *
 * All four panels are mounted from the start and the inactive ones are `hidden`
 * — the same three fetches the one-long-scroll page made. Staying mounted is
 * what keeps a running job's "Running…", a reconcile report or a half-typed
 * password reset alive across a tab switch.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { TabPanel, Tabs } from '../components/Tabs.js';
import { Spinner } from '../components/Spinner.js';
import {
  deleteAdminUser,
  postAdminJob,
  postAdminReconcile,
  postAdminUserDisabled,
  postAdminUserPassword,
} from '../api/client.js';
import { deriveKey } from '../api/kdf.js';
import {
  useAdminBugReports,
  useAdminInvite,
  useAdminJobs,
  useAdminUsers,
} from '../hooks/useApi.js';
import { invalidate } from '../hooks/useResource.js';
import { ADMIN_TABS, parseAdminTab } from '../lib/admin-tabs.js';
import { inviteLink } from '../lib/invite.js';
import type { AdminTab } from '../lib/admin-tabs.js';
import { formatDateTime } from '../lib/datetime.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';
import type { AdminJob } from '../api/client.js';
import type {
  AdminUserView,
  BugReportView,
  JobRunView,
  ReconcileResponse,
} from '../../shared/api-types.js';

/**
 * The three cron jobs, in the order they matter, each with what pressing the
 * button does. A manual run is the identical code path with `trigger = 'admin'`
 * (PLAN.md §9.3) — except `refresh`, which the HTTP CPU budget cuts to ONE
 * target per press. The schedules themselves are deliberately NOT restated
 * here: `wrangler.jsonc` + PLAN §9.1 + OPERATIONS are the guarded copies.
 */
const JOBS: readonly { readonly job: AdminJob; readonly blurb: string }[] = [
  {
    job: 'refresh',
    blurb:
      'Pulls games, scores and lines from ESPN for the single most overdue slate. The cron keeps every slate on its own cadence; press this to jump the queue.',
  },
  {
    job: 'settle',
    blurb:
      'Grades every pending bet whose games are all final and pays winners. Safe to press again — a bet can never be paid twice.',
  },
  {
    job: 'maintenance',
    blurb:
      'Cancels games stuck postponed or dropped from ESPN so the next settle run refunds their legs, and prunes old sessions and job runs.',
  },
];

/**
 * `JobRunView.stats` is `Record<string, unknown>` — the ingest/settle jobs decide
 * its shape, and PLAN.md §8/§9 describe parser warnings and auto-void decisions
 * as living inside it. Rendering it structurally (rather than assuming keys) is
 * what keeps this page useful when a job starts reporting something new.
 */
function StatsCell(props: { readonly run: JobRunView }): ReactElement {
  const stats = props.run.stats;
  if (stats === null) return <span className="muted">—</span>;
  const entries = Object.entries(stats);
  if (entries.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="stats-list">
      {entries.map(([key, value]) => (
        <li key={key}>
          <span className="stats-key">{key}</span> <StatsValue name={key} value={value} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A list of strings (parser warnings, line-gap details) reads one per line and
 * an empty one as a dash; anything else is shown as its JSON, which is what the
 * job wrote.
 */
function StatsValue(props: { readonly name: string; readonly value: unknown }): ReactElement {
  const { name, value } = props;
  if (typeof value === 'string') return <span className="stats-value">{value}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    if (value.length === 0) return <span className="muted">—</span>;
    return (
      <ul className="stats-lines">
        {value.map((line, i) => (
          <li key={`${name}-${String(i)}`} className="stats-value">
            {line}
          </li>
        ))}
      </ul>
    );
  }
  return <span className="stats-value">{JSON.stringify(value)}</span>;
}

/**
 * The delete button is refused by the server for the caller's own account and for
 * the last enabled admin; disabling it here as well is only so the operator finds
 * out before clicking. The server guards are the authority (CLAUDE.md §8) — this
 * is a list the browser happens to be holding, and it can be stale.
 *
 * "Last enabled admin" mirrors the SQL subquery in `auth.ts`: admins that are
 * neither disabled nor deleted. A deleted account is disabled by construction, so
 * the two definitions cannot drift.
 */
/**
 * Newest first, straight off `GET /api/admin/bugs`. A row with no issue link is
 * one GitHub refused — the reporter only saw a 503 — so its text is shown in
 * full here; that is the list's reason to exist.
 */
function BugReportList(props: { readonly reports: readonly BugReportView[] }): ReactElement {
  if (props.reports.length === 0) return <EmptyState title="No bug reports yet." />;
  return (
    <ul className="bug-list">
      {props.reports.map((r) => (
        <li key={r.id} className="card">
          <p className="card-title">
            {r.issueUrl !== null && r.issueNumber !== null ? (
              <a href={r.issueUrl} target="_blank" rel="noreferrer">
                #{String(r.issueNumber)} {r.title}
              </a>
            ) : (
              <>
                <span className="tag tag-error">not filed</span> {r.title}
              </>
            )}
          </p>
          <p className="muted">
            @{r.username} · {formatDateTime(r.createdAt)} · v{r.appVersion}
            {r.page !== null ? ` · ${r.page}` : ''}
          </p>
          {r.error !== null && <p className="field-problem">GitHub: {r.error}</p>}
          {r.issueUrl === null && <pre className="bug-text">{r.description}</pre>}
          {r.diagnostics !== null && (
            <details className="bug-diagnostics">
              <summary className="muted">Diagnostics</summary>
              <pre className="bug-text">{r.diagnostics}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function isLastEnabledAdmin(user: AdminUserView, all: readonly AdminUserView[]): boolean {
  if (!user.isAdmin || user.isDisabled || user.isDeleted) return false;
  return all.filter((u) => u.isAdmin && !u.isDisabled && !u.isDeleted).length <= 1;
}

function UserRow(props: {
  readonly user: AdminUserView;
  readonly meId: string | null;
  readonly lastAdmin: boolean;
}): ReactElement {
  const { user, meId, lastAdmin } = props;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  // An INLINE two-step confirm rather than `window.confirm`: a native dialog is
  // unstyleable, untestable and blocks the whole tab, and this is the only
  // irreversible button on the page.
  const [confirming, setConfirming] = useState(false);

  const isSelf = user.id === meId;
  const deletable = !isSelf && !lastAdmin && !user.isDeleted;

  const run = (action: () => Promise<void>, message: string): void => {
    setBusy(true);
    setError(null);
    setDone(null);
    void action()
      .then(() => {
        setDone(message);
        invalidate('admin:users');
      })
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <li className="admin-user">
      <div className="admin-user-head">
        <span className="admin-user-name">
          {user.displayName} <span className="muted">@{user.username}</span>
        </span>
        {user.isAdmin && <span className="chip chip-quiet">admin</span>}
        {user.isDeleted ? (
          <span className="chip chip-loss">deleted</span>
        ) : (
          user.isDisabled && <span className="chip chip-loss">disabled</span>
        )}
        {isSelf && <span className="chip chip-quiet">you</span>}
      </div>

      {user.isDeleted && (
        <p className="muted">
          Deleted {user.deletedAt === null ? '' : formatDateTime(user.deletedAt)}. Settled bets and
          ledger history are kept; the old username is free again.
        </p>
      )}

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy || isSelf || user.isDeleted}
          onClick={() => {
            run(
              () => postAdminUserDisabled(user.id, !user.isDisabled),
              user.isDisabled ? 'Re-enabled.' : 'Disabled.',
            );
          }}
        >
          {user.isDisabled ? 'Enable' : 'Disable'}
        </button>

        {!confirming && (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy || !deletable}
            title={
              isSelf
                ? 'You cannot delete your own account.'
                : lastAdmin
                  ? 'This is the last enabled admin.'
                  : undefined
            }
            onClick={() => {
              setConfirming(true);
              setDone(null);
              setError(null);
            }}
          >
            Delete
          </button>
        )}
        {confirming && (
          <>
            <span className="muted">Delete {user.username}? This cannot be undone.</span>
            <button
              type="button"
              className="btn btn-quiet tone-loss"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                run(() => deleteAdminUser(user.id), 'Deleted.');
              }}
            >
              {busy ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      <div className="admin-reset">
        <label className="field">
          <span className="field-label">New password for {user.username}</span>
          <input
            className="field-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy || password === '' || user.isDeleted}
          onClick={() => {
            // Runs the IDENTICAL browser KDF as login, salted with the TARGET
            // user's name, and posts only `dk` — the admin's browser never sends
            // a plaintext password and the server never sees one (PLAN.md §10.6).
            run(async () => {
              const dk = await deriveKey(user.username, password);
              await postAdminUserPassword(user.id, dk);
              setPassword('');
            }, 'Password reset.');
          }}
        >
          {busy ? 'Working…' : 'Reset password'}
        </button>
      </div>

      {done !== null && <p className="muted">{done}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </li>
  );
}

/** Split out of AdminPage so the `users.data !== undefined` narrowing survives. */
function UserList(props: {
  readonly users: readonly AdminUserView[];
  readonly meId: string | null;
}): ReactElement {
  return (
    <ul className="admin-users">
      {props.users.map((user) => (
        <UserRow
          key={user.id}
          user={user}
          meId={props.meId}
          lastAdmin={isLastEnabledAdmin(user, props.users)}
        />
      ))}
    </ul>
  );
}

function JobsPanel(): ReactElement {
  const jobs = useAdminJobs();
  const [busyJob, setBusyJob] = useState<AdminJob | null>(null);
  const [jobError, setJobError] = useState<unknown>(null);

  return (
    <>
      <ul className="job-list">
        {JOBS.map(({ job, blurb }) => (
          <li key={job} className="job-item">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busyJob !== null}
              onClick={() => {
                setBusyJob(job);
                setJobError(null);
                void postAdminJob(job)
                  .then(() => {
                    invalidate('admin:jobs');
                  })
                  .catch((thrown: unknown) => {
                    setJobError(thrown);
                  })
                  .finally(() => {
                    setBusyJob(null);
                  });
              }}
            >
              {busyJob === job ? 'Running…' : `Run ${job}`}
            </button>
            <p className="job-blurb muted">{blurb}</p>
          </li>
        ))}
      </ul>
      {jobError !== null && <ErrorBanner error={jobError} />}

      <h3 className="section-title">Recent runs</h3>
      {jobs.error !== undefined && jobs.data === undefined && (
        <ErrorBanner error={jobs.error} onRetry={jobs.refetch} />
      )}
      {jobs.loading && jobs.data === undefined && <Spinner label="Loading job runs…" />}
      {jobs.data !== undefined &&
        (jobs.data.runs.length === 0 ? (
          <EmptyState title="No job runs recorded yet." />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Stats / warnings</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.job}</td>
                    <td>{run.trigger}</td>
                    <td>{formatDateTime(run.startedAt)}</td>
                    <td className={run.status === 'error' ? 'tone-loss' : undefined}>
                      {run.status}
                      {run.error !== null && <div className="stats-value">{run.error}</div>}
                    </td>
                    <td>
                      <StatsCell run={run} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}

function ReconcilePanel(): ReactElement {
  const [reconcile, setReconcile] = useState<ReconcileResponse | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <>
      <p className="muted page-note">
        Recomputes SUM(ledger) against balance_cents for every bankroll. Read-only — it never
        auto-fixes.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={reconciling}
          onClick={() => {
            setReconciling(true);
            setError(null);
            void postAdminReconcile()
              .then(setReconcile)
              .catch((thrown: unknown) => {
                setReconcile(null);
                setError(thrown);
              })
              .finally(() => {
                setReconciling(false);
              });
          }}
        >
          {reconciling ? 'Checking…' : 'Reconcile'}
        </button>
      </div>
      {error !== null && <ErrorBanner error={error} />}
      {reconcile !== null && (
        <div className={reconcile.drift.length === 0 ? 'banner' : 'banner banner-error'}>
          <p className="banner-text">
            Checked {String(reconcile.checked)} bankrolls · {String(reconcile.drift.length)} with
            drift
          </p>
          <ul>
            {reconcile.drift.map((d) => (
              <li key={d.bankrollId}>
                {d.bankrollId}: balance {formatCents(d.balanceCents)} vs ledger{' '}
                {formatCents(d.ledgerSumCents)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * "Invite a friend": the join link (`/login?invite=<code>`) with Copy and, where
 * the browser offers a share sheet, Share. The code comes from
 * `GET /api/admin/invite` — the same shared secret every player was told, read
 * back so nobody has to dictate it over text. With no code set the link is a
 * bare `/login` and the panel says so, because "signup is open" is a
 * misconfiguration worth seeing here as well as in `/api/health`.
 */
function InvitePanel(): ReactElement {
  const invite = useAdminInvite();
  const [status, setStatus] = useState<string | null>(null);

  if (invite.error !== undefined && invite.data === undefined) {
    return <ErrorBanner error={invite.error} onRetry={invite.refetch} />;
  }
  if (invite.data === undefined) return <Spinner label="Loading invite link…" />;

  const link = inviteLink(window.location.origin, invite.data.inviteCode);
  const canShare = typeof navigator.share === 'function';

  const copy = (): void => {
    setStatus(null);
    // `navigator.clipboard` is absent on an insecure origin (plain-http LAN dev);
    // the link is in a selectable field either way, so the failure is not a dead end.
    if (typeof navigator.clipboard === 'undefined') {
      setStatus('Copy is unavailable here — select the link and copy it.');
      return;
    }
    void navigator.clipboard
      .writeText(link)
      .then(() => {
        setStatus('Copied.');
      })
      .catch(() => {
        setStatus('Copy failed — select the link and copy it.');
      });
  };

  const share = (): void => {
    setStatus(null);
    void navigator
      .share({ title: 'Join Spicy Betting Simulator', url: link })
      .then(() => {
        setStatus('Shared.');
      })
      .catch((thrown: unknown) => {
        // Closing the sheet rejects with AbortError; that is not a failure.
        if (thrown instanceof DOMException && thrown.name === 'AbortError') return;
        setStatus('Share failed — copy the link instead.');
      });
  };

  return (
    <div className="invite-box">
      <h3 className="section-title">Invite a friend</h3>
      <p className="muted">
        {invite.data.inviteRequired
          ? 'Opens the signup form with the invite code filled in. Anyone with this link can join.'
          : 'No invite code is set, so signup is open to anyone who finds the site. The link below just opens the signup form.'}
      </p>
      <div className="admin-reset">
        <label className="field invite-field">
          <span className="field-label">Join link</span>
          <input
            className="field-input"
            readOnly
            value={link}
            onFocus={(e) => {
              e.target.select();
            }}
          />
        </label>
        <button type="button" className="btn btn-primary" onClick={copy}>
          Copy link
        </button>
        {canShare && (
          <button type="button" className="btn btn-quiet" onClick={share}>
            Share…
          </button>
        )}
      </div>
      {status !== null && <p className="muted">{status}</p>}
    </div>
  );
}

function UsersPanel(props: { readonly meId: string | null }): ReactElement {
  const users = useAdminUsers();
  return (
    <>
      <InvitePanel />
      <h3 className="section-title">Accounts</h3>
      {users.error !== undefined && users.data === undefined && (
        <ErrorBanner error={users.error} onRetry={users.refetch} />
      )}
      {users.loading && users.data === undefined && <Spinner label="Loading users…" />}
      {users.data !== undefined && <UserList users={users.data.users} meId={props.meId} />}
    </>
  );
}

function BugsPanel(): ReactElement {
  const bugs = useAdminBugReports();
  return (
    <>
      {bugs.error !== undefined && bugs.data === undefined && (
        <ErrorBanner error={bugs.error} onRetry={bugs.refetch} />
      )}
      {bugs.loading && bugs.data === undefined && <Spinner label="Loading bug reports…" />}
      {bugs.data !== undefined && <BugReportList reports={bugs.data.reports} />}
    </>
  );
}

function panelFor(tab: AdminTab, meId: string | null): ReactElement {
  switch (tab) {
    case 'jobs':
      return <JobsPanel />;
    case 'reconcile':
      return <ReconcilePanel />;
    case 'users':
      return <UsersPanel meId={meId} />;
    case 'bugs':
      return <BugsPanel />;
  }
}

export function AdminPage(): ReactElement {
  const session = useSession();
  const meId = session.user?.id ?? null;
  const [params, setParams] = useSearchParams();
  const tab = parseAdminTab(params.get('tab'));

  const setTab = (next: AdminTab): void => {
    // `replace`, so the back button leaves the admin page rather than replaying
    // every tab the operator clicked through. Jobs is the default and stays out
    // of the URL so `/admin` and `/admin?tab=jobs` are one address.
    const nextParams = new URLSearchParams(params);
    if (next === 'jobs') nextParams.delete('tab');
    else nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  };

  return (
    <section className="page">
      <h2 className="page-title">Admin</h2>
      <Tabs id="admin" label="Admin sections" tabs={ADMIN_TABS} value={tab} onChange={setTab} />
      {ADMIN_TABS.map((t) => (
        <TabPanel key={t.id} id="admin" tab={t.id} label={t.label} hidden={t.id !== tab}>
          {panelFor(t.id, meId)}
        </TabPanel>
      ))}
    </section>
  );
}
