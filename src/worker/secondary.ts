/**
 * The SECONDARY odds sweep: decide, claim credits, call The Odds API, merge the
 * result into `game_lines`. PLAN.md §21.2 / §21.5.
 *
 * WHY ITS OWN FILE rather than more of `ingest.ts`. Two reasons, both about
 * blast radius:
 *
 *   * `ingest.ts` owns `LINE_UPSERT_SQL`, whose compare tuple is the primary
 *     feed's write-budget lever (§8.5) and which M9c MUST NOT EDIT. The
 *     secondary needs a DIFFERENT upsert — same shape, plus the three 0007 book
 *     columns in both halves of the compare — and two nearly-identical SQL
 *     constants in one file is how somebody "deduplicates" them into one that is
 *     wrong for both.
 *   * `ingest.ts` is already the most-touched worker file (PLAN.md §16). Here,
 *     `runRefresh` gains exactly one call and one stats field.
 *
 * NEVER THROWS OUT. Every failure is a value on `SecondarySweep`, because this
 * runs in the same invocation as an ESPN ingest that has ALREADY written rows:
 * a revoked key, a 500 or a parser surprise must not turn a good refresh run
 * into a failed one. `runRefresh` calls this LAST for exactly that reason, and
 * because the decision then sees the board the primary just wrote — a gap the
 * primary closed this run costs no credits.
 *
 * NO READ-THEN-WRITE (CLAUDE.md rule 5). The permission to spend credits is
 * `meta.changes === 1` on a conditional `UPDATE secondary_budget` whose `WHERE`
 * carries every guard at once. The `refresh` lease already serialises every
 * caller (§9.2); the conditional claim is the belt to that braces.
 *
 * M9c — every function here throws until then.
 */

import type { EpochMs, League } from '../shared/types.js';
import type { Env } from './env.js';

/**
 * Why a sweep spent three credits. Exactly one value, and the vocabulary is
 * shared with PLAN §21.5's decision pseudocode — there is no `'refresh'`
 * anywhere (it collides with the job name) and no `'reswept'` (it reads as a
 * past-tense outcome rather than a reason).
 *
 *   'retry'   some eligible game is GAPPED and is out of its SECONDARY_RETRY_MS
 *             backoff, or has never been tried. This is what DISCOVERS a fill.
 *   'resweep' some secondary market currently ON the board is within
 *             SECONDARY_RESWEEP_MARGIN_MS of its own staleness window closing.
 *             This is what stops a fill from silently vanishing mid-Saturday.
 *   'forced'  the admin pressed Refresh on a specific gapped game (§21.2).
 */
export type SweepReason = 'retry' | 'resweep' | 'forced';

/**
 * Why a sweep did NOT happen. Always travels back in the stats rather than being
 * an absence, so an operator looking at `GET /api/admin/jobs` can tell "nothing
 * to do" from "refused", which is the whole reason `sweepSecondary` returns a
 * value instead of `null`.
 *
 *   'no-gap'        the decision found nothing worth a credit. The normal case.
 *   'throttled'     SECONDARY_MIN_SWEEP_INTERVAL_MS since this league's last sweep.
 *   'budget'        the claim would drop below ODDS_API_CREDIT_RESERVE.
 *   'cooldown'      a 429 or a transport failure is still parking the feature.
 *   'no-budget-row' `secondary_budget` has no row — the 0007 seed did not run.
 *                   Reported, NEVER thrown: this code path is reached inside a
 *                   refresh run that has already written the ESPN slate.
 */
export type SweepSkipped = 'no-gap' | 'throttled' | 'budget' | 'cooldown' | 'no-budget-row';

/** One league's outcome for one refresh run. Never `null`, always a value. */
export interface SecondarySweep {
  readonly league: League;
  /** Null exactly when `skipped` is non-null. */
  readonly reason: SweepReason | null;
  /** Null exactly when the sweep actually called the API. */
  readonly skipped: SweepSkipped | null;
  /** Credits claimed. 0 when skipped, and 0 for the FREE budget probe. */
  readonly cost: number;
  /** `x-requests-remaining` from THIS response; null when there was no response. */
  readonly remaining: number | null;
  readonly events: number;
  readonly matched: number;
  /** Eligible games nothing matched, by label. Capped by the caller. */
  readonly unmatchedEspn: readonly string[];
  /** Home/away disagreement between the feeds: refused, never matched. */
  readonly swapped: readonly string[];
  readonly filled: {
    readonly spread: number;
    readonly total: number;
    readonly moneyline: number;
  };
  /** Games still gapped afterwards, i.e. `games.secondary_tried_at` stamps written. */
  readonly stamped: number;
  /** D1 `meta.rows_written`, folded into the run total (§8.6). */
  readonly rowsWritten: number;
  readonly warnings: readonly string[];
  /** `OddsApiFailureKind`, or null. Never contains the api key. */
  readonly error: string | null;
}

/**
 * `job_runs.stats.secondary` — the whole feature's report for one refresh run,
 * from every path (cron, admin Run refresh, admin per-game Refresh).
 *
 * `enabled` is the ONLY expression of "there is no key": when it is false,
 * `sweeps` is empty. There is no `skipped: 'disabled'`, because a sweep entry
 * for a feature that is switched off is a row an operator has to learn to
 * ignore.
 */
export interface SecondaryStats {
  /** False when `ODDS_API_KEY` is unset. `sweeps` is then empty. */
  readonly enabled: boolean;
  /** Last known `x-requests-remaining`, from `secondary_budget`. */
  readonly remaining: number | null;
  /** When that number last came from a real header. Null = never. */
  readonly checkedAt: EpochMs | null;
  /** Sweeps the reserve refused this run (`skipped: 'budget'`). */
  readonly budgetSkipped: number;
  readonly sweeps: readonly SecondarySweep[];
}

export interface SweepOptions {
  /**
   * A game id whose `SECONDARY_RETRY_MS` backoff is waived — the admin's
   * per-game Refresh, and NOTHING else. It does not waive the credit reserve,
   * the per-league interval, the failure cooldown, or one-call-per-league-per-run
   * (§21.2).
   */
  readonly force: string | null;
}

/**
 * Sweep both leagues, at most once each, and fold the budget row into the run's
 * stats. THE ONE ENTRY POINT: `runRefresh` calls this and nothing else, so every
 * refresh path gets identical behaviour and there is no second stats vocabulary.
 *
 * Returns `{ enabled: false, sweeps: [] }` without touching D1 or the network
 * when `readConfig(env).oddsApi` is null.
 */
export function runSecondary(
  _env: Env,
  _now: EpochMs,
  _options: SweepOptions,
): Promise<SecondaryStats> {
  throw new Error('not implemented (M9c: PLAN.md §21.5)');
}

/**
 * One league. Decide (one row read, then at most one candidate scan), claim
 * (one conditional `UPDATE`), call, merge, stamp.
 *
 * Exported for the tests, which drive a single league deterministically; the
 * production caller is `runSecondary`.
 */
export function sweepSecondary(
  _env: Env,
  _league: League,
  _now: EpochMs,
  _options: SweepOptions,
): Promise<SecondarySweep> {
  throw new Error('not implemented (M9c: PLAN.md §21.5)');
}
