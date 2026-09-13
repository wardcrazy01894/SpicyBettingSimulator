import { describe, expect, it } from 'vitest';

import { mergePages, nextCursorOf } from '../../src/web/lib/paging.js';
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
