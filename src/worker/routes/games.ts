/**
 * /api/games — the board. PLAN.md §11.3.
 *
 * `bettable` and `lockAt` are computed SERVER-side and sent down; the client must
 * never decide bettability itself.
 */

import { Hono } from 'hono';
import type { GameCard, GameLinesView, GamesResponse } from '../../shared/api-types.js';
import {
  BOARD_LOOKBACK_MS,
  BOARD_MAX_GAMES,
  INGEST_WINDOW_MS,
  LINE_STALE_MS,
} from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import { lockAtFor } from '../../shared/time.js';
import type { BetLeague, EpochMs, GameStatus, League } from '../../shared/types.js';
import { currentSeasonFor, isLeague } from '../bankroll.js';
import { queryAll, queryOne } from '../db.js';
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
  captured_at: number | null;
  seen_at: number | null;
}

/**
 * One row per game with its CURRENT line attached.
 *
 * `game_lines` is keyed `(game_id, provider)`, so the join picks the most
 * recently CONFIRMED provider deterministically rather than letting a second
 * book duplicate the game card.
 */
const BOARD_COLUMNS = `g.id, g.league, g.season, g.season_type, g.week, g.kickoff_at,
       g.status, g.status_detail, g.period, g.display_clock, g.neutral_site,
       g.home_team_id, g.home_abbr, g.home_name, g.home_logo, g.home_rank, g.home_score,
       g.away_team_id, g.away_abbr, g.away_name, g.away_logo, g.away_rank, g.away_score,
       l.provider, l.spread_home_tenths, l.spread_home_price, l.spread_away_tenths,
       l.spread_away_price, l.total_tenths, l.total_over_price, l.total_under_price,
       l.ml_home_price, l.ml_away_price, l.captured_at, l.seen_at`;

const BOARD_JOIN = `FROM games g
  LEFT JOIN game_lines l
         ON l.game_id = g.id
        AND l.provider = (SELECT provider FROM game_lines
                           WHERE game_id = g.id
                           ORDER BY seen_at DESC, provider ASC LIMIT 1)`;

export function gamesRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const league = readLeague(c.req.query('league'));
    const season = readInt(c.req.query('season'), 'season');
    const week = readInt(c.req.query('week'), 'week');
    const status = readStatus(c.req.query('status'));
    const now = c.var.now;
    // PLAN.md §11.3: now − 12 h … now + 10 d unless the caller narrows it.
    const from = readInt(c.req.query('from'), 'from') ?? now - BOARD_LOOKBACK_MS;
    const to = readInt(c.req.query('to'), 'to') ?? now + INGEST_WINDOW_MS;

    const clauses = ['g.league = ?1', 'g.kickoff_at >= ?2', 'g.kickoff_at <= ?3'];
    const values: unknown[] = [league, from, to];
    const next = (value: unknown): string => {
      values.push(value);
      return `?${String(values.length)}`;
    };
    if (season !== undefined) clauses.push(`g.season = ${next(season)}`);
    if (week !== undefined) clauses.push(`g.week = ${next(week)}`);
    if (status !== undefined) clauses.push(`g.status = ${next(status)}`);

    const rows = await queryAll<BoardRow>(
      c.env.DB.prepare(
        `SELECT ${BOARD_COLUMNS} ${BOARD_JOIN}
          WHERE ${clauses.join(' AND ')}
          ORDER BY g.kickoff_at ASC, g.id ASC
          LIMIT ${next(BOARD_MAX_GAMES)}`,
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
      games: rows.map((row) => toGameCard(row, now)),
    };
    return c.json(bodyOut);
  });

  app.get('/:id', async (c) => {
    const row = await queryOne<BoardRow>(
      c.env.DB.prepare(`SELECT ${BOARD_COLUMNS} ${BOARD_JOIN} WHERE g.id = ?1`).bind(
        c.req.param('id'),
      ),
    );
    if (row === null) throw new AppError('GAME_NOT_FOUND', 'No such game.');
    return c.json({ game: toGameCard(row, c.var.now) });
  });

  return app;
}

/** Exported for the bets route, which needs the same card shape for a slip. */
export function toGameCard(row: BoardRow, now: EpochMs): GameCard {
  const lines = toLinesView(row, now);
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
      score: row.home_score,
    },
    away: {
      teamId: row.away_team_id,
      abbr: row.away_abbr,
      name: row.away_name,
      logo: row.away_logo,
      rank: row.away_rank,
      score: row.away_score,
    },
    lockAt,
    // The server's verdict, in one place. A game with no line is NOT an error —
    // it is the normal CFB state early in the week — but it is not bettable.
    bettable:
      status === 'scheduled' &&
      now < lockAt &&
      lines !== null &&
      !lines.stale &&
      (lines.spread !== null || lines.total !== null || lines.moneyline !== null),
    lines,
  };
}

function toLinesView(row: BoardRow, now: EpochMs): GameLinesView | null {
  if (row.provider === null || row.seen_at === null || row.captured_at === null) return null;
  return {
    provider: row.provider,
    capturedAt: row.captured_at,
    seenAt: row.seen_at,
    // Staleness keys off seen_at (last confirmation), never captured_at (last
    // price change) — see the schema comment on game_lines.
    stale: now - row.seen_at > LINE_STALE_MS,
    spread:
      row.spread_home_tenths !== null &&
      row.spread_home_price !== null &&
      row.spread_away_tenths !== null &&
      row.spread_away_price !== null
        ? {
            homeTenths: row.spread_home_tenths,
            homePrice: row.spread_home_price,
            awayTenths: row.spread_away_tenths,
            awayPrice: row.spread_away_price,
          }
        : null,
    total:
      row.total_tenths !== null && row.total_over_price !== null && row.total_under_price !== null
        ? {
            tenths: row.total_tenths,
            overPrice: row.total_over_price,
            underPrice: row.total_under_price,
          }
        : null,
    moneyline:
      row.ml_home_price !== null && row.ml_away_price !== null
        ? { homePrice: row.ml_home_price, awayPrice: row.ml_away_price }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Query-string readers. Shared with the bankroll/leaderboard routers.
// ---------------------------------------------------------------------------

export function readLeague(raw: string | undefined): League {
  if (raw === undefined || !isLeague(raw)) {
    throw new AppError('VALIDATION', 'league must be nfl or ncaaf', { field: 'league' });
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
  throw new AppError('VALIDATION', 'league must be nfl, ncaaf, mixed or all', { field: 'league' });
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
