/**
 * Bug report → GitHub issue, the pure half. PLAN.md §11.7.
 *
 * Platform-free so the unit project pins the exact issue text; the Worker's
 * `bugs.ts` only adds the HTTP call. Everything a reporter (or their browser)
 * supplied lands in a fenced block or an inline-code table cell, so a `#123`
 * or a `@mention` in it is rendered as text rather than as GitHub markup. The
 * one exception is the TITLE, which GitHub renders as plain text everywhere
 * and which therefore needs no escaping.
 */

import type { BugReportInput } from './validate.js';

/** Labels every user-filed issue carries, so the tracker can filter them. */
export const BUG_ISSUE_LABELS: readonly string[] = ['bug', 'user-report'];

/** Prefix on every filed title, so a glance at the issue list says who wrote it. */
export const BUG_ISSUE_TITLE_PREFIX = '[user report] ';

export interface BugIssueMeta {
  readonly username: string;
  readonly appVersion: string;
  /** Epoch ms; rendered as ISO-8601 UTC in the body. */
  readonly reportedAt: number;
  readonly userAgent: string | null;
}

export interface BugIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** Escape the one character that can break out of a fenced code block. */
function fence(text: string): string {
  return text.replace(/```/g, '` ` `');
}

/**
 * A table cell rendered as an inline code span: no pipes, no newlines, and no
 * backticks (a backtick would close the span and let what follows render as
 * markup — a mention, an issue reference, a link). Backslash cannot escape a
 * backtick inside a code span, so it is swapped for an apostrophe. A missing
 * value is a plain dash, outside any span.
 */
function cell(text: string | null): string {
  if (text === null || text === '') return '—';
  const safe = text
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
  return `\`${safe}\``;
}

export function formatBugIssue(input: BugReportInput, meta: BugIssueMeta): BugIssue {
  const body = [
    '## What happened',
    '',
    '```text',
    fence(input.description),
    '```',
    '',
    '## Context',
    '',
    '| | |',
    '| --- | --- |',
    `| Reported by | ${cell(meta.username)} |`,
    `| Page | ${cell(input.page)} |`,
    `| App version | ${cell(meta.appVersion)} |`,
    `| Reported at | ${new Date(meta.reportedAt).toISOString()} |`,
    `| User agent | ${cell(meta.userAgent)} |`,
    '',
    '_Filed automatically from the in-app "Report a bug" form._',
  ].join('\n');
  return {
    title: `${BUG_ISSUE_TITLE_PREFIX}${input.title}`,
    body,
    labels: BUG_ISSUE_LABELS,
  };
}
