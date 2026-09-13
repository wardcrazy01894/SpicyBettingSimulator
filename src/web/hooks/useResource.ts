/**
 * Minimal stale-while-revalidate data hook (~60 lines when implemented).
 * Deliberately not a dependency — react-query would be more code shipped to a
 * phone than this whole app needs.
 */

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  refetch(): void;
}

export function useResource<T>(_key: string | null, _fetcher: () => Promise<T>): Resource<T> {
  throw new Error('not implemented: M7a');
}

/** Drop every cache entry whose key starts with `prefix`, then refetch. */
export function invalidate(_prefix: string): void {
  throw new Error('not implemented: M7a');
}
