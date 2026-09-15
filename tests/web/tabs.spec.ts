import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, isAdminTab, parseAdminTab } from '../../src/web/lib/admin-tabs.js';
import { nextTabIndex } from '../../src/web/lib/tabs.js';

describe('nextTabIndex', () => {
  it('moves right and wraps at the end', () => {
    expect(nextTabIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextTabIndex('ArrowRight', 3, 4)).toBe(0);
  });

  it('moves left and wraps at the start', () => {
    expect(nextTabIndex('ArrowLeft', 2, 4)).toBe(1);
    expect(nextTabIndex('ArrowLeft', 0, 4)).toBe(3);
  });

  it('Home and End jump to the ends', () => {
    expect(nextTabIndex('Home', 2, 4)).toBe(0);
    expect(nextTabIndex('End', 1, 4)).toBe(3);
  });

  it('returns null for keys the tablist does not own', () => {
    expect(nextTabIndex('ArrowDown', 1, 4)).toBeNull();
    expect(nextTabIndex('Enter', 1, 4)).toBeNull();
    expect(nextTabIndex('a', 1, 4)).toBeNull();
  });

  it('is a no-op on a single tab', () => {
    expect(nextTabIndex('ArrowRight', 0, 1)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 1)).toBe(0);
  });
});

describe('admin tabs', () => {
  it('Jobs is first so it is the default landing tab', () => {
    expect(ADMIN_TABS[0]?.id).toBe('jobs');
  });

  it('isAdminTab accepts every declared id and nothing else', () => {
    for (const tab of ADMIN_TABS) expect(isAdminTab(tab.id)).toBe(true);
    expect(isAdminTab('')).toBe(false);
    expect(isAdminTab('Jobs')).toBe(false);
    expect(isAdminTab('ledger')).toBe(false);
  });

  it('parseAdminTab falls back to jobs for a missing or unknown value', () => {
    expect(parseAdminTab(null)).toBe('jobs');
    expect(parseAdminTab('nope')).toBe('jobs');
    expect(parseAdminTab('users')).toBe('users');
    expect(parseAdminTab('bugs')).toBe('bugs');
    expect(parseAdminTab('reconcile')).toBe('reconcile');
  });
});
