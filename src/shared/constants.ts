/**
 * Tunable constants shared by the Worker and the browser.
 *
 * Anything the UI must agree with the server about lives here, and most of it is
 * also echoed by `GET /api/config` so a deployed client can never disagree with a
 * deployed server.
 */

import type { AmericanPrice } from './types.js';

/**
 * Opening balance, deposited once per ACCOUNT in the signup batch (M5b). It is
 * not per league, not per season and never re-granted: there is exactly one
 * `deposit_initial` ledger row per balance, for the life of the account.
 */
export const INITIAL_BANKROLL_CENTS = 100_000;

/** Minimum stake: $1.00. Also enforced by a CHECK constraint on `bets`. */
export const MIN_STAKE_CENTS = 100;

/**
 * Hard cap on any single bet's total return ($1,000,000). Two jobs:
 *   1. A real product rule — every sportsbook caps payouts.
 *   2. It PROVES `bets.potential_payout_cents` / `payout_cents` fit in both an
 *      SQLite INTEGER and a JS `number`: 1e8 vs 2^53 is ~7.95 orders of
 *      magnitude of headroom, so no money column can silently become REAL.
 * A bet above the cap is rejected at placement with PAYOUT_LIMIT_EXCEEDED; the
 * comparison happens in BigInt before any Number conversion.
 *
 * Lives HERE and not in odds.ts because the browser needs it too: the bet slip
 * calls `exceedsPayoutCap()` for pre-flight, and `GET /api/config` echoes it as
 * `maxPayoutCents` so a deployed client cannot disagree with a deployed server.
 * For reference, the largest realistic payout — a 10-leg -110 parlay at the full
 * $1,000 bankroll — returns 64,308,161 cents, comfortably under the cap.
 */
export const MAX_PAYOUT_CENTS = 100_000_000;

/** Parlay leg bounds. A straight bet is exactly 1 leg. */
export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 10;

// ---------------------------------------------------------------------------
// Teasers (M5b). Research and sources: docs/teaser-odds.md, summarised in
// PLAN.md §5.8.
// ---------------------------------------------------------------------------

/**
 * The point tiers we offer, in TENTHS of a point: 6, 6.5 and 7.
 *
 * Tenths because 6.5 has no integer representation in points, and because every
 * other line quantity in this system is already tenths (PLAN.md §3.1) — mixing
 * units is how a 6.5-point teaser ends up teasing by 6.
 */
export const TEASER_POINTS_TENTHS = [60, 65, 70] as const;
export type TeaserPointsTenths = (typeof TEASER_POINTS_TENTHS)[number];

/** A teaser is a parlay shape: never fewer than two legs, never more than ten. */
export const MIN_TEASER_LEGS = 2;

/** Leg counts the card prices. Same ceiling as a parlay. */
export type TeaserLegCount = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * THE TEASER CARD: a FIXED price per (points, legs), in integer American.
 *
 * A teaser is NOT priced as the product of its legs — that is the whole point of
 * the product. Moving every line six points in the bettor's favour destroys the
 * legs' individual prices, so the book posts a flat card instead, and
 * `bet_legs.american_price` for a teaser leg is a placeholder (+100, even money)
 * that carries no pricing meaning. `bets.american_price` is the card value.
 *
 * These are the Bovada "classic standard" numbers — the only fully populated
 * 2-10 leg × 6/6.5/7-point grid that is actually published, and the closest
 * match to what the industry calls the standard teaser card. DraftKings differs
 * only at 3-leg/6-point (+160 vs +150) and FanDuel prices 2-leg/6-point nearer
 * -110; neither publishes a complete grid. Sources in docs/teaser-odds.md.
 *
 * Every value round-trips through `americanToPrice`/`priceToAmerican` exactly
 * (verified, 27/27), so settlement can write the effective price back through
 * the same path a parlay uses. The worst payout the card can produce is the
 * 10-leg 6-point +2500 at the full 100,000¢ bankroll = 2,600,000¢ (verified),
 * which is 38× under MAX_PAYOUT_CENTS — so `exceedsPayoutCap` is unreachable for
 * a teaser in practice and is still checked, for free, on the shared path.
 */
