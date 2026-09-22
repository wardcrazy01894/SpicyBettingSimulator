-- SpicyBettingSimulator — 0008: same-game parlays (rebuild of bet_legs)
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1).
--
-- WHAT CHANGES. A bet may now hold more than one leg on a game: ONE side pick
-- (the spread OR the moneyline — never both, they are the same question asked
-- twice and pay far more than the pair is worth) and ONE total. So
-- `UNIQUE (bet_id, game_id)` becomes `UNIQUE (bet_id, game_id, market)`, and
-- the spread-or-moneyline half of the rule, which no UNIQUE can express, is
-- the BEFORE INSERT trigger at the bottom. PLAN.md §5.2c.
--
-- WHY A REBUILD. SQLite cannot drop or alter a table constraint; the table has
-- to be recreated. `bet_legs` is a LEAF — nothing references it — so unlike
-- 0005 this touches one table: copy, drop, recreate, copy back, indexes,
-- trigger, drop the temp. `bets`, `ledger` and every ledger trigger are
-- untouched, so `balance_cents` is never in play. The DDL below is 0005's
-- `bet_legs` with the comments stripped and the one UNIQUE widened.
--
-- The whole file is ONE batch and therefore atomic: any failure rolls every
-- statement back. Row ids and timestamps are copied verbatim. Dropping a child
-- table is allowed with foreign keys on (its implicit DELETE violates nothing),
-- which 0005 relied on for this same table.
--
-- The trigger is created AFTER the copy-back. Every existing row satisfied the
-- old, stricter UNIQUE, so none can trip it; creating it last just keeps the
-- copy a plain copy. `tests/worker/migration-0008.spec.ts` re-runs this file
-- on a populated database and asserts nothing but the constraint changed.

CREATE TABLE bet_legs_copy AS SELECT * FROM bet_legs;

DROP TABLE bet_legs;

CREATE TABLE bet_legs (
  id                  TEXT    PRIMARY KEY,
  bet_id              TEXT    NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_index           INTEGER NOT NULL,
  game_id             TEXT    NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf')),
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
  UNIQUE (bet_id, game_id, market),                   -- one leg per market per game
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

-- One SIDE PICK per game per bet: a spread and a moneyline on the same game are
-- correlated (the favourite covering implies the favourite winning), and the
-- parlay product would pay the pair as if they were independent. Validation
-- refuses it first; this is the backstop, in the schema like the money rules.
-- `market <> NEW.market` leaves the SAME market twice to the UNIQUE above (a
-- BEFORE INSERT trigger runs before constraints are checked, so without it a
-- second spread would report as a side-pick clash rather than the duplicate
-- it is).
CREATE TRIGGER bet_legs_bi_one_side_per_game BEFORE INSERT ON bet_legs
WHEN NEW.market IN ('spread', 'moneyline')
 AND EXISTS (SELECT 1 FROM bet_legs
              WHERE bet_id = NEW.bet_id AND game_id = NEW.game_id
                AND market IN ('spread', 'moneyline')
                AND market <> NEW.market)
BEGIN
  SELECT RAISE(ABORT, 'bet_legs: one side pick per game');
END;

DROP TABLE bet_legs_copy;
