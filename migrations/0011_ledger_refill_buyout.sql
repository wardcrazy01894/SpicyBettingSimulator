-- SpicyBettingSimulator — 0011: bust refills and badge buyouts (rebuild of ledger)
-- D1 (SQLite). Applied with: wrangler d1 migrations apply spicybetting [--local|--remote]
--
-- A new file, never an edit to 0001 (CLAUDE.md rule 9, PLAN.md §16.1). Like
-- every migration before it, this file is FROZEN once the Deploy workflow has
-- applied it to the remote D1: a later change is 0012, not an edit here.
--
-- WHAT CHANGES. `ledger.kind`'s CHECK admits two new kinds (PLAN.md §4.5):
--   deposit_refill  an admin re-funds a BUSTED account (+n, ref_id = uuid).
--                   One row = one bust badge on the leaderboard, and the
--                   amount joins the account's "bought in" total so net profit
--                   still shows the money that was lost before it.
--   bust_buyout     the player pays BUST_BUYOUT_CENTS to remove one badge
--                   (-n, ref_id = the id of the deposit_refill row it retires,
--                   so UNIQUE (bankroll_id, kind, ref_id) makes "each refill
--                   can be bought off at most once" a schema fact).
-- No column, index, trigger or default changes.
--
-- WHY A REBUILD. SQLite cannot alter a CHECK, so the table is recreated.
-- `ledger` is a LEAF — nothing references it — so like 0008 this touches one
-- table: copy, drop, recreate, copy back, indexes, triggers, drop the temp.
-- The DDL below is 0010's `ledger` with the one CHECK widened.
--
-- ORDER (the 0005 / 0009 / 0010 pattern; there is no PRAGMA):
--   1. copy into a plain CREATE ... AS SELECT table;
--   2. drop ledger (DROP TABLE's implicit DELETE fires no triggers, so
--      ledger_bd_block does not object — 0005, 0009 and 0010 relied on it);
--   3. recreate from 0010's DDL with only the kind CHECK changed;
--   4. copy back with an explicit column list and plain INSERT ... SELECT
--      (never OR IGNORE / OR REPLACE — CLAUDE.md rule 6). Every existing row
--      has one of the five old kinds, so every row passes the new CHECK;
--   5. ONLY THEN recreate the indexes and the five triggers. ledger_ai_apply
--      must not exist while the ledger is copied back, or every historical
--      amount is re-added to balance_cents and every balance DOUBLES.
--      balance_cents is never written here, so SUM(ledger) still equals it;
--   6. drop the copy.
-- `bankrolls_bu_balance_guard` reads `ledger` by NAME and resolves the
-- recreated table, exactly as after 0005, 0009 and 0010.
-- The index and trigger statements are copied byte-for-byte from 0010, which
-- tests/unit/migration-0011-ddl.spec.ts asserts along with the table DDL;
-- tests/worker/migration-0011.spec.ts re-runs this file on a populated
-- database and asserts every row, balance and schema object comes back.
--
-- The whole file is ONE batch and therefore atomic: any failure rolls every
-- statement back. Row ids, uuids and timestamps are copied verbatim.

CREATE TABLE ledger_copy AS SELECT * FROM ledger;

DROP TABLE ledger;

CREATE TABLE ledger (
  id           TEXT    PRIMARY KEY,
  bankroll_id  TEXT    NOT NULL REFERENCES bankrolls(id) ON DELETE RESTRICT,
  kind         TEXT    NOT NULL
                 CHECK (kind IN ('deposit_initial','bet_stake','bet_payout','bet_refund','admin_adjust',
                                 'deposit_refill','bust_buyout')),
  ref_id       TEXT    NOT NULL,
  bet_id       TEXT    REFERENCES bets(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  memo         TEXT,
  UNIQUE (bankroll_id, kind, ref_id)
);

INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
  SELECT id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo
    FROM ledger_copy;

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

DROP TABLE ledger_copy;
