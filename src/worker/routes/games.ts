/**
 * /api/games — the board. PLAN.md §11.3.
 *
 * `bettable` and `lockAt` are computed SERVER-side and sent down; the client must
 * never decide bettability itself.
 */

import { Hono } from 'hono';
import { mergeEffectiveLine } from '../../shared/lines.js';
import type { EffectiveLine, LineRowView } from '../../shared/lines.js';
import { boardWindowEnd } from '../../shared/time.js';
import type { GameCard, GameLinesView, GamesResponse } from '../../shared/api-types.js';
import { BOARD_LOOKBACK_MS, BOARD_MAX_GAMES } from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import { lockAtFor } from '../../shared/time.js';
import { LEAGUES } from '../../shared/types.js';
import type { BetLeague, EpochMs, GameStatus, League } from '../../shared/types.js';
import { listWithOr } from '../../shared/validate.js';
import { currentSeasonFor, isLeague } from '../bankroll.js';
import { isBettingOpen } from '../bets.js';
import { queryAll } from '../db.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';

const GAME_STATUSES: readonly GameStatus[] = [
  'scheduled',
  'in_progress',
  'final',
  'postponed',
  'canceled',
  'unknown',
];

interface BoardRow {
  id: string;
  league: string;
  season: number;
  season_type: number;
  week: number | null;
  kickoff_at: number;
  status: string;
  status_detail: string | null;
  period: number | null;
  display_clock: string | null;
  neutral_site: number;
  home_team_id: string;
  home_abbr: string;
  home_name: string;
  home_logo: string | null;
  home_rank: number | null;
  home_score: number | null;
  away_team_id: string;
  away_abbr: string;
  away_name: string;
  away_logo: string | null;
  away_rank: number | null;
  away_score: number | null;
  home_conference_id: string | null;
  away_conference_id: string | null;
  provider: string | null;
  spread_home_tenths: number | null;
  spread_home_price: number | null;
  spread_away_tenths: number | null;
  spread_away_price: number | null;
  total_tenths: number | null;
  total_over_price: number | null;
  total_under_price: number | null;
  ml_home_price: number | null;
  ml_away_price: number | null;
  spread_book: string | null;
  total_book: string | null;
  ml_book: string | null;
  captured_at: number | null;
  seen_at: number | null;
}

/**
 * One row per (game, line row): EVERY `game_lines` row a game has comes back,
 * and `mergeEffectiveLine` resolves them per market (PLAN.md §21.4). A game with
 * no line row still comes back once, with the `l.*` columns null.
 *
 * The board's LIMIT is applied to GAMES, in a subquery, never to the joined rows
 * — with two line rows per game a LIMIT on the join would cap the board at half
 * its games and raise no error anywhere.
 */
const GAME_COLUMNS = `g.id, g.league, g.season, g.season_type, g.week, g.kickoff_at,
       g.status, g.status_detail, g.period, g.display_clock, g.neutral_site,
       g.home_team_id, g.home_abbr, g.home_name, g.home_logo, g.home_rank, g.home_score,
       g.away_team_id, g.away_abbr, g.away_name, g.away_logo, g.away_rank, g.away_score,
       g.home_conference_id, g.away_conference_id`;
const LINE_COLUMNS = `l.provider, l.spread_home_tenths, l.spread_home_price, l.spread_away_tenths,
       l.spread_away_price, l.total_tenths, l.total_over_price, l.total_under_price,
       l.ml_home_price, l.ml_away_price, l.spread_book, l.total_book, l.ml_book,
       l.captured_at, l.seen_at`;
const BOARD_COLUMNS = `${GAME_COLUMNS}, ${LINE_COLUMNS}`;
const LINES_JOIN = `LEFT JOIN game_lines l ON l.game_id = g.id`;

/** Group the joined rows by game, in the order the query returned the games. */
function groupByGame(rows: readonly BoardRow[]): readonly { game: BoardRow; lines: BoardRow[] }[] {
  const out: { game: BoardRow; lines: BoardRow[] }[] = [];
  const byId = new Map<string, { game: BoardRow; lines: BoardRow[] }>();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (entry === undefined) {
      entry = { game: row, lines: [] };
      byId.set(row.id, entry);
      out.push(entry);
    }
    if (row.provider !== null && row.captured_at !== null && row.seen_at !== null) {
      entry.lines.push(row);
    }
  }
  return out;
}

