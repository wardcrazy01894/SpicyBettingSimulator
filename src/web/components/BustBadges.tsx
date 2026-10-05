/**
 * The bust badges beside a player's name: one skull per refill the player has
 * not yet bought off (PLAN.md §4.5). Up to three are drawn individually so a
 * glance counts them; past that one chip carries the number, because a row of
 * eight skulls stops reading as a count and starts reading as a layout bug.
 *
 * Renders NOTHING for zero — the caller never has to branch.
 */
import type { ReactElement } from 'react';

import { bustBadgeTitle } from '../lib/labels.js';

const DRAWN_INDIVIDUALLY = 3;

export function BustBadges(props: { readonly count: number }): ReactElement | null {
  const { count } = props;
  if (count <= 0) return null;
  const title = bustBadgeTitle(count);
  if (count <= DRAWN_INDIVIDUALLY) {
    return (
      <span className="bust-badges" role="img" aria-label={title} title={title}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="chip chip-loss bust-badge" aria-hidden="true">
            💀
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="bust-badges" role="img" aria-label={title} title={title}>
      <span className="chip chip-loss bust-badge" aria-hidden="true">
        💀 ×{String(count)}
      </span>
    </span>
  );
}
