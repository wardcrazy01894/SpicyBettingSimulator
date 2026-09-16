-- SpicyBettingSimulator — 0007: the secondary odds provider (PLAN.md §21.3)
--
-- Three metadata-only ADD COLUMNs and one new single-row table. Nothing
-- existing is rewritten, so it is safe on the populated remote D1 and the
-- apply/deploy order is harmless either way: the old Worker neither reads nor
-- writes any of it. FROZEN from the merge that ships it (CLAUDE.md rule 9).
-- PLAN.md §21.3 is the specification this file copies.

-- ---------------------------------------------------------------------------
-- 1. Per-market bookmaker on a line row.
--
-- The secondary writes ONE row per game with provider = 'odds-api'
-- (LINE_PROVIDER_SECONDARY). A whole market always comes from ONE book — never a
-- line from one book and a price from another — but the three markets of a
-- single game may come from three different books, and `bet_legs.provider` has
-- to be able to say which. Hence one TEXT column per market rather than one per
-- row. NULL on the primary's row, always: ESPN carries exactly one book and
-- `game_lines.provider` already names it. NULL on a secondary row means "that
-- market is not filled", which is what the price columns say too.
-- ---------------------------------------------------------------------------
ALTER TABLE game_lines ADD COLUMN spread_book TEXT NULL;
ALTER TABLE game_lines ADD COLUMN total_book  TEXT NULL;
ALTER TABLE game_lines ADD COLUMN ml_book     TEXT NULL;

-- ---------------------------------------------------------------------------
-- 2. When the secondary last TRIED, and failed, to fill this game.
--
-- Stamped ONLY for a game that still lacks a market AFTER a sweep has written
-- its rows, so the write cost is one row per genuinely unfillable game per
-- sweep rather than one per eligible game. Deliberately NOT INDEXED: the
-- candidate scan is already bounded by (league, kickoff_at) via
-- `idx_games_board`, and an index here would double the cost of every stamp for
-- a predicate that is never selective on its own.
-- ---------------------------------------------------------------------------
ALTER TABLE games ADD COLUMN secondary_tried_at INTEGER NULL;

-- ---------------------------------------------------------------------------
-- 3. The credit budget. EXACTLY ONE ROW, enforced by CHECK (id = 1).
--
-- The free tier is 500 credits per calendar month and every response carries
-- `x-requests-remaining`. That header is the authority; this row is the durable
-- memory of the last reading plus the rate limiters that stop a bug or an
-- outage spending the month in an afternoon.
--
-- NO READ-THEN-WRITE (CLAUDE.md rule 5). A sweep CLAIMS its credits with a
-- conditional UPDATE whose WHERE carries every guard — reserve, per-league
-- interval, cooldown — and `meta.changes = 1` is the permission to make the
-- call. Pessimistic on purpose: a request that times out has already been
-- debited, so an outage cannot overdraw us.
--
-- Concurrency: every sweep runs inside the `refresh` job lease (cron, admin
-- "Run refresh", and the per-game admin Refresh all take it), so the claim is
-- already serialised. The conditional UPDATE is the belt to that braces.
--
-- Per-league columns rather than a row per league because the balance is GLOBAL
-- and must be claimed atomically with the per-league cadence check, in ONE
-- statement. There are exactly two leagues (`LEAGUES`).
-- ---------------------------------------------------------------------------
CREATE TABLE secondary_budget (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  -- Last value of `x-requests-remaining`, decremented pessimistically before
  -- each request and overwritten by the header after each 2xx.
  remaining_credits    INTEGER NOT NULL CHECK (remaining_credits >= 0),
  -- When `remaining_credits` last came from a real response header. 0 = never.
  -- ALSO the throttle for the POST-FAILURE probe, which is exempt from
  -- `last_attempt_at` and from `cooldown_until` (§21.5): the failed request it
  -- follows has already been made, and the probe costs nothing.
  checked_at           INTEGER NOT NULL DEFAULT 0,
  -- When any CREDIT-SPENDING request was last claimed, either league. This is
  -- what throttles the daily reset probe to one per 24 h globally.
  last_attempt_at      INTEGER NOT NULL DEFAULT 0,
  -- Per-league sweep cadence floor (SECONDARY_MIN_SWEEP_INTERVAL_MS).
  nfl_last_sweep_at    INTEGER NOT NULL DEFAULT 0,
  ncaaf_last_sweep_at  INTEGER NOT NULL DEFAULT 0,
  -- Set on 429 and on any transport failure; no SWEEP claim succeeds before it.
  cooldown_until       INTEGER NOT NULL DEFAULT 0,
  -- How many failures in a row. The cooldown DOUBLES with it, from
  -- ODDS_API_COOLDOWN_MS up to ODDS_API_COOLDOWN_MAX_MS, so a provider that is
  -- down for a day costs ~18 credits to notice instead of 144. Cleared to 0 by
  -- a successful SWEEP or by the daily RESET probe — never by the post-failure
  -- probe, which fires right after a failure and would otherwise reset the
  -- counter every time and stop the cooldown ever doubling.
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- 'ok' | 'unauthorized' | 'rate_limited' | 'error'. Rendered by the admin view.
  last_status          TEXT,
  last_error           TEXT,
  updated_at           INTEGER NOT NULL DEFAULT 0
);

-- Seeded with the free tier's nominal allowance and `checked_at = 0`, i.e. "we
-- have never asked". The first response replaces it with the truth. Seeding 500
-- rather than 0 is what lets the very first sweep happen at all; seeding it too
-- HIGH is harmless because the reserve is checked against the header value from
-- the first response onwards, and the FREE probe re-reads it daily even if no
-- sweep ever runs.
--
-- THE 500 IS `ODDS_API_MONTHLY_CREDITS` (src/shared/constants.ts), literal here
-- because SQL cannot import it — which is exactly why that constant is in §3.1's
-- constants-of-record table and `tests/unit/docs.spec.ts` asserts it. It is a
-- SEED, not a policy: migrations never replay, so changing the constant does not
-- re-seed this row and does not need to; by then the row holds a real header
-- value. If the tier ever changes, change the constant and let the next response
-- correct the row. Do not write an 0008 to re-seed it.
INSERT INTO secondary_budget (id, remaining_credits) VALUES (1, 500);
