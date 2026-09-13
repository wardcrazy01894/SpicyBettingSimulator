/**
 * ESPN ingestion: plan targets, fetch, upsert games + lines. PLAN.md §8.
 *
 * Non-negotiables:
 *   * Parse fully into memory FIRST; write only after a clean parse. An ESPN
 *     outage or schema change must leave existing rows untouched.
 *   * A `final` game is never regressed to `scheduled` (the upsert's WHERE
 *     clause), so a feed glitch cannot re-open betting on a played game.
 *   * Scores are COALESCEd, so a payload that omits a score cannot null it out.
 *   * Games are never deleted while `bet_legs` reference them.
 *
 * WRITE BUDGET IS A CORRECTNESS CONCERN, NOT AN OPTIMISATION. D1 free allows
 * 100,000 rows written per UTC day and has hard-enforced it since 2026-09-01:
 * past the cap D1 returns errors, which blocks BET PLACEMENT and SETTLEMENT, not
 * just the board. Three levers are v1 requirements, not future work:
 *
 *   L1 COMPARE-AND-SKIP. The upsert's `DO UPDATE ... WHERE` compares old and new
 *      row values and skips entirely when nothing changed. A live 15-minute
 *      refresh of a game whose score has not moved writes ZERO rows -- and
 *      therefore zero index entries, which matters because all three `games`
 *      indexes cover mutable columns.
 *   L2 NO LINE WRITES FOR NON-SCHEDULED GAMES. Measured on the committed
 *      samples: 0 of 84 in-progress/final events carried odds. Refreshing
 *      `game_lines` for a live game is pure waste; skip it at the mapper.
 *   L3 TOUCH INTERVALS. `games.last_seen_at` is only bumped when it is older
 *      than GAME_SEEN_TOUCH_MS (6 h) and `game_lines.seen_at` when older than
 *      LINE_SEEN_TOUCH_MS (45 min), so "still here" costs at most 4 and 32 row
 *      writes per game per day instead of 96.
 */

import type { EpochMs, League } from '../shared/types.js';
import type { Env } from './env.js';
import type { ProviderSlate, ScoreProvider, SlateTarget } from './providers.js';

export interface IngestTargetRow {
  readonly id: string;
  readonly league: League;
  /** v1 always constructs 'date'. See PLAN.md §8.2. */
  readonly kind: 'week' | 'date';
  readonly key: string;
  readonly windowStartAt: EpochMs;
  readonly windowEndAt: EpochMs;
  readonly priority: number;
  readonly nextRunAt: EpochMs;
  readonly consecutiveFailures: number;
}

export interface IngestStats {
  readonly targetsProcessed: number;
  /** Rows that actually changed. Watch this against the 100k/day cap. */
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  /** Rows the compare-and-skip guard left alone. */
  readonly rowsSkipped: number;
  readonly warnings: readonly string[];
  readonly failures: readonly { readonly targetId: string; readonly error: string }[];
}

/**
 * Ensure an `ingest_targets` row exists for every US-Eastern calendar date in
 * `now … now + INGEST_WINDOW_MS`, for BOTH leagues, and retire targets whose
 * window ended more than two days ago with no non-final games. Pure DB work, no
 * network, and no knowledge of the league calendar -- which is exactly why the
 * NFL postseason and bowl season need no special case.
 */
export function planTargets(_env: Env, _now: EpochMs): Promise<number> {
  throw new Error('not implemented: M4');
}

/**
 * Claim the due targets for this run. The slots are NOT interchangeable:
 *
 *   slot 1            the most-due target overall (in practice, a live one)
 *   slot 2 (RESERVED) the most-overdue target that has NO in-progress game
 *
 * Without the reservation a Saturday with a live CFB target and a live NFL
 * target would eat both slots on all 96 runs and the other ~20 targets (next
 * week's line discovery) would starve forever — `ORDER BY priority, next_run_at`
 * alone does not prevent that, because live targets are perpetually the most due.
 *
 * Budget (computed): 11 ET dates x 2 leagues = 22 targets; worst case 2 live
 * leaves 20 discovery targets wanting 4 refreshes/day each = 80 slot-uses/day
 * against a supply of 96. Fits with 16 to spare. Two simultaneously-live targets
 * alternate in slot 1 and each get a 30-minute cadence.
 *
 * The reserved-slot query MUST exclude the id already claimed by slot 1
 * (`AND id <> :slot1Id`): on a run with no live target — most runs — slot 1's
 * pick also satisfies slot 2's predicate, and without the exclusion the run
 * fetches the same URL twice and wastes half its capacity. The two picks are
 * always distinct ids. If the reserved slot has no eligible non-live target, it
 * falls through to the general queue (same exclusion) so a run is never wasted.
 */
export function claimDueTargets(
  _env: Env,
  _now: EpochMs,
  _limit: number,
  _reservedDiscoverySlots: number,
): Promise<readonly IngestTargetRow[]> {
  throw new Error('not implemented: M4');
}

/** Fetch + parse + upsert one target. Never throws; failures are returned. */
export function ingestTarget(
  _env: Env,
  _provider: ScoreProvider,
  _target: IngestTargetRow,
  _now: EpochMs,
): Promise<{
  readonly gamesUpserted: number;
  readonly linesUpserted: number;
  readonly rowsSkipped: number;
  readonly error: string | null;
}> {
  throw new Error('not implemented: M4');
}

/**
 * The upsert batch for a slate. See PLAN.md §8.5 for the exact SQL semantics.
 * Returns the number of rows that ACTUALLY changed (from `meta.changes`), not
 * the number of statements issued -- that difference is the whole point of L1.
 */
export function upsertSlate(
  _env: Env,
  _slate: ProviderSlate,
  _now: EpochMs,
): Promise<{ readonly games: number; readonly lines: number; readonly skipped: number }> {
  throw new Error('not implemented: M4');
}

/**
 * L2: a line row is written only for games whose status is `scheduled`. Exposed
 * separately so `ingest.spec.ts` can assert it directly.
 */
export function lineRowsWorthWriting(_slate: ProviderSlate): ProviderSlate['lines'] {
  throw new Error('not implemented: M4');
}

/**
 * Tiered reschedule (PLAN.md §8.4):
 *   live or kickoff < 3h  -> +15 min
 *   kickoff < 48h         -> +60 min
 *   otherwise             -> +6 h
 *   all games final       -> +24 h
 * On failure: `min(15min * 2^consecutiveFailures, 6h)`.
 */
export function computeNextRunAt(
  _target: IngestTargetRow,
  _slate: ProviderSlate | null,
  _failed: boolean,
  _now: EpochMs,
): EpochMs {
  throw new Error('not implemented: M4');
}

/** Translate an `ingest_targets` row into the provider's target shape. */
export function toSlateTarget(_row: IngestTargetRow): SlateTarget {
  throw new Error('not implemented: M4');
}

/** Entry point for the `refresh` job. */
export function runRefresh(_env: Env, _now: EpochMs, _maxTargets: number): Promise<IngestStats> {
  throw new Error('not implemented: M4');
}
