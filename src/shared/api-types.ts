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
  BankrollKind,
  BetLeague,
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
  /** False when `GITHUB_TOKEN` is unset; the UI then hides "Report a bug". */
  readonly bugReportsEnabled: boolean;
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
  /** TEASER_POINTS_TENTHS — the tiers the slip's 6 / 6.5 / 7 selector offers. */
  readonly teaserPoints: readonly number[];
  /**
   * TEASER_PAYOUTS, keyed `[pointsTenths][legCount]`. Echoed in full so the slip
   * prices a teaser from SERVER TRUTH rather than from its own bundled copy of
   * `constants.ts`: a deployed client whose card disagreed with the deployed
   * server would quote a price the bet was never booked at, and unlike a parlay
   * there is no per-leg price for `expected` to catch the difference.
   *
   * Indexed loosely (`number`) because JSON object keys are strings; the client
   * looks a value up and renders "—" if it is missing rather than asserting the
   * shape of a payload it did not author.
   */
  readonly teaserPayouts: Readonly<Record<number, Readonly<Record<number, AmericanPrice>>>>;
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
  /**
   * ADVISORY ONLY since M5b. The server derives the bet's league from the legs'
   * own `games` rows (`'mixed'` when they span both) and never compares the two:
   * a balance is no longer scoped to a league, so a disagreement has no money
   * consequence to protect against. Still validated as a legal value, and still
   * sent by the slip, so the field keeps its meaning for a reader of the logs.
   */
  readonly league: BetLeague;
  readonly betType: BetType;
  readonly stakeCents: Cents;
  readonly acceptLineChange?: boolean;
  /**
   * Required iff `betType === 'teaser'`, rejected otherwise. TENTHS of a point:
   * 60 / 65 / 70. Unlike a price, this IS a client instruction — it selects a
   * row of the server's card, and the server re-reads the price from that card.
   */
  readonly teaserPoints?: 60 | 65 | 70;
  /**
   * Which account balance to charge. Absent means the caller's `main` balance.
   * A balance that is not the caller's is `404 BANKROLL_NOT_FOUND` — never 403,
   * for the same no-existence-oracle reason `GET /api/bets/:id` is a 404.
   */
  readonly bankrollId?: string;
  readonly legs: readonly PlaceBetLegRequest[];
}

