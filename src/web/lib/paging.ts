/**
 * Cursor paging helpers for `GET /api/bets` and `GET /api/ledger`
 * (PLAN.md §11.4 / §11.5 — both return `{ …, nextCursor }`).
 *
 * Page 1 lives in the `useResource` cache and is re-read by polling and by
 * `invalidate()` after a mutation; pages 2..n are held next to it. A poll can
 * therefore hand back a page 1 that OVERLAPS what has already been loaded (a
 * newly placed bet shifts every row down by one), so pages are merged by id —
 * first occurrence wins, which is the freshest copy — rather than concatenated.
 * Concatenating would emit duplicate React keys.
 *
 * DOM-free and React-free so `tests/web/paging.spec.ts` runs in the node project.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Flatten pages in order, dropping any item whose key was already seen. */
export function mergePages<T>(pages: readonly Page<T>[], keyOf: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * The cursor to ask for next: the LAST page's, because that is the only one
 * that describes where the loaded window ends. An empty list has no cursor.
 */
export function nextCursorOf<T>(pages: readonly Page<T>[]): string | null {
  return pages.length === 0 ? null : (pages[pages.length - 1]?.nextCursor ?? null);
}
