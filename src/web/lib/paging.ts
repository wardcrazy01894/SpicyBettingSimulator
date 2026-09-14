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

/** What `usePages` is holding pages 2..n behind. */
export interface HeldWindow {
  readonly resetKey: string;
  /** The id at the top of page 1 when those pages were fetched; `null` if none. */
  readonly firstId: string | null;
}

/**
 * Must the held pages 2..n be thrown away?
 *
 * TWO reasons, and the second is the one that is easy to miss:
 *
 *  1. `resetKey` changed — a different filter, a different league. Obvious.
 *  2. THE TOP OF PAGE 1 CHANGED. Pages 2..n were fetched behind a cursor that
 *     described where page 1 ENDED at the time. Place a bet (or settle one) and
 *     page 1 re-reads with a new row at the top, pushing its old last row down
 *     onto page 2 — which we are still holding from before. The boundary row is
 *     then absent from the merged list and unreachable, because `nextCursorOf`
 *     only ever asks beyond the LAST held page. `mergePages` hides it
 *     completely: every id still differs, so there is no duplicate key to
 *     notice. Re-paging from a fresh page 1 is the only correct answer.
 *
 * `firstId === undefined` means page 1 has not arrived yet, which is NOT
 * information: hold what we have rather than dropping it on every remount.
 */
export function windowIsStale(
  held: HeldWindow,
  resetKey: string,
  firstId: string | null | undefined,
): boolean {
  if (held.resetKey !== resetKey) return true;
  return firstId !== undefined && held.firstId !== firstId;
}