export interface BetLegView {
  readonly id: string;
  readonly legIndex: number;
  readonly gameId: string;
  /**
   * The leg's OWN league. Always a real one — a leg is a game, and a game is
   * never `'mixed'`. Needed since M5b because `BetView.league` may be `'mixed'`,
   * so it is no longer a per-leg answer: rebuilding a cross-league bet's slip
   * for an edit has to read each leg's league from here.
   */
  readonly league: League;
  readonly market: Market;
  readonly side: Side;
  /** The line this leg is GRADED on — for a teaser leg, the teased one. */
  readonly lineTenths: LineTenths | null;
  /**
   * The book's line BEFORE the tease, so My Bets can render "-7.5 → -1.5".
   * `null` for straight and parlay legs, which are never moved.
   */
  readonly originalLineTenths: LineTenths | null;
  /**
   * For a teaser leg this is the placeholder +100 the schema requires, NOT a
   * price: a teaser is priced once, at the bet level, from the card.
   */
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
  /** The account balance this bet is staked against. */
  readonly bankrollId: string;
  /** `'mixed'` when the legs span both leagues. Informational — see §11.4. */
  readonly league: BetLeague;
  /** Season of the earliest-kickoff leg. Informational. */
  readonly season: number;
  readonly betType: BetType;
  /** Tenths: 60 / 65 / 70 for a teaser, `null` for every other bet type. */
  readonly teaserPoints: number | null;
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

/**
 * One account balance plus its statistics. Replaces M5's `BankrollResponse`,
 * which was keyed on (league, season) — a balance is neither, now.
 *
 * `balanceCents` is the whole account and is never filtered; `record`, `roi` and
 * `settledCount` ARE filterable by `?league=`, because "how did I do in college
 * football" is a real question and "how much money do I have, in college
 * football" is not.
 *
 * THERE IS NO `?season=` — on this endpoint or any other. The product has no
 * concept of a season (PLAN.md §19 Q5): a balance never rolls over, so a
 * per-season slice of one would describe a reset that never happened.
 */
export interface BankrollView {
  readonly id: string;
  readonly name: string;
  readonly kind: BankrollKind;
  /** Settled cash. Pending stakes are ALREADY DEDUCTED. */
  readonly balanceCents: Cents;
  /**
   * Sum of stakes on this balance's pending bets ("exposure").
   *
   * NOT filtered by `?league=` — deliberately, and it is the one field where
   * that matters: `balanceCents` is never filtered either, so filtering the
   * exposure alone would break `equityCents === balanceCents +
   * pendingStakeCents` under every tab but "all".
   */
  readonly pendingStakeCents: Cents;
  /** balanceCents + pendingStakeCents. Holds under every filter. */
  readonly equityCents: Cents;
  readonly record: BettingRecord;
  /** (Σ payout − Σ stake) / Σ stake over won+lost bets only. null when no action. */
  readonly roi: number | null;
  readonly settledCount: number;
}

/**
 * `GET /api/bankroll` → every balance the caller owns, `main` first.
 *
 * A LIST even though v1 always returns exactly one, because the schema models
 * balances as a list for future side pots and a single-object response would
 * have to be replaced (not extended) the day a second one exists.
 */
export interface BankrollsResponse {
  readonly balances: readonly BankrollView[];
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: LedgerKind;
  readonly betId: string | null;
  readonly amountCents: Cents;
  readonly createdAt: EpochMs;
  readonly memo: string | null;
}

/** `GET /api/ledger?bankrollId=&limit=&cursor=`. Defaults to the main balance. */
export interface LedgerResponse {
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}

/** `POST /api/admin/users/:id/adjust`. Either sign; an overdraft is a 409. */
export interface AdminAdjustRequest {
  readonly amountCents: Cents;
  readonly memo?: string;
}

export interface LeaderboardRow {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /**
   * The user's MAIN account balance, always — never a per-league subtotal, and
   * never affected by `?league=`, which filters the record and ROI only.
   * Ranking on a filtered balance would be ranking on a number that does not
   * exist anywhere in the ledger.
   *
   * NOT the ranked column: see `equityCents`.
   */
  readonly balanceCents: Cents;
  readonly pendingStakeCents: Cents;
  /**
   * `balanceCents + pendingStakeCents` — what the account is worth if every open
   * bet were voided. **THE RANKED COLUMN** (decided 2026-09-14): a stake that is
   * still in flight should neither help nor hurt your position, and ranking on
   * the settled balance alone put a player with $2,000 and $1,500 riding on
   * tonight's game below one sitting on $600.
   */
  readonly equityCents: Cents;
  readonly record: BettingRecord;
  readonly roi: number | null;
  readonly rank: number;
}

/**
 * `season` is deliberately ABSENT (decided 2026-09-14): the product has no
 * concept of a season. Balances never roll over, so "the 2026 leaderboard" would
 * be a slice of a number that was never reset. A field that could only ever be
 * `null` would be worse than no field. `bets.season` survives internally, for
 * ingestion and the board's week default.
 */
export interface LeaderboardResponse {
  readonly league: League | 'all';
  /** Ranked by equityCents desc, then roi desc, then username. PLAN.md §11.5. */
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

/**
 * Admin user list row. Unlike UserSummary it exposes the disabled flag, and
 * (additively, migration 0002) the soft-delete stamp.
 *
 * The admin list is the ONE surface that still shows deleted accounts: they are
 * gone from the leaderboard and cannot log in, but an operator has to be able to
 * see that the row exists and why a username is now `deleted_<hex>`.
 */
export interface AdminUserView extends UserSummary {
  readonly isDisabled: boolean;
  /** Epoch ms of the soft delete, or `null` for a live account. */
  readonly deletedAt: EpochMs | null;
  /** `deletedAt !== null`, precomputed so the UI never compares timestamps. */
  readonly isDeleted: boolean;
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

// ---------------------------------------------------------------------------
// §11.7 bug reports
// ---------------------------------------------------------------------------

/** POST /api/bugs */
export interface BugReportRequest {
  readonly title: string;
  readonly description: string;
  /** The SPA path the reporter was on, e.g. `/bets`. Optional. */
  readonly page?: string | null;
}

/** 201 from POST /api/bugs: the GitHub issue that was filed. */
export interface BugReportResponse {
  readonly id: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
}

/** One `bug_reports` row, as `GET /api/admin/bugs` lists them. */
export interface BugReportView {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly title: string;
  readonly description: string;
  readonly page: string | null;
  readonly appVersion: string;
  readonly createdAt: EpochMs;
  /** Null when filing on GitHub failed; `error` then says why. */
  readonly issueNumber: number | null;
  readonly issueUrl: string | null;
  readonly error: string | null;
}

export interface AdminBugReportsResponse {
  readonly reports: readonly BugReportView[];
}
