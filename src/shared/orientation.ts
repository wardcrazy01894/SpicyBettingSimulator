/**
 * Home/away ORIENTATION is fixed the first time a game is stored. PLAN.md §8.5.
 *
 * ESPN swaps `homeAway` on some neutral-site events between the day the event
 * appears and game day (seen 2026-11-08: Houston–Cal and USC–Wichita State at
 * the Lake Tahoe Classic both arrived "Houston @ Cal" and were re-published
 * "Cal @ Houston"). Everything downstream of a stored row — `game_lines`'s
 * `*_home_*` / `*_away_*` columns, every `bet_legs.side`, the leg's
 * `home_abbr` / `away_abbr` snapshot and `gradeLeg` reading `home_score`
 * against `side` — is written in the row's orientation, so a row whose sides
 * flip after a bet was placed grades the bet against the WRONG team (Alex's
 * Houston moneyline was marked a loss on an 86–68 Houston win).
 *
 * The rule: the stored row's `home_team_id` / `away_team_id` are identity and
 * never move; a payload whose two team ids arrive the other way round is
 * SWAPPED onto the stored orientation before the upsert — scores, names,
 * logos, ranks, conference ids AND the lines (spread and moneyline sides;
 * a total has no side). ESPN's `name` / `short_name` text is kept as sent:
 * nothing grades or labels from it, and at a neutral site "CAL VS HOU" is
 * neither orientation.
 *
 * Platform-free (CLAUDE.md rule 4): the read that finds the stored ids lives
 * in `src/worker/ingest.ts`; this module only decides and swaps.
 */
import type { Game, GameLines } from './types.js';

/** The two identity columns of a stored `games` row. */
export interface StoredSides {
  readonly homeTeamId: string;
  readonly awayTeamId: string;
}

/**
 * How a parsed game relates to its stored row.
 *   'same'     — same ids, same sides (or a brand-new game: nothing stored).
 *   'swapped'  — the SAME two ids, the other way round: swap onto the row.
 *   'unknown'  — a different pair of ids. Written as parsed; a different pair
 *                is a different game and the upsert's identity columns stay
 *                whatever was first stored (PLAN.md §8.5).
 */
export type Orientation = 'same' | 'swapped' | 'unknown';

export function orientationOf(game: Game, stored: StoredSides | undefined): Orientation {
  if (stored === undefined) return 'same';
  if (game.home.teamId === stored.homeTeamId && game.away.teamId === stored.awayTeamId) {
    return 'same';
  }
  if (game.home.teamId === stored.awayTeamId && game.away.teamId === stored.homeTeamId) {
    return 'swapped';
  }
  return 'unknown';
}

/** The same game with `home` and `away` exchanged. `name`/`shortName` kept. */
export function swapGameSides(game: Game): Game {
  return { ...game, home: game.away, away: game.home };
}

/** The same lines with the spread and moneyline SIDES exchanged; a total has none. */
export function swapLineSides(lines: GameLines): GameLines {
  return {
    ...lines,
    spread:
      lines.spread === null
        ? null
        : {
            homeTenths: lines.spread.awayTenths,
            homePrice: lines.spread.awayPrice,
            awayTenths: lines.spread.homeTenths,
            awayPrice: lines.spread.homePrice,
          },
    moneyline:
      lines.moneyline === null
        ? null
        : { homePrice: lines.moneyline.awayPrice, awayPrice: lines.moneyline.homePrice },
  };
}

export interface OrientedSlate {
  readonly games: readonly Game[];
  readonly lines: readonly GameLines[];
  /** Games swapped onto their stored orientation this time. */
  readonly swapped: number;
}

/**
 * Map a parsed slate onto the stored orientation of every game it already
 * knows. `stored` is keyed by game id; a game with no entry is new and is
 * written as parsed. A line whose game is swapped is swapped with it, so the
 * `spread_home_*` / `ml_home_*` columns keep meaning the row's home team.
 */
export function orientSlate(
  games: readonly Game[],
  lines: readonly GameLines[],
  stored: ReadonlyMap<string, StoredSides>,
): OrientedSlate {
  const swappedIds = new Set<string>();
  const orientedGames = games.map((game) => {
    if (orientationOf(game, stored.get(game.id)) !== 'swapped') return game;
    swappedIds.add(game.id);
    return swapGameSides(game);
  });
  const orientedLines = lines.map((line) =>
    swappedIds.has(line.gameId) ? swapLineSides(line) : line,
  );
  return { games: orientedGames, lines: orientedLines, swapped: swappedIds.size };
}
