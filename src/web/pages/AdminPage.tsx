/** Manual job triggers, recent job runs with stats/warnings, users, reconcile. */
import { useState } from 'react';
import type { ReactElement } from 'react';

import { EmptyState, ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import {
  postAdminJob,
  postAdminReconcile,
  postAdminUserDisabled,
  postAdminUserPassword,
} from '../api/client.js';
import { deriveKey } from '../api/kdf.js';
import { useAdminJobs, useAdminUsers } from '../hooks/useApi.js';
import { invalidate } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/datetime.js';
import { useSession } from '../state/session.js';
import { formatCents } from '../../shared/validate.js';
import type { AdminJob } from '../api/client.js';
import type { AdminUserView, JobRunView, ReconcileResponse } from '../../shared/api-types.js';

const JOBS: readonly AdminJob[] = ['refresh', 'settle', 'maintenance'];

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
          <span className="stats-key">{key}</span>{' '}
          <span className="stats-value">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function UserRow(props: {
  readonly user: AdminUserView;
  readonly meId: string | null;
}): ReactElement {
  const { user, meId } = props;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

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
        {user.isDisabled && <span className="chip chip-loss">disabled</span>}
        {user.id === meId && <span className="chip chip-quiet">you</span>}
      </div>

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy || user.id === meId}
          onClick={() => {
            run(
              () => postAdminUserDisabled(user.id, !user.isDisabled),
              user.isDisabled ? 'Re-enabled.' : 'Disabled.',
            );
          }}
        >
          {user.isDisabled ? 'Enable' : 'Disable'}
        </button>
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
          disabled={busy || password === ''}
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

export function AdminPage(): ReactElement {
  const session = useSession();
  const jobs = useAdminJobs();
  const users = useAdminUsers();
  const [busyJob, setBusyJob] = useState<AdminJob | null>(null);
  const [jobError, setJobError] = useState<unknown>(null);
  const [reconcile, setReconcile] = useState<ReconcileResponse | null>(null);
  const [reconciling, setReconciling] = useState(false);

  return (
    <section className="page">
      <h2 className="page-title">Admin</h2>

      <h3 className="section-title">Jobs</h3>
      <div className="row-actions">
        {JOBS.map((job) => (
          <button
            key={job}
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
        ))}
      </div>
      {jobError !== null && <ErrorBanner error={jobError} />}

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

      <h3 className="section-title">Ledger reconciliation</h3>
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
            void postAdminReconcile()
              .then(setReconcile)
              .catch(() => {
                setReconcile(null);
              })
              .finally(() => {
                setReconciling(false);
              });
          }}
        >
          {reconciling ? 'Checking…' : 'Reconcile'}
        </button>
      </div>
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

      <h3 className="section-title">Users</h3>
      {users.error !== undefined && users.data === undefined && (
        <ErrorBanner error={users.error} onRetry={users.refetch} />
      )}
      {users.loading && users.data === undefined && <Spinner label="Loading users…" />}
      {users.data !== undefined && (
        <ul className="admin-users">
          {users.data.users.map((user) => (
            <UserRow key={user.id} user={user} meId={session.user?.id ?? null} />
          ))}
        </ul>
      )}
    </section>
  );
}
