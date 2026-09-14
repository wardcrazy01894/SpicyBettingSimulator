-- SpicyBettingSimulator — initial schema
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- Conventions (see PLAN.md §3.1):
--   * every timestamp is INTEGER epoch MILLISECONDS, UTC
--   * every money amount is INTEGER CENTS
--   * every point line is INTEGER TENTHS of a point (-3.5 -> -35, o50.5 -> 505)
--   * every price is an INTEGER American price (-110, +164 -> 164). Exact decimal
--     odds are a BigInt rational held ONLY IN MEMORY and derived from that
--     integer; no rational is ever persisted, because a 10-leg parlay numerator
--     reaches 20+ digits and SQLite silently stores that as REAL (verified). See
--     PLAN.md 5.2.
--
-- THIS FILE IS FROZEN. It was applied to the REMOTE D1 on 2026-09-14 (M8's
-- deploy) and D1 recorded it in the `d1_migrations` table, so
-- `wrangler d1 migrations apply` will never replay it. EVERY schema change from
-- here is a NEW numbered migration: `migrations/0002_*.sql`, `0003_*.sql`, ….
-- Editing the DDL below changes nothing in production and leaves this file
-- describing a database that does not exist. Comment-only edits (like this one)
-- are fine.
--
-- HISTORY, so nobody re-derives the old rule: before that first remote deploy
-- this file was the live schema and the M5b contract change (account balances,
-- cross-league bets, teasers) was folded into it rather than shipped as a 0002
-- that would have immediately rebuilt tables nobody had ever populated. That
-- window is closed. PLAN.md §16.1 and CLAUDE.md rule 9 say the same thing; all
-- three move together or none of them do.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  username          TEXT    NOT NULL UNIQUE,          -- stored lowercased
  display_name      TEXT    NOT NULL,                 -- original casing, for display
  kdf_version       INTEGER NOT NULL DEFAULT 1,
  client_iterations INTEGER NOT NULL,                 -- PBKDF2 rounds the BROWSER ran
  server_salt       BLOB    NOT NULL,                 -- 16 random bytes
  server_iterations INTEGER NOT NULL,                 -- PBKDF2 rounds the WORKER runs
  password_hash     BLOB    NOT NULL,                 -- 32 bytes
  is_admin          INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  is_disabled       INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0, 1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (length(username) BETWEEN 3 AND 24),
  CHECK (client_iterations >= 1000),
  CHECK (server_iterations >= 1)
);

