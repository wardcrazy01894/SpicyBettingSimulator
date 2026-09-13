/**
 * The wire contract between src/web and src/worker. PLAN.md §11.
 *
 * OWNERSHIP: written in M2d and FROZEN at the end of M2d. Changes go through a
 * single PR owned by the M2d track (PLAN.md §16).
 *
 * Every timestamp is epoch ms UTC. Every money value is integer cents. Lines are
 * integer tenths. Nothing here is ever a float except `roi`, which is a
 * display-only statistic.
 */

import type {
  AmericanPrice,
  BetStatus,
  BetType,
  Cents,
  EpochMs,
  GameStatus,
  League,
  LedgerKind,
  LegGrade,
  LineTenths,
  Market,
  Side,
  UserSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export interface HealthResponse {
  readonly ok: true;
  readonly version: string;
  readonly now: EpochMs;
  readonly inviteRequired: boolean;
}

export interface ConfigResponse {
  readonly leagues: readonly League[];
  readonly currentSeason: Readonly<Record<League, number | null>>;
  readonly minStakeCents: Cents;
  readonly maxParlayLegs: number;
  readonly cutoffBufferMs: number;
  readonly initialBankrollCents: Cents;
  /**
   * MAX_PAYOUT_CENTS. The bet slip needs it for pre-flight `exceedsPayoutCap()`
   * so a user is told "over the payout cap" before submitting rather than after
   * a 409. Echoed by the server so a stale client cannot disagree with it.
   */
  readonly maxPayoutCents: Cents;
}

export interface KdfParamsResponse {
  readonly version: number;
  readonly algorithm: 'PBKDF2';
  readonly hash: 'SHA-256';
  readonly iterations: number;
  readonly keyLengthBytes: number;
  readonly saltPrefix: string;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export interface SignupRequest {
  readonly username: string;
  readonly displayName?: string;
  /** 64 lowercase hex chars. NOT the password — see PLAN.md §10.2. */
  readonly dk: string;
  readonly inviteCode?: string;
}

export interface LoginRequest {
  readonly username: string;
  readonly dk: string;
}

export interface UserResponse {
  readonly user: UserSummary;
}

// ---------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------

export interface GameTeamView {
  readonly teamId: string;
  readonly abbr: string;
  readonly name: string;
  readonly logo: string | null;
  readonly rank: number | null;
  readonly score: number | null;
}

export interface GameLinesView {
  readonly provider: string;
  /** When the book's price last CHANGED (game_lines.captured_at). */
  readonly capturedAt: EpochMs;
  /** When we last CONFIRMED the line exists (game_lines.seen_at). Staleness keys off THIS. */
  readonly seenAt: EpochMs;
  /** True once `now - seenAt > LINE_STALE_MS`; such markets are not bettable. */
  readonly stale: boolean;
  readonly spread: {
    readonly homeTenths: LineTenths;
    readonly homePrice: AmericanPrice;
    readonly awayTenths: LineTenths;
    readonly awayPrice: AmericanPrice;
  } | null;
  readonly total: {
    readonly tenths: LineTenths;
    readonly overPrice: AmericanPrice;
    readonly underPrice: AmericanPrice;
  } | null;
  readonly moneyline: {
    readonly homePrice: AmericanPrice;
    readonly awayPrice: AmericanPrice;
  } | null;
}

export interface GameCard {
  readonly id: string;
  readonly league: League;
  readonly season: number;
  /** ESPN season type: 1 pre, 2 regular, 3 post. Needed to label "Week 1" vs "Wild Card". */
  readonly seasonType: number;
  readonly week: number | null;
  readonly kickoffAt: EpochMs;
  readonly status: GameStatus;
  readonly statusDetail: string | null;
  readonly period: number | null;
  readonly displayClock: string | null;
  readonly neutralSite: boolean;
  readonly home: GameTeamView;
  readonly away: GameTeamView;
  /** kickoffAt - cutoffBufferMs. The UI shows this; the SERVER enforces it. */
  readonly lockAt: EpochMs;
  /** Server's verdict right now. The client must not compute this itself. */
  readonly bettable: boolean;
  /** null means "no line posted yet" — a NORMAL state for CFB early in the week. */
  readonly lines: GameLinesView | null;
}

export interface GamesResponse {
  readonly league: League;
  readonly season: number | null;
  readonly week: number | null;
  readonly games: readonly GameCard[];
}

// ---------------------------------------------------------------------------
// bets
// ---------------------------------------------------------------------------

export interface PlaceBetLegRequest {
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
  /**
   * Optimistic-concurrency check. When present and different from the server's
   * current line, the request fails 409 LINE_CHANGED unless `acceptLineChange`.
   */
  readonly expected?: {
    readonly americanPrice: AmericanPrice;
    readonly lineTenths: LineTenths | null;
  };
}

export interface PlaceBetRequest {
  readonly league: League;
  readonly betType: BetType;
  readonly stakeCents: Cents;
  readonly acceptLineChange?: boolean;
  readonly legs: readonly PlaceBetLegRequest[];
}

export interface BetLegView {
  readonly id: string;
  readonly legIndex: number;
  readonly gameId: string;
  readonly market: Market;
  readonly side: Side;
  readonly lineTenths: LineTenths | null;
  readonly americanPrice: AmericanPrice;
  readonly provider: string;
  readonly lineCapturedAt: EpochMs;
  readonly snapshotAt: EpochMs;
  readonly kickoffAtSnapshot: EpochMs;
  readonly homeAbbr: string;
  readonly awayAbbr: string;
  /** Persisted result once the bet settles. */
  readonly result: 'win' | 'loss' | 'push' | 'void' | null;
  /** Live projection for OPEN bets. Computed on read, never persisted. */
  readonly projected: LegGrade | null;
  /**
   * Current game state, for rendering "MIA 14 - 10 NE, Q3". Never null:
   * bet_legs.game_id is NOT NULL with ON DELETE RESTRICT, so the row exists.
   */
  readonly game: {
    readonly status: GameStatus;
    readonly statusDetail: string | null;
    readonly kickoffAt: EpochMs;
    readonly homeScore: number | null;
    readonly awayScore: number | null;
  };
}

export interface BetView {
  readonly id: string;
  readonly league: League;
  readonly season: number;
  readonly betType: BetType;
  readonly stakeCents: Cents;
  /**
   * THE EFFECTIVE price. While `status === 'pending'` this is the price the bet
   * was placed at. Once it settles, settlement WRITES BACK the price of the
   * surviving (won) legs, so a push-repriced parlay displays what it actually
   * paid instead of the price it was placed at. PLAN.md §7.4.
   */
  readonly americanPrice: AmericanPrice;
  /** Display string, e.g. "9.112", derived from `americanPrice`. Never parsed back. */
  readonly decimalOdds: string;
  readonly potentialPayoutCents: Cents;
  readonly toWinCents: Cents;
  readonly status: BetStatus;
  readonly payoutCents: Cents | null;
  readonly placedAt: EpochMs;
  readonly earliestKickoffAt: EpochMs;
  readonly lockAt: EpochMs;
  readonly settledAt: EpochMs | null;
  readonly cancelledAt: EpochMs | null;
  /** Server's verdict: may this bet still be cancelled or edited? */
  readonly cancellable: boolean;
  readonly replacesBetId: string | null;
  readonly replacedByBetId: string | null;
  readonly legs: readonly BetLegView[];
}

export interface BetResponse {
  readonly bet: BetView;
  readonly replacedBetId?: string;
}

export interface BetsResponse {
  readonly bets: readonly BetView[];
  readonly nextCursor: string | null;
}

/**
 * `details` of a 409 LINE_CHANGED. A `type` alias, NOT an interface: TS gives
 * aliases an implicit index signature, which is what lets it be passed as
 * `AppError`'s `Readonly<Record<string, unknown>>` details. An interface here
 * fails to compile at the one call site that exists to use it.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be a type alias: see above
export type LineChangedDetails = {
  readonly legs: readonly {
    readonly gameId: string;
    readonly market: Market;
    readonly side: Side;
    readonly expected: {
      readonly americanPrice: AmericanPrice;
      readonly lineTenths: LineTenths | null;
    };
    readonly current: {
      readonly americanPrice: AmericanPrice;
      readonly lineTenths: LineTenths | null;
    } | null;
  }[];
};

// ---------------------------------------------------------------------------
// bankroll / ledger / leaderboard
// ---------------------------------------------------------------------------

export interface BettingRecord {
  readonly won: number;
  readonly lost: number;
  readonly push: number;
  readonly void: number;
}

export interface BankrollResponse {
  readonly league: League;
  readonly season: number;
  /** Settled cash. Pending stakes are ALREADY DEDUCTED. */
  readonly balanceCents: Cents;
  /** Sum of stakes on pending bets ("exposure"). */
  readonly pendingStakeCents: Cents;
  /** balanceCents + pendingStakeCents. */
  readonly equityCents: Cents;
  readonly record: BettingRecord;
  /** (Σ payout − Σ stake) / Σ stake over won+lost bets only. null when no action. */
  readonly roi: number | null;
  readonly settledCount: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: LedgerKind;
  readonly betId: string | null;
  readonly amountCents: Cents;
  readonly createdAt: EpochMs;
  readonly memo: string | null;
}

export interface LedgerResponse {
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}

export interface LeaderboardRow {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly balanceCents: Cents;
  readonly pendingStakeCents: Cents;
  readonly equityCents: Cents;
  readonly record: BettingRecord;
  readonly roi: number | null;
  readonly rank: number;
}

export interface LeaderboardResponse {
  readonly league: League | 'all';
  readonly season: number | null;
  /** Ranked by balanceCents desc, then roi desc, then username. PLAN.md §11.5. */
  readonly rows: readonly LeaderboardRow[];
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export interface JobRunView {
  readonly id: string;
  readonly job: string;
  readonly trigger: 'cron' | 'admin';
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs | null;
  readonly status: 'running' | 'ok' | 'skipped' | 'error';
  readonly stats: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
}

export interface JobRunResponse {
  readonly run: JobRunView;
}

export interface JobRunsResponse {
  readonly runs: readonly JobRunView[];
}

/** Admin user list row. Unlike UserSummary it exposes the disabled flag. */
export interface AdminUserView extends UserSummary {
  readonly isDisabled: boolean;
}

export interface AdminUsersResponse {
  readonly users: readonly AdminUserView[];
}

/** POST /api/admin/users/:id/password */
export interface AdminSetPasswordRequest {
  /** 64 lowercase hex chars, produced by scripts/admin-hash.mjs or the browser KDF. */
  readonly dk: string;
}

/** POST /api/admin/users/:id/disabled */
export interface AdminSetDisabledRequest {
  readonly disabled: boolean;
}

export interface ReconcileResponse {
  readonly checked: number;
  readonly drift: readonly {
    readonly bankrollId: string;
    readonly balanceCents: Cents;
    readonly ledgerSumCents: Cents;
  }[];
}
