/**
 * The PER-MARKET merge of every `game_lines` row a game has, and the ONE
 * definition of "the line the app is offering right now". PLAN.md §21.4.
 *
 * WHY THIS EXISTS. Until the secondary provider there was exactly one row per
 * game and two call sites picked it with mirror-image SQL: the board with
 * `ORDER BY seen_at DESC, provider ASC LIMIT 1` (routes/games.ts) and placement
 * by walking the rows ascending and keeping the last (bets.ts `loadLines`).
 * Mirror images are a convention, and a convention is exactly what breaks when a
 * second provider shows up: the board would show one book's price and placement
 * would charge another's, and `409 LINE_CHANGED` would not even catch it,
 * because the client's `expected` came from the board.
 *
 * So the merge is a FUNCTION, not a convention, and not a third "merged" row
 * written by ingestion either. The rejected alternative and its three specific
 * costs — a fabricated `seen_at` that describes no real confirmation, a
 * `bet_legs.provider` of `'board'` that names no book, and a third write stream
 * against a 100k-rows/day cap — are argued in PLAN.md §21.4.
 *
 * Platform-free (CLAUDE.md rule 4): no fetch, no D1, no DOM. The only input is
 * rows, a kickoff and a clock.
 *
 * M9b.
 */

import {
  LINE_PROVIDER_PRIORITY,
  MAX_ABS_AMERICAN_PRICE,
  MAX_ABS_LINE_TENTHS,
  MIN_ABS_AMERICAN_PRICE,
  MONEYLINE_NOT_OFFERED_SPREAD_TENTHS,
} from './constants.js';
import { lineStaleAfterMs } from './time.js';
import type {
  AmericanPrice,
  EpochMs,
  LineTenths,
  MoneylineMarket,
  SpreadMarket,
  TotalMarket,
} from './types.js';

/**
 * One `game_lines` row, in camelCase, with the 0007 per-market book columns.
 * Deliberately NOT the D1 row shape: both call sites map their own SELECT into
 * this, which is what stops the merge from depending on a column list.
 */
export interface LineRowView {
  /**
   * `game_lines.provider`: 'DraftKings' (primary) or 'odds-api' (secondary) —
   * in principle. In practice it is whatever string the feed wrote the day the
   * row was written (ESPN served 'Draft Kings' for a day, §8.3), which is why
   * `providerRank` normalises before ranking.
   */
  readonly provider: string;
  readonly spreadHomeTenths: LineTenths | null;
  readonly spreadHomePrice: AmericanPrice | null;
  readonly spreadAwayTenths: LineTenths | null;
  readonly spreadAwayPrice: AmericanPrice | null;
  /** Bookmaker key for the SPREAD only; null on a primary row. */
  readonly spreadBook: string | null;
  readonly totalTenths: LineTenths | null;
  readonly totalOverPrice: AmericanPrice | null;
  readonly totalUnderPrice: AmericanPrice | null;
  readonly totalBook: string | null;
  readonly mlHomePrice: AmericanPrice | null;
  readonly mlAwayPrice: AmericanPrice | null;
  readonly mlBook: string | null;
  /** When THIS row's prices last changed. */
  readonly capturedAt: EpochMs;
  /** When THIS row was last confirmed. Staleness keys off this, never capturedAt. */
  readonly seenAt: EpochMs;
}

/**
 * Where one merged market came from — and THE source of the whole `bet_legs`
 * snapshot trio, not just of the label.
 *
 * `resolveLegSnapshots` (src/worker/bets.ts) must take `provider`,
 * `line_captured_at` AND the staleness decision from the MARKET it is placing
 * on, never from "the row" or "the line": with a merged line the spread can be
 * DraftKings' and the total FanDuel's, and a leg that copied `provider` from the
 * market but `line_captured_at` from whichever row happened to win the headline
 * would be an audit record of a thing that never happened (PLAN.md §14.3).
 */
