/**
 * The "Load more" footer for a cursor-paged list (`usePages`). Renders nothing
 * at all when the server says there is no next cursor, so a short list has no
 * dangling affordance.
 */
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import type { Paged } from '../hooks/usePages.js';

export function LoadMore<T>(props: {
  readonly paged: Paged<T>;
  readonly label: string;
}): ReactElement {
  const { paged, label } = props;
  if (!paged.hasMore && paged.moreError === undefined) return <></>;
  return (
    <div className="load-more">
      {paged.moreError !== undefined && <ErrorBanner error={paged.moreError} />}
      {paged.hasMore && (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={paged.loadingMore}
          onClick={paged.loadMore}
        >
          {paged.loadingMore ? 'Loading…' : label}
        </button>
      )}
    </div>
  );
}
