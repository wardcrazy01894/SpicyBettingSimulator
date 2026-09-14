-- SpicyBettingSimulator — 0006: client diagnostics on bug reports
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1).
--
-- The "Report a bug" form now attaches the browser's diagnostics log — recent
-- uncaught errors, console errors, API calls with status and timing, route
-- changes, viewport, app version (PLAN.md §11.7). It is stored with the report
-- so the admin page can show it when GitHub refused the issue, exactly like the
-- description. Bounded to BUG_REPORT_DIAGNOSTICS_MAX chars by the validator.
-- One nullable ADD COLUMN: metadata-only, safe on the populated remote table.

ALTER TABLE bug_reports ADD COLUMN diagnostics TEXT NULL;
