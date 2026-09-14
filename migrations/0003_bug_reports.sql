-- SpicyBettingSimulator — 0003: user-filed bug reports
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1).
--
-- `POST /api/bugs` writes one row here FIRST and files a GitHub issue SECOND
-- (PLAN.md §11.7). The row is the durable record: if GitHub is down or the token
-- has been revoked the report is still kept (`error` says why, `issue_number`
-- stays NULL) and `GET /api/admin/bugs` shows it. The row is also the rate
-- limit — the INSERT's guard counts this user's rows in the last hour — so no
-- separate throttle table is needed.
--
-- ON DELETE RESTRICT, like every other per-user table: a user is soft-deleted
-- (0002), never removed, so this can never fire; it documents the intent.
-- All timestamps are epoch milliseconds UTC (CLAUDE.md rule 3).

CREATE TABLE bug_reports (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  page         TEXT    NULL,
  user_agent   TEXT    NULL,
  app_version  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Set once the GitHub issue exists; NULL with `error` set when filing failed.
  issue_number INTEGER NULL,
  issue_url    TEXT    NULL,
  error        TEXT    NULL
);

-- The rate-limit guard: this user's reports in the trailing window.
CREATE INDEX idx_bug_reports_user_created ON bug_reports (user_id, created_at);
-- The admin list, newest first.
CREATE INDEX idx_bug_reports_created ON bug_reports (created_at);
