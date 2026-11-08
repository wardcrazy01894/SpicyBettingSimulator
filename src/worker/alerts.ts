/**
 * In-app alerts as GitHub issues, deduplicated and throttled. PLAN.md §24.6b.
 *
 * The owner's requirement: an email when something fails, and no spam. A new
 * GitHub issue IS the email (the issue body @mentions `ALERT_MENTION_LOGIN`,
 * because GitHub never notifies the token's own account), and the transport is
 * the bug-report client in `bugs.ts`, extended rather than forked.
 *
 * NON-NEGOTIABLES (CLAUDE.md rule 8i (iii), rule 5):
 *   * EVERY GitHub call is permitted ONLY by `meta.changes` on a guarded
 *     `alerts` UPDATE — the claim. No read-then-write anywhere, so two jobs
 *     evaluating in the same minute cannot double-post.
 *   * Alerts NEVER fail a job. `evaluateAlerts` runs after the run's own
 *     `job_runs` row is finalised and its lease released, catches everything,
 *     and only logs.
 *   * No `GITHUB_TOKEN` → no call at all; occurrences are still recorded and the
 *     run reports `alerts.enabled: false`.
 *
 * The five transitions, each ONE statement:
 *   1. occurrence  INSERT … ON CONFLICT DO UPDATE (reopen-vs-new decided by CASEs)
 *   2. create      claim `issue_number IS NULL`, POST the issue
 *   3. reopen      claim `resolved_at IS NOT NULL`, PATCH open + comment
 *   4. comment     claim `pending > 0` after the doubling interval
 *   5. resolve     `state = 'resolved'` after `ALERT_RESOLVE_AFTER_MS` quiet,
 *                  then a closing comment + PATCH closed
 * A claim moves `last_notified_at` ONLY; a failed post writes it back to 0 and
 * nothing else, so neither the pending count nor the backoff step is lost and
 * the next run retries.
 */

import {
  ALERT_COMMENT_INTERVAL_MS,
  ALERT_COMMENT_MAX_INTERVAL_MS,
  ALERT_D1_ROWS_NEAR_CAP,
  ALERT_GITHUB_LABEL,
  ALERT_GITHUB_TIMEOUT_MS,
  ALERT_MAX_GITHUB_CALLS_PER_RUN,
  ALERT_REOPEN_WINDOW_MS,
  ALERT_RESOLVE_AFTER_MS,
} from '../shared/constants.js';
import type { EpochMs } from '../shared/types.js';
import { commentOnIssue, createIssue, setIssueState } from './bugs.js';
import type { Env, GitHubConfig } from './env.js';
import { readConfig } from './env.js';
import { listParkedTargets, readIngestHealth } from './ingest.js';
import type { JobRun } from './jobs.js';

export type AlertKind =
  | 'refresh-stale'
  | 'target-parked'
  | 'job-error'
  | 'espn-status'
  | 'espn-all-failing'
  | 'settle-stuck'
  | 'secondary-budget-exhausted'
  | 'd1-rows-near-cap';

/** One condition that holds right now. Fingerprint = `${kind}:${key}`. */
export interface AlertCondition {
  readonly kind: AlertKind;
  /** `'-'` for a singleton alert. */
  readonly key: string;
  /** ≤ 500 chars once stored; no stack, no secret. */
  readonly detail: string;
}

/** What one evaluation did; rides in `job_runs.stats.alerts`. */
export interface AlertStats {
  readonly enabled: boolean;
  readonly recorded: number;
  readonly created: number;
  readonly commented: number;
  readonly reopened: number;
  readonly resolved: number;
  readonly failed: number;
}

/** Context `withJobRun` hands over beside the finished run. */
export interface AlertContext {
  /** `running` rows of this job the reaper just turned into `error` (§24.4). */
  readonly reaped?: number;
  /** Rolling-24h `dayRowsWritten` (§8.6), for `d1-rows-near-cap`. Refresh only. */
  readonly dayRowsWritten?: number | null;
}

