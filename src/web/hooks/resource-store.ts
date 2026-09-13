/**
 * The `useResource` cache, with no React in it. PLAN.md §12.2.
 *
 * Split out of `useResource.ts` so the two ordering hazards below can be tested
 * in the DOM-free node project (`tests/web/resource-store.spec.ts`); the hook is
 * now just a `useSyncExternalStore` binding over this module.
 *
 * Cache entries are IMMUTABLE objects replaced wholesale, which is what lets
 * `useSyncExternalStore` compare snapshots by identity.
 *
 * Two things the naive version got wrong:
 *
 * 1. **An `invalidate()` that lands mid-flight must not be swallowed.** The
 *    in-flight response was written with `stale: false`, so an invalidation
 *    raised while it was on the wire (place a bet -> `invalidate('bets')` while
 *    the 60 s poll is already fetching) left the screen showing pre-mutation
 *    data with nothing queued to fix it. A per-key pending flag re-runs the
 *    fetch when the in-flight one settles.
 *
 * 2. **`clearCache()` must FENCE responses that are already on the wire.** A
 *    request started as user A can resolve after user B has logged in, and the
 *    plain version wrote it straight into the shared cache. Every run captures
 *    the generation counter that `clearCache()` bumps and discards its own
 *    result if the generation moved underneath it.
 */

export interface ResourceEntry {
  readonly data: unknown;
  readonly error: Error | undefined;
  readonly loading: boolean;
  /** Set by `invalidate`; the next mount/render of a subscriber reloads. */
  readonly stale: boolean;
  readonly load: (() => Promise<unknown>) | undefined;
}

export const IDLE: ResourceEntry = {
  data: undefined,
  error: undefined,
  loading: false,
  stale: false,
  load: undefined,
};

export const PENDING: ResourceEntry = {
  data: undefined,
  error: undefined,
  loading: true,
  stale: true,
  load: undefined,
};

const cache = new Map<string, ResourceEntry>();
/** key -> the generation the running fetch was started in. */
const inflight = new Map<string, number>();
/** Keys invalidated while their fetch was on the wire; re-run on completion. */
const pending = new Set<string>();
const listeners = new Set<() => void>();

/** Bumped by `clearCache`. A run whose generation is stale writes nothing. */
let generation = 0;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeToResources(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readEntry(key: string | null): ResourceEntry {
  if (key === null) return IDLE;
  return cache.get(key) ?? PENDING;
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export async function run(key: string, load: () => Promise<unknown>): Promise<void> {
  // A fetch for this key is already on the wire; two subscribers mounting at
  // once must make ONE request. Only `invalidate` queues a re-run (see below).
  if (inflight.has(key)) return;
  const startedIn = generation;
  inflight.set(key, startedIn);
  const previous = cache.get(key);
  // Stale-while-revalidate: keep whatever we already had on screen.
  cache.set(key, { data: previous?.data, error: undefined, loading: true, stale: false, load });
  notify();

  let settled: ResourceEntry;
  try {
    const data = await load();
    settled = { data, error: undefined, loading: false, stale: false, load };
  } catch (thrown) {
    settled = { data: previous?.data, error: toError(thrown), loading: false, stale: false, load };
  }

  if (inflight.get(key) === startedIn) inflight.delete(key);
  // A response from before a `clearCache()` belongs to nobody: drop it.
  const fresh = startedIn === generation;
  const again = pending.delete(key) && fresh;
  if (fresh) cache.set(key, settled);
  notify();
  if (again) void run(key, load);
}

/** Drop every cache entry whose key starts with `prefix`, then refetch it. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of [...cache.entries()]) {
    if (!key.startsWith(prefix)) continue;
    cache.set(key, { ...entry, stale: true });
    if (inflight.has(key)) {
      // The response now on the wire predates this invalidation, so it cannot
      // satisfy it. Queue a re-run for when it settles instead of losing it.
      pending.add(key);
      continue;
    }
    if (entry.load !== undefined) void run(key, entry.load);
  }
  notify();
}

/** Forget everything. Called on login and logout so one user never sees another's data. */
export function clearCache(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  pending.clear();
  notify();
}

/**
 * Test-only: put the module back to its boot state. Exported because the store
 * is a module singleton and each spec needs a clean one.
 */
export function resetResourceStore(): void {
  cache.clear();
  inflight.clear();
  pending.clear();
  listeners.clear();
  generation = 0;
}
