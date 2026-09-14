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

import { mergePages, nextCursorOf, windowIsStale } from '../lib/paging.js';
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
  /**
   * The id at the TOP of page 1 the held pages were fetched behind.
   * `null` means "page 1 has not arrived yet, or is empty".
   */
  readonly firstId: string | null;
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
  const [held, setHeld] = useState<Held<T>>({ resetKey, firstId: null, pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error | undefined>(undefined);

  /**
   * `undefined` while page 1 is loading (no information — hold what we have),
   * `null` once it has loaded and is empty, otherwise the top row's id.
   */
  const firstItem = first?.items[0];
  const firstId: string | null | undefined =
    first === undefined ? undefined : firstItem === undefined ? null : keyOf(firstItem);

  // Drop the held pages when the filter changes OR when the top of page 1 does.
  // The second half is the subtle one; `windowIsStale` carries the reasoning and
  // is where `tests/web/paging.spec.ts` pins it.
  const stale = windowIsStale(held, resetKey, firstId);

  // Adjust state during render rather than in an effect: an effect would paint
  // the previous filter's rows for one frame first (and trip
  // react-hooks/set-state-in-effect). Same pattern as `StakeInput`.
  if (stale) {
    setHeld({ resetKey, firstId: firstId ?? null, pages: [] });
    if (held.resetKey !== resetKey) setMoreError(undefined);
  }
  const pages = stale ? [] : held.pages;

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
        // The filter — or the top of page 1 — may have changed while this was on
        // the wire; those pages belong to a window nobody is looking at any more.
        setHeld((current) =>
          current.resetKey === resetKey && current.firstId === (firstId ?? null)
            ? { resetKey, firstId: current.firstId, pages: [...current.pages, page] }
            : current,
        );
      })
      .catch((thrown: unknown) => {
        setMoreError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor, loadingMore, resetKey, firstId]);

  return {
    items: mergePages(all, keyOf),
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    loadMore,
  };
}