export function gamesRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const league = readLeague(c.req.query('league'));
    const season = readInt(c.req.query('season'), 'season');
    const week = readInt(c.req.query('week'), 'week');
    const status = readStatus(c.req.query('status'));
    const now = c.var.now;
    // PLAN.md §11.3 / §22: now − 12 h … the end of the Monday that closes the
    // football week for THIS league, unless the caller narrows or widens it.
    const from = readInt(c.req.query('from'), 'from') ?? now - BOARD_LOOKBACK_MS;
    const to = readInt(c.req.query('to'), 'to') ?? boardWindowEnd(league, now);

    const clauses = ['g.league = ?1', 'g.kickoff_at >= ?2', 'g.kickoff_at <= ?3'];
    const values: unknown[] = [league, from, to];
    const next = (value: unknown): string => {
      values.push(value);
      return `?${String(values.length)}`;
    };
    if (season !== undefined) clauses.push(`g.season = ${next(season)}`);
    if (week !== undefined) clauses.push(`g.week = ${next(week)}`);
    if (status !== undefined) clauses.push(`g.status = ${next(status)}`);

    // The LIMIT is on GAMES (the subquery), not on the joined line rows.
    const rows = await queryAll<BoardRow>(
      c.env.DB.prepare(
        `SELECT ${BOARD_COLUMNS}
           FROM (SELECT * FROM games g
                  WHERE ${clauses.join(' AND ')}
                  ORDER BY g.kickoff_at ASC, g.id ASC
                  LIMIT ${next(BOARD_MAX_GAMES)}) g
           ${LINES_JOIN}
          ORDER BY g.kickoff_at ASC, g.id ASC, l.provider ASC`,
      ).bind(...values),
    );

    // Reading the board WRITES NOTHING (M5b). It used to run §4.4's lazy
    // bankroll prelude here, because a new season needed a new bankroll; a
    // balance is account-level and created at signup, so a GET is a GET again.
    const resolvedSeason = season ?? (await currentSeasonFor(c.env, league, now));

    const bodyOut: GamesResponse = {
      league,
      season: resolvedSeason,
      week: week ?? null,
      games: groupByGame(rows).map(({ game, lines }) => toGameCard(game, lines, now)),
    };
    return c.json(bodyOut);
  });

  // Deliberately UNWINDOWED (PLAN.md §22.7): an id lookup, so a bet on a game
  // the list no longer shows still renders and edits. EVERY line row, merged —
  // never queryOne, which would keep whichever row D1 returned first.
  app.get('/:id', async (c) => {
    const rows = await queryAll<BoardRow>(
      c.env.DB.prepare(
        `SELECT ${BOARD_COLUMNS} FROM games g ${LINES_JOIN} WHERE g.id = ?1 ORDER BY l.provider ASC`,
      ).bind(c.req.param('id')),
    );
    const grouped = groupByGame(rows)[0];
    if (grouped === undefined) throw new AppError('GAME_NOT_FOUND', 'No such game.');
    return c.json({ game: toGameCard(grouped.game, grouped.lines, c.var.now) });
  });

  return app;
}

/**
 * The `GameCard` mapper for both board routes. (It used to say "exported for the
 * bets route"; nothing outside this file imports it — the slip is built in the
 * browser from the board response.)
 */
export function toGameCard(row: BoardRow, lineRows: readonly BoardRow[], now: EpochMs): GameCard {
  const lines = toLinesView(row, lineRows, now);
  const lockAt = lockAtFor(row.kickoff_at);
  const status = row.status as GameStatus;
  return {
    id: row.id,
    league: row.league as League,
    season: row.season,
    seasonType: row.season_type,
    week: row.week,
    kickoffAt: row.kickoff_at,
    status,
    statusDetail: row.status_detail,
    period: row.period,
    displayClock: row.display_clock,
    neutralSite: row.neutral_site === 1,
    home: {
      teamId: row.home_team_id,
      abbr: row.home_abbr,
      name: row.home_name,
      logo: row.home_logo,
      rank: row.home_rank,
      conferenceId: row.home_conference_id,
      score: row.home_score,
    },
    away: {
      teamId: row.away_team_id,
      abbr: row.away_abbr,
      name: row.away_name,
      logo: row.away_logo,
      rank: row.away_rank,
      conferenceId: row.away_conference_id,
      score: row.away_score,
    },
    lockAt,
    // The server's verdict, in one place. A game with no line is NOT an error —
    // it is the normal CFB state early in the week — but it is not bettable.
    // `isBettingOpen` is the per-league gate (LEAGUE_BETTING_OPEN, PLAN.md
    // §23.14): MLB is on the board before its settlement rule ships, unbettable.
    bettable:
      isBettingOpen(row.league) &&
      status === 'scheduled' &&
      now < lockAt &&
      lines !== null &&
      !lines.stale &&
      (lines.spread !== null || lines.total !== null || lines.moneyline !== null),
    lines,
  };
}

