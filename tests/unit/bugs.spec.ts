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
    expect(issue.body).toContain('| User agent | Mozilla/5.0 (iPhone) |');
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

  it('renders a missing page and user agent as a dash, and strips pipes from cells', () => {
    const issue = formatBugIssue(
      { title: 't', description: 'y'.repeat(10), page: null },
      { ...META, userAgent: 'a|b' },
    );
    expect(issue.body).toContain('| Page | `—` |');
    expect(issue.body).toContain('| User agent | a\\|b |');
  });
});
