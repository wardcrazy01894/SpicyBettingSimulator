/**
 * Roving-focus arithmetic for a `role="tablist"` (WAI-ARIA Tabs pattern, automatic
 * activation). DOM-free so `tests/web/tabs.spec.ts` can pin the wrapping.
 *
 * Returns the index the arrow key should move to, or `null` when the key is not
 * one the tablist owns (so the component lets it propagate).
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
