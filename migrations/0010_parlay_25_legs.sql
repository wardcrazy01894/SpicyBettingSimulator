-- SpicyBettingSimulator — 0010: parlays up to 25 legs (rebuild of bets, bet_legs, ledger)
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1). Like
-- every migration before it, this file is FROZEN once the Deploy workflow has
-- applied it to the remote D1: a later change is 0011, not an edit here.
--
-- WHAT CHANGES. On `bets` only:
--   - `CHECK (leg_count BETWEEN 1 AND 10)` becomes `BETWEEN 1 AND 25`
--     (MAX_PARLAY_LEGS, src/shared/constants.ts);
--   - a new table CHECK `(bet_type <> 'teaser' OR leg_count <= 10)` keeps a
--     teaser at MAX_TEASER_LEGS. The teaser card stops at 10 legs, and the old
--     column CHECK used to hold teasers there for free.
-- No column, index, trigger or default changes. bet_legs and ledger are
-- recreated from 0009's DDL verbatim — they are rebuilt only because they are
-- bets' children.
--
-- WHY THREE TABLES. SQLite cannot alter a CHECK, so bets is recreated. On D1
-- foreign-key enforcement cannot be switched off inside a migration, so a
-- parent can be dropped only after every child that references it (measured
-- for 0005, PLAN.md §16.2):
--   ledger    child of bets (bet_id ... ON DELETE RESTRICT)
--   bet_legs  child of bets (ON DELETE CASCADE)
--   bets      the CHECKs; its own parents (users, bankrolls) are untouched.
-- `bankrolls_bu_balance_guard` reads `ledger` by NAME and resolves the
-- recreated table, exactly as after 0005 and 0009.
--
-- ORDER, CHILDREN FIRST (the 0005 / 0009 pattern; there is no PRAGMA):
--   1. copy all three into plain CREATE ... AS SELECT tables;
--   2. drop leaf-first: ledger, bet_legs, bets;
--   3. recreate from 0009's DDL with only the bets CHECKs changed;
--   4. copy back PARENT-first with explicit column lists and plain
--      INSERT ... SELECT (never OR IGNORE / OR REPLACE — CLAUDE.md rule 6).
--      Every existing row has leg_count <= 10, so every row passes both CHECKs;
--   5. ONLY THEN recreate the indexes and the six triggers. ledger_ai_apply
--      must not exist while the ledger is copied back, or every historical
--      amount is re-added to balance_cents and every balance DOUBLES.
--      balance_cents is never written here, so SUM(ledger) still equals it;
--   6. drop the three copies.
-- The index and trigger statements are copied byte-for-byte from 0009, which
-- tests/unit/migration-0010-ddl.spec.ts asserts along with the table DDL;
-- tests/worker/migration-0010.spec.ts re-runs this file on a populated
-- database and asserts every row, balance and schema object comes back.
--
-- Dropping `ledger` does NOT fire `ledger_bd_block`: DROP TABLE's implicit
-- DELETE fires no triggers (0005 and 0009 relied on it). The ledger stays
-- append-only for every application path.
--
-- The whole file is ONE batch and therefore atomic: any failure rolls every
-- statement back. Row ids, uuids and timestamps are copied verbatim.

CREATE TABLE bets_copy     AS SELECT * FROM bets;
CREATE TABLE bet_legs_copy AS SELECT * FROM bet_legs;
CREATE TABLE ledger_copy   AS SELECT * FROM ledger;

DROP TABLE ledger;
DROP TABLE bet_legs;
DROP TABLE bets;

CREATE TABLE bets (
  id                     TEXT    PRIMARY KEY,
  user_id                TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bankroll_id            TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  league                 TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb', 'mixed')),
  season                 INTEGER NOT NULL,
  bet_type               TEXT    NOT NULL CHECK (bet_type IN ('straight', 'parlay', 'teaser')),
  leg_count              INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND 25),
  teaser_points_tenths   INTEGER
                           CHECK (teaser_points_tenths IS NULL
                                  OR (typeof(teaser_points_tenths) = 'integer'
                                      AND teaser_points_tenths BETWEEN 30 AND 140
                                      AND teaser_points_tenths % 5 = 0)),
  stake_cents            INTEGER NOT NULL CHECK (stake_cents >= 100),
  american_price         INTEGER NOT NULL
                           CHECK (abs(american_price) <= 100000000),
  potential_payout_cents INTEGER NOT NULL
                           CHECK (potential_payout_cents BETWEEN 0 AND 100000000),
  status                 TEXT    NOT NULL
                           CHECK (status IN ('pending','won','lost','push','void','cancelled')),
  payout_cents           INTEGER
                           CHECK (payout_cents IS NULL OR payout_cents BETWEEN 0 AND 100000000),
  placed_at              INTEGER NOT NULL,
  earliest_kickoff_at    INTEGER NOT NULL,
  settled_at             INTEGER,
  cancelled_at           INTEGER,
  settle_run_id          TEXT,
  settle_attempts        INTEGER NOT NULL DEFAULT 0,
  settle_attempted_at    INTEGER,
  settle_error           TEXT,
  replaces_bet_id        TEXT,
  replaced_by_bet_id     TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (bet_type <> 'straight' OR leg_count = 1),
  CHECK (bet_type =  'straight' OR leg_count >= 2),
  CHECK ((bet_type = 'teaser') = (teaser_points_tenths IS NOT NULL)),
  CHECK (status = 'pending' OR payout_cents IS NOT NULL OR status = 'cancelled'),
  CHECK (bet_type <> 'teaser' OR leg_count <= 10)
);

