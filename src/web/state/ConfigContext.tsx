/**
 * GET /api/config once per session. Supplies minStakeCents, maxParlayLegs,
 * cutoffBufferMs, initialBankrollCents and maxPayoutCents — the values the UI
 * must agree with the server about (PLAN.md §11.1).
 */

import type { ReactElement, ReactNode } from 'react';

import type { ConfigResponse } from '../../shared/api-types.js';

export function ConfigProvider(_props: { children: ReactNode }): ReactElement {
  throw new Error('not implemented: M7a');
}

export function useConfig(): ConfigResponse {
  throw new Error('not implemented: M7a');
}
