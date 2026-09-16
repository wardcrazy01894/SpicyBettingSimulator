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
 * M9c.
 */

import {
  ESPN_MAX_WARNINGS_RECORDED,
  LINE_PROVIDER_SECONDARY,
  LINE_SEEN_TOUCH_MS,
  ODDS_API_BUDGET_PROBE_MS,
  ODDS_API_COOLDOWN_MAX_MS,
  ODDS_API_COOLDOWN_MS,
  ODDS_API_COST_PER_SWEEP,
  ODDS_API_CREDIT_RESERVE,
  SECONDARY_MATCH_WINDOW_MS,
  SECONDARY_MIN_SWEEP_INTERVAL_MS,
  SECONDARY_RESWEEP_MARGIN_MS,
  SECONDARY_RETRY_MS,
} from '../shared/constants.js';
import { mergeEffectiveLine, missingMarkets } from '../shared/lines.js';
import type { EffectiveLine, LineRowView } from '../shared/lines.js';
import { matchOddsApiEvents } from '../shared/odds-api.js';
import type { MatchCandidate, OddsApiEvent } from '../shared/odds-api.js';
import { boardWindowEnd, lineStaleAfterMs } from '../shared/time.js';
import { LEAGUES } from '../shared/types.js';
import type { EpochMs, League } from '../shared/types.js';
import { queryAll, rowsWrittenOf } from './db.js';
import type { Env } from './env.js';
import { readConfig } from './env.js';
import { TheOddsApiProvider, fetchCredits } from './odds-api.js';
import type { OddsApiConfig, OddsApiCredits } from './odds-api.js';

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
export async function runSecondary(
  env: Env,
  now: EpochMs,
  options: SweepOptions,
): Promise<SecondaryStats> {
  if (readConfig(env).oddsApi === null) {
    return { enabled: false, remaining: null, checkedAt: null, budgetSkipped: 0, sweeps: [] };
  }
  const sweeps: SecondarySweep[] = [];
  for (const league of LEAGUES) sweeps.push(await sweepSecondary(env, league, now, options));
  const budget = await readBudget(env);
  return {
    enabled: true,
    remaining: budget?.remaining_credits ?? null,
    checkedAt: budget === null || budget.checked_at === 0 ? null : budget.checked_at,
    budgetSkipped: sweeps.filter((s) => s.skipped === 'budget').length,
    sweeps,
  };
}

/**
 * One league. Decide (one row read, then at most one candidate scan), claim
 * (one conditional `UPDATE`), call, merge, stamp.
 *
 * Exported for the tests, which drive a single league deterministically; the
 * production caller is `runSecondary`.
 */
/* ------------------------------------------------------------------ *
 * SQL. The claim is the guard (CLAUDE.md rule 5): every condition lives in
 * its WHERE, and `meta.changes === 1` is the permission to spend.
 * ------------------------------------------------------------------ */

/** Constant SQL per league — the column name is NEVER interpolated from input. */
const CLAIM_SQL: Readonly<Record<League, string>> = {
  nfl: `UPDATE secondary_budget
           SET remaining_credits = remaining_credits - ?1, last_attempt_at = ?2,
               nfl_last_sweep_at = ?2, updated_at = ?2
         WHERE id = 1 AND remaining_credits - ?1 >= ?3
           AND ?2 - nfl_last_sweep_at >= ?4 AND ?2 >= cooldown_until`,
  ncaaf: `UPDATE secondary_budget
           SET remaining_credits = remaining_credits - ?1, last_attempt_at = ?2,
               ncaaf_last_sweep_at = ?2, updated_at = ?2
         WHERE id = 1 AND remaining_credits - ?1 >= ?3
           AND ?2 - ncaaf_last_sweep_at >= ?4 AND ?2 >= cooldown_until`,
};

/** (a) The RESET probe's claim: daily, respects the cooldown, NO credit arithmetic. */
const RESET_PROBE_CLAIM_SQL = `UPDATE secondary_budget
   SET last_attempt_at = ?1, updated_at = ?1
 WHERE id = 1 AND ?1 - last_attempt_at >= ?2 AND ?1 >= cooldown_until`;