export const TEASER_PAYOUTS: Readonly<
  Record<TeaserPointsTenths, Readonly<Record<TeaserLegCount, AmericanPrice>>>
> = {
  60: { 2: -120, 3: 150, 4: 260, 5: 400, 6: 600, 7: 900, 8: 1400, 9: 1900, 10: 2500 },
  65: { 2: -130, 3: 135, 4: 225, 5: 350, 6: 500, 7: 800, 8: 1100, 9: 1500, 10: 2000 },
  70: { 2: -140, 3: 120, 4: 200, 5: 325, 6: 450, 7: 700, 8: 900, 9: 1200, 10: 1500 },
};

/** True for a value that indexes `TEASER_PAYOUTS`. */
export function isTeaserPoints(value: unknown): value is TeaserPointsTenths {
  return (TEASER_POINTS_TENTHS as readonly unknown[]).includes(value);
}

/**
 * Betting closes this long BEFORE the stored kickoff time. Covers clock skew,
 * Workers' I/O-frozen `Date.now()`, and ESPN kickoff times being approximate.
 * See PLAN.md §14.1.
 */
export const BET_CUTOFF_BUFFER_MS = 60_000;

/**
 * A `game_lines` row whose `seen_at` is older than this is not offered for
 * betting. Measured against `seen_at` (last confirmation), NOT `captured_at`
 * (last price change), so the compare-and-skip upsert can leave an unchanged
 * line alone without making it look stale.
 */
export const LINE_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * WRITE-BUDGET LEVERS (PLAN.md §8.6). D1 free tier allows 100,000 rows written
 * per UTC day and since 2026-09-01 it is HARD-ENFORCED: past the cap, D1 returns
 * errors, which would block bet placement and settlement, not just staleness.
 *
 * The ingest upsert therefore writes a row only when a value actually changed,
 * or when the "last seen" stamp is older than these touch intervals.
 */
export const GAME_SEEN_TOUCH_MS = 6 * 60 * 60 * 1000;
export const LINE_SEEN_TOUCH_MS = 45 * 60 * 1000;

/**
 * Refresh slot allocation. `REFRESH_TARGETS_PER_RUN` is 2 (env var), and the two
 * slots are NOT interchangeable:
 *   slot 1  the most-due target overall — in practice a live one
 *   slot 2  RESERVED for the most-overdue target with no in-progress game
 *
 * Without the reservation, a Saturday with a live CFB target and a live NFL
 * target would consume both slots on all 96 runs and the other ~20 targets
 * (next week's line discovery) would starve indefinitely; `priority ASC,
 * next_run_at ASC` alone does not prevent that.
 *
 * Budget check (computed): a 10-day window is 11 ET dates × 2 leagues = 22
 * targets. Worst case 2 are live, leaving 20 discovery targets that each want a
 * +6 h refresh = 4/day = 80 slot-uses/day, against a supply of 96 — fits with 16
 * to spare. If two targets are live at once they alternate in slot 1 and each
 * gets a 30-minute cadence, which settlement tolerates.
 */
export const RESERVED_DISCOVERY_SLOTS = 1;

/** How far ahead the ingest planner keeps `ingest_targets` populated. */
export const INGEST_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * A postponed game (or one that vanished from the feed) is auto-voided once this
 * long has passed since its ORIGINAL kickoff. See PLAN.md §7.5.
 */
export const VOID_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Session lifetime, and the minimum age before we bother rewriting the row. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'sbs_session';

/** Header every state-changing request must carry. See PLAN.md §10.5. */
export const CSRF_HEADER = 'X-SBS-Client';
export const CSRF_HEADER_VALUE = '1';

