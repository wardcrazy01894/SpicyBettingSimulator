/**
 * Minimal stale-while-revalidate data hook. PLAN.md §12.2.
 *
 * Deliberately not a dependency — react-query would be more code shipped to a
 * phone than this whole app needs. In-memory cache keyed by a string, shared
 * across components (two panels asking for the same bankroll make one request),
 * `refetch()`, and `invalidate(prefix)` for use after a bet mutation.
 *
 * Cache entries are IMMUTABLE objects replaced wholesale, which is what lets
 * `useSyncExternalStore` compare snapshots by identity.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  readonly refetch: () => void;
}

interface Entry {
  readonly data: unknown;
  readonly error: Error | undefined;
  readonly loading: boolean;
  /** Set by `invalidate`; the next mount/render of a subscriber reloads. */
  readonly stale: boolean;
  readonly load: (() => Promise<unknown>) | undefined;
}

const IDLE: Entry = {
  data: undefined,
  error: undefined,
  loading: false,
  stale: false,
  load: undefined,
};
const PENDING: Entry = {
  data: undefined,
  error: undefined,
  loading: true,
  stale: true,
  load: undefined,
};

const cache = new Map<string, Entry>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

async function run(key: string, load: () => Promise<unknown>): Promise<void> {
  if (inflight.has(key)) return;
  inflight.add(key);
  const previous = cache.get(key);
  // Stale-while-revalidate: keep whatever we already had on screen.
  cache.set(key, { data: previous?.data, error: undefined, loading: true, stale: false, load });
  notify();
  try {
    const data = await load();
    cache.set(key, { data, error: undefined, loading: false, stale: false, load });
  } catch (thrown) {
    cache.set(key, {
      data: previous?.data,
      error: toError(thrown),
      loading: false,
      stale: false,
      load,
    });
  } finally {
    inflight.delete(key);
    notify();
  }
}

/** Drop every cache entry whose key starts with `prefix`, then refetch it. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of [...cache.entries()]) {
    if (!key.startsWith(prefix)) continue;
    cache.set(key, { ...entry, stale: true });
    if (entry.load !== undefined) void run(key, entry.load);
  }
  notify();
}

/** Forget everything. Called on login and logout so one user never sees another's data. */
export function clearCache(): void {
  cache.clear();
  inflight.clear();
  notify();
}

export function useResource<T>(key: string | null, fetcher: () => Promise<T>): Resource<T> {
  // The fetcher is a fresh closure every render; the cache needs a stable one,
  // so it is read through a ref that is updated in an effect (never in render).
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const getSnapshot = useCallback(
    (): Entry => (key === null ? IDLE : (cache.get(key) ?? PENDING)),
    [key],
  );
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (key === null) return;
    const current = cache.get(key);
    if (current === undefined || current.stale) {
      void run(key, () => fetcherRef.current());
    }
  }, [key, entry.stale]);

  const refetch = useCallback(() => {
    if (key !== null) void run(key, () => fetcherRef.current());
  }, [key]);

  return { data: entry.data as T | undefined, error: entry.error, loading: entry.loading, refetch };
}