const DETAIL_MAX = 500;
const HOUR_MS = 60 * 60 * 1000;

/** `5xx`/`timeout`/`network`/`bad-json` alert only on a streak: a blip is not an email. */
const ESPN_STREAK_OUTCOMES = new Set(['5xx', 'timeout', 'network', 'bad-json']);
const ESPN_STREAK_MIN = 3;
/** 403 and 429 are a regime signal (an edge block, a rate limit): the first one alerts. */
const ESPN_REGIME_OUTCOMES = ['403', '429'] as const;

/* ------------------------------------------------------------------ *
 * The guarded statements
 * ------------------------------------------------------------------ */

/**
 * A resolved alert recurring after the reopen window is a NEW incident: a new
 * issue, fresh counters. `?1` = now. Shared by every CASE of the occurrence
 * upsert so they cannot disagree.
 */
const NEW_INCIDENT = `(alerts.state = 'resolved'
   AND alerts.resolved_at < ?1 - ${String(ALERT_REOPEN_WINDOW_MS)})`;

/**
 * Transition 1, the occurrence. `?1` now, `?2` fingerprint, `?3` kind, `?4` key,
 * `?5` detail. A recurrence inside the reopen window keeps `issue_number` and
 * `resolved_at` — the "reopen it" marker; after it, the CASEs start over.
 */
const OCCURRENCE_SQL = `
INSERT INTO alerts (fingerprint, kind, key, state, issue_number, opened_at, last_seen_at,
                    last_notified_at, resolved_at, occurrences, pending, comments, last_detail)
VALUES (?2, ?3, ?4, 'firing', NULL, ?1, ?1, 0, NULL, 1, 1, 0, ?5)
ON CONFLICT(fingerprint) DO UPDATE SET
  state            = 'firing',
  issue_number     = CASE WHEN ${NEW_INCIDENT} THEN NULL ELSE alerts.issue_number END,
  resolved_at      = CASE WHEN ${NEW_INCIDENT} THEN NULL ELSE alerts.resolved_at END,
  opened_at        = CASE WHEN ${NEW_INCIDENT} THEN ?1 ELSE alerts.opened_at END,
  last_notified_at = CASE WHEN ${NEW_INCIDENT} THEN 0 ELSE alerts.last_notified_at END,
  occurrences      = CASE WHEN ${NEW_INCIDENT} THEN 1 ELSE alerts.occurrences + 1 END,
  pending          = CASE WHEN ${NEW_INCIDENT} THEN 1 ELSE alerts.pending + 1 END,
  comments         = CASE WHEN ${NEW_INCIDENT} THEN 0 ELSE alerts.comments END,
  last_seen_at     = ?1,
  last_detail      = ?5`;

/** Quiet for the resolve window (`?1` = now). */
const QUIET = `last_seen_at <= ?1 - ${String(ALERT_RESOLVE_AFTER_MS)}`;
const NOT_QUIET = `last_seen_at > ?1 - ${String(ALERT_RESOLVE_AFTER_MS)}`;
/** The create/reopen throttle (`?1` = now). */
const THROTTLE_OPEN = `last_notified_at <= ?1 - ${String(ALERT_COMMENT_INTERVAL_MS)}`;
/** The comment throttle: 1 h doubling per comment on this issue, capped at 24 h. */
const THROTTLE_COMMENT = `last_notified_at <= ?1 - MIN(${String(ALERT_COMMENT_INTERVAL_MS)} * (1 << MIN(comments, 10)),
                                         ${String(ALERT_COMMENT_MAX_INTERVAL_MS)})`;

