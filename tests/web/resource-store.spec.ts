/**
 * The two ordering hazards in the `useResource` cache. Both are invisible to a
 * render test — they are about what happens to a response that is ALREADY on the
 * wire — so they are exercised directly against the store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearCache,
  invalidate,
  readEntry,
  resetResourceStore,
  run,
  subscribeToResources,
} from '../../src/web/hooks/resource-store.js';

afterEach(() => {
  resetResourceStore();
});

/** A loader whose promise is resolved by the test, so timing is explicit. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-resolved microtask (and the re-run it may queue) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('resource-store: the happy path', () => {
  it('stores the result and reports loading in between', async () => {
    const gate = deferred<string>();
    void run('bets:open', () => gate.promise);
    expect(readEntry('bets:open').loading).toBe(true);

    gate.resolve('page-1');
    await settle();

    const entry = readEntry('bets:open');
    expect(entry.data).toBe('page-1');
    expect(entry.loading).toBe(false);
    expect(entry.stale).toBe(false);
  });

  it('keeps the previous data on screen when a refetch fails (stale-while-revalidate)', async () => {
    const first = deferred<string>();
    void run('bets:open', () => first.promise);
    first.resolve('page-1');
    await settle();

    const second = deferred<string>();
    void run('bets:open', () => second.promise);
    second.reject(new Error('offline'));
    await settle();

    const entry = readEntry('bets:open');
    expect(entry.data).toBe('page-1');
    expect(entry.error?.message).toBe('offline');
  });

  it('makes ONE request when two subscribers ask for the same key at once', async () => {
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);
    void run('games:nfl', load);
    void run('games:nfl', load);
    gate.resolve('slate');
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers PENDING (and therefore stale) for a key nobody has fetched', () => {
    expect(readEntry('nothing:here').stale).toBe(true);
    expect(readEntry(null).stale).toBe(false);
  });
});

describe('resource-store: an invalidation raised mid-flight', () => {
  it('re-runs the fetch instead of losing it', async () => {
    // The 60 s My Bets poll is already on the wire when a bet is placed and the
    // provider calls invalidate('bets'). The in-flight response predates the
    // mutation, so it cannot satisfy the invalidation.
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    void run('bets:open', load);
    invalidate('bets');
    expect(load).toHaveBeenCalledTimes(1); // no second request yet

    first.resolve('before-the-bet');
    await settle();
    expect(load).toHaveBeenCalledTimes(2);

    second.resolve('after-the-bet');
    await settle();
    expect(readEntry('bets:open').data).toBe('after-the-bet');
    expect(readEntry('bets:open').stale).toBe(false);
  });

  it('does not queue a re-run for a key the invalidation did not match', async () => {
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);
    void run('leaderboard:nfl', load);
    invalidate('bets');
    gate.resolve('board');
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refetches a settled entry immediately', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    void run('bankroll:nfl:2026', load);
    first.resolve('100');
    await settle();

    invalidate('bankroll');
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve('200');
    await settle();
    expect(readEntry('bankroll:nfl:2026').data).toBe('200');
  });
});

describe('resource-store: clearCache fences responses on the wire', () => {
  it('discards a response that was started before the logout', async () => {
    // Request begins as user A...
    const gate = deferred<string>();
    void run('bets:open', () => gate.promise);

    // ...user A logs out and user B logs in...
    clearCache();
    expect(readEntry('bets:open').data).toBeUndefined();

    // ...and only NOW does A's response arrive.
    gate.resolve("user A's bets");
    await settle();

    expect(readEntry('bets:open').data).toBeUndefined();
  });

  it('discards a FAILED response from before the logout too', async () => {
    const gate = deferred<string>();
    void run('bets:open', () => gate.promise);
    clearCache();
    gate.reject(new Error("user A's 500"));
    await settle();

    expect(readEntry('bets:open').error).toBeUndefined();
  });

  it('does not let the fenced response block the next one for that key', async () => {
    const stale = deferred<string>();
    void run('bets:open', () => stale.promise);
    clearCache();

    const fresh = deferred<string>();
    void run('bets:open', () => fresh.promise);
    stale.resolve("user A's bets");
    await settle();
    fresh.resolve("user B's bets");
    await settle();

    expect(readEntry('bets:open').data).toBe("user B's bets");
  });
});

describe('resource-store: subscribers', () => {
  it('notifies on every transition and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToResources(listener);
    const gate = deferred<string>();
    void run('health', () => gate.promise);
    gate.resolve('ok');
    await settle();
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
    const calls = listener.mock.calls.length;
    clearCache();
    expect(listener.mock.calls.length).toBe(calls);
  });
});
