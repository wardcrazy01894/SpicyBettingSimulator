/**
 * "Report a bug": a title, a description, and the page the person is on. The
 * server adds who, when, which version and which browser, and files a GitHub
 * issue (PLAN.md §11.7). On success the sheet shows the issue link.
 *
 * Validation runs in the browser with the SAME `validateBugReport` the Worker
 * uses, so the Send button is only enabled for a request the server will take
 * — the server still re-validates (CLAUDE.md rule 8).
 */
import { useCallback, useRef, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';
import { useLocation } from 'react-router-dom';

import { ErrorBanner } from './ErrorBanner.js';
import { diagnosticsText } from '../diagnostics.js';
import { Spinner } from './Spinner.js';
import { postBugReport } from '../api/client.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import {
  BUG_REPORT_DESCRIPTION_MAX,
  BUG_REPORT_DIAGNOSTICS_MAX,
  BUG_REPORT_TITLE_MAX,
} from '../../shared/constants.js';
import { validateBugReport } from '../../shared/validate.js';
import type { BugReportResponse } from '../../shared/api-types.js';

export function BugReportSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const { open, onClose } = props;
  const location = useLocation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [filed, setFiled] = useState<BugReportResponse | null>(null);

  // Closing forgets everything, so re-opening never lands on a stale
  // "filed as #N" screen or a stale error. The setters are stable, so this
  // callback is too, which is what keeps the focus trap from re-arming.
  const close = useCallback(() => {
    setFiled(null);
    setError(null);
    setTitle('');
    setDescription('');
    onClose();
  }, [onClose]);
  useFocusTrap(dialogRef, open, close);

  if (!open) return <></>;

  // The page is captured at SUBMIT, not at open, and is the SPA path only —
  // never the origin, never a hash (there is nothing in one, but a report
  // should not be the place we find out). It is OPTIONAL server-side, and it is
  // derived rather than typed, so a page the validator refuses (a 200+ char
  // query string, say) must not wedge the form: the report goes without it.
  const page = `${location.pathname}${location.search}`;
  const withPage = validateBugReport({ title, description, page });
  const draft =
    !withPage.ok && withPage.field === 'page'
      ? validateBugReport({ title, description, page: null })
      : withPage;
  // Only surface a message once the person has typed something in that field —
  // an empty form is not yet "wrong".
  const problem =
    !draft.ok &&
    ((draft.field === 'title' && title !== '') ||
      (draft.field === 'description' && description !== ''))
      ? draft.message
      : null;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draft.ok || busy) return;
    setBusy(true);
    setError(null);
    // Rendered at SUBMIT so the log includes everything up to the click.
    postBugReport({ ...draft.value, diagnostics: diagnosticsText(BUG_REPORT_DIAGNOSTICS_MAX) })
      .then((response) => {
        setFiled(response);
        setTitle('');
        setDescription('');
      })
      .catch((thrown: unknown) => {
        setError(thrown);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">Report a bug</h2>
          <button type="button" className="btn btn-quiet" onClick={close}>
            Close
          </button>
        </header>

        {filed !== null ? (
          <>
            <div className="banner">
              <p className="banner-text">
                Thanks — filed as{' '}
                <a href={filed.issueUrl} target="_blank" rel="noreferrer">
                  issue #{String(filed.issueNumber)}
                </a>
                .
              </p>
            </div>
            <div className="sheet-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setFiled(null);
                }}
              >
                Report another
              </button>
              <button type="button" className="btn btn-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form className="bug-form" onSubmit={onSubmit}>
            <p className="muted slip-hint">
              What were you doing, what did you expect, and what happened instead? Your username,
              the page you are on, the app version, your browser and a log of recent errors and
              requests are attached automatically, and the report is filed as a public GitHub issue.
            </p>
            <label className="field">
              <span className="field-label">What went wrong</span>
              <input
                className="field-input"
                name="title"
                autoComplete="off"
                maxLength={BUG_REPORT_TITLE_MAX}
                required
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Details</span>
              <textarea
                className="field-input field-textarea"
                name="description"
                maxLength={BUG_REPORT_DESCRIPTION_MAX}
                required
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
              <span className="field-count">
                {String(description.length)} / {String(BUG_REPORT_DESCRIPTION_MAX)}
              </span>
            </label>
            <p className="muted slip-hint">Page: {page}</p>
            <details className="bug-diagnostics">
              <summary className="muted">What gets attached</summary>
              <pre className="bug-text">{diagnosticsText(BUG_REPORT_DIAGNOSTICS_MAX)}</pre>
            </details>

            {problem !== null && <p className="field-problem">{problem}</p>}
            {error !== null && <ErrorBanner error={error} />}

            <div className="sheet-actions">
              <button type="submit" className="btn btn-primary" disabled={!draft.ok || busy}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
            {busy && <Spinner label="Filing the issue…" />}
          </form>
        )}
      </div>
    </div>
  );
}
