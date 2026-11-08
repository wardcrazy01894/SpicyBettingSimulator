/**
 * The bust badges beside a player's name: one per refill the player has not
 * yet bought off (PLAN.md §4.5) — a skull for the first, a shrimp for the
 * second, a photo for the third (`bustBadgeGlyph`). Up to three are drawn
 * individually so a glance counts them; past that one chip carries the number,
 * because a row of eight badges stops reading as a count and starts reading as
 * a layout bug. The mechanics (what a badge IS, how one is earned or bought
 * off) are untouched; only the picture per position changed (2026-11-08).
 *
 * Renders NOTHING for zero — the caller never has to branch.
 */
import type { ReactElement } from 'react';

import { bustBadgeGlyph, bustBadgeTitle } from '../lib/labels.js';

const DRAWN_INDIVIDUALLY = 3;

export function BustBadges(props: { readonly count: number }): ReactElement | null {
  const { count } = props;
  if (count <= 0) return null;
  const title = bustBadgeTitle(count);
  if (count <= DRAWN_INDIVIDUALLY) {
    return (
      <span className="bust-badges" role="img" aria-label={title} title={title}>
        {Array.from({ length: count }, (_, i) => {
          const glyph = bustBadgeGlyph(i);
          return (
            <span key={i} className="chip chip-loss bust-badge" aria-hidden="true">
              {glyph.kind === 'emoji' ? (
                glyph.text
              ) : (
                <img className="bust-badge-img" src={glyph.src} alt="" />
              )}
            </span>
          );
        })}
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
