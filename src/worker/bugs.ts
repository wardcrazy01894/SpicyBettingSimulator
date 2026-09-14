/**
 * Bug reports: store the row, file the GitHub issue. PLAN.md §11.7.
 *
 * Order matters and is deliberate — ROW FIRST, ISSUE SECOND:
 *   1. INSERT into `bug_reports`, guarded by the per-user rate limit in the
 *      statement itself (`WHERE (SELECT COUNT(*) …) < N`), never as a separate
 *      read (CLAUDE.md rule 5). `meta.changes === 0` is the 429.
 *   2. POST to GitHub. On success the row gets `issue_number`/`issue_url`; on
 *      any failure it gets `error` and the caller sees 503 — but the report is
 *      KEPT, which is the whole point of writing it first. An admin can read it
 *      off `GET /api/admin/bugs` and file it by hand.
 *
 * The GitHub call is the ONLY outbound request this module makes, and the token
 * never leaves this file: it is read from config and put in one header.
 */

import type {
  AdminBugReportsResponse,
  BugReportResponse,
  BugReportView,
} from '../shared/api-types.js';
import { formatBugIssue } from '../shared/bugs.js';
import { BUG_REPORTS_PER_WINDOW, BUG_REPORT_WINDOW_MS } from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { BugReportInput } from '../shared/validate.js';
import { newId } from './db.js';
import type { Env, GitHubConfig, RuntimeConfig } from './env.js';

/** Give GitHub this long; the Worker's own request budget is 30 s wall clock. */
export const GITHUB_TIMEOUT_MS = 8_000;

/** The User-Agent GitHub requires on every API call (it 403s without one). */
export const GITHUB_USER_AGENT =
  'spicybetting-worker (+https://github.com/wardcrazy01894/SpicyBettingSimulator)';

/** `GET /api/admin/bugs` shows this many, newest first. */
export const ADMIN_BUG_HISTORY = 50;

export interface CreateBugReportArgs {
  readonly user: UserSummary;
  readonly input: BugReportInput;
  readonly userAgent: string | null;
  readonly now: EpochMs;
}

/**
 * @throws AppError UPSTREAM_UNAVAILABLE when the feature is off or GitHub failed;
 *                  RATE_LIMITED past `BUG_REPORTS_PER_WINDOW` in the trailing window.
 */
export async function createBugReport(
  env: Env,
  config: RuntimeConfig,
  args: CreateBugReportArgs,
): Promise<BugReportResponse> {
  if (config.github === null) {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Bug reporting is not set up on this server.');
  }
  const { user, input, userAgent, now } = args;
  const id = newId();

  // The guard and the write are ONE statement. A user at the limit gets
  // `changes: 0`, and two concurrent requests cannot both slip under it because
  // D1 serialises writes.
  const inserted = await env.DB.prepare(
    `INSERT INTO bug_reports
       (id, user_id, title, description, page, user_agent, app_version, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
     WHERE (SELECT COUNT(*) FROM bug_reports
             WHERE user_id = ?2 AND created_at > ?8 - ?9) < ?10`,
  )
    .bind(
      id,
      user.id,
      input.title,
      input.description,
      input.page,
      userAgent,
      config.appVersion,
      now,
      BUG_REPORT_WINDOW_MS,
      BUG_REPORTS_PER_WINDOW,
    )
    .run();
  if (inserted.meta.changes === 0) {
    throw new AppError(
      'RATE_LIMITED',
      `You can file ${String(BUG_REPORTS_PER_WINDOW)} bug reports an hour. Try again later.`,
      { limit: BUG_REPORTS_PER_WINDOW, windowMs: BUG_REPORT_WINDOW_MS },
    );
  }

  const issue = formatBugIssue(input, {
    username: user.username,
    appVersion: config.appVersion,
    reportedAt: now,
    userAgent,
  });

  let filed: { number: number; url: string };
  try {
    filed = await fileIssue(config.github, issue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bugs] GitHub issue failed', id, message);
    await env.DB.prepare('UPDATE bug_reports SET error = ?2 WHERE id = ?1')
      .bind(id, message.slice(0, 500))
      .run();
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Could not reach GitHub. Your report was saved and an admin can see it.',
      { reportId: id },
    );
  }

  await env.DB.prepare('UPDATE bug_reports SET issue_number = ?2, issue_url = ?3 WHERE id = ?1')
    .bind(id, filed.number, filed.url)
    .run();
  return { id, issueNumber: filed.number, issueUrl: filed.url };
}

/** One POST to the Issues API. Throws on non-2xx, timeout, or a bodyless 201. */
async function fileIssue(
  github: GitHubConfig,
  issue: { title: string; body: string; labels: readonly string[] },
): Promise<{ number: number; url: string }> {
  const url = `${github.apiBaseUrl}/repos/${github.repo}/issues`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${github.token}`,
      'Content-Type': 'application/json',
      'User-Agent': GITHUB_USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title: issue.title, body: issue.body, labels: [...issue.labels] }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Never log the body: GitHub echoes request fields on 422 and that is the
    // reporter's text, not something the log needs.
    throw new Error(`GitHub responded ${String(response.status)}`);
  }
  const parsed: unknown = await response.json();
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { number?: unknown }).number !== 'number' ||
    typeof (parsed as { html_url?: unknown }).html_url !== 'string'
  ) {
    throw new Error('GitHub responded without an issue number');
  }
  const body = parsed as { number: number; html_url: string };
  return { number: body.number, url: body.html_url };
}

interface BugReportRow {
  readonly id: string;
  readonly user_id: string;
  readonly username: string;
  readonly title: string;
  readonly description: string;
  readonly page: string | null;
  readonly app_version: string;
  readonly created_at: number;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly error: string | null;
}

/** Newest first, capped at `ADMIN_BUG_HISTORY`. Includes rows GitHub refused. */
export async function listBugReports(env: Env): Promise<AdminBugReportsResponse> {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.user_id, u.username, b.title, b.description, b.page, b.app_version,
            b.created_at, b.issue_number, b.issue_url, b.error
       FROM bug_reports b JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?1`,
  )
    .bind(ADMIN_BUG_HISTORY)
    .all<BugReportRow>();
  const reports: BugReportView[] = rows.results.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    title: r.title,
    description: r.description,
    page: r.page,
    appVersion: r.app_version,
    createdAt: r.created_at,
    issueNumber: r.issue_number,
    issueUrl: r.issue_url,
    error: r.error,
  }));
  return { reports };
}