CREATE TABLE bet_legs (
  id                  TEXT    PRIMARY KEY,
  bet_id              TEXT    NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_index           INTEGER NOT NULL,
  game_id             TEXT    NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb')),
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
  UNIQUE (bet_id, game_id, market),
  CHECK (market <> 'moneyline' OR line_tenths IS NULL),
  CHECK (market =  'moneyline' OR line_tenths IS NOT NULL),
  CHECK ((market = 'total') = (side IN ('over','under')))
);

CREATE TABLE ledger (
  id           TEXT    PRIMARY KEY,
  bankroll_id  TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  kind         TEXT    NOT NULL
                 CHECK (kind IN ('deposit_initial','bet_stake','bet_payout','bet_refund','admin_adjust')),
  ref_id       TEXT    NOT NULL,
  bet_id       TEXT    REFERENCES bets(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  memo         TEXT,
  UNIQUE (bankroll_id, kind, ref_id)
);

INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                  teaser_points_tenths, stake_cents, american_price, potential_payout_cents,
                  status, payout_cents, placed_at, earliest_kickoff_at, settled_at, cancelled_at,
                  settle_run_id, settle_attempts, settle_attempted_at, settle_error,
                  replaces_bet_id, replaced_by_bet_id, created_at, updated_at)
  SELECT id, user_id, bankroll_id, league, season, bet_type, leg_count,
         teaser_points_tenths, stake_cents, american_price, potential_payout_cents,
         status, payout_cents, placed_at, earliest_kickoff_at, settled_at, cancelled_at,
         settle_run_id, settle_attempts, settle_attempted_at, settle_error,
         replaces_bet_id, replaced_by_bet_id, created_at, updated_at
    FROM bets_copy;
INSERT INTO bet_legs (id, bet_id, leg_index, game_id, league, market, side, line_tenths,
                      original_line_tenths, american_price, provider, line_captured_at,
                      snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr, result, graded_at)
  SELECT id, bet_id, leg_index, game_id, league, market, side, line_tenths,
         original_line_tenths, american_price, provider, line_captured_at,
         snapshot_at, kickoff_at_snapshot, home_abbr, away_abbr, result, graded_at
    FROM bet_legs_copy;
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
  SELECT id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo
    FROM ledger_copy;

CREATE INDEX idx_bets_user     ON bets(user_id, status, earliest_kickoff_at DESC);
CREATE INDEX idx_bets_bankroll ON bets(bankroll_id, status);
CREATE INDEX idx_bets_pending  ON bets(settle_attempts, earliest_kickoff_at) WHERE status = 'pending';
CREATE INDEX idx_bet_legs_bet  ON bet_legs(bet_id, leg_index);
CREATE INDEX idx_bet_legs_game ON bet_legs(game_id);
CREATE INDEX idx_ledger_bankroll ON ledger(bankroll_id, created_at DESC);
CREATE INDEX idx_ledger_sum ON ledger (bankroll_id, amount_cents);
CREATE INDEX idx_ledger_bet      ON ledger(bet_id);

CREATE TRIGGER ledger_bi_bankroll_exists BEFORE INSERT ON ledger
WHEN NOT EXISTS (SELECT 1 FROM bankrolls WHERE id = NEW.bankroll_id)
BEGIN
  SELECT RAISE(ABORT, 'ledger: unknown bankroll_id');
END;

CREATE TRIGGER ledger_bi_sufficient_funds BEFORE INSERT ON ledger
WHEN EXISTS (SELECT 1 FROM bankrolls WHERE id = NEW.bankroll_id)
 AND (SELECT balance_cents FROM bankrolls WHERE id = NEW.bankroll_id) + NEW.amount_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'ledger: insufficient funds');
END;

CREATE TRIGGER ledger_ai_apply AFTER INSERT ON ledger BEGIN
  UPDATE bankrolls
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at    = NEW.created_at
   WHERE id = NEW.bankroll_id;
END;

CREATE TRIGGER ledger_bu_block BEFORE UPDATE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER ledger_bd_block BEFORE DELETE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER bet_legs_bi_one_side_per_game BEFORE INSERT ON bet_legs
WHEN NEW.market IN ('spread', 'moneyline')
 AND EXISTS (SELECT 1 FROM bet_legs
              WHERE bet_id = NEW.bet_id AND game_id = NEW.game_id
                AND market IN ('spread', 'moneyline')
                AND market <> NEW.market)
BEGIN
  SELECT RAISE(ABORT, 'bet_legs: one side pick per game');
END;

DROP TABLE ledger_copy;
DROP TABLE bet_legs_copy;
DROP TABLE bets_copy;
