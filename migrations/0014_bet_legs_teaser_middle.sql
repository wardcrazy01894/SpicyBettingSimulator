-- SpicyBettingSimulator — 0014: teaser middles (rebuild of bet_legs)
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1). FROZEN
-- once the Deploy workflow has applied it to the remote D1.
--
-- WHAT CHANGES. A TEASER may now hold BOTH sides of one market on one game —
-- home and away of the spread, or the over and the under of the total — a
-- "middle": the tease moves the two lines apart and both legs win when the
-- game lands between them (PLAN.md §5.2d). So
-- `UNIQUE (bet_id, game_id, market)` becomes
-- `UNIQUE (bet_id, game_id, market, side)` (the identical pick twice is still
-- refused), and the half no UNIQUE can express — "only in a teaser, never a
-- moneyline" — is the second BEFORE INSERT trigger at the bottom. A parlay
-- holding both sides of a market is a guaranteed push-or-loss and stays
-- refused, now by that trigger instead of the UNIQUE.
--
-- WHY A REBUILD. SQLite cannot drop or alter a table constraint. `bet_legs` is
-- a LEAF — nothing references it — so, exactly like 0008, this touches one
-- table: copy, drop, recreate, copy back, indexes, triggers, drop the temp.
-- `bets`, `ledger` and every ledger trigger are untouched, so `balance_cents`
-- is never in play. The DDL below is 0013's `bet_legs` (its last definer) with
-- the one UNIQUE widened; `bet_legs_bi_one_side_per_game` is recreated
-- verbatim because dropping the table dropped it.
--
-- The whole file is ONE batch and therefore atomic. Row ids and timestamps are
-- copied verbatim. Both triggers are created AFTER the copy-back: every
-- existing row satisfied the old, stricter UNIQUE, so none can trip either.
-- `tests/worker/migration-0014.spec.ts` re-runs this file on a populated
-- database and asserts nothing but the constraint changed.

CREATE TABLE bet_legs_copy AS SELECT * FROM bet_legs;

DROP TABLE bet_legs;

CREATE TABLE bet_legs (
  id                  TEXT    PRIMARY KEY,
  bet_id              TEXT    NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_index           INTEGER NOT NULL,
  game_id             TEXT    NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb', 'ncaab', 'nba')),
  market              TEXT    NOT NULL CHECK (market IN ('moneyline', 'spread', 'total')),
  side                TEXT    NOT NULL CHECK (side IN ('home', 'away', 'over', 'under')),
  line_tenths         INTEGER,
  original_line_tenths INTEGER,
  american_price      INTEGER NOT NULL
                        CHECK (abs(american_price) BETWEEN 100 AND 100000),
  provider            TEXT    NOT NULL,
  line_captured_at    INTEGER NOT NULL,
  snapshot_at         INTEGER NOT NULL,
  kickoff_at_snapshot INTEGER NOT NULL,
  home_abbr           TEXT    NOT NULL,
  away_abbr           TEXT    NOT NULL,
  result              TEXT    CHECK (result IS NULL OR result IN ('win','loss','push','void')),
  graded_at           INTEGER,
  UNIQUE (bet_id, leg_index),
  UNIQUE (bet_id, game_id, market, side),             -- one leg per pick per game
  CHECK (market <> 'moneyline' OR line_tenths IS NULL),
  CHECK (market =  'moneyline' OR line_tenths IS NOT NULL),
  CHECK ((market = 'total') = (side IN ('over','under')))
);

INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                      original_line_tenths, american_price, provider, line_captured_at,
                      snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr, result, graded_at)
  SELECT id, bet_id, leg_index, game_id, league, market, side, line_tenths,
         original_line_tenths, american_price, provider, line_captured_at,
         snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr, result, graded_at
    FROM bet_legs_copy;

CREATE INDEX idx_bet_legs_bet  ON bet_legs(bet_id, leg_index);
CREATE INDEX idx_bet_legs_game ON bet_legs(game_id);

-- One SIDE PICK per game per bet (0008, recreated verbatim): a spread beside a
-- moneyline is refused for every bet type, teasers included.
CREATE TRIGGER bet_legs_bi_one_side_per_game BEFORE INSERT ON bet_legs
WHEN NEW.market IN ('spread', 'moneyline')
 AND EXISTS (SELECT 1 FROM bet_legs
              WHERE bet_id = NEW.bet_id AND game_id = NEW.game_id
                AND market IN ('spread', 'moneyline')
                AND market <> NEW.market)
BEGIN
  SELECT RAISE(ABORT, 'bet_legs: one side pick per game');
END;

-- The OTHER side of a market this bet already holds on this game is a middle,
-- and a middle belongs to a teaser alone: unteased it cannot win. The bet row
-- is inserted before its legs in every placement batch, so `bets.bet_type` is
-- readable here; COALESCE makes a leg whose bet row is somehow absent refuse
-- rather than pass. A moneyline has no line to tease, so both moneylines are
-- refused whatever the bet type. Validation refuses all of this first
-- (`sameGameConflict`); this is the backstop the old UNIQUE used to be.
CREATE TRIGGER bet_legs_bi_middle_teaser_only BEFORE INSERT ON bet_legs
WHEN EXISTS (SELECT 1 FROM bet_legs
              WHERE bet_id = NEW.bet_id AND game_id = NEW.game_id
                AND market = NEW.market AND side <> NEW.side)
 AND (NEW.market = 'moneyline'
      OR COALESCE((SELECT bet_type FROM bets WHERE id = NEW.bet_id), '') <> 'teaser')
BEGIN
  SELECT RAISE(ABORT, 'bet_legs: both sides of a market only in a teaser');
END;

DROP TABLE bet_legs_copy;
