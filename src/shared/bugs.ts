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
 * A table cell rendered as an inline code span, made ESCAPE-FREE rather than
 * escaped: a backtick would close the span (and let a mention, an issue
 * reference or a link render), a pipe would split the row, a backslash is what
 * an escape-unaware table parser could trip on, and a newline ends the table.
 * Each is swapped for a look-alike — apostrophe, broken bar, set-minus, space
 * — so the cell contains nothing any markdown renderer treats as syntax, and
 * there is no "which renderer variant" to reason about. A missing value is a
 * plain dash, outside any span.
 */
function cell(text: string | null): string {
  if (text === null || text === '') return '—';
  const safe = text
    .replace(/`/g, "'")
    .replace(/\\/g, '∖')
    .replace(/\|/g, '¦')
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
    '## Diagnostics',
    '',
    ...(input.diagnostics === null
      ? ['_No diagnostics were attached._']
      : ['```text', fence(input.diagnostics), '```']),
    '',
    '_Filed automatically from the in-app "Report a bug" form. The diagnostics block is the ' +
      "browser's own log of recent errors, API calls and page changes; see PLAN.md §11.7._",
  ].join('\n');
  return {
    title: `${BUG_ISSUE_TITLE_PREFIX}${input.title}`,
    body,
    labels: BUG_ISSUE_LABELS,
  };
}