-- ---------------------------------------------------------------------------
-- sessions
-- id is sha256hex(token); the raw token is never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- auth_throttle — login rate limiting. key is 'u:<username>' or 'ip:<hash16>'.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_throttle (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_auth_throttle_window ON auth_throttle(window_start);

-- ---------------------------------------------------------------------------
-- games — canonical game rows, id = '<league>:<providerEventId>'
-- ---------------------------------------------------------------------------
CREATE TABLE games (
  id                  TEXT    PRIMARY KEY,
  provider            TEXT    NOT NULL DEFAULT 'espn',
  provider_event_id   TEXT    NOT NULL,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf')),
  season              INTEGER NOT NULL,
  season_type         INTEGER NOT NULL,               -- ESPN: 1 pre, 2 regular, 3 post
  week                INTEGER,
  name                TEXT    NOT NULL,               -- "New England Patriots at Seattle Seahawks"
  short_name          TEXT    NOT NULL,               -- "NE @ SEA"
  kickoff_at          INTEGER NOT NULL,               -- MUTABLE: ESPN reschedules
  original_kickoff_at INTEGER NOT NULL,               -- written once, never updated
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
  home_rank           INTEGER,                        -- CFB curatedRank.current (99 = unranked -> NULL)
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
  UNIQUE (provider, league, provider_event_id)
);
CREATE INDEX idx_games_board  ON games(league, kickoff_at);
CREATE INDEX idx_games_status ON games(status, kickoff_at);
CREATE INDEX idx_games_week   ON games(league, season, season_type, week);

-- ---------------------------------------------------------------------------
-- game_lines — CURRENT line snapshot, one row per (game, provider).
-- NULL column == that market is not offered. Rows are never deleted; when odds
-- vanish at kickoff the row simply stops being refreshed.
--
-- TWO timestamps, deliberately (PLAN.md 8.5):
--   captured_at  the moment any PRICE last CHANGED. This is what a bet leg
--                snapshots as `line_captured_at` (real provenance).
--   seen_at      the moment we last CONFIRMED the book still offers this line.
--                Staleness for betting is measured against THIS, so the
--                compare-and-skip upsert can avoid rewriting unchanged rows
--                without making every line look stale.
-- ---------------------------------------------------------------------------
CREATE TABLE game_lines (
  game_id            TEXT    NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  provider           TEXT    NOT NULL,                -- 'draftkings'
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
  PRIMARY KEY (game_id, provider)
);

-- ---------------------------------------------------------------------------
-- bankrolls — ACCOUNT BALANCES (M5b). One balance is one pot of fake money that
-- belongs to a user and persists forever: it is not scoped to a league or to a
-- season, there is no rollover, and nothing creates one lazily. The 'main'
-- balance is created in the SIGNUP batch and is the one the leaderboard ranks.
--
-- Modelled as a LIST rather than a single column on `users` on purpose: the
-- product owner wants side pots ("playoff challenge", "bowl season") later, and
-- `bets.bankroll_id` + the ledger already key off a balance id, so the only
-- thing a second balance needs is a row. `kind='custom'` is reserved for those;
-- v1 never writes one.
--
-- balance_cents is a CACHE maintained exclusively by the ledger triggers below.
-- ---------------------------------------------------------------------------
CREATE TABLE bankrolls (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name          TEXT    NOT NULL DEFAULT 'Main',
  kind          TEXT    NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'custom')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
-- Exactly ONE 'main' balance per user. A PARTIAL unique index, not a plain one:
-- `kind='custom'` rows are unconstrained here and are separated only by
-- UNIQUE(user_id, name). Without this a second signup-style batch (or a repair
-- route run twice) could open a second main balance and the leaderboard would
-- silently pick whichever row it found first.
CREATE UNIQUE INDEX idx_bankrolls_main ON bankrolls(user_id) WHERE kind = 'main';
CREATE INDEX idx_bankrolls_user ON bankrolls(user_id, balance_cents DESC);

-- ---------------------------------------------------------------------------
-- bets
-- ---------------------------------------------------------------------------
CREATE TABLE bets (
  id                     TEXT    PRIMARY KEY,
  user_id                TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bankroll_id            TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  -- 'mixed' when the legs span both leagues (M5b: cross-league parlays and
  -- teasers are legal, because a balance is no longer scoped to a league).
  -- INFORMATIONAL — it drives the stats filters, never the money.
  league                 TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mixed')),
  -- Season of the EARLIEST-KICKOFF leg. Also informational; legs may span
  -- seasons, so this is a label for the bet, not a partition of the balance.
  season                 INTEGER NOT NULL,
  bet_type               TEXT    NOT NULL CHECK (bet_type IN ('straight', 'parlay', 'teaser')),
  leg_count              INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND 10),
  -- Teaser tier in TENTHS of a point: 60 / 65 / 70 == 6 / 6.5 / 7 points. Tenths
  -- for the same reason lines are (PLAN.md §3.1) — 6.5 is not representable as an
  -- integer number of points. NULL for every other bet type; the paired CHECK
  -- below makes the two facts inseparable.
  teaser_points_tenths   INTEGER
                           CHECK (teaser_points_tenths IS NULL
                                  OR teaser_points_tenths IN (60, 65, 70)),
  stake_cents            INTEGER NOT NULL CHECK (stake_cents >= 100),
  -- NO stored rational. The exact decimal odds of a parlay are the product of
  -- the leg rationals and can reach 20+ digits, which SQLite would silently
  -- coerce to REAL in an INTEGER column (verified) -- a float in a money row.
  -- The price is therefore ALWAYS recomputed from bet_legs.american_price via
  -- americanToPrice(); bet_legs is the single source of truth. See PLAN.md 5.2.
  american_price         INTEGER NOT NULL                           -- display only
                           CHECK (abs(american_price) <= 100000000),
  -- Bounded by MAX_PAYOUT_CENTS so this column can never exceed 2^53 and can
  -- never become REAL. Bets whose potential payout would exceed the cap are
  -- rejected with 409 PAYOUT_LIMIT_EXCEEDED.
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
  -- Head-of-line-blocking guard (PLAN.md 7.1): a bet whose games are all final
  -- but which still grades `pending` (e.g. an unparseable score) increments this
  -- and is de-prioritised, so it can never starve the settlement queue.
  -- settle_attempted_at is the RESET key: the settle job zeroes the counter for
  -- any deferred bet whose leg games have been updated since the last attempt,
  -- so a transiently unparseable ESPN score self-heals on the next run instead
  -- of burning the budget down to a permanent park.
  settle_attempts        INTEGER NOT NULL DEFAULT 0,
  settle_attempted_at    INTEGER,
  settle_error           TEXT,
  replaces_bet_id        TEXT,
  replaced_by_bet_id     TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  -- A straight is exactly one leg; a parlay OR A TEASER is two or more. Written
  -- as two one-sided CHECKs against 'straight' rather than against 'parlay', so
  -- adding `teaser` to the bet_type enum did not silently make a 1-leg teaser
  -- legal (the old `bet_type = 'parlay' OR leg_count = 1` would have).
  CHECK (bet_type <> 'straight' OR leg_count = 1),
  CHECK (bet_type =  'straight' OR leg_count >= 2),
  -- The tier and the type are the same fact. An `=` between two predicates is a
  -- biconditional in SQLite, so this rejects BOTH a teaser with no tier and a
  -- parlay that carries one.
  CHECK ((bet_type = 'teaser') = (teaser_points_tenths IS NOT NULL)),
  CHECK (status = 'pending' OR payout_cents IS NOT NULL OR status = 'cancelled')
);
CREATE INDEX idx_bets_user     ON bets(user_id, status, earliest_kickoff_at DESC);
CREATE INDEX idx_bets_bankroll ON bets(bankroll_id, status);
CREATE INDEX idx_bets_pending  ON bets(settle_attempts, earliest_kickoff_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- bet_legs — THE IMMUTABLE LINE SNAPSHOT. Grading reads the line from here and
-- ONLY the score/status from games. Nothing in the settlement path touches
-- game_lines. line_tenths is stored from the BETTOR'S SIDE's perspective.
-- ---------------------------------------------------------------------------
CREATE TABLE bet_legs (
  id                  TEXT    PRIMARY KEY,
  bet_id              TEXT    NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_index           INTEGER NOT NULL,
  game_id             TEXT    NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  league              TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf')),
  market              TEXT    NOT NULL CHECK (market IN ('moneyline', 'spread', 'total')),
  side                TEXT    NOT NULL CHECK (side IN ('home', 'away', 'over', 'under')),
  -- THE LINE THIS LEG IS GRADED ON. For a teaser leg that is the TEASED line
  -- (the book's number moved `teaser_points_tenths` in the bettor's favour), so
  -- grading needs no knowledge of teasers at all — it keeps reading one column.
  line_tenths         INTEGER,                        -- NULL for moneyline
  -- The BOOK's line before the tease, kept for display ("-7.5 → -1.5") and for
  -- audit. NULL for straight and parlay legs, which are never moved.
  original_line_tenths INTEGER,
  -- The American integer IS the snapshot. Exact decimal odds are derived from it
  -- by americanToPrice(), which is a total, deterministic, lossless function of
  -- this one integer -- so there is no second source of truth to drift.
  american_price      INTEGER NOT NULL
                        CHECK (abs(american_price) BETWEEN 100 AND 100000),
  provider            TEXT    NOT NULL,
  line_captured_at    INTEGER NOT NULL,               -- when the BOOK's price last CHANGED
  snapshot_at         INTEGER NOT NULL,               -- when the USER locked it in
  kickoff_at_snapshot INTEGER NOT NULL,               -- kickoff as known at placement
  home_abbr           TEXT    NOT NULL,               -- denormalized for stable display
  away_abbr           TEXT    NOT NULL,
  result              TEXT    CHECK (result IS NULL OR result IN ('win','loss','push','void')),
  graded_at           INTEGER,
  UNIQUE (bet_id, leg_index),
  UNIQUE (bet_id, game_id),                           -- no two legs from the same game
  CHECK (market <> 'moneyline' OR line_tenths IS NULL),
  CHECK (market =  'moneyline' OR line_tenths IS NOT NULL),
  CHECK ((market = 'total') = (side IN ('over','under')))
);
CREATE INDEX idx_bet_legs_bet  ON bet_legs(bet_id, leg_index);
CREATE INDEX idx_bet_legs_game ON bet_legs(game_id);

-- ---------------------------------------------------------------------------
-- ledger — APPEND-ONLY source of truth for money.
-- ref_id is the idempotency key:
--   bet_stake / bet_payout / bet_refund -> the bet id
--   deposit_initial                     -> the literal 'init' (written in the
--                                          SIGNUP batch; one per balance, ever)
--   admin_adjust                        -> a caller-supplied uuid
-- ---------------------------------------------------------------------------
CREATE TABLE ledger (
  id           TEXT    PRIMARY KEY,
  bankroll_id  TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  kind         TEXT    NOT NULL
                 CHECK (kind IN ('deposit_initial','bet_stake','bet_payout','bet_refund','admin_adjust')),
  ref_id       TEXT    NOT NULL,
  bet_id       TEXT    REFERENCES bets(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL,                      -- signed; stakes are negative
  created_at   INTEGER NOT NULL,
  memo         TEXT,
  UNIQUE (bankroll_id, kind, ref_id)
);
CREATE INDEX idx_ledger_bankroll ON ledger(bankroll_id, created_at DESC);
-- Covering index for bankrolls_bu_balance_guard's SUM(amount_cents) per bankroll:
-- the guard runs on every ledger insert, so keep it an index-only scan. NOT a
-- duplicate of idx_ledger_bankroll above (which orders the history view by
-- created_at) — both earn their keep; do not "clean up" either.
CREATE INDEX idx_ledger_sum ON ledger (bankroll_id, amount_cents);
CREATE INDEX idx_ledger_bet      ON ledger(bet_id);

-- GUARDS: RAISE(ABORT) inside a BEFORE INSERT trigger is NOT suppressed by
-- `INSERT OR IGNORE` (verified in sqlite3), whereas a CHECK violation raised
-- from inside an AFTER trigger IS -- which would leave a ledger row with no
-- balance effect, permanently, in an append-only table. These triggers are
-- therefore the real guards; the CHECK on bankrolls is belt-and-braces.
--
-- TWO triggers with DISTINCT messages, not one with a compound WHEN. They
-- describe completely different faults and must map to different responses:
--   unknown bankroll   -> an internal bug            -> 500 INTERNAL
--   insufficient funds -> a legitimate user state    -> 409 INSUFFICIENT_FUNDS
-- One shared message would make db.ts::isOverdraftError report an orphan-bankroll
-- bug to the user as "insufficient funds" and hide it forever. The WHEN clauses
-- are mutually exclusive, so SQLite's unspecified ordering between multiple
-- BEFORE INSERT triggers does not matter.
--
-- The existence test is a NOT EXISTS, not a COALESCE(..., -1) sentinel: a
-- POSITIVE amount against an unknown bankroll would pass a sentinel arithmetic
-- test, land an orphan row, and leave the AFTER trigger's UPDATE matching zero
-- rows -- the exact failure these triggers exist to stop. The FOREIGN KEY would
-- normally catch it, but `INSERT OR IGNORE` suppresses FK violations too.
-- See PLAN.md 4.2.
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

-- The ONLY writer of bankrolls.balance_cents (enforced by the two
-- bankrolls_b*_balance_guard triggers below, not just by convention).
CREATE TRIGGER ledger_ai_apply AFTER INSERT ON ledger BEGIN
  UPDATE bankrolls
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at    = NEW.created_at
   WHERE id = NEW.bankroll_id;
END;

-- balance_cents must ALWAYS equal SUM(ledger.amount_cents) for that bankroll.
-- A direct `UPDATE bankrolls SET balance_cents = ...` (or an INSERT with a
-- non-zero opening balance) that breaks the identity is rejected. The
-- ledger_ai_apply write passes because it fires AFTER the ledger row exists,
-- so the SUM already includes it. Updating other columns (updated_at) with an
-- unchanged balance also passes, since the identity still holds.
CREATE TRIGGER bankrolls_bu_balance_guard BEFORE UPDATE OF balance_cents ON bankrolls
WHEN NEW.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger
                            WHERE bankroll_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'bankrolls: balance_cents may only be written by the ledger trigger');
END;

-- INSERT guard: a balance always opens at 0 (the deposit is a ledger row).
-- Deliberately `<> 0`, NOT `<> SUM(ledger)`: BEFORE INSERT triggers fire BEFORE
-- `OR IGNORE` resolves a uniqueness conflict, so an idempotent
-- `INSERT OR IGNORE INTO bankrolls (..., 0, ...)` aimed at an already-FUNDED row
-- would abort the whole batch under a SUM comparison. M5b moved balance creation
-- into the signup batch and deleted the per-request prelude, but
-- `ensureMainBalance()` -- a tested repair primitive with no endpoint yet -- is
-- still shaped that way, and the reasoning must survive regardless: for a
-- genuinely new id no ledger rows can exist (ledger_bi_bankroll_exists), so
-- `<> 0` is equivalent for every real insert.
CREATE TRIGGER bankrolls_bi_balance_guard BEFORE INSERT ON bankrolls
WHEN NEW.balance_cents <> 0
BEGIN
  SELECT RAISE(ABORT, 'bankrolls: balance_cents may only be written by the ledger trigger');
END;

CREATE TRIGGER ledger_bu_block BEFORE UPDATE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER ledger_bd_block BEFORE DELETE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

-- ---------------------------------------------------------------------------
-- ingest_targets — the ESPN work queue. One row == one HTTP request.
--
-- v1 uses kind='date' for BOTH leagues: key='YYYYMMDD', a US Eastern calendar
-- day, id='<league>:date:<key>'. Date targets are the only shape that is
-- collision-free across regular season and postseason (a week-keyed target
-- cannot distinguish regular week 1 from Wild Card week 1 without also keying
-- seasontype) and they need no knowledge of the league calendar at all -- the
-- planner just walks the date range. 'week' remains a legal value so a later
-- optimisation does not need a migration. See PLAN.md 8.2.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_targets (
  id                   TEXT    PRIMARY KEY,           -- '<league>:<kind>:<key>'
  league               TEXT    NOT NULL CHECK (league IN ('nfl', 'ncaaf')),
  kind                 TEXT    NOT NULL CHECK (kind IN ('week', 'date')),
  key                  TEXT    NOT NULL,
  window_start_at      INTEGER NOT NULL,
  window_end_at        INTEGER NOT NULL,
  priority             INTEGER NOT NULL DEFAULT 100,  -- lower runs first
  next_run_at          INTEGER NOT NULL,
  last_run_at          INTEGER,
  last_status          TEXT    CHECK (last_status IS NULL OR last_status IN ('ok','error')),
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  games_seen           INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_ingest_targets_due ON ingest_targets(next_run_at, priority);

-- ---------------------------------------------------------------------------
-- job_locks — single-row-per-job cooperative lease. See PLAN.md §9.2.
-- ---------------------------------------------------------------------------
CREATE TABLE job_locks (
  name        TEXT    PRIMARY KEY,
  lease_until INTEGER NOT NULL DEFAULT 0,
  run_id      TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO job_locks (name, lease_until, run_id, updated_at) VALUES
  ('refresh', 0, '', 0),
  ('settle', 0, '', 0),
  ('maintenance', 0, '', 0);

-- ---------------------------------------------------------------------------
-- job_runs — observability. Pruned by the maintenance job to the newest 200/job.
-- ---------------------------------------------------------------------------
CREATE TABLE job_runs (
  id          TEXT    PRIMARY KEY,
  job         TEXT    NOT NULL,
  trigger     TEXT    NOT NULL CHECK (trigger IN ('cron', 'admin')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT    NOT NULL CHECK (status IN ('running','ok','skipped','error')),
  stats       TEXT,                                   -- JSON
  error       TEXT
);
CREATE INDEX idx_job_runs_recent ON job_runs(job, started_at DESC);
