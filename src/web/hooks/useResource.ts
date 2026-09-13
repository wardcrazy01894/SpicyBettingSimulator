/**
 * Minimal stale-while-revalidate data hook. PLAN.md §12.2.
 *
 * Deliberately not a dependency — react-query would be more code shipped to a
 * phone than this whole app needs. The cache itself lives in
 * `resource-store.ts` (no React, so its ordering rules are unit-testable); this
 * file is only the `useSyncExternalStore` binding over it.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { readEntry, run, subscribeToResources } from './resource-store.js';
import type { ResourceEntry } from './resource-store.js';

export { clearCache, invalidate } from './resource-store.js';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  readonly refetch: () => void;
}

export function useResource<T>(key: string | null, fetcher: () => Promise<T>): Resource<T> {
  // The fetcher is a fresh closure every render; the cache needs a stable one,
  // so it is read through a ref that is updated in an effect (never in render).
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const getSnapshot = useCallback((): ResourceEntry => readEntry(key), [key]);
  const entry = useSyncExternalStore(subscribeToResources, getSnapshot, getSnapshot);

  useEffect(() => {
    if (key === null) return;
    // `readEntry` answers PENDING (stale) for a key that has never been
    // fetched, so one test covers both "never loaded" and "invalidated".
    if (readEntry(key).stale) void run(key, () => fetcherRef.current());
  }, [key, entry.stale]);

  const refetch = useCallback(() => {
    if (key !== null) void run(key, () => fetcherRef.current());
  }, [key]);

  return { data: entry.data as T | undefined, error: entry.error, loading: entry.loading, refetch };
}
