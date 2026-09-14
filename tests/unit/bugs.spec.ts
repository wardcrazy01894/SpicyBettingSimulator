import { describe, expect, it } from 'vitest';
import { BUG_ISSUE_LABELS, BUG_ISSUE_TITLE_PREFIX, formatBugIssue } from '../../src/shared/bugs.js';

const META = {
  username: 'alex',
  appVersion: '0.1.0',
  reportedAt: Date.UTC(2026, 8, 14, 15, 30, 0),
  userAgent: 'Mozilla/5.0 (iPhone)',
};

describe('formatBugIssue', () => {
  it('prefixes the title and applies the fixed labels', () => {
    const issue = formatBugIssue(
      { title: 'Slip will not close', description: 'x'.repeat(10), page: '/bets' },
      META,
    );
    expect(issue.title).toBe(`${BUG_ISSUE_TITLE_PREFIX}Slip will not close`);
    expect(issue.labels).toEqual(BUG_ISSUE_LABELS);
    expect(issue.labels).toContain('bug');
  });

  it('puts the description in a fenced block and the context in a table', () => {
    const issue = formatBugIssue(
      {
        title: 't',
        description: 'Tapped Place bet and nothing happened.',
        page: '/games?league=nfl',
      },
      META,
    );
    expect(issue.body).toContain('```text\nTapped Place bet and nothing happened.\n```');
    expect(issue.body).toContain('| Reported by | `alex` |');
    expect(issue.body).toContain('| Page | `/games?league=nfl` |');
    expect(issue.body).toContain('| App version | `0.1.0` |');
    expect(issue.body).toContain('| Reported at | 2026-09-14T15:30:00.000Z |');
    expect(issue.body).toContain('| User agent | `Mozilla/5.0 (iPhone)` |');
  });

  it('neutralises a closing fence inside the description', () => {
    const issue = formatBugIssue(
      { title: 't', description: 'before\n```\n@octocat #1 <script>\n```\nafter', page: null },
      META,
    );
    // Exactly one opening and one closing fence: ours.
    expect(issue.body.match(/^```/gm)).toHaveLength(2);
    expect(issue.body).toContain('` ` `');
  });

  it('renders a missing page and user agent as a bare dash, and swaps pipes and backslashes', () => {
    const issue = formatBugIssue(
      { title: 't', description: 'y'.repeat(10), page: null },
      { ...META, userAgent: 'a|b\\|c\\\\d' },
    );
    expect(issue.body).toContain('| Page | — |');
    expect(issue.body).toContain('| User agent | `a¦b∖¦c∖∖d` |');
    // The context table has no character a table or code-span parser escapes on.
    const table = issue.body.slice(issue.body.indexOf('## Context'));
    expect(table).not.toMatch(/\\/);
    for (const line of table.split('\n').filter((l) => l.startsWith('| '))) {
      expect(line.split('|')).toHaveLength(4); // "| a | b |" -> ['', ' a ', ' b ', '']
    }
  });

  it('puts the user agent in a code span and swaps its backticks, so it cannot become markup', () => {
    // The User-Agent header is attacker-controlled: a curl caller can send anything.
    const issue = formatBugIssue(
      { title: 't', description: 'y'.repeat(10), page: null },
      { ...META, userAgent: 'x` cc @someone see #1 [pay](https://evil.example) `y' },
    );
    expect(issue.body).toContain(
      "| User agent | `x' cc @someone see #1 [pay](https://evil.example) 'y` |",
    );
    // No backtick from the input survives — only the two the cell adds.
    const line = issue.body.split('\n').find((l) => l.startsWith('| User agent |')) ?? '';
    expect(line.match(/`/g)).toHaveLength(2);
  });

  it('swaps backticks in page and username the same way', () => {
    const issue = formatBugIssue(
      { title: 't', description: 'y'.repeat(10), page: '/bets`@x`y' },
      { ...META, username: 'al`ex' },
    );
    expect(issue.body).toContain("| Page | `/bets'@x'y` |");
    expect(issue.body).toContain("| Reported by | `al'ex` |");
  });
});