/** Login throttling. */
export const AUTH_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_MAX_FAILURES = 10;
export const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Password KDF parameters. The heavy stretching runs in the BROWSER because the
 * Workers free plan allows only 10 ms of CPU per invocation. See PLAN.md §10.
 *
 * `saltPrefix` + lowercased username is hashed to produce a deterministic client
 * salt, so there is no "fetch my salt" endpoint and therefore no user-enumeration
 * oracle.
 */
export const KDF_VERSION = 1;
export const CLIENT_KDF = {
  algorithm: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 210_000,
  keyLengthBytes: 32,
  saltPrefix: 'SBS-v1|',
} as const;
export const SERVER_KDF_ITERATIONS = 1_000;
export const SERVER_SALT_BYTES = 16;

/** Username policy (enforced server-side; the DB also has a length CHECK). */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/** Advisory only — the server never sees the plaintext password. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Settlement chunk bookkeeping. A bet that is selected as settleable but still
 * grades `pending` (all games final, but a score is unparseable) increments
 * `bets.settle_attempts`; past this it is de-prioritised and reported, so it can
 * never block the head of the queue. See PLAN.md §7.1.
 *
 * 96 attempts at the 15-minute settle cadence = **24 hours** of patience before a
 * bet is parked for a human. An earlier value of 5 gave up after 1.25 h, which is
 * well inside the window in which a transiently malformed ESPN score is
 * plausible — and there was no reset path, so a brief feed glitch could park a
 * bet permanently.
 *
 * There are now TWO ways out, so 96 is a ceiling rather than a death sentence:
 *   1. The settle job's first statement each run zeroes `settle_attempts` for any
 *      deferred bet whose leg games have been updated since `settle_attempted_at`
 *      — i.e. the moment ESPN publishes a sane score, the bet gets a fresh 24 h.
 *   2. `POST /api/admin/bets/:id/retry-settlement` clears it manually.
 */
export const MAX_SETTLE_ATTEMPTS = 96;

/** Job names. Must match the `job_locks` rows seeded by migration 0001. */
export const JOB_NAMES = ['refresh', 'settle', 'maintenance'] as const;

/** Lease TTLs, all shorter than their cron period so a crash self-heals. */
export const JOB_LEASE_TTL_MS: Readonly<Record<(typeof JOB_NAMES)[number], number>> = {
  refresh: 5 * 60 * 1000,
  settle: 5 * 60 * 1000,
  maintenance: 10 * 60 * 1000,
};

/** ESPN request tuning. */
export const ESPN_TIMEOUT_MS = 8_000;
export const ESPN_MAX_WARNINGS_RECORDED = 20;
export const ESPN_DRAFTKINGS_PROVIDER_ID = '100';

/** Sanity bounds for parsed market data; anything outside is dropped + warned. */
export const MAX_ABS_LINE_TENTHS = 1_000;
export const MIN_ABS_AMERICAN_PRICE = 100;
export const MAX_ABS_AMERICAN_PRICE = 100_000;

/** Board query defaults. */
export const BOARD_LOOKBACK_MS = 12 * 60 * 60 * 1000;
export const BOARD_MAX_GAMES = 300;

/**
 * Bug reports (PLAN.md §11.7). A report is stored in `bug_reports` and filed as
 * a GitHub issue. The limits bound what one signed-in user can push into the
 * issue tracker: a title, a description, the page they were on, and at most
 * `BUG_REPORTS_PER_WINDOW` reports per `BUG_REPORT_WINDOW_MS`.
 */
export const BUG_REPORT_TITLE_MIN = 3;
export const BUG_REPORT_TITLE_MAX = 120;
export const BUG_REPORT_DESCRIPTION_MIN = 10;
export const BUG_REPORT_DESCRIPTION_MAX = 4_000;
export const BUG_REPORT_PAGE_MAX = 200;
/** The request's User-Agent is stored and filed too; anything past this is cut. */
export const BUG_REPORT_USER_AGENT_MAX = 300;
export const BUG_REPORTS_PER_WINDOW = 5;
export const BUG_REPORT_WINDOW_MS = 60 * 60 * 1000;