export interface MarketSource {
  /**
   * The provenance string a `bet_legs.provider` gets: `'DraftKings'` for a
   * primary market, `'odds-api:<bookmaker>'` for a secondary one. Composed from
   * the row's `provider` and that market's book column, so the board label and
   * the leg label are byte-identical.
   */
  readonly provider: string;
  /** THIS market's row's `captured_at` — when the book's price last changed. */
  readonly capturedAt: EpochMs;
  /**
   * THIS market's row's `seen_at`. A market present in an `EffectiveLine` has
   * already passed the staleness test against this value, which is why placement
   * must re-test against the market's own `seenAt` and not against a row-level
   * one it no longer has.
   */
  readonly seenAt: EpochMs;
}

/**
 * The effective line: each market resolved independently, each carrying its own
 * provenance. A market is present here ONLY if some row offered it complete and
 * that row was fresh at `now`; absent means "do not render a button, do not
 * accept a bet".
 */
export interface EffectiveLine {
  readonly spread: (SpreadMarket & MarketSource) | null;
  readonly total: (TotalMarket & MarketSource) | null;
  readonly moneyline: (MoneylineMarket & MarketSource) | null;
  /**
   * Headline provenance for the card: the source of the highest-priority market
   * that survived, so a card whose spread is primary and total secondary reads
   * as 'DraftKings'. Per-market provenance is on the markets themselves.
   */
  readonly provider: string;
  readonly capturedAt: EpochMs;
  readonly seenAt: EpochMs;
  /**
   * The board's existing "Line is stale — not accepting bets right now" state:
   * some row offered a COMPLETE market, and every row that did is stale at
   * `now`. False whenever a market survived, including a card where only one of
   * three did.
   *
   * THE "SOME ROW OFFERED A COMPLETE MARKET" CLAUSE IS LOAD-BEARING and is not
   * what an earlier draft said ("rows exist but no market survived"). ESPN
   * writes an ALL-NULL primary row when DraftKings pulls every market ("OFF" —
   * src/shared/espn.ts), and that row is FRESH: today `toLinesView` renders it
   * as `stale: false` with three null markets, i.e. "no line yet", which is the
   * truth. Under the naive clause the same card would start showing "Line is
   * stale", which says the ingest is broken when it is working perfectly. So:
   * no complete market anywhere, ever -> `stale: false` and three nulls.
   */
  readonly stale: boolean;
}

/**
 * Merge every row a game has into one effective line. `null` when `rows` is
 * empty — i.e. the game has never been priced, which is the normal early-week
 * CFB state and not an error.
 *
 * Per market, independently:
 *   1. drop rows that do not offer the market COMPLETE (a spread needs both
 *      tenths and both prices; a total needs the number and both prices; a
 *      moneyline needs both prices). A half-market is not a market.
 *   2. drop rows that are stale AT `now`:
 *      `now - seenAt > lineStaleAfterMs(kickoffAt, seenAt)`. Judged per ROW, so
 *      a fresh secondary fill survives next to a primary row that went stale.
 *   3. of what is left, take the first by `LINE_PROVIDER_PRIORITY`, then
 *      `seenAt` DESC, then `provider` ASC. Primary-first is what makes "the
 *      primary wins the market back on the next refresh" automatic.
 *
 * MONOTONICITY, which the board and placement both depend on: the staleness
 * test is the existing `lineStaleAfterMs`, which is keyed on `seenAt` and not on
 * `now`, so a market that is present at time T is present for every T' in
 * [T, T + window]. The board read and the placement read happen milliseconds
 * apart in the same direction of time, so the board can never offer a price that
 * placement then refuses as `MARKET_UNAVAILABLE`. Do not "improve" this into a
 * window measured from `now`.
 *
 * TOTAL: never throws. A row with nonsense in it loses its market and nothing
 * else; there is no input for which this returns a half-built object.
 */