/**
 * (b) The POST-FAILURE probe's claim: exempt from `last_attempt_at` and from
 * `cooldown_until` — the failing sweep just set both — throttled only by a 60 s
 * `checked_at` floor that stops a retry storm issuing a probe per request.
 */
const POST_FAILURE_PROBE_MIN_MS = 60_000;
const POST_FAILURE_PROBE_CLAIM_SQL = `UPDATE secondary_budget
   SET updated_at = ?1
 WHERE id = 1 AND ?1 - checked_at >= ?2`;

/** The nine market columns plus the three book columns: BOTH halves of the compare. */
const S_OLD = `(game_lines.spread_home_tenths, game_lines.spread_home_price, game_lines.spread_away_tenths,
  game_lines.spread_away_price, game_lines.spread_book, game_lines.total_tenths, game_lines.total_over_price,
  game_lines.total_under_price, game_lines.total_book, game_lines.ml_home_price, game_lines.ml_away_price,
  game_lines.ml_book)`;
const S_NEW = `(excluded.spread_home_tenths, excluded.spread_home_price, excluded.spread_away_tenths,
  excluded.spread_away_price, excluded.spread_book, excluded.total_tenths, excluded.total_over_price,
  excluded.total_under_price, excluded.total_book, excluded.ml_home_price, excluded.ml_away_price,
  excluded.ml_book)`;

/**
 * (S1) The secondary's OWN upsert (PLAN.md §21.3): a book change alone is a
 * write, and advances `captured_at`. Used only when at least one market is
 * non-null.
 */
const SECONDARY_LINE_UPSERT_SQL = `
INSERT INTO game_lines (
  game_id, provider, spread_home_tenths, spread_home_price, spread_away_tenths,
  spread_away_price, spread_book, total_tenths, total_over_price, total_under_price,
  total_book, ml_home_price, ml_away_price, ml_book, captured_at, seen_at
) VALUES (?, '${LINE_PROVIDER_SECONDARY}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id, provider) DO UPDATE SET
  spread_home_tenths = excluded.spread_home_tenths,
  spread_home_price  = excluded.spread_home_price,
  spread_away_tenths = excluded.spread_away_tenths,
  spread_away_price  = excluded.spread_away_price,
  spread_book        = excluded.spread_book,
  total_tenths       = excluded.total_tenths,
  total_over_price   = excluded.total_over_price,
  total_under_price  = excluded.total_under_price,
  total_book         = excluded.total_book,
  ml_home_price      = excluded.ml_home_price,
  ml_away_price      = excluded.ml_away_price,
  ml_book            = excluded.ml_book,
  captured_at = CASE WHEN ${S_OLD} IS NOT ${S_NEW} THEN excluded.captured_at ELSE game_lines.captured_at END,
  seen_at = excluded.seen_at
WHERE ${S_OLD} IS NOT ${S_NEW}
   OR game_lines.seen_at < excluded.seen_at - ${String(LINE_SEEN_TOUCH_MS)}`;

/**
 * (S2) The all-null case is an UPDATE that cannot create a row: a never-priced
 * game must not get a fresh empty row and start reading as "stale".
 */
const SECONDARY_LINE_BLANK_SQL = `
UPDATE game_lines
   SET spread_home_tenths = NULL, spread_home_price = NULL, spread_away_tenths = NULL,
       spread_away_price = NULL, spread_book = NULL, total_tenths = NULL,
       total_over_price = NULL, total_under_price = NULL, total_book = NULL,
       ml_home_price = NULL, ml_away_price = NULL, ml_book = NULL,
       captured_at = ?2, seen_at = ?2
 WHERE game_id = ?1 AND provider = '${LINE_PROVIDER_SECONDARY}'
   AND (spread_home_tenths IS NOT NULL OR total_tenths IS NOT NULL OR ml_home_price IS NOT NULL)`;

const STAMP_SQL = `UPDATE games SET secondary_tried_at = ?2 WHERE id = ?1`;

/* ------------------------------------------------------------------ *
 * The budget row
 * ------------------------------------------------------------------ */

interface BudgetRow {
  remaining_credits: number;
  checked_at: number;
  last_attempt_at: number;
  nfl_last_sweep_at: number;
  ncaaf_last_sweep_at: number;
  cooldown_until: number;
  consecutive_failures: number;
  last_status: string | null;
}

