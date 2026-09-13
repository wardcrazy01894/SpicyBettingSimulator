/**
 * GET /api/config once per session. Supplies minStakeCents, maxParlayLegs,
 * cutoffBufferMs, initialBankrollCents and maxPayoutCents — the values the UI
 * must agree with the server about (PLAN.md §11.1).
 *
 * Nothing renders until it answers. The alternative (falling back to
 * `src/shared/constants.ts`) is exactly the "deployed client disagrees with a
 * deployed server" failure the endpoint exists to prevent.
 */

import type { ReactElement, ReactNode } from 'react';

import { getConfig } from '../api/client.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { useResource } from '../hooks/useResource.js';
import { ConfigContext } from './config.js';

export function ConfigProvider(props: { children: ReactNode }): ReactElement {
  const config = useResource('config', getConfig);

  if (config.data === undefined) {
    return (
      <div className="boot">
        {config.error === undefined ? (
          <Spinner label="Loading…" />
        ) : (
          <ErrorBanner error={config.error} onRetry={config.refetch} />
        )}
      </div>
    );
  }

  return <ConfigContext value={config.data}>{props.children}</ConfigContext>;
}
