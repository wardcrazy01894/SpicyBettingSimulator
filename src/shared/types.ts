/**
 * Core domain types. Platform-free: no DOM, no Workers, no D1.
 *
 * OWNERSHIP: this file is written in milestone M2d and FROZEN at the end of M2d.
 * Every other track treats it as read-only (PLAN.md §16).
 */

export type League = 'nfl' | 'ncaaf';

export type GameStatus =
  'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled' | 'unknown';

export type Market = 'moneyline' | 'spread' | 'total';

/** `home`/`away` for moneyline+spread, `over`/`under` for totals. */
export type Side = 'home' | 'away' | 'over' | 'under';

export type BetType = 'straight' | 'parlay';

export type BetStatus = 'pending' | 'won' | 'lost' | 'push' | 'void' | 'cancelled';

/** Per-leg grading outcome. `pending` means "not decidable yet — write nothing". */
export type LegResult = 'win' | 'loss' | 'push' | 'void';
export type LegGrade = LegResult | 'pending';

export type LedgerKind =
  'deposit_initial' | 'bet_stake' | 'bet_payout' | 'bet_refund' | 'admin_adjust';

/** Epoch milliseconds, UTC. Every timestamp in the system is one of these. */
export type EpochMs = number;

/** Integer cents. Never a float. */
export type Cents = number;

/** A point line in TENTHS of a point: -3.5 => -35, o50.5 => 505. */
export type LineTenths = number;

/** An American price as an integer: -110, +164 => 164. |value| >= 100. */
export type AmericanPrice = number;

/**
 * Exact decimal odds as a rational. ALL payout arithmetic uses this; a float
 * decimal odd is never multiplied. See PLAN.md §5.
 *
 * NEVER PERSISTED. A 10-leg parlay rational has a 20+ digit numerator, which an
 * SQLite INTEGER column silently coerces to REAL (verified) and which `bind()`
 * cannot carry past 2^53 anyway. `Price` is computed on demand from the stored
 * `american_price` integers via `americanToPrice()`, which is lossless.
 */
export interface Price {
  readonly num: bigint;
  readonly den: bigint;
}

/** A team as denormalized onto a game row. */
export interface GameTeam {
  readonly teamId: string;
  readonly abbr: string;
  readonly name: string;
  readonly logo: string | null;
  /** CFB AP/curated rank, 1-25; null when unranked or not applicable. */
  readonly rank: number | null;
  readonly score: number | null;
}

export interface Game {
  readonly id: string;
  readonly league: League;
  readonly season: number;
  readonly seasonType: number;
  readonly week: number | null;
  readonly name: string;
  readonly shortName: string;
  readonly kickoffAt: EpochMs;
  readonly originalKickoffAt: EpochMs;
  readonly status: GameStatus;
  readonly statusDetail: string | null;
  readonly period: number | null;
  readonly displayClock: string | null;
  readonly neutralSite: boolean;
  readonly home: GameTeam;
  readonly away: GameTeam;
}

export interface SpreadMarket {
  readonly homeTenths: LineTenths;
  readonly homePrice: AmericanPrice;
  readonly awayTenths: LineTenths;
  readonly awayPrice: AmericanPrice;
}

export interface TotalMarket {
  readonly tenths: LineTenths;
  readonly overPrice: AmericanPrice;
  readonly underPrice: AmericanPrice;
}

export interface MoneylineMarket {
  readonly homePrice: AmericanPrice;
  readonly awayPrice: AmericanPrice;
}

/** The current line for a game from one provider. Any market may be absent. */
export interface GameLines {
  readonly gameId: string;
  readonly provider: string;
  readonly capturedAt: EpochMs;
  readonly spread: SpreadMarket | null;
  readonly total: TotalMarket | null;
  readonly moneyline: MoneylineMarket | null;
}

/**
 * The immutable snapshot a bet leg carries. Grading uses THIS for the line and
 * only reads score/status from the game. See PLAN.md §14.3.
 */
export interface BetLegSnapshot {
  readonly gameId: string;
  readonly league: League;
  readonly market: Market;
  readonly side: Side;
  /** From the BETTOR'S side's perspective. null for moneyline. */
  readonly lineTenths: LineTenths | null;
  /** The snapshot. `price` is derived from this, never stored alongside it. */
  readonly americanPrice: AmericanPrice;
  readonly provider: string;
  /** When the BOOK's price last CHANGED (game_lines.captured_at). */
  readonly lineCapturedAt: EpochMs;
  readonly snapshotAt: EpochMs;
  readonly kickoffAtSnapshot: EpochMs;
  readonly homeAbbr: string;
  readonly awayAbbr: string;
}

/** The subset of a game that grading is allowed to see. */
export interface GameResult {
  readonly status: GameStatus;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
}

export interface Bankroll {
  readonly id: string;
  readonly userId: string;
  readonly league: League;
  readonly season: number;
  readonly balanceCents: Cents;
}

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly createdAt: EpochMs;
}