/** Each claim: `?1` now, `?2` fingerprint. Moves `last_notified_at` ONLY. */
const CLAIM_SQL: Readonly<Record<'create' | 'reopen' | 'comment', string>> = {
  create: `UPDATE alerts SET last_notified_at = ?1
            WHERE fingerprint = ?2 AND state = 'firing' AND issue_number IS NULL
              AND ${THROTTLE_OPEN}`,
  reopen: `UPDATE alerts SET last_notified_at = ?1
            WHERE fingerprint = ?2 AND state = 'firing' AND resolved_at IS NOT NULL
              AND issue_number IS NOT NULL AND ${THROTTLE_OPEN}`,
  comment: `UPDATE alerts SET last_notified_at = ?1
             WHERE fingerprint = ?2 AND state = 'firing' AND resolved_at IS NULL
               AND issue_number IS NOT NULL AND pending > 0 AND ${THROTTLE_COMMENT}`,
};

/** Transition 5 with a call: the open issue goes quiet. `?1` now, `?2` fingerprint. */
const RESOLVE_SQL = `UPDATE alerts SET state = 'resolved', resolved_at = ?1
  WHERE fingerprint = ?2 AND state = 'firing' AND issue_number IS NOT NULL
    AND resolved_at IS NULL AND ${QUIET}`;

/**
 * Transition 5 with NO call: a firing alert whose create never succeeded (or
 * whose issue is already closed, its reopen never having landed) goes quiet.
 * There is nothing on GitHub to close. `?1` now.
 */
const SILENT_RESOLVE_SQL = `UPDATE alerts SET state = 'resolved', resolved_at = COALESCE(resolved_at, ?1)
  WHERE state = 'firing' AND (issue_number IS NULL OR resolved_at IS NOT NULL) AND ${QUIET}`;

/**
 * The ONE read of due actions (§24.6b): creates first, then reopens, resolves
 * and comments. `?1` now, `?2` limit. Its predicates are the claims' own, so a
 * row it returns is one a claim can take — and the claim still decides.
 */
const DUE_SQL = `
SELECT fingerprint,
       CASE WHEN issue_number IS NULL THEN 'create'
            WHEN resolved_at IS NOT NULL THEN 'reopen'
            WHEN ${QUIET} THEN 'resolve'
            ELSE 'comment' END AS action
  FROM alerts
 WHERE state = 'firing'
   AND ((issue_number IS NULL AND ${THROTTLE_OPEN} AND ${NOT_QUIET})
     OR (issue_number IS NOT NULL AND resolved_at IS NOT NULL AND ${THROTTLE_OPEN} AND ${NOT_QUIET})
     OR (issue_number IS NOT NULL AND resolved_at IS NULL AND ${QUIET})
     OR (issue_number IS NOT NULL AND resolved_at IS NULL AND ${NOT_QUIET}
         AND pending > 0 AND ${THROTTLE_COMMENT}))
 ORDER BY CASE WHEN issue_number IS NULL THEN 0
               WHEN resolved_at IS NOT NULL THEN 1
               WHEN ${QUIET} THEN 2
               ELSE 3 END,
          opened_at, fingerprint
 LIMIT ?2`;

/** On a failed post: give the claim back, and nothing else. `?1` claim instant, `?2` fingerprint. */
const RELEASE_SQL = `UPDATE alerts SET last_notified_at = 0
  WHERE fingerprint = ?2 AND last_notified_at = ?1`;

type Action = 'create' | 'reopen' | 'comment' | 'resolve';

/** GitHub calls each action spends against `ALERT_MAX_GITHUB_CALLS_PER_RUN`. */
const ACTION_COST: Readonly<Record<Action, number>> = {
  create: 1,
  comment: 1,
  reopen: 2, // PATCH open + the comment
  resolve: 2, // the closing comment + PATCH closed
};

