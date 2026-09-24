-- SpicyBettingSimulator — 0009: 'mlb' as a third league (rebuild of six tables)
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1). Like
-- every migration before it, this file is FROZEN once the Deploy workflow has
-- applied it to the remote D1: a later change is 0010, not an edit here.
--
-- WHAT CHANGES. CHECK (league IN (...)) on games, bets, bet_legs and
-- ingest_targets gains 'mlb' (bets keeps 'mixed'). Nothing else: no column,
-- no index, no trigger, no default. PLAN.md §23.3.
--
-- WHY SIX TABLES. SQLite cannot alter a CHECK: each table is recreated. On D1
-- foreign-key enforcement cannot be switched off inside a migration (only
-- deferred, and RESTRICT is checked at the statement regardless), so a parent
-- can be dropped only after every child that references it — measured for
-- 0005 (PLAN.md §16.2). The reference graph forces the set:
--   ledger         child of bets (bet_id ... ON DELETE RESTRICT)
--   bet_legs       its CHECK; child of bets (CASCADE) and games (RESTRICT)
--   bets           its CHECK
--   game_lines     child of games, ON DELETE CASCADE — dropped BEFORE games,
--                  so dropping games cascades into nothing
--   games          its CHECK
--   ingest_targets its CHECK; no foreign keys. COPIED, not recreated empty:
--                  next_run_at / consecutive_failures / last_run_at /
--                  last_status are the evidence §23.7's void rule reads.
-- users, sessions, auth_throttle, bankrolls, bug_reports, job_locks, job_runs
-- and secondary_budget are untouched. `bankrolls_bu_balance_guard` reads
-- `ledger` by NAME and resolves the recreated table, exactly as after 0005.
--
-- ORDER, CHILDREN FIRST (the 0005 pattern; there is no PRAGMA anywhere):
--   1. copy all six into plain CREATE ... AS SELECT tables (no constraints,
--      no triggers, no foreign keys);
--   2. drop leaf-first: ledger, bet_legs, bets, game_lines, games,
--      ingest_targets — each is a leaf when it goes, so its implicit DELETE
--      violates nothing and cascades into nothing;
--   3. recreate from the CURRENT DDL with only the four CHECKs widened (the
--      live schema with comments stripped: games is 0001's plus the 0004 and
--      0007 ALTERed columns in their physical order, after updated_at;
--      game_lines is 0001's plus 0007's three *_book columns; bets and ledger
--      are 0005's; bet_legs is 0008's; ingest_targets is 0001's);
--   4. copy back PARENT-first with explicit column lists and plain
--      INSERT ... SELECT (never OR IGNORE / OR REPLACE — CLAUDE.md rule 6);
--   5. ONLY THEN recreate the indexes and the six triggers. ledger_ai_apply
--      must not exist while the ledger is copied back, or every historical
--      amount is re-added to balance_cents and every balance DOUBLES.
--      balance_cents is never written here, so SUM(ledger) still equals it
--      afterwards. bet_legs_bi_one_side_per_game is likewise created after its
--      copy, so the copy is a plain copy (0008's reasoning);
--   6. drop the six copies.
-- The index and trigger statements are copied byte-for-byte from 0001 / 0005
-- / 0008 so sqlite_master.sql comes back identical, which
-- tests/worker/migration-0009.spec.ts asserts along with every row and balance.
--
-- Dropping `ledger` does NOT fire `ledger_bd_block`: DROP TABLE's implicit
-- DELETE fires no triggers (SQLite documents this; 0005 relied on it). The
-- ledger stays append-only for every application path.
--
-- The whole file is ONE batch and therefore atomic: any failure rolls every
-- statement back. Row ids, uuids and timestamps are copied verbatim.

CREATE TABLE ingest_targets_copy AS SELECT * FROM ingest_targets;
CREATE TABLE games_copy          AS SELECT * FROM games;
CREATE TABLE game_lines_copy     AS SELECT * FROM game_lines;
CREATE TABLE bets_copy           AS SELECT * FROM bets;
CREATE TABLE bet_legs_copy       AS SELECT * FROM bet_legs;
CREATE TABLE ledger_copy         AS SELECT * FROM ledger;

DROP TABLE ledger;
DROP TABLE bet_legs;
DROP TABLE bets;
DROP TABLE game_lines;
DROP TABLE games;
DROP TABLE ingest_targets;

CREATE TABLE games (
  id                  TEXT    PRIMARY KEY,
  provider            TEXT    NOT NULL DEFAULT 'espn',
  provider_event_id   TEXT    NOT NULL,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb')),
  season              INTEGER NOT NULL,
  season_type         INTEGER NOT NULL,
  week                INTEGER,
  name                TEXT    NOT NULL,
  short_name          TEXT    NOT NULL,
  kickoff_at          INTEGER NOT NULL,
  original_kickoff_at INTEGER NOT NULL,
  status              TEXT    NOT NULL
                        CHECK (status IN ('scheduled','in_progress','final','postponed','canceled','unknown')),
  status_detail       TEXT,
  period              INTEGER,
  display_clock       TEXT,
  neutral_site        INTEGER NOT NULL DEFAULT 0 CHECK (neutral_site IN (0, 1)),
  home_team_id        TEXT    NOT NULL,
  home_abbr           TEXT    NOT NULL,
  home_name           TEXT    NOT NULL,
  home_logo           TEXT,
  home_rank           INTEGER,
  home_score          INTEGER,
  away_team_id        TEXT    NOT NULL,
  away_abbr           TEXT    NOT NULL,
  away_name           TEXT    NOT NULL,
  away_logo           TEXT,
  away_rank           INTEGER,
  away_score          INTEGER,
  first_seen_at       INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  home_conference_id  TEXT    NULL,
  away_conference_id  TEXT    NULL,
  secondary_tried_at  INTEGER NULL,
  UNIQUE (provider, league, provider_event_id)
);

CREATE TABLE game_lines (
  game_id            TEXT    NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  provider           TEXT    NOT NULL,
  spread_home_tenths INTEGER,
  spread_home_price  INTEGER,
  spread_away_tenths INTEGER,
  spread_away_price  INTEGER,
  total_tenths       INTEGER,
  total_over_price   INTEGER,
  total_under_price  INTEGER,
  ml_home_price      INTEGER,
  ml_away_price      INTEGER,
  captured_at        INTEGER NOT NULL,
  seen_at            INTEGER NOT NULL,
  spread_book        TEXT    NULL,
  total_book         TEXT    NULL,
  ml_book            TEXT    NULL,
  PRIMARY KEY (game_id, provider)
);

CREATE TABLE bets (
  id                     TEXT    PRIMARY KEY,
  user_id                TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bankroll_id            TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  league                 TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb', 'mixed')),
  season                 INTEGER NOT NULL,
  bet_type               TEXT    NOT NULL CHECK (bet_type IN ('straight', 'parlay', 'teaser')),
  leg_count              INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND 10),
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
  CHECK (status = 'pending' OR payout_cents IS NOT NULL OR status = 'cancelled')
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

CREATE TABLE ingest_targets (
  id                   TEXT    PRIMARY KEY,
  league               TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb')),
  kind                 TEXT    NOT NULL CHECK (kind IN ('week', 'date')),
  key                  TEXT    NOT NULL,
  window_start_at      INTEGER NOT NULL,
  window_end_at        INTEGER NOT NULL,
  priority             INTEGER NOT NULL DEFAULT 100,
  next_run_at          INTEGER NOT NULL,
  last_run_at          INTEGER,
  last_status          TEXT    CHECK (last_status IS NULL OR last_status IN ('ok','error')),
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  games_seen           INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

INSERT INTO games (id, provider, provider_event_id, league, season, season_type, week,
                   name, short_name, kickoff_at, original_kickoff_at, status, status_detail,
                   period, display_clock, neutral_site,
                   home_team_id, home_abbr, home_name, home_logo, home_rank, home_score,
                   away_team_id, away_abbr, away_name, away_logo, away_rank, away_score,
                   first_seen_at, last_seen_at, updated_at,
                   home_conference_id, away_conference_id, secondary_tried_at)
  SELECT id, provider, provider_event_id, league, season, season_type, week,
         name, short_name, kickoff_at, original_kickoff_at, status, status_detail,
         period, display_clock, neutral_site,
         home_team_id, home_abbr, home_name, home_logo, home_rank, home_score,
         away_team_id, away_abbr, away_name, away_logo, away_rank, away_score,
         first_seen_at, last_seen_at, updated_at,
         home_conference_id, away_conference_id, secondary_tried_at
    FROM games_copy;
INSERT INTO game_lines (game_id, provider, spread_home_tenths, spread_home_price,
                        spread_away_tenths, spread_away_price, total_tenths,
                        total_over_price, total_under_price, ml_home_price, ml_away_price,
                        captured_at, seen_at, spread_book, total_book, ml_book)
  SELECT game_id, provider, spread_home_tenths, spread_home_price,
         spread_away_tenths, spread_away_price, total_tenths,
         total_over_price, total_under_price, ml_home_price, ml_away_price,
         captured_at, seen_at, spread_book, total_book, ml_book
    FROM game_lines_copy;
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
INSERT INTO ingest_targets (id, league, kind, key, window_start_at, window_end_at, priority,
                            next_run_at, last_run_at, last_status, last_error,
                            consecutive_failures, games_seen, created_at, updated_at)
  SELECT id, league, kind, key, window_start_at, window_end_at, priority,
         next_run_at, last_run_at, last_status, last_error,
         consecutive_failures, games_seen, created_at, updated_at
    FROM ingest_targets_copy;

CREATE INDEX idx_games_board  ON games(league, kickoff_at);
CREATE INDEX idx_games_status ON games(status, kickoff_at);
CREATE INDEX idx_games_week   ON games(league, season, season_type, week);
CREATE INDEX idx_bets_user     ON bets(user_id, status, earliest_kickoff_at DESC);
CREATE INDEX idx_bets_bankroll ON bets(bankroll_id, status);
CREATE INDEX idx_bets_pending  ON bets(settle_attempts, earliest_kickoff_at) WHERE status = 'pending';
CREATE INDEX idx_bet_legs_bet  ON bet_legs(bet_id, leg_index);
CREATE INDEX idx_bet_legs_game ON bet_legs(game_id);
CREATE INDEX idx_ledger_bankroll ON ledger(bankroll_id, created_at DESC);
CREATE INDEX idx_ledger_sum ON ledger (bankroll_id, amount_cents);
CREATE INDEX idx_ledger_bet      ON ledger(bet_id);
CREATE INDEX idx_ingest_targets_due ON ingest_targets(next_run_at, priority);

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
DROP TABLE game_lines_copy;
DROP TABLE games_copy;
DROP TABLE ingest_targets_copy;