/** A joined line row -> the shape the merge reads. */
function toLineRowView(row: BoardRow): LineRowView {
  return {
    provider: row.provider ?? '',
    spreadHomeTenths: row.spread_home_tenths,
    spreadHomePrice: row.spread_home_price,
    spreadAwayTenths: row.spread_away_tenths,
    spreadAwayPrice: row.spread_away_price,
    spreadBook: row.spread_book,
    totalTenths: row.total_tenths,
    totalOverPrice: row.total_over_price,
    totalUnderPrice: row.total_under_price,
    totalBook: row.total_book,
    mlHomePrice: row.ml_home_price,
    mlAwayPrice: row.ml_away_price,
    mlBook: row.ml_book,
    capturedAt: row.captured_at ?? 0,
    seenAt: row.seen_at ?? 0,
  };
}

/**
 * The card's lines are the MERGED effective line (PLAN.md §21.4): every market
 * resolved independently across every row, each carrying its own provenance,
 * staleness judged per row at the request's one clock — the same call
 * placement makes, so the board can never offer a price placement refuses.
 */
export function toLinesView(
  game: BoardRow,
  lineRows: readonly BoardRow[],
  now: EpochMs,
): GameLinesView | null {
  const merged: EffectiveLine | null = mergeEffectiveLine(
    lineRows.map(toLineRowView),
    game.kickoff_at,
    now,
  );
  if (merged === null) return null;
  return {
    provider: merged.provider,
    capturedAt: merged.capturedAt,
    seenAt: merged.seenAt,
    stale: merged.stale,
    spread:
      merged.spread === null
        ? null
        : {
            homeTenths: merged.spread.homeTenths,
            homePrice: merged.spread.homePrice,
            awayTenths: merged.spread.awayTenths,
            awayPrice: merged.spread.awayPrice,
            provider: merged.spread.provider,
          },
    total:
      merged.total === null
        ? null
        : {
            tenths: merged.total.tenths,
            overPrice: merged.total.overPrice,
            underPrice: merged.total.underPrice,
            provider: merged.total.provider,
          },
    moneyline:
      merged.moneyline === null
        ? null
        : {
            homePrice: merged.moneyline.homePrice,
            awayPrice: merged.moneyline.awayPrice,
            provider: merged.moneyline.provider,
          },
  };
}

// ---------------------------------------------------------------------------
// Query-string readers. Shared with the bankroll/leaderboard routers.
// ---------------------------------------------------------------------------

export function readLeague(raw: string | undefined): League {
  if (raw === undefined || !isLeague(raw)) {
    throw new AppError('VALIDATION', `league must be ${listWithOr(LEAGUES)}`, { field: 'league' });
  }
  return raw;
}

/**
 * An OPTIONAL `?league=` filter over `bets.league`, which since M5b may also be
 * `'mixed'`. Absent (or the empty string) means "every league", which is a real
 * answer here rather than the error it is for the board — a balance and a
 * leaderboard exist without one.
 */
export function readBetLeague(raw: string | undefined): BetLeague | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'all') return undefined;
  if (raw === 'mixed' || isLeague(raw)) return raw;
  throw new AppError('VALIDATION', `league must be ${listWithOr([...LEAGUES, 'mixed', 'all'])}`, {
    field: 'league',
  });
}

export function readInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION', `${field} must be an integer`, { field });
  }
  return value;
}

/** `limit`, clamped into `[1, max]` and defaulted. Never throws for a big number. */
export function readLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = readInt(raw, 'limit');
  if (value === undefined) return fallback;
  if (value < 1) return 1;
  return value > max ? max : value;
}

function readStatus(raw: string | undefined): GameStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(GAME_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError('VALIDATION', 'status is not a known game status', { field: 'status' });
  }
  return raw as GameStatus;
}