export function mergeEffectiveLine(
  rows: readonly LineRowView[],
  kickoffAt: EpochMs,
  now: EpochMs,
): EffectiveLine | null {
  if (rows.length === 0) return null;

  // Step 3's order, applied once: primary first, then most recently seen, then
  // provider name. Each market then takes the FIRST row in this order that
  // offers it complete and fresh.
  const ordered = [...rows].sort(
    (a, b) =>
      providerRank(a.provider) - providerRank(b.provider) ||
      b.seenAt - a.seenAt ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
  );
  const fresh = (row: LineRowView): boolean =>
    Number.isFinite(row.seenAt) && now - row.seenAt <= lineStaleAfterMs(kickoffAt, row.seenAt);
  const source = (row: LineRowView, book: string | null): MarketSource => ({
    provider: marketProvider(row.provider, book),
    capturedAt: row.capturedAt,
    seenAt: row.seenAt,
  });

  // Whether ANY row offered a complete market, fresh or not: the difference
  // between "no line" (stale: false, three nulls) and "line is stale".
  let offered = false;
  let spread: EffectiveLine['spread'] = null;
  let total: EffectiveLine['total'] = null;
  let moneyline: EffectiveLine['moneyline'] = null;
  let headline: LineRowView | null = null;

  for (const row of ordered) {
    const s = completeSpread(row);
    const t = completeTotal(row);
    const m = completeMoneyline(row);
    if (s !== null || t !== null || m !== null) offered = true;
    if (!fresh(row)) continue;
    let contributed = false;
    if (spread === null && s !== null) {
      spread = { ...s, ...source(row, row.spreadBook) };
      contributed = true;
    }
    if (total === null && t !== null) {
      total = { ...t, ...source(row, row.totalBook) };
      contributed = true;
    }
    if (moneyline === null && m !== null) {
      moneyline = { ...m, ...source(row, row.mlBook) };
      contributed = true;
    }
    if (contributed && headline === null) headline = row;
  }

  // The headline trio: the highest-priority row that contributed a market, or,
  // when nothing survived, the highest-priority row there is — so a fresh
  // all-null "OFF" row still reads as its provider with stale: false.
  const first = headline ?? ordered[0];
  if (first === undefined) return null;
  return {
    spread,
    total,
    moneyline,
    provider: first.provider,
    capturedAt: first.capturedAt,
    seenAt: first.seenAt,
    stale: offered && spread === null && total === null && moneyline === null,
  };
}

/*
 * A market is COMPLETE only when every one of its numbers is a usable integer.
 * EXPORTED so placement (src/worker/bets.ts) applies the SAME predicate when it
 * re-reads a quote off the merged line: two copies of "usable" that drift is a
 * board/placement divergence waiting to happen.
 */

export function usableTenths(value: LineTenths | null): value is LineTenths {
  return value !== null && Number.isSafeInteger(value) && Math.abs(value) <= MAX_ABS_LINE_TENTHS;
}

export function usablePrice(value: AmericanPrice | null): value is AmericanPrice {
  return (
    value !== null &&
    Number.isSafeInteger(value) &&
    Math.abs(value) >= MIN_ABS_AMERICAN_PRICE &&
    Math.abs(value) <= MAX_ABS_AMERICAN_PRICE
  );
}

function completeSpread(row: LineRowView): SpreadMarket | null {
  return usableTenths(row.spreadHomeTenths) &&
    usablePrice(row.spreadHomePrice) &&
    usableTenths(row.spreadAwayTenths) &&
    usablePrice(row.spreadAwayPrice)
    ? {
        homeTenths: row.spreadHomeTenths,
        homePrice: row.spreadHomePrice,
        awayTenths: row.spreadAwayTenths,
        awayPrice: row.spreadAwayPrice,
      }
    : null;
}

function completeTotal(row: LineRowView): TotalMarket | null {
  return usableTenths(row.totalTenths) &&
    usablePrice(row.totalOverPrice) &&
    usablePrice(row.totalUnderPrice)
    ? { tenths: row.totalTenths, overPrice: row.totalOverPrice, underPrice: row.totalUnderPrice }
    : null;
}

