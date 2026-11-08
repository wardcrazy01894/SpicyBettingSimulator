-- SpicyBettingSimulator — 0012: the poison-target guard, sharding groundwork,
-- and the alerts table (PLAN.md §24.6b; its CREATE TABLE follows these ALTERs)
-- D1 (SQLite). A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1).
--
-- attempt_started_at / incomplete_attempts: stamped immediately before THAT
-- target's own fetch, reset by BOTH reschedule paths, so only the target in
-- flight when a run is killed is left raised. PLAN.md §24.4.
-- last_ok_at: written by the success path only; NULL = size unknown (§24.7).
-- conference_id: NULL for every target the planner emits today; the scoping SQL
-- that reads it is PLAN.md §24.8.
--
-- No rebuild: four plain ADD COLUMNs and one new table. Like every migration
-- before it, this file is FROZEN once the Deploy workflow has applied it to the
-- remote D1: a later change is 0013, not an edit here.
ALTER TABLE ingest_targets ADD COLUMN attempt_started_at  INTEGER;
ALTER TABLE ingest_targets ADD COLUMN incomplete_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (incomplete_attempts >= 0);
ALTER TABLE ingest_targets ADD COLUMN last_ok_at          INTEGER;
ALTER TABLE ingest_targets ADD COLUMN conference_id       TEXT;

-- In-app alerts as GitHub issues (PLAN.md §24.6b). One row per fingerprint
-- '<kind>:<key>'. Every transition is ONE guarded statement and `meta.changes`
-- is the only permission to call GitHub (CLAUDE.md rule 5).
CREATE TABLE alerts (
  fingerprint      TEXT    PRIMARY KEY,                 -- '<kind>:<key>'
  kind             TEXT    NOT NULL,
  key              TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('firing', 'resolved')),
  issue_number     INTEGER,                             -- NULL until GitHub accepted the create
  opened_at        INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  last_notified_at INTEGER NOT NULL DEFAULT 0,          -- the throttle and the claim
  resolved_at      INTEGER,                             -- non-NULL while firing = "issue is closed, reopen it"
  occurrences      INTEGER NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  pending          INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),  -- since the last notification
  comments         INTEGER NOT NULL DEFAULT 0 CHECK (comments >= 0), -- drives the comment backoff
  last_detail      TEXT                                 -- ≤ 500 chars, no stack, no secret
);