async function readBudget(env: Env): Promise<BudgetRow | null> {
  return env.DB.prepare('SELECT * FROM secondary_budget WHERE id = 1').first<BudgetRow>();
}

/** The doubling cooldown, capped. `failuresSoFar` is the count BEFORE this one. */
export function cooldownFor(failuresSoFar: number): number {
  let ms = ODDS_API_COOLDOWN_MS;
  for (let i = 0; i < failuresSoFar && ms < ODDS_API_COOLDOWN_MAX_MS; i += 1) ms *= 2;
  return ms < ODDS_API_COOLDOWN_MAX_MS ? ms : ODDS_API_COOLDOWN_MAX_MS;
}

/** Copy the provider's balance into the row after a 2xx. Only ever raises it from a header. */
async function recordCredits(
  env: Env,
  credits: OddsApiCredits,
  now: EpochMs,
  extra: 'success' | 'probe-only',
): Promise<number> {
  const sets =
    extra === 'success'
      ? `remaining_credits = COALESCE(?1, remaining_credits), checked_at = CASE WHEN ?1 IS NULL THEN checked_at ELSE ?2 END,
         consecutive_failures = 0, last_status = 'ok', last_error = NULL, updated_at = ?2`
      : `remaining_credits = COALESCE(?1, remaining_credits), checked_at = CASE WHEN ?1 IS NULL THEN checked_at ELSE ?2 END,
         updated_at = ?2`;
  const res = await env.DB.prepare(`UPDATE secondary_budget SET ${sets} WHERE id = 1`)
    .bind(credits.remaining, now)
    .run();
  return rowsWrittenOf(res);
}

/**
 * (a) The reset probe, while the reserve is blocking: at most one per
 * `ODDS_API_BUDGET_PROBE_MS`, free, and the only way the monthly reset is
 * noticed without month arithmetic. A 2xx also clears `consecutive_failures`.
 */
async function maybeResetProbe(env: Env, cfg: OddsApiConfig, now: EpochMs): Promise<number> {
  const claim = await env.DB.prepare(RESET_PROBE_CLAIM_SQL)
    .bind(now, ODDS_API_BUDGET_PROBE_MS)
    .run();
  if (claim.meta.changes !== 1) return 0;
  let rows = rowsWrittenOf(claim);
  const probe = await fetchCredits(cfg, now);
  if (probe.ok) {
    rows += await recordCredits(env, probe.credits, now, 'probe-only');
    const clear = await env.DB.prepare(
      'UPDATE secondary_budget SET consecutive_failures = 0, updated_at = ?1 WHERE id = 1',
    )
      .bind(now)
      .run();
    rows += rowsWrittenOf(clear);
  }
  return rows;
}

/**
 * (b) The post-failure probe: replace the pessimistic debit with the provider's
 * own number. Exempt from the daily throttle and the cooldown; never touches
 * `last_attempt_at` or `consecutive_failures`.
 */
