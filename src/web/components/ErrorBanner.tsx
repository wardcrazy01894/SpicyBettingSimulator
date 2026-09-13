/** Renders an ApiError using the messages table, with a retry affordance. */
import type { ReactElement } from 'react';

import { ApiError } from '../api/client.js';
import { messageForError } from '../api/messages.js';

export function ErrorBanner(props: {
  readonly error: unknown;
  onRetry?: () => void;
}): ReactElement {
  const { error, onRetry } = props;
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div className="banner banner-error" role="alert">
      <p className="banner-text">{messageForError(error)}</p>
      {code !== null && <p className="banner-code">{code}</p>}
      {onRetry !== undefined && (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** The empty-state twin of ErrorBanner: no data, no error, nothing to retry. */
export function EmptyState(props: {
  readonly title: string;
  readonly hint?: string;
}): ReactElement {
  return (
    <div className="empty">
      <p className="empty-title">{props.title}</p>
      {props.hint !== undefined && <p className="empty-hint">{props.hint}</p>}
    </div>
  );
}