interface AlertDbRow {
  readonly fingerprint: string;
  readonly kind: string;
  readonly key: string;
  readonly issue_number: number | null;
  readonly opened_at: number;
  readonly last_seen_at: number;
  readonly occurrences: number;
  readonly pending: number;
  readonly last_detail: string | null;
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

function fingerprintOf(c: AlertCondition): string {
  return `${c.kind}:${c.key}`;
}

/**
 * Transition 1 for every condition that holds, in one batch. Zero statements —
 * zero rows written — when nothing holds, which is every healthy run.
 */
export async function recordAlertConditions(
  env: Env,
  now: EpochMs,
  conditions: readonly AlertCondition[],
): Promise<number> {
  if (conditions.length === 0) return 0;
  await env.DB.batch(
    conditions.map((c) =>
      env.DB.prepare(OCCURRENCE_SQL).bind(
        now,
        fingerprintOf(c),
        c.kind,
        c.key,
        c.detail.slice(0, DETAIL_MAX),
      ),
    ),
  );
  return conditions.length;
}

/* ------------------------------------------------------------------ *
 * Acting
 * ------------------------------------------------------------------ */

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function hours(ms: number): string {
  return String(ms / HOUR_MS);
}

function changed(res: D1Result): boolean {
  const changes = (res.meta as { changes?: unknown }).changes;
  return typeof changes === 'number' && changes > 0;
}

function mentionPrefix(login: string): string {
  return login === '' ? '' : `@${login}\n\n`;
}

function issueBody(row: AlertDbRow, login: string): string {
  const what = row.key === '-' ? `**${row.kind}**` : `**${row.kind}** for \`${row.key}\``;
  return [
    `${mentionPrefix(login)}${what}: first seen ${iso(row.opened_at)}, ${plural(row.occurrences, 'occurrence')} so far.`,
    '',
    `> ${row.last_detail ?? '(no detail)'}`,
    '',
    `_Raised by the app's in-app alerts (PLAN.md §24.6b). Further occurrences are added as comments,` +
      ` at most one per ${hours(ALERT_COMMENT_INTERVAL_MS)} h, doubling to ${hours(ALERT_COMMENT_MAX_INTERVAL_MS)} h;` +
      ` the issue closes itself after ${hours(ALERT_RESOLVE_AFTER_MS)} h without one._`,
  ].join('\n');
}

function occurrenceComment(row: AlertDbRow, login: string, lead: string): string {
  return (
    `${mentionPrefix(login)}${lead}${plural(row.pending, 'occurrence')} since the last comment, ` +
    `the last at ${iso(row.last_seen_at)}: ${row.last_detail ?? '(no detail)'}`
  );
}

async function readRow(env: Env, fingerprint: string): Promise<AlertDbRow | null> {
  return env.DB.prepare(
    `SELECT fingerprint, kind, key, issue_number, opened_at, last_seen_at, occurrences, pending,
            last_detail
       FROM alerts WHERE fingerprint = ?1`,
  )
    .bind(fingerprint)
    .first<AlertDbRow>();
}

type Outcome = 'done' | 'lost' | 'failed';

/**
 * One due action: claim, call, settle the row. The claim's `meta.changes` is
 * the ONLY permission to call GitHub; a lost claim means another evaluation
 * got there first and this one does nothing.
 */
async function act(
  env: Env,
  github: GitHubConfig,
  login: string,
  now: EpochMs,
  fingerprint: string,
  action: Action,
): Promise<Outcome> {
  if (action === 'resolve') {
    if (!changed(await env.DB.prepare(RESOLVE_SQL).bind(now, fingerprint).run())) return 'lost';
    const row = await readRow(env, fingerprint);
    const issueNumber = row?.issue_number ?? null;
    if (row === null || issueNumber === null) return 'done';
    try {
      await commentOnIssue(
        github,
        issueNumber,
        `Quiet for ${hours(ALERT_RESOLVE_AFTER_MS)} h, closing. ${plural(row.occurrences, 'occurrence')} in all, the last at ${iso(row.last_seen_at)}.`,
        ALERT_GITHUB_TIMEOUT_MS,
      );
      await setIssueState(github, issueNumber, 'closed', ALERT_GITHUB_TIMEOUT_MS);
      return 'done';
    } catch (err) {
      logFailure(fingerprint, action, err);
      // Undo the resolve so the next run retries the close — unless an
      // occurrence has re-fired it meanwhile, which the guard leaves alone.
      await env.DB.prepare(
        `UPDATE alerts SET state = 'firing', resolved_at = NULL
          WHERE fingerprint = ?2 AND state = 'resolved' AND resolved_at = ?1`,
      )
        .bind(now, fingerprint)
        .run();
      return 'failed';
    }
  }

  if (!changed(await env.DB.prepare(CLAIM_SQL[action]).bind(now, fingerprint).run())) {
    return 'lost';
  }
  // Safe to read: the claim is held, so no other evaluation will post for it.
  const row = await readRow(env, fingerprint);
  if (row === null) return 'lost';
  const sent = row.pending;
  try {
    if (action === 'create') {
      const issue = await createIssue(
        github,
        {
          title: `[alert] ${row.kind}: ${row.key}`,
          body: issueBody(row, login),
          labels: [ALERT_GITHUB_LABEL],
        },
        ALERT_GITHUB_TIMEOUT_MS,
      );
      // Subtract what the post reported rather than zeroing, so occurrences that
      // arrived during the call still count toward the next comment.
      await env.DB.prepare(
        `UPDATE alerts SET issue_number = ?2, resolved_at = NULL, pending = MAX(pending - ?3, 0)
          WHERE fingerprint = ?1`,
      )
        .bind(fingerprint, issue.number, sent)
        .run();
      return 'done';
    }
    const number = row.issue_number;
    if (number === null) throw new Error('claimed an alert with no issue');
    if (action === 'reopen') {
      await setIssueState(github, number, 'open', ALERT_GITHUB_TIMEOUT_MS);
      await commentOnIssue(
        github,
        number,
        occurrenceComment(row, login, 'Reopened: the condition came back. '),
        ALERT_GITHUB_TIMEOUT_MS,
      );
      await env.DB.prepare(
        `UPDATE alerts SET resolved_at = NULL, pending = MAX(pending - ?2, 0) WHERE fingerprint = ?1`,
      )
        .bind(fingerprint, sent)
        .run();
      return 'done';
    }
    await commentOnIssue(
      github,
      number,
      occurrenceComment(row, login, ''),
      ALERT_GITHUB_TIMEOUT_MS,
    );
    await env.DB.prepare(
      `UPDATE alerts SET pending = MAX(pending - ?2, 0), comments = comments + 1
        WHERE fingerprint = ?1`,
    )
      .bind(fingerprint, sent)
      .run();
    return 'done';
  } catch (err) {
    logFailure(fingerprint, action, err);
    await env.DB.prepare(RELEASE_SQL).bind(now, fingerprint).run();
    return 'failed';
  }
}

function logFailure(fingerprint: string, action: Action, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error('[alert] GitHub call failed', fingerprint, action, message.slice(0, 200));
}

/**
 * Transitions 2–5 for whatever is due, within `ALERT_MAX_GITHUB_CALLS_PER_RUN`
 * calls. The silent resolve runs first and always, token or not.
 */
export async function processAlerts(env: Env, now: EpochMs): Promise<AlertStats> {
  const config = readConfig(env);
  const github = config.github;
  const silent = await env.DB.prepare(SILENT_RESOLVE_SQL).bind(now).run();
  const silentResolved =
    typeof (silent.meta as { changes?: unknown }).changes === 'number'
      ? (silent.meta as { changes: number }).changes
      : 0;
  const counts = { created: 0, commented: 0, reopened: 0, resolved: silentResolved, failed: 0 };
  if (github === null) return { enabled: false, recorded: 0, ...counts };

  const due = await env.DB.prepare(DUE_SQL)
    .bind(now, ALERT_MAX_GITHUB_CALLS_PER_RUN)
    .all<{ fingerprint: string; action: Action }>();
  let budget = ALERT_MAX_GITHUB_CALLS_PER_RUN;
  for (const { fingerprint, action } of due.results) {
    const cost = ACTION_COST[action];
    if (cost > budget) break; // the rest waits for the next run
    budget -= cost;
    const outcome = await act(env, github, config.alertMentionLogin, now, fingerprint, action);
    if (outcome === 'failed') counts.failed += 1;
    if (outcome !== 'done') continue;
    if (action === 'create') counts.created += 1;
    else if (action === 'comment') counts.commented += 1;
    else if (action === 'reopen') counts.reopened += 1;
    else counts.resolved += 1;
  }
  return { enabled: true, recorded: 0, ...counts };
}

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The conditions that hold after `run`, per §24.6b's "evaluated by" column:
 * `job-error` for every job about itself; `refresh-stale` for all three (a
 * killed refresh cannot alert about itself, so SETTLE is what notices);
 * `target-parked` and `espn-all-failing` for refresh and settle; ESPN status,
 * the secondary budget and the D1 write cap for refresh; `settle-stuck` for
 * settle — ONE fingerprint however many bets are stuck.
 */
async function conditionsFor(
  env: Env,
  now: EpochMs,
  run: JobRun,
  context: AlertContext,
): Promise<AlertCondition[]> {
  const job = run.job;
  const out: AlertCondition[] = [];
  if (run.status === 'error') {
    out.push({
      kind: 'job-error',
      key: job,
      detail: `${job} run ${run.id} recorded error: ${run.error ?? '(no message)'}`,
    });
  }
  const reaped = context.reaped ?? 0;
  if (reaped > 0) {
    out.push({
      kind: 'job-error',
      key: job,
      detail: `${plural(reaped, `${job} run`)} never finished: killed (CPU or wall limit) or crashed`,
    });
  }

  const health = await readIngestHealth(env, now);
  if (health.reasons.includes('refresh-stale')) {
    out.push({
      kind: 'refresh-stale',
      key: '-',
      detail:
        health.lastRefreshOkAt === null
          ? 'no refresh run has ever recorded ok'
          : `no refresh run has recorded ok since ${iso(health.lastRefreshOkAt)}`,
    });
  }

  if (job === 'refresh' || job === 'settle') {
    if (health.parkedTargets > 0) {
      for (const p of await listParkedTargets(env)) {
        out.push({
          kind: 'target-parked',
          key: p.targetId,
          detail: `${plural(p.incompleteAttempts, 'incomplete attempt')}, the last started ${
            p.attemptStartedAt === null ? 'at an unknown time' : iso(p.attemptStartedAt)
          }`,
        });
      }
    }
    if (health.reasons.includes('espn-all-failing')) {
      out.push({
        kind: 'espn-all-failing',
        key: '-',
        detail: 'every ingest target that has been fetched reports an error, and none is ok',
      });
    }
  }

  const stats = record(run.stats);
  if (job === 'refresh') {
    const espn = record(stats['espnStatus']);
    for (const status of ESPN_REGIME_OUTCOMES) {
      const n = num(espn[status]);
      if (n > 0) {
        out.push({
          kind: 'espn-status',
          key: status,
          detail: `ESPN answered ${status} to ${plural(n, 'target fetch')} in refresh run ${run.id}`,
        });
      }
    }
    const streaks = new Map<string, string[]>();
    const failures = Array.isArray(stats['failures']) ? (stats['failures'] as unknown[]) : [];
    for (const f of failures) {
      const entry = record(f);
      const outcome = typeof entry['espn'] === 'string' ? entry['espn'] : '';
      if (!ESPN_STREAK_OUTCOMES.has(outcome)) continue;
      if (num(entry['consecutiveFailures']) < ESPN_STREAK_MIN) continue;
      const list = streaks.get(outcome) ?? [];
      list.push(
        `${String(entry['targetId'])} (${String(num(entry['consecutiveFailures']))} in a row)`,
      );
      streaks.set(outcome, list);
    }
    for (const [outcome, targets] of streaks) {
      out.push({
        kind: 'espn-status',
        key: outcome,
        detail: `ESPN ${outcome} on consecutive fetches: ${targets.join(', ')}`,
      });
    }
    if (num(record(stats['secondary'])['budgetSkipped']) > 0) {
      out.push({
        kind: 'secondary-budget-exhausted',
        key: '-',
        detail: `a secondary odds sweep was skipped for budget in refresh run ${run.id}`,
      });
    }
    const rows = context.dayRowsWritten ?? null;
    if (rows !== null && rows >= ALERT_D1_ROWS_NEAR_CAP) {
      out.push({
        kind: 'd1-rows-near-cap',
        key: '-',
        detail: `rolling-24h rows written is ${String(rows)}, at or over ${String(ALERT_D1_ROWS_NEAR_CAP)} of the 100,000 D1 cap: set REFRESH_LIVE_TICKS to 2 (PLAN.md §24.13)`,
      });
    }
  }

  if (job === 'settle') {
    const stuck = Array.isArray(stats['stuck'])
      ? (stats['stuck'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (stuck.length > 0) {
      out.push({ kind: 'settle-stuck', key: '-', detail: await stuckDetail(env, stuck) });
    }
  }
  return out;
}

/** "N bets stuck: <bet> (<games>), …", from one read of their legs. */
async function stuckDetail(env: Env, betIds: readonly string[]): Promise<string> {
  const ids = betIds.slice(0, 50);
  const placeholders = ids.map((_, i) => `?${String(i + 1)}`).join(', ');
  const legs = await env.DB.prepare(
    `SELECT bet_id, game_id FROM bet_legs WHERE bet_id IN (${placeholders}) ORDER BY bet_id, leg_index`,
  )
    .bind(...ids)
    .all<{ bet_id: string; game_id: string }>();
  const games = new Map<string, string[]>();
  for (const l of legs.results) games.set(l.bet_id, [...(games.get(l.bet_id) ?? []), l.game_id]);
  const parts = betIds.map((id) => {
    const g = games.get(id);
    return g === undefined ? id : `${id} (${g.join(', ')})`;
  });
  return `${plural(betIds.length, 'bet')} stuck past MAX_SETTLE_ATTEMPTS: ${parts.join('; ')}`;
}

/**
 * Called by `withJobRun` AFTER the run's row is final and its lease released.
 * NEVER throws: an alert that cannot be evaluated or sent is logged, counted,
 * and leaves the job's status exactly as it was.
 */
export async function evaluateAlerts(
  env: Env,
  now: EpochMs,
  run: JobRun,
  context: AlertContext = {},
): Promise<AlertStats> {
  let recorded = 0;
  try {
    const conditions = await conditionsFor(env, now, run, context);
    recorded = await recordAlertConditions(env, now, conditions);
    const acted = await processAlerts(env, now);
    const stats: AlertStats = { ...acted, recorded };
    if (alertActivity(stats)) console.warn('[alert]', run.job, run.id, JSON.stringify(stats));
    return stats;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[alert] evaluation failed', run.job, run.id, message.slice(0, 200));
    let enabled = false;
    try {
      enabled = readConfig(env).github !== null;
    } catch {
      // readConfig throwing is the job's problem, not this one's.
    }
    return { enabled, recorded, created: 0, commented: 0, reopened: 0, resolved: 0, failed: 1 };
  }
}

/** True when an evaluation recorded or did anything — the only case worth storing. */
export function alertActivity(s: AlertStats): boolean {
  return s.recorded + s.created + s.commented + s.reopened + s.resolved + s.failed > 0;
}