async function postFailureProbe(env: Env, cfg: OddsApiConfig, now: EpochMs): Promise<number> {
  const claim = await env.DB.prepare(POST_FAILURE_PROBE_CLAIM_SQL)
    .bind(now, POST_FAILURE_PROBE_MIN_MS)
    .run();
  if (claim.meta.changes !== 1) return 0;
  let rows = rowsWrittenOf(claim);
  const probe = await fetchCredits(cfg, now);
  if (probe.ok) rows += await recordCredits(env, probe.credits, now, 'probe-only');
  return rows;
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

interface CandidateRow {
  id: string;
  kickoff_at: number;
  home_name: string;
  away_name: string;
  short_name: string;
  secondary_tried_at: number | null;
  provider: string | null;
  spread_home_tenths: number | null;
  spread_home_price: number | null;
  spread_away_tenths: number | null;
  spread_away_price: number | null;
  spread_book: string | null;
  total_tenths: number | null;
  total_over_price: number | null;
  total_under_price: number | null;
  total_book: string | null;
  ml_home_price: number | null;
  ml_away_price: number | null;
  ml_book: string | null;
  captured_at: number | null;
  seen_at: number | null;
}

interface Candidate {
  readonly match: MatchCandidate;
  readonly triedAt: number | null;
  readonly line: EffectiveLine | null;
  readonly gapped: boolean;
}

const CANDIDATES_SQL = `
SELECT g.id, g.kickoff_at, g.home_name, g.away_name, g.short_name, g.secondary_tried_at,
       l.provider, l.spread_home_tenths, l.spread_home_price, l.spread_away_tenths,
       l.spread_away_price, l.spread_book, l.total_tenths, l.total_over_price,
       l.total_under_price, l.total_book, l.ml_home_price, l.ml_away_price, l.ml_book,
       l.captured_at, l.seen_at
  FROM games g LEFT JOIN game_lines l ON l.game_id = g.id
 WHERE g.league = ?1 AND g.status = 'scheduled'
   AND g.kickoff_at > ?2 AND g.kickoff_at <= ?3
   AND (?1 = 'nfl' OR g.home_rank BETWEEN 1 AND 25 OR g.away_rank BETWEEN 1 AND 25)
 ORDER BY g.kickoff_at ASC, g.id ASC, l.provider ASC`;

function toView(r: CandidateRow): LineRowView {
  return {
    provider: r.provider ?? '',
    spreadHomeTenths: r.spread_home_tenths,
    spreadHomePrice: r.spread_home_price,
    spreadAwayTenths: r.spread_away_tenths,
    spreadAwayPrice: r.spread_away_price,
    spreadBook: r.spread_book,
    totalTenths: r.total_tenths,
    totalOverPrice: r.total_over_price,
    totalUnderPrice: r.total_under_price,
    totalBook: r.total_book,
    mlHomePrice: r.ml_home_price,
    mlAwayPrice: r.ml_away_price,
    mlBook: r.ml_book,
    capturedAt: r.captured_at ?? 0,
    seenAt: r.seen_at ?? 0,
  };
}

async function loadCandidates(env: Env, league: League, now: EpochMs): Promise<Candidate[]> {
  const rows = await queryAll<CandidateRow>(
    env.DB.prepare(CANDIDATES_SQL).bind(league, now, boardWindowEnd(league, now)),
  );
  const byGame = new Map<string, { game: CandidateRow; lines: LineRowView[] }>();
  for (const r of rows) {
    let entry = byGame.get(r.id);
    if (entry === undefined) {
      entry = { game: r, lines: [] };
      byGame.set(r.id, entry);
    }
    if (r.provider !== null && r.captured_at !== null && r.seen_at !== null)
      entry.lines.push(toView(r));
  }
  return [...byGame.values()].map(({ game, lines }) => {
    const line = mergeEffectiveLine(lines, game.kickoff_at, now);
    return {
      match: {
        gameId: game.id,
        league,
        kickoffAt: game.kickoff_at,
        homeName: game.home_name,
        awayName: game.away_name,
        label: game.short_name,
      },
      triedAt: game.secondary_tried_at,
      line,
      gapped: missingMarkets(line).any,
    };
  });
}

/** A secondary market on the board that is about to go stale. */
function needsResweep(c: Candidate, now: EpochMs): boolean {
  const markets = [c.line?.spread, c.line?.total, c.line?.moneyline];
  return markets.some(
    (m) =>
      m !== null &&
      m !== undefined &&
      m.provider.startsWith(`${LINE_PROVIDER_SECONDARY}:`) &&
      now >= m.seenAt + lineStaleAfterMs(c.match.kickoffAt, m.seenAt) - SECONDARY_RESWEEP_MARGIN_MS,
  );
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

function skipped(league: League, why: SweepSkipped): SecondarySweep {
  return {
    league,
    reason: null,
    skipped: why,
    cost: 0,
    remaining: null,
    events: 0,
    matched: 0,
    unmatchedEspn: [],
    swapped: [],
    filled: { spread: 0, total: 0, moneyline: 0 },
    stamped: 0,
    rowsWritten: 0,
    warnings: [],
    error: null,
  };
}

export async function sweepSecondary(
  env: Env,
  league: League,
  now: EpochMs,
  options: SweepOptions,
): Promise<SecondarySweep> {
  try {
    return await sweepInner(env, league, now, options);
  } catch (err) {
    // The boundary: nothing here may fail the refresh run around it.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[secondary] ${league} sweep threw:`, message);
    return {
      ...skipped(league, 'no-gap'),
      skipped: null,
      reason: 'retry',
      error: `exception: ${message.slice(0, 200)}`,
    };
  }
}

async function sweepInner(
  env: Env,
  league: League,
  now: EpochMs,
  options: SweepOptions,
): Promise<SecondarySweep> {
  const cfg = readConfig(env).oddsApi;
  if (cfg === null) return skipped(league, 'no-gap');

  // 0. One row. If the league cannot possibly sweep, never pay for the scan.
  const budget = await readBudget(env);
  if (budget === null) return skipped(league, 'no-budget-row');
  if (now < budget.cooldown_until) return skipped(league, 'cooldown');
  const lastSweep = league === 'nfl' ? budget.nfl_last_sweep_at : budget.ncaaf_last_sweep_at;
  if (now - lastSweep < SECONDARY_MIN_SWEEP_INTERVAL_MS) return skipped(league, 'throttled');
  if (budget.remaining_credits - ODDS_API_COST_PER_SWEEP < ODDS_API_CREDIT_RESERVE) {
    const rows = await maybeResetProbe(env, cfg, now);
    return { ...skipped(league, 'budget'), rowsWritten: rows };
  }

  // 1. Candidates and the three reasons.
  const candidates = await loadCandidates(env, league, now);
  const retry = candidates.some(
    (c) => c.gapped && (c.triedAt === null || now - c.triedAt >= SECONDARY_RETRY_MS),
  );
  const resweep = candidates.some((c) => needsResweep(c, now));
  const forced =
    options.force !== null && candidates.some((c) => c.match.gameId === options.force && c.gapped);
  if (!(retry || resweep || forced)) return skipped(league, 'no-gap');
  const reason: SweepReason = forced ? 'forced' : retry ? 'retry' : 'resweep';

  // 2. Claim, then call. `meta.changes === 1` is the permission.
  const claim = await env.DB.prepare(CLAIM_SQL[league])
    .bind(ODDS_API_COST_PER_SWEEP, now, ODDS_API_CREDIT_RESERVE, SECONDARY_MIN_SWEEP_INTERVAL_MS)
    .run();
  if (claim.meta.changes !== 1) {
    // Something moved between the pre-check and the claim (it cannot, under the
    // lease — but the claim is the authority). Classify from a fresh read.
    const again = await readBudget(env);
    if (again === null) return skipped(league, 'no-budget-row');
    if (now < again.cooldown_until) return skipped(league, 'cooldown');
    if (again.remaining_credits - ODDS_API_COST_PER_SWEEP < ODDS_API_CREDIT_RESERVE)
      return skipped(league, 'budget');
    return skipped(league, 'throttled');
  }
  let rowsWritten = rowsWrittenOf(claim);

  const provider = new TheOddsApiProvider(cfg);
  const result = await provider.fetchOdds(
    league,
    { fromAt: now, toAt: boardWindowEnd(league, now) },
    now,
  );

  if (!result.ok) {
    const base = {
      ...skipped(league, 'no-gap'),
      skipped: null,
      reason,
      cost: ODDS_API_COST_PER_SWEEP,
      remaining: result.credits.remaining,
      error: result.kind,
    };
    if (result.kind === 'unauthorized') {
      const res = await env.DB.prepare(
        `UPDATE secondary_budget SET last_status = 'unauthorized', last_error = ?2, updated_at = ?1 WHERE id = 1`,
      )
        .bind(now, result.error)
        .run();
      console.error(`[secondary] ${league}: unauthorized — check ODDS_API_KEY`);
      return { ...base, rowsWritten: rowsWritten + rowsWrittenOf(res) };
    }
    // rate_limited / unavailable / malformed: cooldown, doubling with the streak.
    const cooldownMs = cooldownFor(budget.consecutive_failures);
    const status = result.kind === 'rate_limited' ? 'rate_limited' : 'error';
    const res = await env.DB.prepare(
      `UPDATE secondary_budget
          SET cooldown_until = ?1 + ?2, consecutive_failures = consecutive_failures + 1,
              last_status = ?3, last_error = ?4, updated_at = ?1,
              remaining_credits = COALESCE(?5, remaining_credits),
              checked_at = CASE WHEN ?5 IS NULL THEN checked_at ELSE ?1 END
        WHERE id = 1`,
    )
      .bind(now, cooldownMs, status, result.error.slice(0, 200), result.credits.remaining)
      .run();
    rowsWritten += rowsWrittenOf(res);
    // The FREE post-failure probe replaces the pessimistic debit when the
    // failing response carried no balance.
    if (result.credits.remaining === null) rowsWritten += await postFailureProbe(env, cfg, now);
    if (result.kind === 'malformed') console.error(`[secondary] ${league}: ${result.error}`);
    return { ...base, rowsWritten };
  }

  // 3. Match, write, stamp.
  const outcome = matchOddsApiEvents(
    candidates.map((c) => c.match),
    result.events,
  );
  const filled = { spread: 0, total: 0, moneyline: 0 };
  const stmts: D1PreparedStatement[] = [];
  const touched = new Map<string, OddsApiEvent>();
  for (const c of candidates) {
    const e = outcome.matched.get(c.match.gameId);
    if (e === undefined) continue;
    touched.set(c.match.gameId, e);
    const m = e.markets;
    if (m.spread === null && m.total === null && m.moneyline === null) {
      stmts.push(env.DB.prepare(SECONDARY_LINE_BLANK_SQL).bind(c.match.gameId, now));
      continue;
    }
    if (c.gapped) {
      const gaps = missingMarkets(c.line);
      if (gaps.spread && m.spread !== null) filled.spread += 1;
      if (gaps.total && m.total !== null) filled.total += 1;
      if (gaps.moneyline && m.moneyline !== null) filled.moneyline += 1;
    }
    stmts.push(
      env.DB.prepare(SECONDARY_LINE_UPSERT_SQL).bind(
        c.match.gameId,
        m.spread?.homeTenths ?? null,
        m.spread?.homePrice ?? null,
        m.spread?.awayTenths ?? null,
        m.spread?.awayPrice ?? null,
        m.spread?.book ?? null,
        m.total?.tenths ?? null,
        m.total?.overPrice ?? null,
        m.total?.underPrice ?? null,
        m.total?.book ?? null,
        m.moneyline?.homePrice ?? null,
        m.moneyline?.awayPrice ?? null,
        m.moneyline?.book ?? null,
        now,
        now,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 40) {
    const results = await env.DB.batch(stmts.slice(i, i + 40));
    for (const r of results) rowsWritten += rowsWrittenOf(r);
  }

  // Stamp the games that are STILL gapped after the writes, and only those.
  const after = await loadCandidates(env, league, now);
  const stamps = after
    .filter((c) => c.gapped)
    .map((c) => env.DB.prepare(STAMP_SQL).bind(c.match.gameId, now));
  for (let i = 0; i < stamps.length; i += 40) {
    const results = await env.DB.batch(stamps.slice(i, i + 40));
    for (const r of results) rowsWritten += rowsWrittenOf(r);
  }

  rowsWritten += await recordCredits(env, result.credits, now, 'success');

  return {
    league,
    reason,
    skipped: null,
    cost: ODDS_API_COST_PER_SWEEP,
    remaining: result.credits.remaining,
    events: result.events.length,
    matched: outcome.matched.size,
    unmatchedEspn: outcome.unmatchedGames.slice(0, ESPN_MAX_WARNINGS_RECORDED),
    swapped: outcome.swappedCandidates.slice(0, ESPN_MAX_WARNINGS_RECORDED),
    filled,
    stamped: stamps.length,
    rowsWritten,
    warnings: result.warnings
      .slice(0, ESPN_MAX_WARNINGS_RECORDED)
      .map((w) => (w.label === null ? w.reason : `${w.label}: ${w.reason}`)),
    error: null,
  };
}

/** Unused-import guard for the match window: the matcher owns it, the sweep reports it. */
export const SWEEP_MATCH_WINDOW_MS = SECONDARY_MATCH_WINDOW_MS;
