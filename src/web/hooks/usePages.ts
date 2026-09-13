/**
 * "Load more" over a cursor-paged list. PLAN.md §11.4 / §11.5.
 *
 * `GET /api/bets` and `GET /api/ledger` both answer with a `nextCursor` that the
 * SPA never used, so every list silently truncated at the server's default page
 * size with no way to see anything older.
 *
 * Page 1 stays in the `useResource` cache — it is what polling refreshes and
 * what `invalidate()` re-reads after a bet is placed — and this hook holds pages
 * 2..n beside it. The merge is by id (see `lib/paging.ts`) because a refreshed
 * page 1 overlaps what has already been loaded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { mergePages, nextCursorOf } from '../lib/paging.js';
import type { Page } from '../lib/paging.js';

export interface Paged<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly moreError: Error | undefined;
  readonly loadMore: () => void;
}

interface Held<T> {
  readonly resetKey: string;
  readonly pages: readonly Page<T>[];
}

/**
 * @param resetKey  Changes whenever the FIRST page is a different query (a
 *                  different filter or league); the extra pages are dropped.
 * @param first     Page 1, or undefined while it is loading.
 * @param keyOf     Stable identity of an item, for de-duplication.
 * @param fetchPage Fetch one more page from a cursor.
 */
export function usePages<T>(
  resetKey: string,
  first: Page<T> | undefined,
  keyOf: (item: T) => string,
  fetchPage: (cursor: string) => Promise<Page<T>>,
): Paged<T> {
  const [held, setHeld] = useState<Held<T>>({ resetKey, pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error | undefined>(undefined);

  // Adjust state during render rather than in an effect: an effect would paint
  // the previous filter's rows for one frame first (and trip
  // react-hooks/set-state-in-effect). Same pattern as `StakeInput`.
  if (held.resetKey !== resetKey) {
    setHeld({ resetKey, pages: [] });
    setMoreError(undefined);
  }
  const pages = held.resetKey === resetKey ? held.pages : [];

  // Fresh closure every render; the callback needs a stable one.
  const fetchRef = useRef(fetchPage);
  useEffect(() => {
    fetchRef.current = fetchPage;
  });

  const all: readonly Page<T>[] = first === undefined ? pages : [first, ...pages];
  const cursor = nextCursorOf(all);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(undefined);
    void fetchRef
      .current(cursor)
      .then((page) => {
        // The filter may have changed while this was on the wire; those pages
        // belong to a query nobody is looking at any more.
        setHeld((current) =>
          current.resetKey === resetKey ? { resetKey, pages: [...current.pages, page] } : current,
        );
      })
      .catch((thrown: unknown) => {
        setMoreError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor, loadingMore, resetKey]);

  return {
    items: mergePages(all, keyOf),
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    loadMore,
  };
}
