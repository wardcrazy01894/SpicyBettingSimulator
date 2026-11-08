/**
 * The college boards' filter: Top 25, one conference, or everything. PLAN.md
 * §12.1 (CFB) and §24.14 (generalised by league in M13d).
 *
 * Pure and DOM-free (tests/web/board-filter.spec.ts). It narrows the slate the
 * server already returned — a board narrowing, never a money slice, so it
 * needs no query parameter and no server round-trip.
 *
 * Keyed by league: college football uses `CFB_CONFERENCES` and shows every
 * game by default; college basketball uses `CBB_CONFERENCES` (BASKETBALL ids —
 * the same conference has a different id per sport) and defaults to Top 25,
 * because a Saturday is ~155 cards. The NFL, MLB and the NBA have no filter.
 *
 * A game matches when EITHER team does: "SEC" shows Georgia's non-conference
 * game against a MAC team, because that is the game an SEC fan is looking for.
 */
import { CBB_CONFERENCES, CFB_CONFERENCES } from '../../shared/constants.js';
import type { GameCard } from '../../shared/api-types.js';
import type { League } from '../../shared/types.js';

/** `all`, `top25`, `conf:<espn id>`, or `conf:other` (an id not in the league's list). */
export type BoardFilter = 'all' | 'top25' | `conf:${string}`;

export const OTHER_CONFERENCE = 'conf:other';

export interface BoardFilterOption {
  readonly value: BoardFilter;
  readonly label: string;
}

export interface BoardFilterSpec {
  /** The league's conferences by ESPN `groups` id, in display order. */
  readonly conferences: readonly { readonly id: string; readonly name: string }[];
  /** What the board shows on arrival and after a league change. */
  readonly defaultFilter: BoardFilter;
}

/**
 * Which boards have a filter. A total `Record`, so a sixth league has to say
 * whether it gets one.
 */
export const BOARD_FILTERS: Readonly<Record<League, BoardFilterSpec | null>> = {
  nfl: null,
  ncaaf: { conferences: CFB_CONFERENCES, defaultFilter: 'all' },
  mlb: null,
  ncaab: { conferences: CBB_CONFERENCES, defaultFilter: 'top25' },
  nba: null,
};

const LISTED_IDS: Readonly<Record<League, ReadonlySet<string>>> = {
  nfl: new Set(),
  ncaaf: new Set(CFB_CONFERENCES.map((c) => c.id)),
  mlb: new Set(),
  ncaab: new Set(CBB_CONFERENCES.map((c) => c.id)),
  nba: new Set(),
};

/** The filter a league's board starts on: its spec's default, or `all`. */
export function defaultBoardFilter(league: League): BoardFilter {
  return BOARD_FILTERS[league]?.defaultFilter ?? 'all';
}

/** The dropdown, in display order. Fixed, so the control never jumps around. */
export function boardFilterOptions(spec: BoardFilterSpec): readonly BoardFilterOption[] {
  return [
    { value: 'all', label: 'All games' },
    { value: 'top25', label: 'Top 25' },
    ...spec.conferences.map((c) => ({ value: `conf:${c.id}` as const, label: c.name })),
    { value: OTHER_CONFERENCE, label: 'Other' },
  ];
}

export function isBoardFilter(value: string): value is BoardFilter {
  return value === 'all' || value === 'top25' || value.startsWith('conf:');
}

function teamMatches(league: League, team: GameCard['home'], filter: BoardFilter): boolean {
  if (filter === 'top25') return team.rank !== null;
  const id = filter.slice('conf:'.length);
  // "Other" is "not a listed conference OR no id at all", not "FCS" or
  // "independent": ESPN sometimes files an FCS team under an FBS id, and
  // omits a basketball team's `conferenceId` on a game's own ET day (§24.2).
  if (id === 'other')
    return team.conferenceId === null || !LISTED_IDS[league].has(team.conferenceId);
  return team.conferenceId === id;
}

/**
 * `league`'s board narrowed by `filter`. A league with no filter, or `all`,
 * returns the slate itself (same reference).
 */
export function filterGames(
  league: League,
  games: readonly GameCard[],
  filter: BoardFilter,
): readonly GameCard[] {
  if (BOARD_FILTERS[league] === null || filter === 'all') return games;
  return games.filter(
    (g) => teamMatches(league, g.home, filter) || teamMatches(league, g.away, filter),
  );
}
