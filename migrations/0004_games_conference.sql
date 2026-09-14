-- SpicyBettingSimulator — 0004: conference per team on games
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1).
--
-- ESPN's CFB scoreboard carries `competitors[].team.conferenceId` (a numeric
-- string: 8 = SEC, 5 = Big Ten, ...). It is stored denormalized next to the
-- other team fields so the board can be filtered by conference without a
-- second table or a second request (PLAN.md §12.1). NULL for the NFL, whose
-- competitors carry no conferenceId, and for any CFB payload that omits it.
-- Two nullable ADD COLUMNs: metadata-only, safe on the populated remote table.
-- Ingestion's live update (B) writes them alongside rank and logo, so a
-- mid-season realignment is picked up on the next refresh.

ALTER TABLE games ADD COLUMN home_conference_id TEXT NULL;
ALTER TABLE games ADD COLUMN away_conference_id TEXT NULL;
