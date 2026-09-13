/**
 * The board. League tabs, week picker, day groups.
 *
 * Grouping: primary group is ESPN's `week` (authoritative — it spans Thu-Mon for
 * the NFL, so we never compute week boundaries ourselves); within a week, games
 * are subgrouped by the VIEWER'S LOCAL calendar date via Intl.DateTimeFormat.
 */
import type { ReactElement } from 'react';

export function GamesPage(): ReactElement {
  throw new Error('not implemented: M7b');
}
