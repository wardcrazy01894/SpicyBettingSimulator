import { describe, expect, it } from 'vitest';

import { mergePages, nextCursorOf, windowIsStale } from '../../src/web/lib/paging.js';
import type { Page } from '../../src/web/lib/paging.js';

interface Row {
  readonly id: string;
  readonly label: string;
}

const idOf = (row: Row): string => row.id;

function page(ids: readonly string[], nextCursor: string | null, label = 'v1'): Page<Row> {
  return { items: ids.map((id) => ({ id, label })), nextCursor };
}

describe('mergePages', () => {
  it('concatenates pages in order', () => {
    const merged = mergePages([page(['a', 'b'], 'c2'), page(['c', 'd'], null)], idOf);
    expect(merged.map(idOf)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops a repeat of an id already seen, keeping the FIRST (freshest) copy', () => {
    // Page 1 is re-read by the poll after a bet is placed, so a row that was on
    // page 1 can reappear on the page 2 that was loaded before it. Concatenating
    // would emit duplicate React keys.
    const merged = mergePages(
      [page(['a', 'b'], 'c2', 'fresh'), page(['b', 'c'], null, 'stale')],
      idOf,
    );
    expect(merged.map(idOf)).toEqual(['a', 'b', 'c']);
    expect(merged[1]?.label).toBe('fresh');
  });

  it('is empty for no pages and for empty pages', () => {
    expect(mergePages<Row>([], idOf)).toEqual([]);
    expect(mergePages([page([], null)], idOf)).toEqual([]);
  });
});

describe('nextCursorOf', () => {
  it("is the LAST page's cursor, not the first", () => {
    expect(nextCursorOf([page(['a'], 'c2'), page(['b'], 'c3')])).toBe('c3');
  });

  it('is null once the last page says there is no more', () => {
    expect(nextCursorOf([page(['a'], 'c2'), page(['b'], null)])).toBeNull();
  });

  it('is null when nothing has loaded yet', () => {
    expect(nextCursorOf<Row>([])).toBeNull();
  });
});

describe('windowIsStale', () => {
  const held = { resetKey: 'open', firstId: 'b1' };

  it('is false while nothing has moved', () => {
    expect(windowIsStale(held, 'open', 'b1')).toBe(false);
  });

  it('is true when the filter changes', () => {
    expect(windowIsStale(held, 'settled', 'b1')).toBe(true);
    // ...even before page 1 of the new filter has arrived.
    expect(windowIsStale(held, 'settled', undefined)).toBe(true);
  });

  it('is TRUE when the top of page 1 changes under the held pages', () => {
    // A new bet lands at the top, so every held page is off by one and the row
    // that used to end page 1 is now unreachable. This is the case M7's review
    // flagged and the one `mergePages` cannot detect.
    expect(windowIsStale(held, 'open', 'b2')).toBe(true);
  });

  it('holds the pages while page 1 is still loading (undefined is not information)', () => {
    // Otherwise a remount, or any refetch, would throw away pages the user has
    // explicitly asked for on every poll.
    expect(windowIsStale(held, 'open', undefined)).toBe(false);
  });

  it('treats an emptied page 1 as a real change, but an always-empty one as stable', () => {
    expect(windowIsStale(held, 'open', null)).toBe(true);
    expect(windowIsStale({ resetKey: 'open', firstId: null }, 'open', null)).toBe(false);
    expect(windowIsStale({ resetKey: 'open', firstId: null }, 'open', 'b1')).toBe(true);
  });
});
