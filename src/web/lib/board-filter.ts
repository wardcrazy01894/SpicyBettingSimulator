/**
 * The CFB board filter: Top 25, one conference, or everything. PLAN.md §12.1.
 *
 * Pure and DOM-free (tests/web/board-filter.spec.ts). It narrows the slate the
 * server already returned for the week — a board narrowing, never a money
 * slice, so it needs no query parameter and no server round-trip.
 *
 * A game matches when EITHER team does: "SEC" shows Georgia's non-conference
 * game against a MAC team, because that is the game an SEC fan is looking for.
 */
import { CFB_CONFERENCES } from '../../shared/constants.js';
import type { GameCard } from '../../shared/api-types.js';

/** `all`, `top25`, `conf:<espn id>`, or `conf:other` (an FCS opponent). */
export type BoardFilter = 'all' | 'top25' | `conf:${string}`;

export const OTHER_CONFERENCE = 'conf:other';

export interface BoardFilterOption {
  readonly value: BoardFilter;
  readonly label: string;
}

const FBS_IDS: ReadonlySet<string> = new Set(CFB_CONFERENCES.map((c) => c.id));

/** The dropdown, in display order. Fixed, so the control never jumps around. */
export function boardFilterOptions(): readonly BoardFilterOption[] {
  return [
    { value: 'all', label: 'All games' },
    { value: 'top25', label: 'Top 25' },
    ...CFB_CONFERENCES.map((c) => ({ value: `conf:${c.id}` as const, label: c.name })),
    { value: OTHER_CONFERENCE, label: 'Other (FCS)' },
  ];
}

export function isBoardFilter(value: string): value is BoardFilter {
  return value === 'all' || value === 'top25' || value.startsWith('conf:');
}

function teamMatches(team: GameCard['home'], filter: BoardFilter): boolean {
  if (filter === 'top25') return team.rank !== null;
  const id = filter.slice('conf:'.length);
  if (id === 'other') return team.conferenceId === null || !FBS_IDS.has(team.conferenceId);
  return team.conferenceId === id;
}

export function filterGames(games: readonly GameCard[], filter: BoardFilter): readonly GameCard[] {
  if (filter === 'all') return games;
  return games.filter((g) => teamMatches(g.home, filter) || teamMatches(g.away, filter));
}
