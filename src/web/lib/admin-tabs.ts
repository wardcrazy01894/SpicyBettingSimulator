/**
 * The admin page's tabs. The active one lives in the URL (`/admin?tab=users`) so
 * a reload, a back-swipe or a pasted link lands on the same section; the parse
 * here is what keeps a hand-edited or stale `?tab=` from rendering nothing.
 *
 * Order is display order, and `jobs` is first because `GET /api/admin/jobs` is
 * the first place to look when something is wrong (docs/OPERATIONS.md).
 */
export type AdminTab = 'jobs' | 'reconcile' | 'users' | 'bugs';

export const ADMIN_TABS: readonly { readonly id: AdminTab; readonly label: string }[] = [
  { id: 'jobs', label: 'Jobs' },
  { id: 'reconcile', label: 'Ledger' },
  { id: 'users', label: 'Users' },
  { id: 'bugs', label: 'Bug reports' },
];

export function isAdminTab(value: string): value is AdminTab {
  return ADMIN_TABS.some((tab) => tab.id === value);
}

/** `null` is "no `?tab=` at all"; anything unrecognised also lands on Jobs. */
export function parseAdminTab(raw: string | null): AdminTab {
  return raw !== null && isAdminTab(raw) ? raw : 'jobs';
}
