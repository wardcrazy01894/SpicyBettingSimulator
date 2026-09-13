/**
 * Router + provider stack. PLAN.md §12.1.
 *
 *   <SessionProvider> -> <ConfigProvider> -> <BetSlipProvider> -> <AppShell>
 *
 * Routes: / (games), /bets, /leaderboard, /account, /admin, /login
 *
 * M1 STATE: a minimal health panel proving the dev loop (vite -> /api proxy ->
 * wrangler dev -> Worker). M7a replaces this with the real provider stack.
 */

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { HealthResponse } from '../shared/api-types.js';

type HealthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly health: HealthResponse }
  | { readonly kind: 'error'; readonly message: string };

export function App(): ReactElement {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/health', { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const health = (await res.json()) as HealthResponse;
        if (!ac.signal.aborted) setState({ kind: 'ok', health });
      } catch (err) {
        if (!ac.signal.aborted) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      ac.abort();
    };
  }, []);

  return (
    <main className="shell">
      <h1>Spicy Betting Simulator</h1>
      <p className="muted">Fake money. Real lines. (M1 dev-loop check)</p>
      {state.kind === 'loading' && <p>Checking the API…</p>}
      {state.kind === 'error' && <p className="error">API unreachable: {state.message}</p>}
      {state.kind === 'ok' && (
        <dl className="kv">
          <dt>API</dt>
          <dd>ok</dd>
          <dt>Version</dt>
          <dd>{state.health.version}</dd>
          <dt>Server time</dt>
          <dd>{new Date(state.health.now).toLocaleString()}</dd>
          <dt>Invite required</dt>
          <dd>{state.health.inviteRequired ? 'yes' : 'no'}</dd>
        </dl>
      )}
    </main>
  );
}