function completeMoneyline(row: LineRowView): MoneylineMarket | null {
  return usablePrice(row.mlHomePrice) && usablePrice(row.mlAwayPrice)
    ? { homePrice: row.mlHomePrice, awayPrice: row.mlAwayPrice }
    : null;
}

/**
 * The provenance string for one market of one row: `row.provider` alone for the
 * primary, `` `${row.provider}:${book}` `` when the row carries a per-market
 * book. Exported because `bets.ts` writes it into `bet_legs.provider` and the
 * board renders it, and those two must not compose it differently.
 */
export function marketProvider(rowProvider: string, book: string | null): string {
  return book === null || book === '' ? rowProvider : `${rowProvider}:${book}`;
}

/**
 * Sort key for step 3 above: the index of `provider` in
 * `LINE_PROVIDER_PRIORITY`, or `LINE_PROVIDER_PRIORITY.length` for a provider
 * nobody has ranked — which sorts it last rather than crashing, so an unknown
 * row in the table can never make the board throw.
 */
export function providerRank(provider: string): number {
  // Normalised, because the STRING on a row is whatever the feed said the day
  // it was written: ESPN served "DraftKings" and "Draft Kings" within one day
  // (2026-09-17), and the rows under the variant must still rank as the primary.
  const key = normaliseProvider(provider);
  const index = PRIORITY_KEYS.indexOf(key);
  return index === -1 ? LINE_PROVIDER_PRIORITY.length : index;
}

function normaliseProvider(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]/g, '');
}
const PRIORITY_KEYS: readonly string[] = LINE_PROVIDER_PRIORITY.map(normaliseProvider);

/* ------------------------------------------------------------------ *
 * What the secondary provider is allowed to chase (PLAN.md §21.2)
 * ------------------------------------------------------------------ */

/** Which markets the effective line is missing, per the rule below. */
export interface MarketGaps {
  readonly spread: boolean;
  readonly total: boolean;
  readonly moneyline: boolean;
  /** `spread || total || moneyline`. The sweep's "this game is gapped" test. */
  readonly any: boolean;
}

/**
 * The gap predicate the SWEEP DECISION uses — deliberately not the same as the
 * coverage MEASUREMENT in `src/worker/ingest.ts`, which counts every absent
 * market because its job is to describe the feed rather than to spend money.
 *
 * A missing spread is always a gap. A missing total is always a gap. A missing
 * MONEYLINE is a gap only when the effective spread is smaller than
 * `MONEYLINE_NOT_OFFERED_SPREAD_TENTHS` (30.0 points), or when there is no
 * spread at all to judge by.
 *
 * WHY, measured on docs/samples/odds-api-ncaaf.json (75 events, nine books):
 * 15 events have no moneyline at ANY book, every one of them at |spread| >= 33.5,
 * and no book anywhere posts one. Those games are permanently unfillable, and
 * before this rule each of them re-triggered a three-credit sweep every
 * `SECONDARY_RETRY_MS`. Simulated over a 30-day month, four such games cost 471
 * credits of a 500-credit tier and pushed the reserve block from "never" to day
 * 19, starving the fills that DO work (PLAN.md §21.5). The largest spread that
 * carries a DraftKings moneyline in the same sample is 35.5, with 30.5 the
 * largest below it, so the threshold sits in a real gap in the data.
 *
 * `null` (the game has never been priced) is three gaps, not zero.
 *
 * PLAN.md §21.2.
 */
export function missingMarkets(line: EffectiveLine | null): MarketGaps {
  if (line === null) return { spread: true, total: true, moneyline: true, any: true };
  const spread = line.spread === null;
  const total = line.total === null;
  const moneyline =
    line.moneyline === null &&
    (line.spread === null ||
      Math.abs(line.spread.homeTenths) < MONEYLINE_NOT_OFFERED_SPREAD_TENTHS);
  return { spread, total, moneyline, any: spread || total || moneyline };
}
