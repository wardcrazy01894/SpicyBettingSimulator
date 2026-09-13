/**
 * A ticking wall clock and a repeating callback.
 *
 * `useNow` drives the cosmetic lock countdowns. The interval is 10 s, not 1 s,
 * on purpose: a board can hold 300 cards and the bet cutoff buffer is 60 s, so
 * per-second precision would cost 300 re-renders a second on a phone to display
 * information nobody acts on. The server's `bettable` flag — refreshed by
 * `usePoll` below — is the thing that actually gates a button (PLAN.md §12.3).
 */

import { useEffect, useRef, useState } from 'react';

export const CLOCK_TICK_MS = 10_000;

export function useNow(intervalMs: number = CLOCK_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Call `callback` every `intervalMs`, but only while the tab is visible — a
 * backgrounded phone must not keep polling the Worker (free-tier request
 * budget, PLAN.md §14.13). Fires once immediately when the tab comes back.
 */
export function usePoll(callback: () => void, intervalMs: number): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const start = (): void => {
      stop();
      id = setInterval(() => {
        callbackRef.current();
      }, intervalMs);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
