/**
 * Columns: rank, user, balance, open exposure, equity, W-L-P, ROI.
 * Ranked by BALANCE (realized). Equity is shown but not ranked — PLAN.md §11.5.
 */
import type { ReactElement } from 'react';
import type { LeaderboardRow } from '../../shared/api-types.js';

export function LeaderboardTable(_props: {
  readonly rows: readonly LeaderboardRow[];
}): ReactElement {
  throw new Error('not implemented: M7d');
}
