# SpicyBettingSimulator — Implementation Plan

Fake-money sports-betting simulator for a small group of friends. Real lines, real
odds, real payouts, **zero real money**. NFL + FBS college football. Every user gets
a fresh fake $1,000 per `(league, season)`.

- **Repo**: `wardcrazy01894/SpicyBettingSimulator`
- **Stack**: one Cloudflare Worker (Hono API + Cron Triggers + static assets) + D1 (SQLite) + React/TS/Vite SPA
- **Cost target**: $0/month — Workers Free + D1 Free
- **Data**: ESPN keyless "site" scoreboard API (DraftKings lines), behind a provider adapter
- **Status of this document**: architecture + milestones. Stubs exist; no business logic is implemented.

---

## 0. Table of contents

1. [Platform constraints that shape everything](#1-platform-constraints-that-shape-everything)
2. [Architecture overview](#2-architecture-overview)
3. [Data model](#3-data-model)
4. [Money, ledger and invariants](#4-money-ledger-and-invariants)
5. [Odds math spec](#5-odds-math-spec)
6. [Bet lifecycle state machine](#6-bet-lifecycle-state-machine)
7. [Grading + settlement algorithm](#7-grading--settlement-algorithm)
8. [ESPN ingestion design](#8-espn-ingestion-design)
9. [Cron, leases and crash recovery](#9-cron-leases-and-crash-recovery)
10. [Auth design](#10-auth-design)
11. [API surface](#11-api-surface)
12. [Frontend design](#12-frontend-design)
13. [Testing strategy](#13-testing-strategy)
14. [Adversarial review: known failure modes and how we handle them](#14-adversarial-review-known-failure-modes-and-how-we-handle-them)
15. [Milestones](#15-milestones)
16. [Parallel-execution map](#16-parallel-execution-map)
17. [Risks and mitigations](#17-risks-and-mitigations)
18. [Spikes](#18-spikes)
19. [Open questions for Alex](#19-open-questions-for-alex)
20. [Out of scope for v1](#20-out-of-scope-for-v1)

---

## 1. Platform constraints that shape everything

Verified against Cloudflare docs on 2026-09-12. These are not trivia — three of them
drive real architectural decisions.

| Limit                                        | Free plan value                                                                                                           | Consequence for us                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker CPU time / invocation                 | **10 ms** (HTTP _and_ Cron)                                                                                               | **The single hardest constraint.** No server-side 100k-iteration PBKDF2. No parsing a full CFB week payload in one invocation. See §10 and §8.                                                                                                                                                 |
| Wall-clock duration                          | unlimited for HTTP while client connected; 15 min for cron                                                                | I/O waits are free; only CPU counts.                                                                                                                                                                                                                                                           |
| External subrequests / invocation            | 50                                                                                                                        | We make ≤ 2 ESPN calls per cron run. Non-issue.                                                                                                                                                                                                                                                |
| Subrequests to CF services (D1) / invocation | 1000 (raised 2026-02-11); the D1 docs page still says **50**                                                              | **We budget ≤ 40 D1 statements per invocation** and treat the 50 figure as binding until Spike S2 measures it. `batch()` is the tool.                                                                                                                                                          |
| D1 rows read                                 | 5,000,000 / day                                                                                                           | Plenty; see write budget in §8.6.                                                                                                                                                                                                                                                              |
| D1 rows written                              | 100,000 / day                                                                                                             | **Hard-enforced since 2026-09-01**: past the cap D1 returns errors, which blocks bet placement and settlement — not just the board. Budget + the three levers that keep us under it: §8.6.                                                                                                     |
| D1 storage                                   | 500 MB                                                                                                                    | ~1 season of both leagues ≈ a few MB.                                                                                                                                                                                                                                                          |
| D1 bound params / statement                  | 100                                                                                                                       | 10-leg parlay insert must stay under this — it does.                                                                                                                                                                                                                                           |
| D1 statement length                          | 100 KB                                                                                                                    | Fine.                                                                                                                                                                                                                                                                                          |
| D1 row size                                  | 2 MB                                                                                                                      | Fine.                                                                                                                                                                                                                                                                                          |
| Worker requests                              | 100,000 / day                                                                                                             | Static asset requests **do not** invoke the Worker when `run_worker_first` is an allow-list (see §2.3), so page loads are free.                                                                                                                                                                |
| Cron triggers                                | included; minimum interval 1 min. Docs are inconsistent on the cap (5 per account vs 3 per Worker)                        | We use exactly **3**, which satisfies the stricter reading. Do not add a fourth without re-checking.                                                                                                                                                                                           |
| `crypto.subtle` PBKDF2 iterations            | Cloudflare documents a 100,000 cap; **local workerd 1.20260911 did not enforce it** (M3 measured 210k succeeding in-pool) | The design does not rely on the cap either way: §10.1's 10 ms CPU budget is the reason the heavy KDF runs in the browser. Our server KDF is 1,000 iterations. Worker-project tests still use precomputed `dk` vectors (a 210k derivation in-pool is slow, and production may enforce the cap). |

**D1 has no interactive transactions.** `db.batch([...])` is the only atomicity
primitive: statements execute sequentially, and if any statement errors the whole
sequence is rolled back. Everything that must be atomic is expressed as exactly one
`batch()`, using conditional `WHERE` guards and DB-level `CHECK`/`UNIQUE`
constraints instead of read-modify-write.

---

## 2. Architecture overview

### 2.1 One Worker, three entry points

```
                     ┌──────────────────────────────────────────┐
 browser ──────────► │ Cloudflare Worker (single script)        │
                     │                                          │
   GET /  /bets  ... │  assets binding (SPA, index.html fallback)│  ← never runs JS
   /api/*            │  fetch()  → Hono router                  │
   cron              │  scheduled() → jobs: refresh/settle/maint │
                     └────────────┬────────────┬────────────────┘
                                  │            │
                                  ▼            ▼
                            ┌──────────┐   ┌──────────────────┐
                            │ D1 (DB)  │   │ ESPN site API    │
                            └──────────┘   │ (ScoreProvider / │
                                           │  OddsProvider)   │
                                           └──────────────────┘
```

### 2.2 Layering (strict, enforced by tsconfig project references)

| Layer       | Directory     | May import                    | Platform globals                                                                |
| ----------- | ------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| Pure domain | `src/shared/` | nothing but itself            | **none** (no `fetch`, no `Request`, no DOM). Compiles under `lib: ES2023` only. |
| Worker      | `src/worker/` | `src/shared`, Workers runtime | Workers                                                                         |
| Web         | `src/web/`    | `src/shared`, DOM             | DOM                                                                             |

`src/shared` holds everything that a reviewer will want unit tests for: odds math,
grading, parlay pricing, validation, the ESPN payload → domain mapper, and the
API request/response type contracts. It is platform-free by construction, which is
also what makes `tsc -b` project references clean.

### 2.3 Static assets vs `/api/*`

`wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "./dist/client",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]
}
```

- `run_worker_first` as an **array** means: only those paths reach the Worker.
  `/api/whatever` is guaranteed to hit Hono (so an unknown API path returns our JSON
  404, not `index.html`).
- Everything else is served by the assets router; unmatched paths fall back to
  `index.html`, which is what an SPA deep-link like `/leaderboard` needs.
- Because non-`/api` requests never invoke the Worker, page loads cost **zero**
  Worker requests. That is why the 100k/day request budget is a non-issue.

### 2.4 Provider adapter

`src/worker/providers.ts` defines `ScoreProvider` and `OddsProvider`. `EspnProvider`
implements both from one scoreboard response (ESPN returns scores and odds in the
same payload). A future `TheOddsApiProvider` would implement `OddsProvider` only and
be composed with `EspnProvider` for scores. **Not implemented in v1** — the interface
exists so that `ingest.ts` never mentions ESPN directly.

Key adapter contract: `fetchSlate(league, target) → ProviderSlate` where
`ProviderSlate = { games: ProviderGame[]; lines: ProviderLine[]; fetchedAt: number }`.
Parsing lives in `src/shared/espn.ts` (pure, takes a already-parsed JSON value);
HTTP lives in `src/worker/espn.ts`. This split is what makes the parser unit-testable
against `docs/samples/*.json` with no network and no Workers runtime.

---

## 3. Data model

Full DDL is in `migrations/0001_init.sql` — that file is the source of truth; this
section explains the _why_.

### 3.1 Conventions

- **All timestamps are `INTEGER` epoch milliseconds, UTC.** No ISO strings, no
  `DATETIME`. Comparisons are integer comparisons; there is no parsing and no
  timezone ambiguity anywhere in the backend.
- **All money is `INTEGER` cents.** No floats ever touch a money column.
- **All point lines are `INTEGER` tenths of a point** (`line_tenths`): `-3.5 → -35`,
  `o50.5 → 505`. Football lines are always multiples of 0.5, so tenths is exact and
  grading is pure integer arithmetic. See §5.4.
- **All American prices are `INTEGER`** (`-110`, `+164` → `164`), and the American
  integer is the _only_ price representation that is ever persisted. Exact
  decimal odds exist only in memory, as a BigInt rational derived from that
  integer. **No rational is ever written to a column** — see §3.2 (`bets`) and §5.2
  for why that is a correctness requirement, not a style choice.
- IDs are opaque `TEXT`. User/session/bet/leg/ledger ids are UUIDv4
  (`crypto.randomUUID()`). Game ids are `"<league>:<providerEventId>"` e.g.
  `"nfl:401872656"` — provider-scoped so an id collision between leagues or a future
  provider is impossible.
- `bankrolls.id` is **deterministic**: `"<userId>:<league>:<season>"`. That makes lazy
  bankroll creation a plain `INSERT OR IGNORE` — idempotent, no read-then-write race.

### 3.2 Tables

**`users`** — one row per friend.
`id, username` (lowercased, `UNIQUE`), `display_name` (original case), `kdf_version`,
`client_iterations`, `server_salt BLOB(16)`, `server_iterations`, `password_hash BLOB(32)`,
`is_admin`, `is_disabled`, `created_at`, `updated_at`.
Storing the KDF parameters per row is what makes a future parameter bump migratable
without a forced reset (§10.4).

**`sessions`** — `id` is the **SHA-256 hex of the session token**, never the token
itself, so a D1 dump does not hand an attacker live sessions. Plus `user_id`,
`created_at`, `expires_at`, `last_seen_at`. Index on `expires_at` for pruning.

**`auth_throttle`** — `key TEXT PRIMARY KEY` (`u:<username>` or `ip:<sha256-prefix>`),
`window_start`, `fail_count`, `locked_until`. One upsert per failed login. §10.5.

**`games`** — the canonical game row.
Notable columns:

- `kickoff_at` — **mutable**; ESPN can reschedule.
- `original_kickoff_at` — written once on insert, never updated. Used by the
  "postponed too long → void" rule (§7.5) so a game that gets pushed a month out
  doesn't hold bets hostage forever.
- `status` — our own enum `scheduled | in_progress | final | postponed | canceled | unknown`,
  mapped defensively from ESPN (§8.3). `unknown` is bettable=false and gradeable=false.
- `home_*` / `away_*` denormalized team id/abbr/name/logo/score. Denormalized on
  purpose: there is no `teams` table in v1 because we never query by team, and a
  join per game card would cost rows-read for no benefit.
- `first_seen_at`, `last_seen_at` — `last_seen_at` powers "ESPN dropped this game"
  detection (§7.5).
- `week`, `season`, `season_type` from ESPN — `week` is the authoritative grouping
  key for the NFL Thu–Mon week, so we never have to compute week boundaries ourselves.

Indexes: `(league, kickoff_at)` for the board, `(status, kickoff_at)` for the
settlement/maintenance sweeps.

**`game_lines`** — current line snapshot, `PRIMARY KEY (game_id, provider)`.
One row per game per book with all six prices as columns
(`spread_home_tenths/price`, `spread_away_tenths/price`, `total_tenths`,
`total_over_price`, `total_under_price`, `ml_home_price`, `ml_away_price`) plus
**two** timestamps:

- `captured_at` — the moment any price last **changed**. This is what a bet leg
  snapshots as `line_captured_at`, so the provenance stamp means something.
- `seen_at` — the moment we last **confirmed** the book still offers this line.
  Bettability staleness is measured against this.

They are separate because of the compare-and-skip upsert (§8.5): if `captured_at`
doubled as the confirmation stamp, skipping the write for an unchanged line would
make that line look stale and silently pull it off the board.

_Why one wide row instead of a row per market/side_: rows-written is a metered,
capped resource (100k/day). One row per game per refresh instead of six cuts our
biggest write stream by 6×. Nulls mean "this market is not offered", which happens in
CFB (big favourites often have no moneyline).

_Why a separate table instead of columns on `games`_: refreshing scores must not
rewrite the line columns and vice versa, and a second provider is a second row rather
than a schema migration.

**`bankrolls`** — `id` (deterministic), `user_id`, `league`, `season`,
`balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0)`, timestamps,
`UNIQUE(user_id, league, season)`.
The `CHECK` is the real overdraft protection — see §4.

**`ledger`** — append-only, the source of truth for money.
`id, bankroll_id, kind, ref_id, bet_id, amount_cents (signed), created_at, memo`
with `UNIQUE(bankroll_id, kind, ref_id)`.
`kind ∈ {deposit_initial, bet_stake, bet_payout, bet_refund, admin_adjust}`.
`ref_id` is the **idempotency key**: the bet id for bet-related kinds, the literal
`'init'` for the opening deposit, a caller-supplied UUID for admin adjustments.
Four triggers (§4.2): a `BEFORE INSERT` value guard that `INSERT OR IGNORE`
cannot suppress, an `AFTER INSERT` that applies the amount to
`bankrolls.balance_cents`, and `BEFORE UPDATE` / `BEFORE DELETE` blocks.

**`bets`** — `id, user_id, bankroll_id, league, season, bet_type, leg_count,
stake_cents, american_price, potential_payout_cents, status, payout_cents,
placed_at, earliest_kickoff_at, settled_at, cancelled_at, settle_run_id,
settle_attempts, settle_error, replaces_bet_id, replaced_by_bet_id, created_at,
updated_at`.

- **There is NO stored decimal-odds rational, deliberately.** A 10-leg parlay
  numerator can reach 20+ digits (10 legs at −101 gives `201^10 ≈ 1.08e23`), and
  GCD reduction does not save coprime prices. An SQLite `INTEGER` column
  _silently coerces_ such a value to `REAL` — verified:
  `INSERT price_num = 166798809782010000000000` → `typeof(price_num) = 'real'`,
  i.e. a float in a money column, violating the project's first rule. `bind()`
  is worse still: it takes a JS `number`, so the real ceiling is `2^53`
  (9.0e15), not `i64` — `41^10 = 1.34e16` fits an i64 and _still_ loses
  precision on bind. The price of a bet is therefore **always recomputed from
  `bet_legs.american_price`** via `priceFromLegs()`. One source of truth, and
  `americanToPrice()` is a total, lossless function of a small bounded integer.
- `american_price` is display only, `CHECK (abs(...) <= 100000000)`.
- `potential_payout_cents` and `payout_cents` are
  `CHECK (... BETWEEN 0 AND 100000000)`. `MAX_PAYOUT_CENTS = 100_000_000`
  ($1,000,000) is a genuine product rule — every sportsbook caps payouts — that
  doubles as the _proof_ these columns can never exceed `2^53` and never become
  `REAL`. A bet whose payout would exceed it is rejected at placement with
  `409 PAYOUT_LIMIT_EXCEEDED`, and the comparison happens in BigInt **before**
  any `Number` conversion, so an astronomically priced parlay never produces a
  lossy `number` even transiently.
- `season` is derived from the legs' own `games` rows, never from a wall clock
  (§4.4).
- `settle_attempts` / `settle_error` are the head-of-line-blocking guard (§7.1).
- `earliest_kickoff_at` is denormalized **for indexing, sorting and display
  only**. It is a placement-time snapshot that ingestion never updates, so it is
  emphatically _not_ the authority for the cancel/edit lock — see §6 and §14.2.
- `replaces_bet_id` / `replaced_by_bet_id` give edit lineage, so "My Bets" can show
  "edited from …" and an auditor can follow the chain.
- Partial index
  `idx_bets_pending ON bets(settle_attempts, earliest_kickoff_at) WHERE status='pending'`
  keeps the settlement sweep cheap as history grows _and_ supports the
  `settle_attempts ASC` ordering that defeats head-of-line blocking.

**`bet_legs`** — **the immutable line snapshot**. One row per leg:
`id, bet_id, leg_index, game_id, league, market, side, line_tenths,
american_price, provider, line_captured_at, snapshot_at, kickoff_at_snapshot,
home_abbr, away_abbr, result, graded_at`.

- `american_price` is a small bounded integer
  (`CHECK abs(...) BETWEEN 100 AND 100000`) and **is** the price snapshot. The
  exact rational is derived from it on demand; storing both would be two sources
  of truth that can drift.
- `line_tenths` is stored **from the bettor's side's perspective** (`home -3.5 → -35`,
  `away +3.5 → +35`, `over 50.5 → 505`, `under 50.5 → 505`; `NULL` for moneyline).
  Grading therefore never has to know which side "owns" the sign.
- `provider`, `line_captured_at`, `snapshot_at` are the provenance trio: which
  book, when that book's price last _changed_ (`game_lines.captured_at`, not a
  "we polled it" stamp), and when the user locked it in.
- `home_abbr`/`away_abbr` are denormalized so a settled bet renders identically
  forever even if a team is renamed or the game row is pruned.
- `UNIQUE(bet_id, game_id)` is the DB-level enforcement of "no two legs from the same
  game in a parlay". `UNIQUE(bet_id, leg_index)` keeps ordering stable.
- `result`/`graded_at` are **NULL until the whole bet settles** (see §7.3).

**`job_locks`** — `name PRIMARY KEY, lease_until, run_id, updated_at`. §9.2.

**`job_runs`** — `id, job, trigger ('cron'|'admin'), started_at, finished_at,
status, stats (JSON TEXT), error`. Bounded by the maintenance job.

**`ingest_targets`** — the ingestion work queue. §8.4.
`id PRIMARY KEY` (`"<league>:<kind>:<key>"`), `league`, `kind ('week'|'date')`,
`key`, `window_start_at`, `window_end_at`, `priority`, `next_run_at`,
`last_run_at`, `last_status`, `last_error`, `consecutive_failures`, `games_seen`.

**v1 uses `kind='date'` for BOTH leagues**, key `YYYYMMDD` in US Eastern. A
week-keyed target is unsafe: `<season>-<week>` cannot distinguish regular-season
week 1 from Wild Card week 1, so `nfl:week:2026-1` collides and the NFL
postseason — and CFB bowls, which Q5 puts explicitly in scope — would either be
unreachable or would overwrite regular-season rows. A date target also needs no
knowledge of the league calendar at all: the planner just walks the date range,
so postseason works with zero special-casing. `'week'` stays a legal `CHECK`
value so a later optimisation needs no migration; nothing constructs one in v1.

### 3.3 What we deliberately did _not_ model

- No `teams` table (denormalized into `games`; no query needs it).
- No `line_history` table (bet snapshots are the historical record that matters, and
  a history row per game per refresh would be our largest write stream). Listed as
  future work.
- No `weeks` table (ESPN's `week.number` is authoritative).
- No `leagues`/`seasons` tables (a `CHECK` constraint and a config constant).

---

## 4. Money, ledger and invariants

### 4.1 Invariants (each enforced by the database, not by application code)

| Invariant                                                          | Enforcement                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Balance is never negative                                          | `BEFORE INSERT ON ledger` trigger `RAISE(ABORT)` (unsuppressable, §4.2) **plus** `CHECK(balance_cents >= 0)` on `bankrolls` |
| No ledger row against a non-existent bankroll                      | same `BEFORE INSERT` trigger (`COALESCE(..., -1)`)                                                                          |
| Balance always equals the sum of its ledger rows                   | `AFTER INSERT ON ledger` trigger is the _only_ writer of `balance_cents`                                                    |
| Ledger is append-only                                              | `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT)`                                                                     |
| A bet is paid at most once                                         | `UNIQUE(bankroll_id, kind, ref_id)` on `ledger`                                                                             |
| A bet is refunded at most once                                     | same unique key, `kind='bet_refund'`                                                                                        |
| Exactly one opening deposit per bankroll                           | same unique key, `kind='deposit_initial'`, `ref_id='init'`                                                                  |
| Stake ≥ $1.00                                                      | `CHECK(stake_cents >= 100)` on `bets`                                                                                       |
| Payout ≤ `MAX_PAYOUT_CENTS` (so no money column can become `REAL`) | `CHECK(potential_payout_cents BETWEEN 0 AND 100000000)` and the same on `payout_cents`                                      |
| A leg price is a small bounded integer                             | `CHECK(abs(american_price) BETWEEN 100 AND 100000)` on `bet_legs`                                                           |
| 1–10 legs                                                          | `CHECK(leg_count BETWEEN 1 AND 10)` + validation                                                                            |
| No duplicate game in a parlay                                      | `UNIQUE(bet_id, game_id)` on `bet_legs`                                                                                     |

The point of pushing these into DDL: a settlement bug becomes a failed `batch()`
(loud, rolled back, retried next run) instead of silent money creation.

### 4.2 The ledger triggers

```sql
-- (1a) EXISTENCE GUARD. An orphan ledger row is an internal bug.
CREATE TRIGGER ledger_bi_bankroll_exists BEFORE INSERT ON ledger
WHEN NOT EXISTS (SELECT 1 FROM bankrolls WHERE id = NEW.bankroll_id)
BEGIN
  SELECT RAISE(ABORT, 'ledger: unknown bankroll_id');
END;

-- (1b) FUNDS GUARD. An overdraft is a legitimate user state.
CREATE TRIGGER ledger_bi_sufficient_funds BEFORE INSERT ON ledger
WHEN EXISTS (SELECT 1 FROM bankrolls WHERE id = NEW.bankroll_id)
 AND (SELECT balance_cents FROM bankrolls WHERE id = NEW.bankroll_id) + NEW.amount_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'ledger: insufficient funds');
END;

-- (2) THE ONLY WRITER OF balance_cents.
CREATE TRIGGER ledger_ai_apply AFTER INSERT ON ledger BEGIN
  UPDATE bankrolls
     SET balance_cents = balance_cents + NEW.amount_cents,
         updated_at    = NEW.created_at
   WHERE id = NEW.bankroll_id;
END;

-- (3)(4) APPEND-ONLY.
CREATE TRIGGER ledger_bu_block BEFORE UPDATE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
CREATE TRIGGER ledger_bd_block BEFORE DELETE ON ledger BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
```

**Two triggers with distinct messages, not one with a compound `WHEN`.** They
describe different faults that must reach the user differently:

| Fault                       | Message                       | Maps to                                        |
| --------------------------- | ----------------------------- | ---------------------------------------------- |
| bankroll row does not exist | `ledger: unknown bankroll_id` | **`500 INTERNAL`** — always a bug              |
| balance would go negative   | `ledger: insufficient funds`  | `409 INSUFFICIENT_FUNDS` — a normal user state |

A single shared message would make `db.ts::isOverdraftError` classify an
orphan-bankroll bug as "insufficient funds" and hide it from us forever. `db.ts`
therefore exposes `isOverdraftError` **and** `isOrphanBankrollError`. The two
`WHEN` clauses are mutually exclusive, so SQLite's unspecified ordering between
multiple `BEFORE INSERT` triggers does not matter.

The existence test is a `NOT EXISTS`, not a `COALESCE(..., -1)` arithmetic
sentinel: a _positive_ amount against an unknown bankroll (`-1 + 100000 >= 0`)
would sail past a sentinel, land an orphan ledger row, and leave the `AFTER`
trigger's `UPDATE` matching zero rows — the precise failure these triggers exist
to prevent. The `FOREIGN KEY` would normally catch it, but `INSERT OR IGNORE`
suppresses FK violations too.

**Why trigger (1) exists, and why it is not redundant with the `CHECK`.**
Relying on the `CHECK` alone has a real hole: an overdraft raised from _inside an
AFTER trigger_ is a constraint violation on `bankrolls`, and `INSERT OR IGNORE`
on `ledger` **suppresses it**. Verified in sqlite3 against the old schema:

```
INSERT OR IGNORE INTO ledger VALUES ('oi1','b1','bet_stake','ghost',NULL,-9999999,…);
  balance before 103644 | balance after 103644 | ledger rows +1
```

— the ledger row lands with **no balance effect, permanently**, in a table that
is append-only and therefore unrepairable. `SUM(ledger) = balance_cents` is
silently broken forever. `RAISE(ABORT)` from a `BEFORE INSERT` trigger is _not_
suppressed by `OR IGNORE`; verified against the new schema:

```
INSERT OR IGNORE … overdraft                          -> Error: ledger: insufficient funds
INSERT OR IGNORE … bankroll 'NOPE', amount -100       -> Error: ledger: unknown bankroll_id
INSERT OR IGNORE … bankroll 'NOPE', amount +100       -> Error: ledger: unknown bankroll_id
INSERT OR IGNORE … duplicate (bankroll, kind, ref_id) -> silently skipped, balance unmoved  ✓
```

That last line is the point of the split: **UNIQUE-based duplicate suppression
stays skippable (we want that for idempotency); value safety becomes
unskippable.**

Consequences worth spelling out:

- A stake insert of `-2500` against a bankroll holding `2000` aborts the
  statement, which **rolls back the entire `batch()`** — so the bet, its legs and
  the stake row all disappear. Insufficient funds is impossible to get wrong,
  even under concurrent placement from two tabs.
- A payout insert that collides on `UNIQUE(bankroll_id, kind, ref_id)` aborts the
  batch, so a double-settlement attempt can never move money. The settlement job
  catches that specific error and records "already settled" (§7.4).
- **House rule, also in CLAUDE.md**: never write `INSERT OR IGNORE` or
  `INSERT OR REPLACE` into `ledger`. Use
  `INSERT … SELECT … WHERE NOT EXISTS (…)`, which expresses the idempotency
  intent explicitly instead of relying on conflict resolution. Trigger (1) is the
  backstop for when somebody does it anyway; `tests/worker/bets.spec.ts` asserts
  all three behaviours above.

### 4.3 Money flows

| Event                   | Ledger rows written                                       |
| ----------------------- | --------------------------------------------------------- |
| Bankroll created (lazy) | `deposit_initial` `+100000`, `ref_id='init'`              |
| Bet placed              | `bet_stake` `-stake`, `ref_id=betId`                      |
| Bet won                 | `bet_payout` `+payout` (= stake + profit), `ref_id=betId` |
| Bet pushed / voided     | `bet_payout` `+stake`, `ref_id=betId`                     |
| Bet lost                | **none** — the stake row already debited it               |
| Bet cancelled by user   | `bet_refund` `+stake`, `ref_id=betId`                     |
| Admin adjustment        | `admin_adjust` `±n`, `ref_id=<uuid>`                      |

A loss writing no row is deliberate: it keeps the ledger a pure cash-movement log,
and `SUM(amount_cents) = balance_cents` stays trivially checkable
(`scripts/reconcile.mjs`, M7).

### 4.4 Lazy season rollover

`GET /api/bankroll`, `GET /api/games`, and `POST /api/bets` all call
`ensureBankroll(userId, league, season)`, a 1-statement `batch` prelude:

```sql
-- The bankroll may use OR IGNORE: it is not the ledger, and a duplicate is the
-- only failure mode.
INSERT OR IGNORE INTO bankrolls (id, user_id, league, season, balance_cents, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5);

-- The ledger may NOT. `OR IGNORE` on this table can swallow a value-guard
-- failure (§4.2); express idempotency explicitly instead.
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT ?6, ?1, 'deposit_initial', 'init', NULL, 100000, ?5, 'season opening balance'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledger
    WHERE bankroll_id = ?1 AND kind = 'deposit_initial' AND ref_id = 'init');
```

Both keys are deterministic, so this is idempotent and concurrency-proof (the
`UNIQUE` index is still there if two runs race past the `NOT EXISTS`). The
bankroll starts at `0` and the trigger raises it to `100000` — the balance is
never written directly by application code.

**Season provenance.** `bets.season` is **never** guessed. It is read from the
legs' own `games` rows inside placement (`resolveBetScope`), and every leg must
share one `(league, season)` or the bet is rejected with `MIXED_LEAGUE_PARLAY` /
`MIXED_SEASON_PARLAY`. So a January-2027 bowl bet is charged to the 2026
bankroll, permanently and by construction.

`currentSeason` — used only to _default_ the board and the bankroll view — is the
season of the **next game to kick off** (`MIN(kickoff_at) >= now − BOARD_LOOKBACK_MS`),
falling back to the most recent game when nothing is upcoming. It is deliberately
not `MAX(games.season)`: once 2027 preseason lands in August 2027, `MAX` would
point a January-2027 bowl at the 2027 bankroll.

---

## 5. Odds math spec

Implemented in `src/shared/odds.ts`. **All of it is exact integer/BigInt arithmetic.
No `number` division is used in any code path that produces a cent.**

### 5.1 Representation

American price `A` (integer, `|A| >= 100`) → decimal odds as an exact rational
`{ num, den }` (BigInt):

```
A >= +100:  num = A + 100,   den = 100
A <= -100:  num = |A| + 100, den = |A|
```

Check: `-110 → {210, 110}` = 1.909090…; `+164 → {264, 100}` = 2.64;
`+100 → {200, 100}` = 2.0.

ESPN sometimes emits `"EVEN"` / `"PK"` / `"pk"`; the parser normalizes these to
`+100` and `0.0` respectively. Anything else unparseable → the market is dropped for
that game (never guessed).

### 5.2 Parlay pricing

```
parlayPrice(legs) = { num: Π legs[i].num, den: Π legs[i].den }
```

BigInt, so no precision loss. Worst case (10 legs, price magnitude ≤ 100000) gives
a 24-digit numerator — trivial for BigInt.

**This is exactly why the product is never persisted.** Two hard limits sit below
a 24-digit integer:

| Limit                   | Value                        | What happens                                                                                                                                    |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite `INTEGER` column | i64, ≈ 9.2e18                | Silently stores it as `REAL` instead. Verified: `INSERT price_num=166798809782010000000000` → `typeof = 'real'`. A **float in a money column**. |
| D1 `bind()`             | JS `number`, `2^53` ≈ 9.0e15 | Loses precision _before_ SQLite ever sees it. `41^10 = 1.34e16` fits an i64 and still binds wrong.                                              |

GCD reduction is not a fix: `(21/11)^10` reduces to 1.67e13 (fine), but ten legs
at −101 give `201^10 ≈ 1.08e23` with nothing to cancel.

So: `bets` stores no rational at all, and the price of a settled or pending bet is
**recomputed from `bet_legs.american_price`** with `priceFromLegs()` every time it
is needed. `bet_legs.american_price` is `CHECK (abs(...) BETWEEN 100 AND 100000)`,
and `americanToPrice()` is total and lossless on that domain, so recomputation is
bit-identical to the value used at placement. One source of truth, no drift,
nothing that can degrade to `REAL`.

### 5.2b Payout cap

`MAX_PAYOUT_CENTS = 100_000_000` ($1,000,000). Every real sportsbook caps
payouts; here it also _proves_ that `potential_payout_cents` and `payout_cents`
fit in both an SQLite `INTEGER` and a JS `number` with ~7 orders of magnitude to
spare, so those money columns can never become `REAL` either.

A bet whose payout would exceed the cap is rejected at placement with
`409 PAYOUT_LIMIT_EXCEEDED`. The comparison is made **in BigInt, before any
`Number` conversion**, so an absurdly priced parlay never materialises as a lossy
`number` even transiently. `CHECK (... BETWEEN 0 AND 100000000)` on both columns
is the DB-level backstop.

### 5.3 Payout

```
payoutCents(stakeCents, price) = (BigInt(stakeCents) * price.num) / price.den     // BigInt division truncates
profitCents = payoutCents - stakeCents
```

BigInt `/` truncates toward zero and all operands are non-negative, so this **is**
floor. Result is converted to `number` only at the end (max value ≈ 6.4e7 cents for a
$1000 10-leg parlay — far below `Number.MAX_SAFE_INTEGER`).

**Why not floats.** Choosing this regression vector is subtle, and the obvious
candidates are traps. There are two common float formulations of decimal odds —
`1 + 100/|A|` and `(|A|+100)/|A|` — and they are _not_ always the same double. A
vector that only breaks one of them is useless: an implementation written the
other way passes it by luck. (`460¢ @ −115` is exactly such a trap: `1 + 100/115`
gives 859, `215/115` gives 860. Do not use it.)

The headline vector is an ordinary football parlay at the **minimum stake**, and
it breaks both:

```
3-leg parlay  -110 / +120 / -105
  exact rational : 9471000/1155000, which reduces to exactly 41/5 = 8.2
  stake 100¢ ($1.00, = MIN_STAKE_CENTS)
    exact : floor(100n * 9471000n / 1155000n) = 820   ✓
    float : Math.floor(100 * 8.2)             = 819   ✗   (both formulations)
```

**Divergence is stake-dependent, and that is the real lesson.** On this same
parlay — every value below computed, none estimated:

| stake ¢ | exact      | float  |          |
| ------- | ---------- | ------ | -------- |
| 100     | **820**    | 819    | diverges |
| 1000    | 8200       | 8200   | agrees   |
| 1500    | **12300**  | 12299  | diverges |
| 25000   | **205000** | 204999 | diverges |
| 50000   | **410000** | 409999 | diverges |
| 100000  | **820000** | 819999 | diverges |

A previous revision of this plan asserted "stake 1000¢ → 820, float 819". That is
wrong three times over (the payout at 1000¢ is 8200, not 820; the two agree at
that stake; and the quoted rational was wrong), and it was simultaneously
enshrined in this document, the `odds.ts` docblock and the TDD contract — where it
would have made a _correct_ implementation fail its own regression test. It is
called out rather than silently deleted because the lesson generalises: **an
arithmetic claim that is not pasted from a REPL does not belong in a spec.**

Other dual-breaking vectors, all computed:
`-110/+164/-112` at 100¢ → exact **954**, float 953;
`185¢ @ −370` → exact **235**, float 234;
`746¢ @ −2984` → exact **771**, float 770.
And a single-formulation trap worth knowing: `5000¢ @ +164` → exact 13200, but
`1 + 164/100` gives 13199 while `264/100` gives 13200.

At typical straight-bet prices the float path often agrees with the exact one.
Say that out loud rather than pretending floats are always wrong: the value of
exact arithmetic here is the _guarantee_, not the empirical hit rate. A book that
is right 99.99% of the time is a book that shorts a friend a cent and cannot
explain why.

`tests/unit/odds.spec.ts` pins every vector above plus a property test sweeping
every `stake ∈ [100, 200000]` against a BigInt oracle for a set of prices, and a
test asserting that the two float formulations disagree with each other — which is
itself the argument.

### 5.4 Worked examples (these are the test vectors)

Every row below was produced by a REPL, not by hand. Profit = payout − stake.

| Case                              | Price rational           | Decimal    | Stake ¢ | Payout ¢                             | Profit ¢ | Display  | Float?                    |
| --------------------------------- | ------------------------ | ---------- | ------- | ------------------------------------ | -------- | -------- | ------------------------- |
| Straight −110                     | 210/110                  | 1.909091   | 2500    | **4772**                             | 2272     | −110     | agrees                    |
| Straight +164                     | 264/100                  | 2.640000   | 5000    | **13200**                            | 8200     | +164     | `1+164/100` gives 13199   |
| 3-leg −110/−110/+150              | 11025000/1210000         | 9.111570   | 1000    | **9111**                             | 8111     | **+811** | agrees                    |
| …leg 3 pushes → 2 legs            | 44100/12100              | 3.644628   | 1000    | **3644**                             | 2644     | **+264** | agrees                    |
| …all legs push                    | 1/1                      | 1.000000   | 1000    | **1000**                             | 0        | —        | agrees                    |
| 10-leg −110                       | (210/110)^10             | 643.081618 | 100000  | **64308161**                         | 64208161 | +64208   | agrees                    |
| **Regression** −110/+120/−105     | 9471000/1155000 (= 41/5) | 8.200000   | **100** | **820**                              | 720      | **+720** | **819 — both diverge**    |
| …same parlay, max stake           | 9471000/1155000          | 8.200000   | 100000  | **820000**                           | 720000   | +720     | **819999 — both diverge** |
| **Regression** −110/+164/−112     | 11753280/1232000         | 9.540000   | 100     | **954**                              | 854      | +854     | **953 — both diverge**    |
| **Regression** long straight      | 470/370                  | 1.270270   | 185     | **235**                              | 50       | −370     | **234 — both diverge**    |
| **Regression** very long straight | 3084/2984                | 1.033512   | 746     | **771**                              | 25       | −2984    | **770 — both diverge**    |
| Over the cap: 10 legs @ +2000     | (2100/100)^10            | 1.67e13    | 100000  | **rejected** `PAYOUT_LIMIT_EXCEEDED` | —        | —        | —                         |

Two sanity checks a reader can apply to this table without a REPL, and which an
earlier revision failed: **profit is never negative on a winning bet**, and a
payout at a positive American price is always more than double the stake.

Note the 10-leg −110 row: 64,308,161¢ is the largest payout reachable from the
full $1,000 bankroll at realistic prices, and it sits comfortably under
`MAX_PAYOUT_CENTS` (100,000,000¢). The cap only bites on genuinely absurd
parlays, like ten +2000 legs.

### 5.5 Decimal → American (display only)

```
num >= 2*den :  +round( 100*(num-den) / den )
else         :  -round( 100*den / (num-den) )
```

`round` is half-up on the magnitude, done in BigInt (`(10x + 5) / 10`). This value is
**display only** — it is stored in `bets.american_price` for rendering and is never an
input to a payout computation.

### 5.6 Implied probability and hold (display only)

```
impliedProb(price) = den / num          (a float; UI only)
hold(marketPrices) = Σ impliedProb - 1
```

Example: CIN −198 / TB +164 → 0.66443 + 0.37879 = 1.04322 → **4.32% hold**. Shown on
the game card as a nerd stat; never used in grading.

### 5.7 Grading arithmetic (integer tenths)

```
spread:  margin10 = (sideScore*10 + line_tenths) - (oppScore*10)
         margin10 > 0 → win;  < 0 → loss;  == 0 → push
total:   sum10 = (home + away) * 10
         over:  sum10 > line_tenths → win; < → loss; == → push
         under: mirrored
ml:      sideScore > oppScore → win;  < → loss;  == → push (NFL ties)
```

Because half-point lines are exactly representable in tenths, `== 0` is a real,
reachable, exact comparison. No epsilon anywhere.

---

## 6. Bet lifecycle state machine

```
                       ┌──────────────────────────────────────┐
                       │             pending                  │
        POST /api/bets │  (stake debited, legs snapshotted)   │
   ────────────────────►                                      │
                       └───┬────────┬────────┬────────┬───────┘
                           │        │        │        │
     user cancel/edit,     │        │        │        │  all legs graded
     only while            │        │        │        │  by settlement job
     now < earliest_kickoff│        │        │        │
                           ▼        ▼        ▼        ▼
                     ┌─────────┐ ┌─────┐ ┌──────┐ ┌──────┐
                     │cancelled│ │ won │ │ lost │ │ push │   (+ void)
                     └─────────┘ └─────┘ └──────┘ └──────┘
                        refund   payout   nothing  refund
```

- **Terminal states**: `won`, `lost`, `push`, `void`, `cancelled`. No transitions out.
- `push` = every decided leg pushed (straight: the one leg pushed).
- `void` = the bet resolved with no live legs because game(s) were cancelled — paid
  out identically to `push` (stake returned). Kept as a distinct status so the UI and
  the record line can say "voided" and so `void` bets are excluded from W-L-P and ROI.
- `cancelled` = user-initiated, before lock. Excluded from every stat.
- **Edit** is not a transition: it is `cancel(old) + place(new)` inside a single
  `batch()`, linked by `replaces_bet_id`/`replaced_by_bet_id`. The new bet re-validates
  against **current** lines and current kickoff times (§11.4).

**Lock rule**: a pending bet may be cancelled or edited iff **every leg's current
`games` row** satisfies `status = 'scheduled' AND kickoff_at > now + BET_CUTOFF_BUFFER_MS`.

Read that carefully, because it is easy to implement wrong and the SQL in §14.2
is written to match: **`bets.earliest_kickoff_at` is not part of the guard.** It
is a placement-time snapshot that ingestion never updates. If ESPN moves a game
two hours earlier and it kicks off, `earliest_kickoff_at` is still comfortably in
the future — so a guard written against that column alone lets a user watch the
first quarter go badly and then cancel for a full refund. The guard must be a
`NOT EXISTS` over `bet_legs JOIN games`. `earliest_kickoff_at` survives only as an
index/sort key and as the `lockAt` the UI displays.

`BET_CUTOFF_BUFFER_MS = 60_000` (1 minute). Rationale in §14.1.

---

## 7. Grading + settlement algorithm

Job name: `settle`. Cron `5-59/15 * * * *` (:05, :20, :35, :50). Also
`POST /api/admin/jobs/settle`.

### 7.1 Select settleable bets (1 query)

```sql
SELECT b.id, b.bankroll_id, b.stake_cents, b.bet_type
  FROM bets b
 WHERE b.status = 'pending'
   AND b.settle_attempts < :maxAttempts        -- head-of-line guard
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = b.id
        AND g.status NOT IN ('final','canceled')
   )
 ORDER BY b.settle_attempts ASC, b.earliest_kickoff_at ASC
 LIMIT :chunk;                       -- chunk = 20
```

**Head-of-line blocking.** A bet can match this query and _still_ grade
`pending`: every game is final, but a score never parsed, or a status is
`unknown`. With a plain `ORDER BY earliest_kickoff_at LIMIT 20`, twenty such bets
at the head of the queue would be re-selected every 15 minutes forever and
**nothing behind them would ever settle**. So:

- `bets.settle_attempts` (INTEGER, default 0) and `bets.settle_error` (TEXT) are
  in `0001` — added before the freeze precisely because retrofitting them later
  would mean a migration on a live money table.
- A selected-but-ungradeable bet increments `settle_attempts` and records
  `settle_error`. **That single UPDATE is the only thing a `pending` outcome ever
  writes**; it touches no money, no bet status and no leg results.
- `ORDER BY settle_attempts ASC` pushes repeat offenders behind fresh work.
- At `MAX_SETTLE_ATTEMPTS = 96` a bet leaves the selection set and is reported in
  `job_runs.stats.stuck[]` for a human. It stays `pending` — money is never
  silently forfeited.

**Why 96, and how the counter resets.** 96 attempts at the 15-minute settle
cadence is **24 hours** (computed: 96 × 15 / 60 = 24.00 h). An earlier value of 5
gave up after **1.25 h**, which is comfortably inside the window in which a
briefly malformed ESPN score is plausible — and, worse, nothing reset it, so a
transient feed glitch could park a bet permanently with no documented way out.
Both halves are now fixed:

1. **Automatic reset, every run.** The first statement of every settle run is:

   ```sql
   UPDATE bets SET settle_attempts = 0, settle_error = NULL
    WHERE status = 'pending' AND settle_attempts > 0
      AND EXISTS (SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
                   WHERE l.bet_id = bets.id
                     AND g.updated_at > bets.settle_attempted_at);
   ```

   `bets.settle_attempted_at` exists in `0001` for exactly this. The moment ESPN
   republishes a sane score — which bumps `games.updated_at` via the ingest
   upsert — the bet gets a fresh 24-hour budget on the very next run. One
   statement per run, and it normally matches zero rows. This relies on
   `games.updated_at` advancing **only on a real data change** (§8.5 L1 `CASE`),
   never on the 6-hour L3 "still here" touch; otherwise the 96 cap is unreachable
   and `stuck[]` never fires.

2. **Manual reset.** `POST /api/admin/bets/:id/retry-settlement` (§11.6) zeroes
   the counter, for the case where the game row itself needed fixing.

A _partially_ final parlay never enters this path at all: it fails the
`NOT EXISTS`, is never selected, and costs zero writes.

A parlay with 3 finals and 2 in-progress legs does not match → **stays pending**, no
partial payout, no partially-written state. That is the whole answer to "partially
graded parlay".

`postponed` deliberately does _not_ appear in the `IN` list: a postponed game keeps
its bet pending until either it is played (→ `final`) or the maintenance job converts
it to `canceled` (§7.5).

### 7.2 Load legs (1 query)

```sql
SELECT l.*, g.status, g.home_score, g.away_score
  FROM bet_legs l JOIN games g ON g.id = l.game_id
 WHERE l.bet_id IN (…)          -- ≤ 20 ids, ≤ 100 bound params OK
 ORDER BY l.bet_id, l.leg_index;
```

**The line comes from `l.*` (the snapshot). Only `status`/`home_score`/`away_score`
come from `games`.** The exact price is
`priceFromLegs(legs.map(l => l.american_price))`; there is no stored rational to
read (§5.2). There is no code path anywhere in `settle.ts` that reads
`game_lines`. This is enforced by a lint-visible module boundary: `settle.ts` does not
import the `game_lines` accessor at all, and `tests/worker/settle.spec.ts` includes a
test that mutates `game_lines` after placement and asserts the payout is unchanged.

### 7.3 Grade (pure function, `src/shared/grading.ts`)

```
gradeLeg(leg, game) -> 'win' | 'loss' | 'push' | 'void' | 'pending'
  game.status === 'canceled'                    -> 'void'
  game.status !== 'final'                       -> 'pending'
  scores not finite integers                    -> 'pending'   (log + skip; never guess)
  otherwise                                     -> §5.7

gradeBet(bet, legs) -> BetOutcome
  if any leg 'pending'                          -> { status: 'pending' }          // no writes
  if any leg 'loss'                             -> { status: 'lost',  payout: 0 }
  live = legs where result === 'win'
  if live.length === 0:
      allVoid = every leg is 'void'
      -> { status: allVoid ? 'void' : 'push', payout: stake }
  price = Π live[i].price
  payout = floorDiv(stake * price.num, price.den)
  -> { status: 'won', payout }
```

Note the ordering: **a losing leg beats everything**, evaluated before push removal —
a parlay with 1 loss and 4 pushes still loses. And a straight bet is just the
1-leg case of the same function; there is no separate straight code path.

### 7.4 Persist — one `batch()` per bet, idempotent by construction

```sql
-- 1. conditional transition, stamped with this run's id.
--    NOTE `american_price = :effectiveAmerican` — see "Re-pricing" below.
UPDATE bets
   SET status         = :outcomeStatus,
       payout_cents   = :payout,
       american_price = :effectiveAmerican,
       settled_at     = :now,
       settle_run_id  = :runId,
       updated_at     = :now
 WHERE id = :betId AND status = 'pending';

-- 2. per-leg results, only if *this run* won the transition
UPDATE bet_legs SET result = :r, graded_at = :now
 WHERE bet_id = :betId AND leg_index = :i
   AND EXISTS (SELECT 1 FROM bets WHERE id = :betId AND settle_run_id = :runId);
   -- (repeated per leg, ≤ 10)

-- 3. money, only if this run won the transition and only when payout > 0
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT :ledgerId, b.bankroll_id, 'bet_payout', b.id, b.id, :payout, :now, :memo
  FROM bets b
 WHERE b.id = :betId AND b.settle_run_id = :runId AND b.status = :outcomeStatus;
```

Three independent layers of idempotency, on purpose:

1. `WHERE status='pending'` — a second concurrent run's UPDATE matches 0 rows.
2. `settle_run_id = :runId` guard on steps 2 and 3 — a run that _lost_ the race
   writes nothing, because the row now carries the winner's run id.
3. `UNIQUE(bankroll_id, 'bet_payout', bet_id)` on `ledger` — if 1 and 2 were both
   somehow defeated, the insert aborts the batch and no money moves.

**Re-pricing, and why `american_price` must be written back.** Deleting the
stored rational (§5.2) made `bets.american_price` the only persisted price, and it
is written once at placement from _all_ legs. A parlay with a pushed leg is paid
at the price of the surviving legs only — so without this write-back, the
canonical worked example in §5.4 would pay **3644¢** while `BetView.americanPrice`
still read **+811** and `decimalOdds` still read **9.112**, forever. The user
would see a price they were never paid.

So: `:effectiveAmerican = priceToAmerican(priceFromLegs(legs.filter(r => r === 'win')))`,
computed in-process from the surviving legs' `american_price` integers, and
persisted in statement 1. Persisted history beats recompute-on-read here — the
ledger already makes the payout auditable, and the displayed price should be the
one that was paid, not one re-derived by whatever the read path happens to
implement. `BetView.decimalOdds` is derived from `americanPrice` for display.

Corollaries, both stated so nothing downstream looks like a latent bug:

- **`:payout` is guaranteed ≤ `MAX_PAYOUT_CENTS`.** Every legal American price has
  decimal odds strictly > 1 — the minimum over the whole legal domain
  `[-100000, -100] ∪ [100, 100000]` is **1.001**, at `A = -100000` (computed) — so
  dropping pushed or voided legs _strictly shrinks_ the product. Hence
  `payout_cents ≤ potential_payout_cents ≤ MAX_PAYOUT_CENTS` always holds, and the
  `CHECK` on `payout_cents` can never abort a settlement batch. Worked:
  3-leg 9111¢ ≥ 2-leg-after-push 3644¢ ≥ all-push 1000¢ = stake.
- For a `push` / `void` outcome the effective price is `1/1` and
  `american_price` is written as `100` (even money) with `payout = stake`.
- A `lost` bet keeps its placement price: there are no surviving legs to re-price
  from, and the price it was _offered_ is the honest thing to display.

Statement count per bet: `1 + legCount + (payout>0 ? 1 : 0)` ≤ 12 for a settled
bet (10-leg parlay: 1 + 10 + 1). A **deferred** bet (§7.1) writes exactly **1**
statement — the `settle_attempts` / `settle_attempted_at` / `settle_error` UPDATE —
and no batch. A run therefore issues `1 (reset sweep) + 1 (select) + 1 (load legs)

- ≤20 batches`= **23 D1 calls** if a batch counts as one, or **243 statements**
worst case if it counts per-statement — which is why Spike **S2** must confirm
the accounting before we raise`chunk` above 20. With ≤ 10 users the realistic
  volume is a few bets per run.

**If the Worker dies mid-run**: each bet's transition + leg results + payout are one
atomic batch, so every bet is either fully settled or fully pending. Bets not yet
reached are simply picked up by the next run 15 minutes later. There is no
"half-settled" state to repair. The lease (§9.2) expires on its own.

### 7.5 Maintenance sweeps (job `maintenance`, daily `30 8 * * *`)

These convert "stuck" games into settleable ones so that money is never frozen
forever:

| Situation                           | Detection                                                                                                                   | Action                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Game postponed and never replayed   | `status='postponed' AND now > original_kickoff_at + VOID_AFTER_MS (7d)`                                                     | set `status='canceled'`, `status_detail='auto-void: postponed >7d'` → legs void next settle run          |
| ESPN dropped the game from the feed | `status IN ('scheduled','in_progress','unknown') AND now > original_kickoff_at + VOID_AFTER_MS AND last_seen_at < now - 2d` | same                                                                                                     |
| Game stuck `in_progress`            | `status='in_progress' AND now > kickoff_at + 12h AND last_seen_at < now - 6h`                                               | leave; alert via `job_runs.stats.stuck[]` (do **not** auto-void a game that might just be a feed glitch) |
| Expired sessions                    | `expires_at < now`                                                                                                          | delete                                                                                                   |
| Auth throttle rows                  | `window_start < now - 1d`                                                                                                   | delete                                                                                                   |
| `job_runs` history                  | keep newest 200 per job                                                                                                     | delete                                                                                                   |

Every auto-void writes a `job_runs.stats` entry naming the game id, so it is visible
in `GET /api/admin/jobs`.

---

## 8. ESPN ingestion design

### 8.1 Endpoints we call

| League | URL                                                                                                    | Notes                                                  |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| NFL    | `{BASE}/apis/site/v2/sports/football/nfl/scoreboard?dates={YYYYMMDD}&limit=100`                        | Per ET date.                                           |
| NCAAF  | `{BASE}/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates={YYYYMMDD}` | FBS only (`groups=80` also covers bowls). Per ET date. |

`{BASE}` is the `ESPN_BASE_URL` var (default `https://site.api.espn.com`), pointed
at the local fixture server in dev via `.dev.vars` (§15 M1).

**Neither URL sends `seasontype`.** Doing so would filter out postseason games
that fall on a date inside the regular-season calendar, and vice versa.

**Why both leagues are fetched by ET DATE, not by week.** Two reasons, and
_neither of them is CPU_:

1. **Correctness — postseason.** A week-keyed target id is `<season>-<week>`,
   which cannot distinguish regular-season week 1 from Wild Card week 1. Bowl and
   playoff games are explicitly in scope (§19 Q5), so a week key either collides
   or forces the planner to learn the league calendar and switch `seasontype`
   itself. A date key sidesteps the whole problem: the planner walks dates and
   never needs to know what a "week" is.
2. **Write budget — refresh granularity.** An NFL Sunday (13 games) and an NFL
   Thursday (1 game) do not want the same cadence. A week target forces Sunday's
   15-minute live cadence onto all five days, and D1 row-writes are our scarcest
   metered resource (§8.6). Per-date targets let a quiet Tuesday sit at +6h.

Measured ET buckets for the committed samples, which is what these targets look
like in practice:

```
NFL    { 20260909: 1, 20260910: 1, 20260913: 13, 20260914: 1 }
NCAAF  { 20260910: 1, 20260911: 5, 20260912: 80 }
```

Cost: roughly 4 NFL requests per week instead of 1, against a budget of 50
external subrequests _per invocation_ and ≤ 2 calls per run. Irrelevant.

**Correction — CPU was never the reason.** An earlier draft of this plan claimed
that splitting CFB by date "caps a single parse at ~60 events, ~1 MB" and thereby
rescued the 10 ms CPU budget. That was wrong on both counts and is corrected here
rather than quietly deleted:

- The CFB Saturday is **93% of the week** (80 of 86 events), so date-splitting
  saves ~7% of the parse, not half of it.
- `JSON.parse` of the full 1.3 MB file measures **~2.0 ms** (20-iteration mean,
  local V8). Even allowing several times that on Cloudflare's hardware, parsing
  is not the thing that will blow a 10 ms budget.

The real CPU unknown is what comes _after_ the parse: mapping ~86 events to rows
and building ~172 bound statements. **Spike S1 is re-scoped to measure map + bind

- `batch()`, not parse**, and the mitigation ladder is re-ordered accordingly
  (§17 R1).

### 8.2 Unit of work

An `ingest_targets` row is one request, and in v1 there is exactly one shape:

- `nfl:date:20260913` → all NFL games on ET date 2026-09-13
- `ncaaf:date:20260912` → all FBS games on ET date 2026-09-12

**VERIFIED against the live ESPN API on 2026-09-13** (Spike S4 parts (a) and (b)
— see §18). `dates=YYYYMMDD` with **no `seasontype` parameter** buckets by US
Eastern calendar day:

| Request                         | Result                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `nfl/scoreboard?dates=20260913` | **13 games**, including SNF `DAL@NYG` at `2026-09-14T00:20Z` |
| `nfl/scoreboard?dates=20260914` | **exactly 1 game**, MNF `DEN@KC` at `2026-09-15T00:15Z`      |
| `nfl/scoreboard?dates=20260915` | **0 games**                                                  |

A Sunday-night kickoff lands in Sunday's key and a Monday-night kickoff in
Monday's key — exactly what `etDateKey()` produces, and exactly what §8.2 assumes.
Omitting `seasontype` filters nothing out. This also matches re-bucketing the
committed samples offline through `America/New_York`, which reproduces the
groupings above precisely.

The key is computed with `Intl.DateTimeFormat` and an explicit `America/New_York`
timezone, **once per planner run**, not per game; `src/shared/time.ts` owns
`etDateKey(epochMs)`.

**Still an assumption, not a measurement:** that `dates=` reaches _postseason_
games (NFL Wild Card in January, CFB bowls under `groups=80`). That cannot be
probed until January. If it turns out postseason needs `seasontype=3`, the remedy
is additive — the planner emits a second target per date carrying `seasontype=3`
— and does not change the key scheme. Tracked as S4(c) and flagged in the M8
runbook.

### 8.3 Parsing (pure, `src/shared/espn.ts`)

Everything is defensive. The parser takes `unknown`, walks with narrowing helpers,
and returns `{ games, lines, warnings }` — **it never throws on a malformed event, it
skips it and appends a warning**. Warnings land in `job_runs.stats.warnings` (capped
at 20) so schema drift shows up in the admin view instead of as a 500.

Status mapping — driven by `status.type.state` + `completed`, not by string equality
on `name`, so `STATUS_FINAL_OT`-style variants and unknown future names degrade
safely:

```
state === 'post' && completed === true            -> 'final'
name  ∈ {STATUS_POSTPONED}                        -> 'postponed'
name  ∈ {STATUS_CANCELED, STATUS_FORFEIT}         -> 'canceled'
state === 'in'                                    -> 'in_progress'   (incl. STATUS_HALFTIME)
state === 'pre'                                   -> 'scheduled'
anything else                                     -> 'unknown'
```

`unknown` games are never bettable and never gradeable. That is the safe default.

Odds extraction, per the verified payload shape
(`competitions[0].odds[]`, provider `DraftKings` id `100`):

```
spread home : pointSpread.home.close.line  + .odds   (fallback .open)
spread away : pointSpread.away.close.line  + .odds
total       : total.over.close.line "o50.5" → 505    + total.over/under.close.odds
moneyline   : moneyline.home/away.close.odds
```

Rules:

- Pick the odds entry with `provider.id === '100'`; if absent, take the entry with the
  lowest `provider.priority`; record the provider name on the row.
- `close` preferred, `open` as fallback, otherwise that market is `NULL`.
- `"o50.5"` / `"u50.5"` / `"+3.5"` / `"-3.5"` / `"EVEN"` / `"PK"` are all handled by
  `parseLineToTenths` / `parseAmericanPrice` with explicit unit tests.
- Cross-check: if `pointSpread.home.close.line` is missing but the top-level
  `spread` number is present, use `spread` (home perspective). `details` (`"CIN -3.5"`)
  is **never** parsed — it is a display string and abbreviation-dependent.
- Sanity bounds: `|line_tenths| <= 1000` (±100 pts), `100 <= |american| <= 100000`.
  Out-of-range → drop the market + warning.

**Scores, teams and venue** — the part that is easy to get subtly wrong:

```
score          competitors[].score is a STRING in all 204 competitors across both
               samples, and BEFORE KICKOFF IT IS "0", NOT ABSENT.
               => parseScore(raw): null unless typeof raw is 'string'|'number'
                  AND Number.isInteger(Number(raw)) AND the trimmed text is
                  non-empty. NEVER `Number(x) || null` — that maps a real 0–0
                  scoreline to null and would make a 0–0 final ungradeable.
               A pre-game "0" is stored as 0; that is harmless because grading
               keys off status === 'final', never off the score being non-zero.
home/away      competitors[].homeAway. Exactly one of each is required; any other
               shape (0, 1 or 3 competitors) skips the event with a warning.
team fields    team.{id, abbreviation, displayName, logo}. id, abbreviation and
               displayName are REQUIRED (skip + warn if missing); logo is
               nullable. Stored denormalized on `games`.
rank           competitors[].curatedRank.current. Kept only when 1..25; 99 and
               anything else becomes NULL. NFL competitors have no curatedRank.
neutral site   competitions[0].neutralSite. Absent => false.
season/week    event.season.{year,type} and event.week.number, taken from the
               EVENT, not from the payload root, because a date query can return
               events from two different weeks (and, in January, two different
               season types).
kickoff        event.date, ISO with no seconds ("2026-09-13T17:00Z").
               parseIsoToEpochMs returns null on anything unparseable, which
               skips the event rather than storing NaN.
```

### 8.4 Scheduling (`refresh` job, cron `*/15 * * * *`)

Each run:

1. **Plan** (cheap, no network): ensure an `ingest_targets` row exists for every
   `(league, ET date)` covering `now … now + 10d` — 2 leagues × ~11 dates ≈ 22
   rows, created once and then reused. Delete targets whose window ended more
   than 2 days ago and that have no non-final games. The planner needs no league
   calendar, which is what makes bowls and the NFL postseason free (§8.2).
2. **Pick** up to `REFRESH_TARGETS_PER_RUN = 2` targets with `next_run_at <= now`.
   **The two slots are not interchangeable**:

   | Slot | Selection                                                                                      |
   | ---- | ---------------------------------------------------------------------------------------------- |
   | 1    | the most-due target overall, `ORDER BY priority ASC, next_run_at ASC` — in practice a live one |
   | 2    | **RESERVED**: the most-overdue target that has **no in-progress game** (line discovery)        |

   Without the reservation, a Saturday with a live CFB target and a live NFL
   target would consume both slots on all 96 runs and the other ~20 targets would
   **starve indefinitely** — `priority ASC, next_run_at ASC` does not prevent
   that, because live targets are perpetually the most due. Next week's CFB lines
   would simply never be discovered.

   Budget check, computed: a 10-day window is 11 ET dates × 2 leagues = **22
   targets**. Worst case 2 are live, leaving **20** discovery targets that each
   want a +6 h refresh = 4/day = **80 slot-uses/day**, against a supply of **96**
   — fits with 16 to spare. If two targets are live simultaneously they alternate
   in slot 1 and each gets a **30-minute** cadence; settlement tolerates that (it
   is a fake-money app, and the settle job runs independently of ingest).
   The reserved-slot query excludes the id slot 1 already claimed
   (`AND id <> :slot1Id`) — on a run with no live target slot 1's pick would
   otherwise satisfy slot 2's predicate too and the run would fetch the same URL
   twice. If the reserved slot finds no eligible non-live target it falls through
   to the general queue (same exclusion) so a run is never wasted.

3. For each: fetch → parse → upsert games (§8.5) → upsert `game_lines` → reschedule.

Reschedule interval, derived from what the target actually contains:

| Target contains                            | Next refresh                 |
| ------------------------------------------ | ---------------------------- |
| a game `in_progress`, or kickoff within 3h | +15 min (every run)          |
| a game kicking off within 48h              | +60 min                      |
| otherwise (line discovery for next week)   | +6 h                         |
| all games `final`/`canceled`               | +24 h, and drop after 2 days |

Failures: exponential backoff `min(15min * 2^consecutive_failures, 6h)`, capped at 8
failures before the target is parked at +6h and reported in `job_runs.stats`. **A
failed fetch or a parse error writes nothing to `games`/`game_lines`** — parse first,
into memory, then write. ESPN being down means stale data, never corrupt data.

### 8.5 Upserts — and the three write-budget levers

D1 free allows **100,000 rows written per UTC day, hard-enforced since
2026-09-01**: past the cap, D1 returns errors. That does not merely stale the
board — it blocks `INSERT INTO bets` and the settlement batch. Write budget is
therefore a **correctness** concern here, and the three levers below are v1
requirements, not future optimisations.

**L1 — compare-and-skip.** Every write's `WHERE` runs only when something
actually changed. When it does not fire, SQLite writes zero rows **and zero index
entries**.

**L1b — the A/B split (added in the M4 round-2 review).** L1 on its own is not
enough, and the reason is worth stating precisely, because the first
implementation shipped without it.

_Measured on miniflare D1_ — `meta.rows_written`, which counts the table row plus
every index entry the statement rewrote, i.e. the unit the 100k/day cap counts:

| Statement                                                                                  | rows_written |
| ------------------------------------------------------------------------------------------ | ------------ |
| `UPDATE games SET last_seen_at = ?`                                                        | **1**        |
| `UPDATE games SET last_seen_at = ?, status = status, kickoff_at = kickoff_at, week = week` | **4**        |
| `INSERT INTO games (...)` (a brand-new row)                                                | **6**        |

SQLite rewrites an index entry whenever the index's column appears in an
`UPDATE`'s `SET` list, **regardless of whether the value changed**. `games` has
three explicit indexes covering exactly three mutable columns —
`idx_games_board(league, kickoff_at)`, `idx_games_status(status, kickoff_at)`,
`idx_games_week(league, season, season_type, week)` — so a single statement
carrying the whole `SET` list costs 4 rows for **any** applied update, a
clock-only change and an L3 touch included. (An `INSERT` is 6 because it also
writes the `PRIMARY KEY` and `UNIQUE (provider, league, provider_event_id)`
autoindexes; an `UPDATE` touches neither.)

And for a **live** game `display_clock` changes on every single refresh, so
clause (b) always fires and L1 saves nothing at all. Measured: 86 CFB games live
across 96 refreshes with the clock moving each time = **33,196 rows/day** from
`games` alone, which is §8.6's "without the levers" figure, reached _with_ L1.

So each game is written as **two statements**:

```sql
-- (A) FULL upsert. New rows take the INSERT path. The DO UPDATE fires ONLY when
-- an INDEXED column really changed, so only genuine status/kickoff/week
-- transitions pay the 4-row price.
INSERT INTO games (...) VALUES (...)
ON CONFLICT(id) DO UPDATE SET
  kickoff_at    = excluded.kickoff_at,
  status        = excluded.status,
  status_detail = excluded.status_detail,
  period        = excluded.period,
  display_clock = excluded.display_clock,
  home_score    = COALESCE(excluded.home_score, games.home_score),
  away_score    = COALESCE(excluded.away_score, games.away_score),
  week          = COALESCE(excluded.week, games.week),
  last_seen_at  = excluded.last_seen_at,
  -- (A) fires only on a real transition, which IS a data change.
  updated_at    = excluded.updated_at
WHERE
  -- (a) never regress a final game; but do allow score corrections
  (games.status <> 'final' OR excluded.status = 'final')
  -- (b) an INDEXED column must actually differ
  AND (games.status, games.kickoff_at, COALESCE(games.week, -1))
      IS NOT
      (excluded.status, excluded.kickoff_at, COALESCE(COALESCE(excluded.week, games.week), -1));

-- (B) LIVE update. NO INDEXED COLUMN MAY APPEAR IN THIS SET LIST. 1 row written
-- for a clock, score or rank change, and 1 for an L3 "seen" touch.
UPDATE games SET
  period = ?, display_clock = ?,
  home_score = COALESCE(?, home_score), away_score = COALESCE(?, away_score),
  status_detail = ?,
  home_rank = ?, away_rank = ?, home_logo = ?, away_logo = ?,
  name = ?, short_name = ?, home_name = ?, away_name = ?,
  last_seen_at = ?,
  -- updated_at means "data changed", NOT "seen again": it advances only when the
  -- compare tuple differs. An L3 touch moves last_seen_at alone. This is what
  -- keeps §7.1's resetDeferredBets predicate honest — a touch must not hand a
  -- permanently-ungradeable bet a fresh 24 h budget every 6 h.
  updated_at = CASE WHEN <compare tuple> IS NOT <new values> THEN ? ELSE updated_at END
WHERE id = ?
  AND (status <> 'final' OR ? = 'final')          -- the same never-regress guard
  AND (<compare tuple> IS NOT <new values>
       OR last_seen_at < ? - 21600000);           -- L3, GAME_SEEN_TOUCH_MS 6h
```

(A) runs first, so when it applies it already carries the new values and (B) finds
nothing to do. The statement count per game doubles — an 86-game target is ~172
statements across ~5 chunked batches in one invocation, the one deliberate
exception to `db.ts`'s 40-per-invocation note — and the rows written collapse.

_Measured cost per kind of change_ (`tests/worker/ingest.spec.ts` asserts every
row of this table, against both the production accounting and an independent
`env.DB.batch` probe):

| Change                       | rows_written                       |
| ---------------------------- | ---------------------------------- |
| nothing changed              | **0**                              |
| clock only                   | **1**                              |
| score only                   | **1**                              |
| rank only                    | **1**                              |
| L3 "still here" touch        | **1** (`updated_at` does NOT move) |
| status transition            | **4**                              |
| status transition + rank     | **4 + 1**                          |
| kickoff reschedule           | **4**                              |
| first insert                 | **6**                              |
| final glitching to scheduled | **0** (both statements refuse)     |

**Deliberate omission from (B)'s compare tuple: `status_detail`.** It is in the
`SET` list but not in the tuple, so a change to _only_ the human-readable detail
string (e.g. `"Final"` → `"Final/OT"`) is skipped until something else changes or
the 6-hour touch fires. That is intentional — `status_detail` is cosmetic, it is
not read by grading or bettability, and including it would cost writes for no
behavioural gain. Noted here so it reads as a decision rather than an oversight.
`display_clock` _is_ in the tuple, because a stopped clock is a useful signal that
a game has stalled — and after the A/B split it genuinely does cost 1 row, so the
"drop `display_clock`" knob in §8.6 is now a last resort rather than a live
concern.

**Why ranks, logos and names are in (B).** They used to be in the `INSERT` column
list only, so a CFB game first seen on Monday wore Monday's rank all week — on a
board where the rank is the most visible thing about a matchup. None of them is
indexed, so refreshing them rides along in (B) for the 1 row it was already going
to cost.

**L2 — no line writes for non-scheduled games.** Measured on the committed
samples: **0 of 84** in-progress/final events carried odds, **16 of 16** scheduled
NFL events did. Writing `game_lines` for a live game is therefore pure waste. The
mapper drops those rows before they reach the batch (`lineRowsWorthWriting()`), so
a CFB Saturday afternoon — the single worst hour of our year — writes **no line
rows at all**.

**L3 — touch intervals.** "Still here" is not news. `games.last_seen_at` is bumped
only when older than `GAME_SEEN_TOUCH_MS` (6 h) and `game_lines.seen_at` only when
older than `LINE_SEEN_TOUCH_MS` (45 min). Worst case that is 4 and 32 writes per
game per day instead of 96, and staleness is still detected within 45 minutes
against a 3-hour `LINE_STALE_MS`.

Other upsert rules:

- `original_kickoff_at` is only in the `INSERT` column list, never in `DO UPDATE`.
- `neutral_site` is likewise INSERT-only, and that is a **decision**: ESPN sets it
  when the event is created, grading reads the `bet_legs` snapshot rather than
  this column, and putting it in the compare tuple would add a column that never
  moves. If ESPN is ever observed to correct it, it goes into (B) — where it
  costs 1 row — never into (A).
- `COALESCE` on scores means a feed that momentarily omits a score cannot null it
  out. (See §8.3 on why a pre-game `"0"` must not be treated as absent.)
- Clause (a) means an ESPN glitch reporting a completed game as `STATUS_SCHEDULED`
  cannot un-finalize it, and therefore cannot re-open betting on a played game.
  A final game is otherwise fully skipped, which is fine: `last_seen_at` is only
  consulted for non-final games.
- Games are **never deleted** while any `bet_legs` row references them (there is
  no `DELETE` path in v1; pruning is future work and must respect the FK).

`game_lines` — same shape, with the `captured_at` / `seen_at` split:

```sql
INSERT INTO game_lines (game_id, provider, ..., captured_at, seen_at)
VALUES (...)
ON CONFLICT(game_id, provider) DO UPDATE SET
  spread_home_tenths = excluded.spread_home_tenths, ...,
  -- captured_at advances ONLY when a price actually changed
  captured_at = CASE WHEN (game_lines.spread_home_tenths, ..., game_lines.ml_away_price)
                       IS NOT (excluded.spread_home_tenths, ..., excluded.ml_away_price)
                     THEN excluded.captured_at ELSE game_lines.captured_at END,
  seen_at = excluded.seen_at
WHERE (game_lines.spread_home_tenths, ..., game_lines.ml_away_price)
        IS NOT (excluded.spread_home_tenths, ..., excluded.ml_away_price)
   OR game_lines.seen_at < excluded.seen_at - 2700000;   -- LINE_SEEN_TOUCH_MS 45m
```

**When odds vanish at kickoff** (0 of 84 started games carried odds): we do **not**
delete or null the row. The last known line stays; `seen_at` simply stops
advancing. Bettability is decided by `games.status` + `kickoff_at`, not by line
presence, so a vanished line changes nothing about an in-flight game. For a
_still-scheduled_ game whose line the book pulled, `seen_at` goes stale and the
board hides that market once `now - seen_at > LINE_STALE_MS (3 h)` — rendering an
explicit "line unavailable" state rather than a silently missing button.

### 8.6 Request and write budget

**Requests.** `2 targets/run × 96 runs/day = 192 ESPN calls/day` absolute worst
case; typical is 60–100 because targets self-throttle to +6 h when nothing is
near. That is **≤ 2 external subrequests per invocation** against a limit of 50,
and well under the "< 20 calls/run" goal.

**Rows written.** This is the one that can actually break the app, so it is
budgeted from the worst real day rather than an average, and an earlier draft's
~3× under-estimate is corrected here.

_What the earlier draft got wrong:_ it assumed "~12 refreshes/day" when §8.4
mandates **+15 min (96 runs/day)** for any target containing a live game, and it
counted "2 indexes on games" when there are **three** — `idx_games_board`,
`idx_games_status`, `idx_games_week` — all of which cover columns in the
`DO UPDATE SET` list, so an unconditional upsert costs **4 rows per game**, not 2.

_Worst day, WITHOUT the levers (i.e. what we would have shipped):_

| Stream                           | Arithmetic                               | Rows                                   |
| -------------------------------- | ---------------------------------------- | -------------------------------------- |
| CFB Saturday `games`             | 86 games × 96 runs × 4 (row + 3 indexes) | **33,024**                             |
| NFL Sunday `games`               | 13 games × 96 × 4                        | 4,992                                  |
| `game_lines` (both)              | ~99 × 96 × 1                             | 9,504                                  |
| `ingest_targets`, sessions, bets | —                                        | ~1,000                                 |
| **Total**                        |                                          | **≈ 48,500 / day — 49% of a hard cap** |

Half the daily budget on one Saturday, with a whole Sunday still to come, is not a
safety margin. Hence L1/L2/L3 in §8.5.

_Worst day, WITH the levers — MEASURED, not modelled._ The CFB `games` line is
the one that used to be a guess; it is now the output of
`tests/worker/ingest.spec.ts`, which drives 96 refreshes of 86 CFB games in four
kickoff waves (scheduled → in_progress for 3.5 h → final), moving the clock on
**every** refresh, and sums `meta.rows_written`:

| Stream                              | Arithmetic                                               | Rows                          |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------- |
| CFB Saturday `games` + `game_lines` | **measured**: 86 games × 96 refreshes, A/B split         | **2,979**                     |
| NFL Sunday `games` + `game_lines`   | 13/86 of the above                                       | ~450                          |
| Other 8 date targets (quiet days)   | mostly 0 rows; L3 touches at 1 row each                  | ~500                          |
| `ingest_targets` reschedules        | 96 runs × 2 targets × 2 (row + `idx_ingest_targets_due`) | 384                           |
| bets / legs / ledger (10 users)     | —                                                        | < 500                         |
| sessions / throttle / job_runs      | —                                                        | < 300                         |
| **Total**                           |                                                          | **≈ 5,100 / day — 5% of cap** |

For reference, the same fixture run through the **single-statement** upsert this
replaces writes **6,978** rows; and the theoretical worst case of all 86 games
live for all 96 refreshes is **8,686** with the A/B split against **33,196**
without it. A typical weekday is a few hundred.

The dominant remaining term is one row per live game per refresh — irreducible,
because those are the real score and clock changes we need in order to grade bets.

**`display_clock` is no longer the knob to watch.** An earlier draft of this
section claimed "`display_clock` and `period` are not in any index, so a change
costs 1 row not 4". **That was wrong**, and it is the mistake the A/B split
exists to fix: the columns are indeed not indexed, but naming `status`,
`kickoff_at` and `week` in the same `UPDATE`'s `SET` list rewrites all three
indexes anyway, so a clock-only change cost **4** rows, not 1 (measured). With
(A) and (B) separated the claim is finally true — a clock change costs exactly 1
row — which demotes "drop `display_clock` from the comparison tuple" from a
likely next step to a last resort worth about 1,200 rows a Saturday.

**Observability, not faith.** Every `refresh` run records `rowsWritten` (summed
from D1's `meta.rows_written`, covering games, lines and the target reschedule)
and `rowsSkipped` in `job_runs.stats`. `GET /api/admin/jobs` folds a rolling-24h
`dayRowsWritten` total into every run's `stats` — inside `stats` rather than
beside it, because `api-types.ts` is frozen and `JobRunView.stats` is already
`Record<string, unknown>`. `tests/worker/ingest.spec.ts` carries the regression
assertion that 96 refreshes of the 86-game CFB Saturday write **< 5,000** rows,
cross-checked against an independent `env.DB.batch` probe, so a change that
silently defeats a lever fails CI rather than failing on a Saturday in November.

## 9. Cron, leases and crash recovery

### 9.1 Triggers

```jsonc
"triggers": { "crons": [
  "*/15 * * * *",      // refresh   :00 :15 :30 :45
  "5-59/15 * * * *",   // settle    :05 :20 :35 :50
  "30 8 * * *"         // maintenance, 08:30 UTC
]}
```

`scheduled(event)` dispatches on `event.cron`. Three small jobs rather than one big
one, because the 10 ms CPU limit is per invocation and staggering them means the
settle job never competes with a 1 MB `JSON.parse`. Settle runs 5 minutes after
refresh so it grades against freshly written scores.

### 9.2 Lease

```sql
INSERT INTO job_locks (name, lease_until, run_id, updated_at)
VALUES (:job, :now + :ttl, :runId, :now)
ON CONFLICT(name) DO UPDATE
   SET lease_until = excluded.lease_until, run_id = excluded.run_id, updated_at = excluded.updated_at
 WHERE job_locks.lease_until <= :now;
```

`meta.changes === 0` → someone else holds the lease → **exit immediately**, record a
`job_runs` row with `status='skipped'`. TTL: `refresh` 5 min, `settle` 5 min,
`maintenance` 10 min — all shorter than their cron period, so a crashed run's lease
always expires before the next scheduled run.

Release on the way out sets `lease_until = 0`. That is a _separate statement_ from
the one finalizing `job_runs` — they are different tables — but both go in the
**same `batch()`**, so a job can never be recorded as finished while still holding
its lease, or vice versa. On crash neither runs and the lease expires naturally.

**Crash-safety claim**: the only durable effects a job has are (a) idempotent upserts
of games/lines, (b) `ingest_targets.next_run_at` bumps, (c) per-bet atomic settlement
batches. None of these is a multi-step non-atomic mutation, so "died halfway" is
always recoverable by simply running again. See §7.4 for the settlement case
specifically.

### 9.3 Manual trigger

`POST /api/admin/jobs/:job` (`refresh | settle | maintenance`) runs the identical
function with `trigger='admin'`, takes the same lease, and returns the `job_runs` row
including stats. This is how we test in production without waiting 15 minutes, and
it is the documented recovery action if a job wedges.

CPU caution: the admin trigger runs in an HTTP invocation with the same 10 ms
budget. It returns `202` with the run id and does the work in `ctx.waitUntil()`
**only if** S1 shows it does not fit inline; otherwise it runs inline and returns
`200` with stats. Default implementation: inline, with `REFRESH_TARGETS_PER_RUN`
forced to 1 for admin runs. (`ctx.waitUntil` does not grant extra CPU — it grants
extra wall time — so if S1 comes back bad the real remedy is the R1 ladder, not
`waitUntil`.)

---

## 10. Auth design

Username + password, no email, no reset flow, invite-gated signup.

### 10.1 The 10 ms problem, stated plainly

Server-side PBKDF2-SHA256 at 100,000 iterations costs roughly 25–100 ms of CPU. The
Workers **Free** plan hard limit is **10 ms per invocation**, for HTTP requests and
cron alike. So the brief's "≥100k iterations, server-side" is **not achievable on the
free tier**. Three options were considered:

| Option                                                                   | Verdict                                                                                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side PBKDF2 at ~8k iterations (fits 10 ms)                        | Rejected — weak stretching _and_ consumes ~80% of the request's CPU budget, leaving nothing for routing/DB/JSON. One slow request away from 1102 errors. |
| Workers Paid ($5/mo, 30 s CPU)                                           | Rejected by the $0 constraint. Listed as open question Q1.                                                                                               |
| **Split KDF: heavy stretching in the browser, cheap hash on the server** | **Chosen.**                                                                                                                                              |

### 10.2 Split KDF (chosen)

```
client  (src/web/api/kdf.ts, browser WebCrypto)
  clientSalt = SHA-256("SBS-v1|" + username.toLowerCase())        // deterministic
  dk         = PBKDF2-SHA256(password, clientSalt, 210_000, 32B)  // ~200-400 ms in-browser
  POST { username, dk: hex(dk) }        over TLS

server  (src/worker/crypto.ts)
  hash = PBKDF2-SHA256(dk, users.server_salt, 1_000, 32B)         // ~0.3 ms CPU
  timingSafeEqual(hash, users.password_hash)
```

Properties, stated for the reviewer:

- **Total work factor against an offline attacker who steals the D1 file is still
  210,000 PBKDF2 iterations per password guess**, because the stolen `password_hash`
  can only be matched by candidate passwords run through the client KDF first. We did
  not weaken the KDF, we moved it.
- **A stolen DB does not yield a usable credential**: `dk` is not stored, only
  `PBKDF2(dk, server_salt, 1000)`. So an attacker cannot replay the DB contents
  against the login endpoint.
- **The salt is deterministic from the username, so there is no "fetch my salt"
  endpoint and therefore no user-enumeration oracle.** Login for a non-existent
  user runs a dummy PBKDF2 against a fixed decoy salt and returns the identical
  `401 INVALID_CREDENTIALS` in comparable time.
- **The cost of that, stated plainly: a deterministic salt is publicly derivable,
  so it permits PRE-BREACH precomputation.** `SHA-256("SBS-v1|alex")` can be
  computed by anyone, today, without ever touching our database — so an attacker
  can build a 210k-iteration rainbow table for likely usernames _in advance_ and
  have it ready the moment a dump leaks. A per-user random salt would force that
  work to start only after the breach. This is **not** parity with a random salt,
  and an earlier draft of this section wrongly implied it was.
  We accept it because: the attacker still pays 210k iterations per candidate
  password per username (it removes the _waiting_, not the _work_); there are
  fewer than a dozen usernames, all chosen by people who will be told to use a
  password manager; and the alternative — a `POST /api/auth/salt` endpoint — buys
  that back by handing out a user-enumeration oracle, which for a private
  friends-only app is the worse trade. Revisit if this ever has real users:
  the fix is a random salt plus a constant-time decoy salt
  (`HMAC(serverSecret, username)`) for unknown users, which preserves both
  properties at the cost of one extra round trip.
- **Transport**: `dk` is password-equivalent in transit. That is exactly the same
  exposure as sending the password itself, which is what every password form does, and
  it is protected by TLS (Workers is HTTPS-only). No regression.
- **Cost**: the browser pays ~300 ms on login/signup. Acceptable with a spinner;
  it is a login, not a hot path.
- **PBKDF2 iteration cap (documented 100,000; not enforced by local workerd
  1.20260911 — M3 measured 210k succeeding).** Irrelevant to the design: the
  split KDF exists because of the 10 ms CPU budget, not the cap. Worker-project
  tests still never derive a `dk` in-pool; they use vectors precomputed by
  `scripts/admin-hash.mjs` and exported from `tests/worker/setup.ts`.
- **Server salt still matters**: it prevents a precomputed `dk → hash` table across
  users and makes each row's 1,000 iterations independent.

Known trade-off (say it out loud): the server can no longer enforce a password policy
it cannot see, and a malicious client could send an arbitrary 32-byte `dk` instead of
deriving one. That is fine — `dk` _is_ the credential from the server's perspective,
and a client that wants to use a weak one is only hurting its own account. Minimum
password length is enforced client-side and documented as advisory.

### 10.3 Parameters

`src/shared/constants.ts`:

```
KDF_VERSION = 1
CLIENT_KDF = { algorithm: 'PBKDF2', hash: 'SHA-256', iterations: 210_000, keyLengthBytes: 32, saltPrefix: 'SBS-v1|' }
SERVER_KDF_ITERATIONS = 1_000
```

`GET /api/auth/kdf` returns the current client parameters (public, contains no
user-specific data — deliberately not an enumeration oracle).

### 10.4 Upgrading KDF parameters later

`users.kdf_version`, `client_iterations`, `server_iterations` are per-row. To bump to
v2: the client computes **both** `dk_v1` and `dk_v2` and posts both; the server
verifies against the user's stored version and, on success, rewrites the row with the
v2 hash inside the login batch. After a deprecation window the v1 branch is deleted.
Documented here so nobody has to invent it under pressure.

### 10.5 Sessions, cookies, CSRF, rate limiting

- Token: 32 random bytes, base64url. Cookie `sbs_session`, flags
  `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 d).
  `Secure` works on `http://localhost` (browsers treat localhost as a secure context);
  `COOKIE_SECURE=false` in `.dev.vars` exists as an escape hatch.
- Stored as `sessions.id = sha256hex(token)`. Lookup hashes the presented token.
- **Rolling expiry with a write budget guard**: `expires_at` is only extended (and
  `last_seen_at` written) if more than 24 h has elapsed since `last_seen_at`. Avoids a
  D1 write per request.
- Logout deletes the row. `POST /api/auth/logout-all` (admin/self) deletes all rows
  for the user.
- **CSRF posture**: `SameSite=Lax` already blocks cross-site cookie-bearing `POST`.
  On top of that every state-changing request must carry `X-SBS-Client: 1` (a header
  a cross-origin form cannot set without a preflight we will not grant) and, when an
  `Origin` header is present, it must equal the request's own origin. Violations →
  `403 CSRF_BLOCKED`. `GET`s are side-effect free.
- **Login rate limiting** (`auth_throttle`, D1): per `u:<username>` and per
  `ip:<sha256(cf-connecting-ip + IP_HASH_SALT)[0:16]>`, 15-minute windows. 10 failures
  → `locked_until = now + 15 min` → `429 RATE_LIMITED` with `Retry-After`. Successful
  login clears the username key. IP is hashed so the DB holds no raw IPs.
- Signup requires `inviteCode === env.INVITE_CODE` when that secret is set (compared
  with a constant-time comparison). If `INVITE_CODE` is unset, signup is open —
  `GET /api/health` reports `inviteRequired: false` so a misconfiguration is visible.
- **First user to sign up becomes admin**, implemented as a conditional insert inside
  the signup batch (`is_admin = CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END`
  evaluated in the same statement), so two simultaneous first signups cannot both win.
- No user enumeration anywhere: signup with a taken username returns the same
  `409 USERNAME_TAKEN` (this one is unavoidable and acceptable for a 10-person
  invite-only app — documented, not hidden); login/unknown-user is indistinguishable.

### 10.6 Admin password reset

`scripts/admin-hash.mjs <username> <password>` runs the _identical_ client KDF in Node
and prints a `wrangler d1 execute` statement. Because the derivation is deterministic
and versioned in `src/shared/constants.ts`, the script imports those constants rather
than duplicating them — a test (`tests/unit/kdf-parity.spec.ts`) asserts the Node and
browser derivations agree on a fixed vector.

---

## 11. API surface

All responses are JSON. All errors are
`{ "error": { "code": "<STABLE_CODE>", "message": "<human>", "details"?: {...} } }`
with codes enumerated in `src/shared/errors.ts`. All state-changing routes require the
`X-SBS-Client: 1` header. `Content-Type: application/json` required on bodies.

### 11.1 Public

| Method | Path            | Response                                                                                                                                                                                                                                                                                                                                             |
| ------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`   | `200 {ok, version, now, inviteRequired}` — no DB access                                                                                                                                                                                                                                                                                              |
| GET    | `/api/config`   | `200 {leagues, currentSeason:{nfl,ncaaf}, minStakeCents, maxParlayLegs, cutoffBufferMs, initialBankrollCents, maxPayoutCents}` — these field names match `ConfigResponse` in `src/shared/api-types.ts` exactly; `maxPayoutCents` exists because the bet slip calls `exceedsPayoutCap()` for pre-flight (§5.2b) and must not disagree with the server |
| GET    | `/api/auth/kdf` | `200 {version, algorithm, hash, iterations, keyLengthBytes, saltPrefix}`                                                                                                                                                                                                                                                                             |

### 11.2 Auth

| Method | Path                   | Body                                        | Success                                              | Errors                                                                                  |
| ------ | ---------------------- | ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/auth/signup`     | `{username, displayName?, dk, inviteCode?}` | `201 {user}` + cookie                                | `400 VALIDATION`, `401 BAD_INVITE_CODE`, `409 USERNAME_TAKEN`, `429 RATE_LIMITED`       |
| POST   | `/api/auth/login`      | `{username, dk}`                            | `200 {user}` + cookie                                | `400 VALIDATION`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_DISABLED`, `429 RATE_LIMITED` |
| POST   | `/api/auth/logout`     | —                                           | `204`                                                | —                                                                                       |
| POST   | `/api/auth/logout-all` | —                                           | `204` — revokes every session for the caller (§10.5) | `401 UNAUTHENTICATED`                                                                   |
| GET    | `/api/auth/me`         | —                                           | `200 {user}`                                         | `401 UNAUTHENTICATED`                                                                   |

`user = {id, username, displayName, isAdmin, createdAt}`.
`username`: 3–24 chars, `^[a-z0-9_]+$` after lowercasing. `dk`: exactly 64 lowercase
hex chars.

### 11.3 Games

| Method | Path             | Query                                                         | Response                                      |
| ------ | ---------------- | ------------------------------------------------------------- | --------------------------------------------- |
| GET    | `/api/games`     | `league` (req), `season?`, `week?`, `from?`, `to?`, `status?` | `200 {season, week, games: GameCard[]}`       |
| GET    | `/api/games/:id` | —                                                             | `200 {game: GameCard}` / `404 GAME_NOT_FOUND` |

```ts
GameCard = {
  id, league, season, week, kickoffAt, status, statusDetail,
  home: { teamId, abbr, name, logo, score }, away: {...},
  neutralSite: boolean,
  lockAt: number,                 // kickoffAt - cutoffBufferMs
  bettable: boolean,              // status==='scheduled' && now < lockAt && lines fresh
  lines: null | {
    provider: string,
    capturedAt: number,           // when the BOOK's price last CHANGED
    seenAt: number,               // when we last CONFIRMED the line exists
    stale: boolean,               // now - seenAt > LINE_STALE_MS
    spread: null | { homeTenths, homePrice, awayTenths, awayPrice },
    total:  null | { tenths, overPrice, underPrice },
    moneyline: null | { homePrice, awayPrice }
  }
}
```

Default window when `from`/`to` are absent: `now - 12h … now + 10d`, capped at 300
games. Requires auth (this is a private app; the whole API is behind a session except
§11.1).

### 11.4 Bets

**`POST /api/bets`**

```ts
{
  league: 'nfl'|'ncaaf',
  betType: 'straight'|'parlay',
  stakeCents: number,                       // integer, >= 100
  acceptLineChange?: boolean,               // default false
  legs: Array<{
    gameId: string,
    market: 'moneyline'|'spread'|'total',
    side: 'home'|'away'|'over'|'under',
    expected?: { americanPrice: number, lineTenths: number | null }
  }>
}
```

The client **never** sends the price it will be charged. The server reads the current
`game_lines` row and snapshots it. `expected` is an optional optimistic-concurrency
check: if it is supplied and differs from the server's current line, the request fails
`409 LINE_CHANGED` with `details.legs[i].current`, unless `acceptLineChange` is true.
This is how a real book behaves and it closes the "the screen said −110 but I got
−130" complaint.

Success `201 { bet: BetView }`. Error codes:
`400 VALIDATION` (stake, leg count, market/side mismatch, duplicate game in parlay,
straight with ≠1 leg, parlay with <2 legs), `404 GAME_NOT_FOUND`,
`409 GAME_NOT_BETTABLE` (status ≠ scheduled), `409 BETTING_CLOSED` (past `lockAt`),
`409 MARKET_UNAVAILABLE` (no line for that market, or `seenAt` stale),
`409 LINE_CHANGED`, `409 INSUFFICIENT_FUNDS`, `409 PAYOUT_LIMIT_EXCEEDED`
(potential payout above `MAX_PAYOUT_CENTS`), `409 MIXED_LEAGUE_PARLAY` and
`409 MIXED_SEASON_PARLAY` (v1: every leg must share one `(league, season)` so
exactly one bankroll is charged; `bets.season` is read from the legs' game rows,
never guessed — §4.4).

Server-side placement is **one `batch()`** (§14.2).

| Method | Path            | Notes                                                                                                                                                                                                                                 |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/bets`     | `?status=open\|settled\|all&league=&season=&limit=&cursor=`. Returns `BetView[]` with legs; for open bets each leg carries a live `projected: 'win'\|'loss'\|'push'\|'pending'` computed from the current game row (never persisted). |
| GET    | `/api/bets/:id` | `404 BET_NOT_FOUND` if not yours (not `403` — no existence oracle)                                                                                                                                                                    |
| DELETE | `/api/bets/:id` | Cancel + full refund. `409 BET_LOCKED`, `409 BET_NOT_PENDING`                                                                                                                                                                         |
| PUT    | `/api/bets/:id` | Edit = atomic cancel + place. Body identical to `POST`. Returns `200 {bet, replacedBetId}`. All `POST` errors plus `409 BET_LOCKED`.                                                                                                  |

`BetView = { id, league, season, betType, stakeCents, americanPrice, decimalOdds
(string, for display), potentialPayoutCents, toWinCents, status, payoutCents,
placedAt, earliestKickoffAt, lockAt, settledAt, cancellable, replacesBetId,
replacedByBetId, legs: BetLegView[] }`.

**`americanPrice` is the EFFECTIVE price, not always the placement price.** While
`status === 'pending'` it is what the bet was placed at. Once the bet settles,
§7.4's UPDATE writes back the price of the surviving (won) legs, so a parlay with
a pushed leg reports the price it was actually paid at rather than the one it was
placed at. `decimalOdds` is derived from `americanPrice` for display and is never
parsed back into arithmetic. `potentialPayoutCents` is frozen at placement (it is
what the slip promised); `payoutCents` is what was actually paid.

### 11.5 Bankroll, ledger, leaderboard

| Method | Path                                         | Response                                                                                                                                |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/bankroll?league=&season=`              | `200 {league, season, balanceCents, pendingStakeCents, equityCents, record:{w,l,p,v}, roi, settledCount}` (creates the bankroll lazily) |
| GET    | `/api/ledger?league=&season=&limit=&cursor=` | `200 {entries: LedgerEntry[], nextCursor}`                                                                                              |
| GET    | `/api/leaderboard?league=&season=`           | `200 {league, season, rows: LeaderboardRow[]}`                                                                                          |
| GET    | `/api/leaderboard/all-time`                  | `200 {rows: LeaderboardRow[]}` — summed across every league+season                                                                      |

**Leaderboard semantics (explicit, because this is the classic ambiguity):**

```
balanceCents       = settled cash on hand. Pending stakes are ALREADY DEDUCTED.
pendingStakeCents  = Σ stake of bets with status='pending'   ("exposure")
equityCents        = balanceCents + pendingStakeCents        (value if all open bets were voided)
record             = counts over SETTLED bets only: w=won, l=lost, p=push, v=void
                     cancelled bets are excluded entirely
roi                = (Σ payout - Σ stake) / Σ stake over bets with status ∈ {won, lost}
                     push and void are excluded from BOTH numerator and denominator
                     (standard sportsbook convention; a push is a no-action bet)
                     undefined (null) when the denominator is 0
```

**Ranking is by `balanceCents` descending**, tie-broken by `roi` then `username`. The
table also shows `equityCents` and `pendingStakeCents` so a leader with a lot of open
action is visible. Rationale: `balanceCents` is unambiguous and self-correcting;
ranking by equity would let someone "lead" purely by having money in flight.

All-time view sums `balanceCents` and `pendingStakeCents` across bankrolls and
recomputes `roi` from the pooled numerator/denominator (not an average of ROIs).

### 11.6 Admin (requires `users.is_admin = 1`)

| Method | Path                                   | Notes                                                                                                   |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin/jobs/:job`                 | `job ∈ {refresh, settle, maintenance}` → `200 {run}` or `409 JOB_LOCKED`                                |
| GET    | `/api/admin/jobs`                      | last 50 `job_runs`                                                                                      |
| GET    | `/api/admin/users`                     | list                                                                                                    |
| POST   | `/api/admin/users/:id/password`        | `{dk}` → resets                                                                                         |
| POST   | `/api/admin/users/:id/disabled`        | `{disabled: boolean}`                                                                                   |
| POST   | `/api/admin/bets/:id/retry-settlement` | zeroes `settle_attempts`/`settle_error` on a parked bet (§7.1). Never changes status or money.          |
| POST   | `/api/admin/reconcile`                 | recomputes `SUM(ledger) vs balance_cents` per bankroll, returns any drift (read-only; never auto-fixes) |

Non-admins get `404` on `/api/admin/*` (not `403`), so the surface is invisible.

---

## 12. Frontend design

React 19 + TypeScript + Vite, `react-router-dom` for routing, **no UI framework** —
one `styles.css` with CSS custom properties plus a handful of co-located
`*.module.css` files. Mobile-first: single column, 44px minimum tap targets, sticky
bet slip bar at the bottom on small screens.

### 12.1 Component tree

```
main.tsx
└── <App>                                   BrowserRouter + providers
    ├── <SessionProvider>                   { user, status, login, signup, logout }
    │   └── <ConfigProvider>                /api/config, cached for the session
    │       └── <BetSlipProvider>           slip state, persisted to localStorage
    │           ├── <AppShell>              header + <NavTabs> + <Outlet> + <BetSlipBar>
    │           │   ├── route "/"           <GamesPage>
    │           │   │   ├── <LeagueTabs league onChange>
    │           │   │   ├── <WeekPicker>
    │           │   │   └── <DayGroup date>            (grouped in the user's LOCAL tz)
    │           │   │       └── <GameCard game>
    │           │   │           ├── <TeamRow team score rank>
    │           │   │           └── <MarketButton market side line price selected>   ×6
    │           │   ├── route "/bets"       <MyBetsPage>
    │           │   │   ├── <BetFilterTabs open|settled>
    │           │   │   └── <WeekendGroup>              (local-tz weekend grouping)
    │           │   │       └── <BetCard bet>
    │           │   │           ├── <BetLegRow leg projected>
    │           │   │           └── <BetActions onCancel onEdit>   (hidden once locked)
    │           │   ├── route "/leaderboard" <LeaderboardPage>
    │           │   │   ├── <ScopeTabs nfl|ncaaf|all-time>
    │           │   │   └── <LeaderboardTable rows meDeltas>
    │           │   ├── route "/account"    <AccountPage>
    │           │   │   ├── <BankrollSummary>
    │           │   │   └── <LedgerList entries>
    │           │   └── route "/admin"      <AdminPage>      (admin only)
    │           └── <BetSlip>               modal/sheet
    │               ├── <SlipModeToggle straight|parlay>
    │               ├── <SlipLegRow leg onRemove>
    │               ├── <StakeInput cents quickChips>
    │               └── <SlipSummary price toWin payout />
    └── route "/login"                      <AuthPage>  (login + signup tabs)
```

### 12.2 State

Three contexts, each a `useReducer`; no Redux, no react-query.

- **SessionContext** — `{ status: 'loading'|'anon'|'authed', user }`. Bootstraps from
  `GET /api/auth/me`. A global `fetch` wrapper (`src/web/api/client.ts`) attaches
  `X-SBS-Client: 1`, `credentials: 'same-origin'`, parses the error envelope into a
  typed `ApiError`, and on `401` dispatches `SESSION_EXPIRED`, which bounces to
  `/login`.
- **BetSlipContext** — `{ mode, legs: SlipLeg[], stakeCents }`. Persisted to
  `localStorage` keyed by league so a refresh doesn't lose the slip. Validation
  mirrors `src/shared/validate.ts` (the _same_ pure functions the Worker uses) so the
  UI can grey out an invalid slip before submitting — the server still re-validates,
  the client copy is purely for UX.
- **Data fetching** — `useResource<T>(key, fetcher)` in `src/web/hooks/useResource.ts`:
  a ~60-line hook with in-memory cache, `refetch()`, stale-while-revalidate and an
  `invalidate(keyPrefix)` used after a successful bet mutation. Deliberately not a
  dependency.

### 12.3 Time handling in the UI

Everything from the API is epoch ms UTC. The UI formats with
`Intl.DateTimeFormat(undefined, {...})` — i.e. the viewer's local timezone, so a
friend in Denver sees Denver times.

- **Games board grouping**: primary group = `week` (authoritative from ESPN, which
  correctly spans Thu→Mon for the NFL); within a week, subgroup by the viewer's local
  calendar date.
- **My Bets "weekend" grouping**: group by `(league, season, week)` of the bet's
  earliest leg and label it "Week N — Sep 11–15" using local dates. Using ESPN's week
  number rather than a computed Sat/Sun boundary is what makes Thursday and Monday
  games land in the right bucket.
- Countdown to lock is rendered from `lockAt - Date.now()`; the client clock may be
  wrong, so the countdown is cosmetic and the button's disabled state is refreshed
  from the server's `bettable` flag on every board fetch. The server is the only
  authority on whether a bet is accepted.

### 12.4 Accessibility / mobile notes

Market buttons are real `<button>`s with `aria-pressed`; the slip is a
`role="dialog"` sheet with focus trapping; all interactive text is ≥16px to stop iOS
zoom-on-focus; the stake input is `inputMode="decimal"` and converted to cents by
`parseDollarsToCents` in `src/shared/validate.ts` (with its own tests for `"12.345"`,
`"1,000"`, `".5"`, `"12."`).

---

## 13. Testing strategy

TDD is mandatory: for every task below, the test file is written and failing before
the implementation.

**Project 1 — `unit` (node env, `tests/unit/`)**: everything in `src/shared/`.
No Workers runtime, instant feedback.

- `odds.spec.ts` — the §5.4 table verbatim; the `-110/+120/-105` dual-float
  regression (plus a test asserting the two float formulations disagree with each
  other); `MAX_PAYOUT_CENTS` enforcement checked in BigInt before any `Number`
  conversion; `priceFromLegs` round-tripping a 10-leg parlay bit-identically;
  BigInt round-tripping; `EVEN`/`PK` parsing; a property sweep against a BigInt
  oracle.
- `grading.spec.ts` — every market × win/loss/push, exact half-point pushes,
  integer-tenths edge cases, tie→push for ML, void, `pending` when a leg is not final,
  malformed scores → `pending`, loss-beats-push ordering in parlays.
- `espn.spec.ts` — parses both `docs/samples/*.json` end-to-end; asserts exact counts
  (NFL: 16 events, 14 scheduled all with odds, 2 final with none; CFB: 86 events,
  2 scheduled with odds, 84 in-progress/final with none); status mapping for all six
  ESPN states; malformed-event skipping; missing-market nulls; provider selection.
- `validate.spec.ts` — stake bounds, leg counts, duplicate-game rejection,
  market/side compatibility, dollar→cents parsing.
- `time.spec.ts` — `etDateKey` across a DST boundary and across UTC midnight.
- `kdf-parity.spec.ts` — Node WebCrypto derivation matches a hard-coded vector.

**Project 2 — `worker` (`@cloudflare/vitest-pool-workers`, `tests/worker/`)**: real
Miniflare D1 with `applyD1Migrations`, so the schema, the triggers and the `CHECK`
constraints are exercised for real. This is important: the money invariants live in
DDL, and a mock would not test them.

- `auth.spec.ts` — signup/login/logout/cookie flags, invite gate, first-user-admin,
  throttle lockout, CSRF header requirement, no-enumeration timing parity.
- `bets.spec.ts` — placement happy path; insufficient funds rolls back the _whole_
  batch (assert no orphan `bet_legs`); `BETTING_CLOSED` at `lockAt`; kickoff moved
  earlier blocks a new bet **and blocks cancel/edit even though
  `earliest_kickoff_at` is still in the future**; `LINE_CHANGED`; duplicate game in
  a parlay rejected by the DB; `MIXED_SEASON_PARLAY`; a January bowl charges the
  2026 bankroll even after 2027 games exist; `PAYOUT_LIMIT_EXCEEDED`; cancel refunds
  exactly once; **double-cancel returns 409, never a 500, and writes no second
  refund**; the three `INSERT OR IGNORE` ledger behaviours from §4.2; edit is atomic
  (force a failure in the place half and assert the old bet is still pending).
- `settle.spec.ts` — straight win/loss/push; parlay with a push leg re-priced;
  parlay with a loss + pushes loses; partially-final parlay stays pending and
  writes nothing; **running settle twice pays once** (assert ledger row count and
  balance); a `game_lines` row mutated _or deleted_ after placement does not change
  the payout; cancelled game → void → stake returned; **head-of-line blocking** (20
  undecidable bets do not starve a settleable one behind them; `settle_attempts`
  increments and nothing else is written); the payout is recomputed from
  `bet_legs.american_price` with no stored rational anywhere;
  `SUM(ledger) === balance_cents` after every scenario.
- `ingest.spec.ts` — fixture-driven upsert; a final game is not regressed to
  scheduled; scores are not nulled by a partial payload and a pre-game `"0"` is not
  nulled either; a malformed event is skipped without aborting the run; a fetch
  failure leaves the DB untouched; date targets are planned for both leagues with
  no calendar knowledge; **the three write-budget levers each have a direct test,
  plus a CI regression assertion that 96 live refreshes of the 86-game sample
  Saturday write < 5,000 rows** (§8.6).
- `jobs.spec.ts` — lease prevents overlap; expired lease is reclaimed; `job_runs`
  rows are written on success, skip and error.
- `routes.spec.ts` — auth required on every non-public route; admin routes 404 for
  non-admins; unknown `/api/*` returns the JSON 404 envelope.

**Fixtures — two files, on purpose.** `tests/fixtures.ts` at the root would not
work: `tsconfig.tests-worker.json` includes only `tests/worker/**`, and workerd has
no `node:fs`, so a single shared loader would fail both the project boundary and
the runtime.

- `tests/unit/fixtures.ts` (node project) reads `docs/samples/*.json` via
  `node:fs` and provides `makeScoreboard(base, overrides)` so a test can say "make
  event 401872925 FINAL 27-24" without hand-writing 15 KB of JSON. This is where
  the "parses the real thing" guarantee lives.
- `tests/worker/fixtures.ts` (workers project) SYNTHESISES small slates in ESPN's
  shape via `buildScoreboard(EventSpec[])` and installs the `https://espn.test/**`
  fetch stub. No `fs`, no 1.5 MB bundle, and slates are mutable mid-test (kick a
  game off, move a line, cancel a game).
- `tests/unit/espn.spec.ts` carries a **conformance test** asserting a builder
  output parses to the same domain object as the equivalent real event, so the two
  fixture worlds cannot drift.

**Coverage gate**: `src/shared/**` must be ≥ 90% lines. No gate on `src/web/**` in v1.

---

## 14. Adversarial review: known failure modes and how we handle them

### 14.1 Kickoff-lock race

- **Bet placed at T−1s.** The placement `batch()` re-reads `games.kickoff_at` and
  `games.status` **inside the same batch as the insert** (the insert is an
  `INSERT … SELECT … WHERE` guarded on them), so there is no read-then-write window.
  Two concurrent placements cannot disagree about the game state.
- **Workers' `Date.now()` is frozen between I/O operations** (Spectre mitigation), so
  the `now` used for the guard is captured once per request and cannot advance
  mid-handler. That removes one class of skew but means `now` can lag real time by the
  duration of the request's I/O.
- **ESPN reschedules the game after we fetched the line.** `games.kickoff_at` is
  mutable and updated on every refresh; the placement guard always uses the current
  DB value, so a game moved _earlier_ immediately stops accepting new bets. A bet
  already placed under the old kickoff is honoured (we cannot retroactively know),
  which matches how books handle it, and `kickoff_at_snapshot` records what the
  user was told.
- **The same reschedule must also close the CANCEL/EDIT window, and this is the
  easiest version of the bug to ship.** `bets.earliest_kickoff_at` is a
  placement-time snapshot; ingestion never updates it (§8.5 does not touch `bets`
  at all). So a cancel guard written as `earliest_kickoff_at > :nowPlusBuffer` —
  which reads perfectly sensible — lets a user whose game moved two hours earlier
  watch the first quarter go badly and then cancel for a **full refund**. The
  guard in §14.2 is therefore a `NOT EXISTS` over `bet_legs JOIN games` requiring
  every leg's _current_ game row to be `scheduled` and beyond the buffer.
  `earliest_kickoff_at` is index/sort/display only.
  `tests/worker/bets.spec.ts` carries this exact scenario as a named test.
- **Clock skew / approximate kickoffs.** ESPN kickoff times are scheduled times, and
  broadcasts start a few minutes late or early. `BET_CUTOFF_BUFFER_MS = 60_000` closes
  betting one minute before the stored kickoff. It is a config constant, surfaced in
  `GET /api/config` so the UI shows the same `lockAt` the server enforces.
- The **client clock is never trusted** for anything: no timestamp in any request body
  is read by the server.

### 14.2 Bet placement / cancel / edit atomicity — the exact batches

**Placement**, one `batch()` (`n` = leg count):

```sql
-- 0a. bankroll (OR IGNORE is fine HERE: not the ledger, duplicate is the only
--     failure mode, and the id is deterministic)
INSERT OR IGNORE INTO bankrolls (id, user_id, league, season, balance_cents, created_at, updated_at)
  VALUES (:bankrollId, :userId, :league, :season, 0, :now, :now);
-- 0b. opening deposit. NOT `OR IGNORE` — see §4.2.
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT :depositId, :bankrollId, 'deposit_initial', 'init', NULL, 100000, :now, 'season opening balance'
 WHERE NOT EXISTS (SELECT 1 FROM ledger
                    WHERE bankroll_id = :bankrollId AND kind = 'deposit_initial' AND ref_id = 'init');

-- 1. the bet, guarded on ALL legs being bettable AND in the same (league, season)
INSERT INTO bets (id, user_id, bankroll_id, league, season, ..., earliest_kickoff_at, status, ...)
SELECT :betId, :userId, :bankrollId, :league, :season, ..., :earliestKickoff, 'pending', ...
 WHERE (SELECT COUNT(*) FROM games
         WHERE id IN (:g1,…,:gn)
           AND league = :league AND season = :season       -- one bankroll, always
           AND status = 'scheduled'
           AND kickoff_at > :nowPlusBuffer) = :n;

-- 2..n+1. legs, each guarded on the bet existing
INSERT INTO bet_legs (...) SELECT ... WHERE EXISTS (SELECT 1 FROM bets WHERE id = :betId);

-- n+2. stake
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT :ledgerId, b.bankroll_id, 'bet_stake', b.id, b.id, -:stake, :now, :memo
  FROM bets b WHERE b.id = :betId;
```

`:league` / `:season` come from `resolveBetScope()`, which reads them from the
legs' own `games` rows before the batch; the `COUNT(*) = :n` guard then re-checks
inside the batch that all `n` games really do share that scope, so a race cannot
smuggle a leg from another season into a bankroll.

Then `results[2].meta.changes === 1`? → `201`. If `0`, nothing else in the batch
matched either (every subsequent statement is guarded on the bet row existing), so
the batch is a clean no-op; we re-query the games to produce a _specific_ error
(`BETTING_CLOSED` vs `GAME_NOT_BETTABLE` vs `GAME_NOT_FOUND` vs
`MIXED_SEASON_PARLAY`). Insufficient funds surfaces as the
`ledger_bi_sufficient_funds`
`RAISE(ABORT)` (§4.2), which throws and rolls the batch back → `409
INSUFFICIENT_FUNDS`. `PAYOUT_LIMIT_EXCEEDED` is checked in-process before the
batch is built, and again by the `CHECK` on `potential_payout_cents`.

Bound parameters: worst case 10 legs ≈ 10 (game ids) + ~14 (bet) + 10×15 (legs) —
that **exceeds the 100-parameter-per-statement limit if written as one
statement**, which is exactly why the legs are `n` separate statements inside the
batch (~15 parameters each). Called out because it is a real limit that is easy to
trip.

**Cancel (`DELETE /api/bets/:id`)**, one `batch()`:

```sql
-- 1. the transition. NOTE: the lock guard is a NOT EXISTS over the CURRENT game
--    rows, NOT `bets.earliest_kickoff_at` (which ingestion never updates).
UPDATE bets
   SET status = 'cancelled', cancelled_at = :now, updated_at = :now
 WHERE id = :betId AND user_id = :userId AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = :betId
        AND (g.status <> 'scheduled' OR g.kickoff_at <= :nowPlusBuffer));

-- 2. the refund, guarded on THIS call having won the transition.
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT :ledgerId, b.bankroll_id, 'bet_refund', b.id, b.id, b.stake_cents, :now, 'user cancelled'
  FROM bets b
 WHERE b.id = :betId
   AND b.status = 'cancelled'
   AND b.cancelled_at = :now                              -- this call, not a prior one
   AND NOT EXISTS (SELECT 1 FROM ledger
                    WHERE bankroll_id = b.bankroll_id AND kind = 'bet_refund' AND ref_id = b.id);
```

**Why statement 2 is guarded three ways, and why `cancelled_at = :now` matters.**
The obvious version — `... WHERE b.status = 'cancelled'` — is wrong: on a _second_
cancel of an already-cancelled bet, statement 1 matches 0 rows but statement 2's
`SELECT` still matches (the bet _is_ cancelled), so the `INSERT` fires, hits
`UNIQUE(bankroll_id, 'bet_refund', betId)`, and **aborts the whole batch with a
500** — when the correct behaviour is a quiet `409 BET_NOT_PENDING`. `:now` is
captured once per request and is unique to this call, so it acts as a nonce; the
`NOT EXISTS` on the ledger is the belt to its braces. `results[0].meta.changes`
tells the handler whether to return the bet or an error, and a re-query
distinguishes `BET_LOCKED` from `BET_NOT_PENDING` from `BET_NOT_FOUND`.

**Edit (`PUT /api/bets/:id`)**, one `batch()`:

```sql
-- 1. cancel half, with the SAME leg->game lock guard as above
UPDATE bets
   SET status = 'cancelled', cancelled_at = :now,
       replaced_by_bet_id = :newBetId, updated_at = :now
 WHERE id = :oldId AND user_id = :userId AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = :oldId
        AND (g.status <> 'scheduled' OR g.kickoff_at <= :nowPlusBuffer));

-- 2. refund, guarded on this call having won it
INSERT INTO ledger (...)
SELECT :refundId, b.bankroll_id, 'bet_refund', b.id, b.id, b.stake_cents, :now, 'replaced by edit'
  FROM bets b
 WHERE b.id = :oldId AND b.status = 'cancelled' AND b.replaced_by_bet_id = :newBetId
   AND NOT EXISTS (SELECT 1 FROM ledger
                    WHERE bankroll_id = b.bankroll_id AND kind = 'bet_refund' AND ref_id = b.id);

-- 3..  the full placement sequence above with replaces_bet_id = :oldId, and its
--      statement 1 ADDITIONALLY guarded on the cancel having applied:
--        AND EXISTS (SELECT 1 FROM bets
--                     WHERE id = :oldId AND status = 'cancelled'
--                       AND replaced_by_bet_id = :newBetId)
```

If the cancel half fails the lock check, the place half is guarded off and the
whole thing is a clean no-op → `409 BET_LOCKED`. If the place half fails
validation or funds, the batch rolls back and the old bet is untouched and still
`pending`. **Neither half can land alone.** The new bet is priced from **current**
`game_lines`, never from the old snapshot.

### 14.3 Line snapshot immutability and provenance

`bet_legs` stores `provider`, `market`, `side`, `line_tenths`, `american_price`,
`line_captured_at` (when the book's price last _changed_) and `snapshot_at` (when
the user locked it). Grading reads only these; the exact price is recomputed from
`american_price` (§5.2). `settle.ts` does not import the `game_lines` accessor,
and `tests/worker/settle.spec.ts` proves the payout is unaffected by mutating —
or deleting — the `game_lines` row after placement.

### 14.4 Cents rounding and money-column types

Covered in §5.2/§5.3. BigInt rationals end-to-end; `number` appears only at the
boundary where a cent count is serialized.

Two specifics a reviewer should check:

- The regression vector is a 3-leg `-110/+120/-105` parlay, chosen because it
  fails under **both** float formulations of decimal odds. The previously-cited
  `460¢ @ −115` vector is a trap — it only fails `1 + 100/|A|`, so a naive
  implementation written as `(|A|+100)/|A|` would pass it. §5.3 spells this out.
- No money or price column can hold a non-integer. `bets` stores no rational at
  all (§5.2), and `potential_payout_cents`/`payout_cents` are `CHECK`-bounded to
  `MAX_PAYOUT_CENTS`, seven orders of magnitude below `2^53`. eslint bans
  `Math.round`/`floor`/`ceil`/`trunc` and `parseFloat` throughout `src/shared`
  and `src/worker` — `Math.floor(stake * decimalOdds)` is the actual failure
  mode, so banning only `Math.round` (as an earlier draft did) missed it.

### 14.5 Idempotent settlement

Covered in §7.4 — three layers (conditional UPDATE, run-id guard, ledger UNIQUE).
Test: run the settle job twice over the same final games, assert exactly one
`bet_payout` row and an unchanged balance.

### 14.6 Cron overlap and crash mid-run

Covered in §9.2/§9.3. Specifically "dies between grading legs and paying out": those
are in the same `batch()`, which D1 rolls back as a unit, so that state does not
exist. Dying between two _bets_ leaves the second bet pending for the next run.

### 14.7 Rescheduling / postponement / cancellation / disappearing games

Covered in §7.5 and §8.5. Summary: cancel → void immediately; postponed → keep
pending, auto-void after 7 days past `original_kickoff_at`; dropped from the feed
→ `last_seen_at` staleness + 7 days → auto-void; final never regresses; games are
never deleted while legs reference them. A reschedule _earlier_ closes both the
placement window and the cancel/edit window, because both guards read the current
`games` row (§14.1, §14.2) — not the placement-time snapshot.

### 14.8 ESPN outage or schema drift

The parser is total (never throws), skips bad events with a warning, and ingestion
writes only after a successful full parse. A non-200, a timeout (`AbortSignal.timeout(8000)`),
or a JSON error increments `consecutive_failures` and backs off. Existing rows are
never modified on failure. Warnings are visible in `GET /api/admin/jobs`.

### 14.9 CFB specifics

`groups=80` is FBS (and also covers bowls), but an FBS-vs-FCS game still appears
and we ingest it normally — the FCS team is just another team row, and DraftKings
usually prices it.

**`lines: null` is a NORMAL state**, rendered as "line not posted yet" rather than
an error. What the committed sample actually proves (the only numbers in this plan
anyone can re-derive from the repo): of 86 CFB events, **2** carried a DraftKings
block and both were `STATUS_SCHEDULED`; the other 84 had started or finished and
carried none. So the sample demonstrates the _odds-vanish-at-kickoff_ property,
not the _lines-appear-gradually-during-the-week_ property. The latter was observed
in a live probe that is not in the repo and is therefore stated as an expectation,
not a measurement: CFB lines for next weekend appear over the course of the week,
so an empty board on Monday is expected behaviour. (Not covered by the live S4
probe, which measured date bucketing, not line availability; treat it as an
expectation until M8 observes a full week.)

Big favourites often have no moneyline — each market is independently nullable.
Lines move a lot; the snapshot is the whole answer.

### 14.10 Timezones

Everything stored and transmitted as epoch ms UTC. ET is used in exactly one place
(ESPN's `dates=` bucket key, §8.2) via `Intl.DateTimeFormat` with an explicit
`America/New_York` timezone. Display is the viewer's local timezone. NFL week
boundaries come from ESPN's `week.number`, never computed.

### 14.11 Auth

Covered in §10. The headline is §10.1: **100k server-side PBKDF2 iterations do not fit
the 10 ms free-tier CPU limit**, so we moved the stretching to the browser and kept
the total work factor. Cookie flags, session-token hashing at rest, SameSite=Lax +
custom-header CSRF, D1 login throttling, invite gate, and no login-side enumeration
are all specified there.

### 14.12 D1 limits

Verified: 100 bound params per statement (drives the per-leg statement split,
§14.2); 100 KB per statement; 2 MB per row; 50 (docs) / 1000 (2026-02-11
changelog) service subrequests per invocation; rows-read and rows-written quotas
**hard-enforced since 2026-09-01** (§8.6 — this is why write budget is treated as
correctness, not tuning). `INTEGER` columns silently degrade to `REAL` above i64,
which is why no rational is persisted (§5.2). We budget **≤ 40 statements per invocation** and chunk
settlement at 20 bets. Spike **S2** resolves the batch-accounting question before any
chunk size is raised. There is no documented "100 statements per batch" cap — the
documented batch rule is that per-statement limits apply to each statement
individually, and the whole batch must finish inside the 30 s Cloudflare API timeout.

### 14.13 Free-tier request budget

≤ 2 ESPN calls per cron run × 96 runs = ≤ 192/day. Worker invocations: 288 cron +
actual API calls from ~10 users; static assets do not invoke the Worker at all.
Nowhere near 100k/day.

### 14.14 Static assets vs API routes

`run_worker_first: ["/api/*"]` guarantees the API is never swallowed;
`not_found_handling: "single-page-application"` guarantees deep links work. Test:
`routes.spec.ts` asserts `/api/definitely-not-a-route` returns our JSON 404 envelope,
not HTML.

### 14.15 Secrets

Only `INVITE_CODE` and `IP_HASH_SALT` are secrets (`wrangler secret put`). No ESPN
key exists. `.dev.vars` is gitignored; `.dev.vars.example` is committed with dummy
values. gitleaks runs on every PR and on a schedule. `wrangler.jsonc` contains no
secrets — the D1 `database_id` is not a secret but is a deployment identity, so it is
committed with a comment explaining that.

---

## 15. Milestones

Each milestone lists: files owned, tests written **first**, and a definition of done.
"DoD" always implicitly includes: `npm run typecheck && npm run lint && npm run
format:check && npm test && npm run build` all green.

### M0 — Repo skeleton and toolchain _(no parallelism; everything depends on it)_

**Files**: `package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest*.config.ts`,
`eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `wrangler.jsonc`,
`index.html`, `.github/workflows/ci.yml`, `.dev.vars.example`, `README.md`,
`CLAUDE.md`.
**Tasks**: `npm install`; `wrangler d1 create spicybetting` and paste the id into
`wrangler.jsonc`; confirm the five gate commands run (tests may be `it.todo`).
**DoD**: fresh clone → `npm ci && npm run typecheck && npm run lint && npm test`
passes; CI green on a throwaway PR.

**Toolchain pinning — read before "upgrading" anything.** The versions in
`package.json` are not "whatever was newest on npm today"; three of them are
constrained:

| Package                | Pinned    | Why not latest                                                                                                                                                                                                                |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`               | `^4.1.11` | `@cloudflare/vitest-pool-workers@0.22.0` declares `peerDependencies: { vitest: "^4.1.0" }`. Vitest **5.0.0** exists but is not supported by the pool. Bumping vitest without the pool breaks the whole `worker` test project. |
| `typescript`           | `~5.9.3`  | `typescript-eslint@8.70` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript **7.0.2** (the Go port) exists but is outside that range, so `npm run lint` would fail.                                                          |
| `@vitejs/plugin-react` | `^5.2.0`  | 5.2.0 is the first v5 that accepts `vite@^8`. v6 accepts vite 8 too but pulls in extra optional peers (`oxc-transform-react`, `@rolldown/plugin-babel`) we do not need.                                                       |

`vite@^8`, `react@19`, `eslint@10`, `wrangler@^4.131` are current and unconstrained.
If a dependency bump is proposed, check these three first — and note Alex's
standing rule that dependency-bump PRs also get an adversarial review.

**`tsconfig` layout.** Six projects wired as a `tsc -b` solution, not one config:
`shared` (lib ES2023, `types: []`), `worker` (Workers types), `web` (DOM + JSX),
`tests-unit`, `tests-worker`, `node` (config files). This is what keeps
`Request`/`Response` from meaning two different things in one program, and it is
why `src/shared` must stay platform-free (§2.2). Referenced projects are
`composite` + `emitDeclarationOnly` into `.tsbuild/`, which is gitignored — no
JavaScript is emitted by the typecheck.

### M1 — Runnable local dev loop with mocked ESPN

**Files**: `migrations/0001_init.sql` (already written — apply it), `src/worker/env.ts`,
`src/worker/index.ts` (health route + assets passthrough), `src/worker/db.ts`,
`scripts/fixture-server.mjs`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/styles.css`.
**Tests first**: `tests/worker/routes.spec.ts::health`, migration-applies test.
**Tasks**:

- `npm run db:migrate:local` applies `0001_init.sql` to local D1.
- `cp .dev.vars.example .dev.vars`. **This is load-bearing**: `wrangler.jsonc`
  defaults `ESPN_BASE_URL` to the real `https://site.api.espn.com`, so without the
  `.dev.vars` override `npm run dev` would hit production ESPN while the fixture
  server sat idle on :8788. `.dev.vars.example` ships that override as its first
  line, and M1's DoD explicitly checks it.
- `scripts/fixture-server.mjs` serves `docs/samples/*.json` on `:8788` with the
  ESPN URL shape (accepting and ignoring `?dates=`), so
  `ESPN_BASE_URL=http://127.0.0.1:8788` works unchanged.
- `npm run dev` = `concurrently` of fixture-server + `wrangler dev` (:8787) +
  `vite` (:5173 with `/api` proxied to :8787). `predev`/`pretest` create
  `dist/client` so wrangler's assets binding resolves on a fresh clone.
  **DoD**: `npm run dev`, open `http://localhost:5173`, see a React page that
  renders the result of `GET /api/health`; `wrangler dev` logs show the local D1
  bound; **and `wrangler tail`/the fixture-server log shows the ingest hitting
  `127.0.0.1:8788`, not `site.api.espn.com`** — verify by stopping the fixture
  server and confirming the refresh job fails. Also resolve Spike S3 here.
  **This is the milestone that unblocks every parallel track below.**

### M2 — Pure domain core

**M2d runs FIRST and is a prerequisite for the rest** — everything imports its
types, error codes and constants, including `odds.ts` (§16).

- **M2d — contract + validation** _(blocking)_: `src/shared/types.ts`,
  `api-types.ts`, `errors.ts`, `constants.ts`, `validate.ts` +
  `tests/unit/validate.spec.ts`.
  DoD: every `POST /api/bets` validation error in §11.4 has a test; the files are
  **frozen** and announced as read-only to the other tracks.
- **M2a — odds** _(needs M2d)_: `src/shared/odds.ts` + `tests/unit/odds.spec.ts`.
  DoD: every row of the §5.4 table passes; the `-110/+120/-105` dual-float
  regression passes (and a test asserts the two float formulations disagree with
  each other); `MAX_PAYOUT_CENTS` enforcement is tested in BigInt; `priceFromLegs`
  round-trips a 10-leg parlay bit-identically; property sweep passes; 100% branch
  coverage of the module.
- **M2b — grading** _(needs M2d **and M2a's implementation**, not just its types —
  `gradeBet` multiplies prices and floors a payout)_: `src/shared/grading.ts` +
  `tests/unit/grading.spec.ts`.
  DoD: the §7.3 truth table is exhaustively tested including `pending` and `void`.
- **M2c — ESPN parser + time** _(needs M2d)_: `src/shared/espn.ts`,
  `src/shared/time.ts` + `tests/unit/espn.spec.ts`, `tests/unit/time.spec.ts`,
  `tests/unit/fixtures.ts`. Spike S4(a)/(b) are already **resolved** (§18) — land
  the `etDateKey` unit tests that pin the measured NFL bucketing; S4(c),
  postseason reachability, stays open until January and is an M8 runbook item.
  DoD: both sample files parse with the exact counts asserted in §13; every ESPN
  status maps; a pre-game score of the string `"0"` parses to `0` and not `null`;
  a truncated/garbage event is skipped with a warning.

### M3 — Auth _(depends on M1; independent of M2 except constants)_

**Files**: `src/worker/crypto.ts`, `src/worker/session.ts`, `src/worker/auth.ts`,
`src/worker/middleware.ts`, `src/worker/routes/auth.ts`, `src/web/api/kdf.ts`,
`scripts/admin-hash.mjs`, `tests/worker/auth.spec.ts`, `tests/unit/kdf-parity.spec.ts`.
**DoD**: signup → cookie → `GET /api/auth/me` round-trips in the pool-workers test;
first user is admin; invite gate enforced; 10 bad logins → 429; CSRF header required;
`admin-hash.mjs` output actually logs in.

### M4 — Ingestion _(depends on M1 + M2c)_

**Files**: `src/worker/providers.ts`, `src/worker/espn.ts`, `src/worker/ingest.ts`,
`src/worker/jobs.ts`, `tests/worker/ingest.spec.ts`, `tests/worker/jobs.spec.ts`.
**DoD**: `POST /api/admin/jobs/refresh` against the fixture server populates
`games` and `game_lines`; **re-running an unchanged slate writes ZERO rows**
(`meta.changes === 0` — L1); a slate of started games writes zero `game_lines`
rows (L2); `last_seen_at`/`seen_at` only move past their touch intervals (L3); the
write-budget regression assertion in `ingest.spec.ts` passes; a final game is not
regressed; date targets reach a January postseason date; lease prevents overlap;
every §8.4 backoff branch tested. **Run Spike S1 at the end of this milestone.**

### M5 — Betting _(depends on M1 + M2a/b/d + M3)_

**Files**: `src/worker/bankroll.ts`, `src/worker/bets.ts`, `src/worker/routes/bets.ts`,
`src/worker/routes/games.ts`, `src/worker/routes/bankroll.ts`,
`tests/worker/bets.spec.ts`.
**DoD**: every error code in §11.4 has a test; the atomicity tests in §13 pass;
`SUM(ledger) === balance_cents` asserted after each scenario.

### M6 — Settlement _(depends on M4 + M5)_

**Files**: `src/worker/settle.ts`, `src/worker/maintenance.ts`,
`tests/worker/settle.spec.ts`.
**DoD**: the §13 settle scenarios pass, including double-run idempotency,
post-placement `game_lines` mutation/deletion, and the head-of-line-blocking test
(20 undecidable bets must not prevent a settleable bet behind them from settling
on the next run).

### M7 — Frontend _(M7a–M7e parallelizable once M1 + the relevant API exists)_

- **M7a** shell/routing/session: `App.tsx`, `AppShell.tsx`, `AuthPage.tsx`,
  `SessionContext.tsx`, `api/client.ts`, `hooks/useResource.ts` — needs M3.
- **M7b** games board + bet slip: `GamesPage.tsx`, `GameCard.tsx`, `MarketButton.tsx`,
  `BetSlip*.tsx`, `BetSlipContext.tsx` — needs M4 + M5.
- **M7c** my bets: `MyBetsPage.tsx`, `BetCard.tsx`, `BetActions.tsx` — needs M5.
- **M7d** leaderboard + account: `LeaderboardPage.tsx`, `AccountPage.tsx` — needs M5.
- **M7e** admin page: `AdminPage.tsx` — needs M4/M6.
  **DoD**: mobile viewport (390×844) walk-through of place → view → edit → cancel with
  no horizontal scroll; every API error code renders a human message.

### M8 — Deploy + operate

**Files**: `README.md` deploy section, `CLAUDE.md` runbook, `scripts/reconcile.mjs`,
`.github/workflows/ci.yml` (add a manual deploy job).
**Tasks**: `wrangler d1 migrations apply --remote`; `wrangler secret put INVITE_CODE`;
`wrangler secret put IP_HASH_SALT`; `wrangler deploy`; flip `ESPN_BASE_URL` to the real
host; watch `GET /api/admin/jobs` for one full weekend.
**DoD**: a real NFL week ingests, a real bet grades correctly, `reconcile` reports
zero drift, and the free-tier dashboard shows usage within budget — specifically,
check `job_runs.stats.rowsWritten` against the §8.6 model after the first full
Saturday, since the D1 write cap is hard-enforced.

**Runbook items with a date attached** (do not let these be discovered by a
friend who cannot find a game to bet):

- **Before the first bowl / Wild Card weekend**: resolve Spike S4(c) — confirm a
  January date target actually returns postseason games. If not, add the
  `seasontype=3` companion target (§8.2).
- **After the first live Saturday**: compare measured rows-written to the §8.6
  model and, if it is running hot, drop `display_clock` from the compare tuple.
  `GET /api/admin/jobs` reports `stats.dayRowsWritten` (rolling 24 h) for exactly
  this check; §8.6 predicts ≈ 5,100/day.

---

## 16. Parallel-execution map

**M2d is a prerequisite, not a sibling.** `types.ts`, `api-types.ts`, `errors.ts`
and `constants.ts` are imported by every other track — including `odds.ts`, which
throws `AppError('PAYOUT_LIMIT_EXCEEDED')` and reads `MAX_PAYOUT_CENTS`. An earlier
draft of this graph showed M2a–M2d as four independent siblings, which was wrong.

```
M0 ──► M1 ──► M2d (types/errors/constants/validate)   [PREREQ — freezes the contract]
                │
                ├──────────────────────────► M3 (auth)              ─┐
                ├──► M2a (odds) ──► M2b (grading)                    │
                ├──► M2c (espn/time) ──► M4 (ingest) ───────────────┼──► M5 (betting) ──► M6 (settle)
                │                                                    │           │
                └──► M7a (shell/auth UI, after M3) ──────────────────┘           ▼
                                       └──► M7b / M7c / M7d / M7e ──────────► M8
```

Real edges that are easy to miss, now drawn explicitly:

- **M2d → M2a** — `odds.ts` imports `AppError` and `ErrorCode`.
- **M2a → M2b** — `gradeBet` must _multiply prices and floor a payout_, so it
  depends on `odds.ts`'s **implementation**, not just its types. Track B can be
  written test-first against the M2a contract, but it cannot go green until M2a
  is green.
- **M4 → M6** and **M5 → M6** — settlement needs both real games and real bets.

**Safe to run fully in parallel (disjoint file ownership), once M2d is frozen:**

| Track | Owns                                                                                                                                                                             | Depends on                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A     | `src/shared/odds.ts`, `tests/unit/odds.spec.ts`                                                                                                                                  | M2d (errors, constants)              |
| B     | `src/shared/grading.ts`, `tests/unit/grading.spec.ts`                                                                                                                            | M2d + **M2a implementation**         |
| C     | `src/shared/espn.ts`, `src/shared/time.ts`, `tests/unit/{espn,time}.spec.ts`, `tests/unit/fixtures.ts`                                                                           | M2d                                  |
| E     | `src/worker/{crypto,session,auth}.ts`, `src/worker/routes/auth.ts`, `src/web/api/kdf.ts`, `scripts/admin-hash.mjs`, `tests/worker/auth.spec.ts`, `tests/unit/kdf-parity.spec.ts` | M1, M2d                              |
| F     | `src/worker/{providers,espn,ingest}.ts`, `tests/worker/{ingest,fixtures}.ts`                                                                                                     | M1, M2c                              |
| G     | `src/web/{styles.css,components/*,pages/*}` (static shell, mock data)                                                                                                            | M2d only; never touches `src/worker` |

**Shared files — owner and protocol.** These are the ones that will actually
collide, so each has a named rule rather than a hope:

| File                                                               | Touched by                                                                                                                                                     | Protocol                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/types.ts`, `api-types.ts`, `errors.ts`, `constants.ts` | everyone                                                                                                                                                       | **M2d writes them first and freezes at end of M2d.** Read-only thereafter; changes go through one PR that M2d's owner reviews. |
| `src/worker/middleware.ts`                                         | **M1** (`contextMiddleware`, `errorHandler`) and **M3** (`sessionMiddleware`, `csrfMiddleware`, `requireAuth`, `requireAdmin`)                                 | M1 lands the file with all six exports stubbed; M3 fills only its four. Function-level ownership, no structural edits.         |
| `src/worker/db.ts`                                                 | **M1** (`runBatch`, `queryOne`, `queryAll`, `newId`, `nowMs`, `changesAt`), **M5** (`isOverdraftError`, `isUniqueViolation`), **M7/M8** (`reconcileBankrolls`) | Same rule: M1 lands every export stubbed; later milestones fill their own functions only.                                      |
| `src/worker/routes/admin.ts`                                       | **M4** (job triggers/history), **M3** (user admin, password reset), **M8** (reconcile)                                                                         | M4 lands the router skeleton with one commented placeholder per group; each milestone adds its own `app.get/post` block.       |
| `src/worker/index.ts` (route table)                                | E, F, M5                                                                                                                                                       | Table is a flat list of `app.route('/api/x', xRoutes())` lines; each track adds exactly one. Conflicts are one line.           |
| `src/worker/env.ts`                                                | all                                                                                                                                                            | Additive only; append your binding/var, never reorder.                                                                         |
| `migrations/0001_init.sql`                                         | —                                                                                                                                                              | **Frozen after M1.** Any schema change is a new `0002_*.sql`; nobody edits `0001`.                                             |
| `package.json`                                                     | M0                                                                                                                                                             | Only M0 adds dependencies. A track that needs one raises it.                                                                   |

## 17. Risks and mitigations

| #   | Risk                                                                        | Likelihood    | Impact                                                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 10 ms CPU limit blown while ingesting an 86-game CFB Saturday               | **Medium**    | Ingest fails on the day that matters                                                                                                              | **Not** a parse problem — `JSON.parse` of the 1.3 MB file measures ~2.0 ms, and date-splitting saves only ~7% because the Saturday is 93% of the week. The risk is map + bind + `batch()`, and the M4 A/B split (§8.5) DOUBLED the statement count to ~172 for an 86-game target — a deliberate trade of CPU for rows written, since only the latter is hard-enforced. Spike S1 (re-scoped) measures it. Fallback ladder: `REFRESH_TARGETS_PER_RUN=1` → drop `display_clock` from the compare tuple (now worth only ~1,200 rows/Saturday, so try it last among the cheap rungs) → split the mapping across two invocations via an internal self-`fetch` (each gets a fresh 10 ms) → split CFB by `groups=<conf>` → **last resort** Workers Paid ($5), which needs Alex's sign-off (Q1).                                                                                                                  |
| R2  | ESPN changes the payload shape or rate-limits us                            | Medium        | Stale lines/scores                                                                                                                                | Total parser, warnings surfaced, backoff, existing rows never corrupted. Provider adapter means a swap to The Odds API is a new file, not a rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R3  | D1 "queries per invocation" is really 50 and a batch counts per-statement   | Medium        | Settlement throws mid-run                                                                                                                         | Chunk at 20 bets; the job is safely resumable so a throw just defers work 15 min. Spike S2 confirms before raising.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R4  | ESPN never posts a line for a CFB game users want to bet                    | High (normal) | UX confusion                                                                                                                                      | `lines: null` is a first-class rendered state ("line not posted"), not an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R5  | A friend finds a way to bet after kickoff                                   | Low           | Game integrity                                                                                                                                    | The guard is a DB-level `WHERE` inside the insert batch, plus a 60 s buffer, plus `status='scheduled'`. Tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R6  | Client-side KDF feels slow / breaks on an old phone                         | Low           | Login friction                                                                                                                                    | 210k iterations ≈ 300 ms on a modern phone; `CLIENT_KDF.iterations` is a versioned constant and §10.4 describes the migration path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R7  | Free-tier D1 **write** budget exceeded on a big Saturday                    | **Medium**    | **D1 returns errors for the rest of the UTC day — this blocks BET PLACEMENT and SETTLEMENT, not just the board.** Hard-enforced since 2026-09-01. | Naive design measured ≈ **48,500 rows/day** on a CFB Saturday (49% of cap, with Sunday still to come). Levers are **v1 requirements**, not future work (§8.5): L1 compare-and-skip, **L1b the A/B split** — without which L1 buys NOTHING for a live game, because `display_clock` moves every refresh (measured: 33,196 rows for 86 games × 96 refreshes even WITH L1) — L2 no line writes for non-scheduled games (0 of 84 started games carry odds), L3 touch intervals. **Measured** after the split: **2,979 rows** for that Saturday's ingest, ≈ 5,100/day all in (5% of cap). `job_runs.stats.rowsWritten` is recorded per run, `GET /api/admin/jobs` surfaces a rolling-24h `dayRowsWritten`, and `ingest.spec.ts` asserts < 5,000 rows for 96 refreshes of the sample Saturday with the clock moving every time. Next knob if tight: drop `display_clock` from the compare tuple (~1,200 rows). |
| R11 | A money or price value silently becomes a float in D1                       | Low (now)     | Unauditable cents; violates the project's first rule                                                                                              | SQLite `INTEGER` coerces >i64 to `REAL` (verified) and `bind()` truncates past 2^53. Mitigated structurally: **no rational is persisted** (§5.2), every money column is `CHECK`-bounded to `MAX_PAYOUT_CENTS`, leg prices are `CHECK abs(...) BETWEEN 100 AND 100000`, and eslint bans `Math.round/floor/ceil/trunc` and `parseFloat` in `src/shared` and `src/worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R12 | Settlement queue starved by undecidable bets                                | Low           | Nothing settles at all                                                                                                                            | `bets.settle_attempts` + `ORDER BY settle_attempts ASC` + `MAX_SETTLE_ATTEMPTS` (§7.1). Columns added before the schema freeze.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R13 | An `INSERT OR IGNORE` into `ledger` silently breaks `SUM(ledger) = balance` | Low           | Unrepairable drift in an append-only table                                                                                                        | the two `ledger_bi_*` `BEFORE INSERT` triggers — `RAISE(ABORT)` is not suppressible by `OR IGNORE` (verified both ways), and they raise distinct messages so an orphan-bankroll bug is not misreported to the user as insufficient funds. Plus a CLAUDE.md house rule and four named tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R8  | Someone deletes/rewrites `migrations/0001_init.sql` after deploy            | Low           | Divergent prod schema                                                                                                                             | Frozen-after-M1 rule (§16) + `wrangler d1 migrations` tracking table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R9  | ESPN rate limits / blocks the Worker IP range                               | Low           | Total ingest outage                                                                                                                               | Backoff + admin visibility; manual `refresh` trigger; documented fallback to The Odds API free tier (500 req/mo is enough at our cadence).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R10 | Bet slip localStorage holds a stale line and the user is surprised          | Medium        | Trust                                                                                                                                             | `expected` + `409 LINE_CHANGED` + explicit "accept line change" confirm (§11.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 18. Spikes

**S1 — CPU cost of ingesting a full CFB Saturday (RE-SCOPED).**
_Background_: an earlier version of this spike assumed `JSON.parse` was the risk.
It is not. Measured locally, `JSON.parse` of the committed 1.3 MB CFB week file is
**~2.0 ms** (20-run mean), and per-ET-date splitting barely helps anyway because
the Saturday is 93% of the week (80 of 86 events).
_Question_: does `map to rows + build ~172 bound statements + batch()` for one
86-game CFB ET date fit inside the 10 ms free-tier CPU limit? (The second half of
this spike — "does the compare-and-skip upsert actually reduce `rows_written` as
modelled in §8.6?" — IS NOW ANSWERED, in the wrong direction and then fixed: L1
alone reduced nothing for a live game, and the A/B split of §8.5 took the measured
Saturday from 33,196 rows to 2,979. `tests/worker/ingest.spec.ts` carries the
numbers. What remains is CPU.)
_Note_: the A/B split is what makes it ~172 statements rather than ~86 — two per
game plus one per line. That trade is deliberate: rows written are hard-enforced,
statements per invocation are the open question of S2.
_Method_: after M4, `POST /api/admin/jobs/refresh` against a deployed Worker on a
real Saturday date; read CPU time from `wrangler tail` and the dashboard. Also
instrument `performance.now()` around map/bind separately from parse in a
pool-workers test.
_Exit criterion_: a p95 CPU number for the worst target, plus a decision between (a) ship as is,
(b) `REFRESH_TARGETS_PER_RUN=1`, (c) drop `display_clock` from the comparison
tuple (§8.6), (d) split the mapping across two invocations via an internal
self-`fetch`, (e) escalate to Alex re: Workers Paid.
**Blocks raising `REFRESH_TARGETS_PER_RUN` above 2.**

**S2 — D1 statement accounting per invocation.**
_Question_: does a `db.batch([...n])` count as 1 or n against the free-plan
subrequest/query budget, and is the binding number 50 or 1000? The D1 limits page
says 50; the 2026-02-11 changelog says Cloudflare-service subrequests are 1000 on
free. They cannot both be right.
_Method_: a pool-workers test plus one deployed probe that runs a batch of 60
statements and observes whether it errors; cross-check `wrangler tail`.
_Exit criterion_: a documented number in `CLAUDE.md` and a justified
`SETTLE_CHUNK`. **Blocks raising `SETTLE_CHUNK` above 20.**
_Raised urgency after M4_: `db.ts` says "budget ≤ 40 statements per invocation",
and ingestion now issues ~172 in one — chunked into ~5 `batch()` calls of 40. If
the answer is "50 QUERIES per invocation, and a batch of n counts as n", ingest is
already over and the remedy is R1's "split the mapping across two invocations"
rung, not a smaller chunk. `MAX_BATCH_STATEMENTS` is the size of ONE batch, not a
per-invocation total, and db.ts now says so.

**S3 — `@cloudflare/vitest-pool-workers` + D1 migrations ergonomics.**
_Question_: does `applyD1Migrations` from `cloudflare:test` apply
`migrations/0001_init.sql` — **including the four `ledger` triggers and every
`CHECK`** — cleanly per test, and is per-test isolation fast enough? Secondary:
does pool-workers tolerate `wrangler.jsonc` pointing `assets.directory` at a
`dist/client` that may not exist? (`npm run pretest` creates it; if the pool still
objects, drop `wrangler.configPath` and configure miniflare explicitly with
`d1Databases: ['DB']`.)
_Method_: write `tests/worker/setup.ts` in M1 and run it, including an assertion
that `INSERT OR IGNORE` of an overdrafting ledger row aborts (§4.2).
_Exit criterion_: green integration test, or a decision to fall back to a
`better-sqlite3` shim — explicitly the worse option, since it would not test D1's
batch semantics and the money invariants live in DDL.

**S4 — ESPN `dates=` bucket timezone. (a) and (b) RESOLVED — VERIFIED
2026-09-13. (c) open until January.**

_(a) Is `dates=YYYYMMDD` a US Eastern calendar day? (b) Does the NFL scoreboard
accept `dates=` with no `seasontype`?_ — **Both yes, measured against live ESPN:**

```
nfl/scoreboard?dates=20260913  -> 13 games, incl. SNF DAL@NYG  2026-09-14T00:20Z
nfl/scoreboard?dates=20260914  -> exactly 1 game, MNF DEN@KC   2026-09-15T00:15Z
nfl/scoreboard?dates=20260915  -> 0 games
```

Sunday night → Sunday's key; Monday night → Monday's key; no `seasontype`
required and nothing filtered out. That is precisely `etDateKey()`'s behaviour, so
the §8.2 design now rests on a measurement rather than an inference from the
committed samples. M2c still lands a unit test pinning `etDateKey` to these cases.

_(c) Do date targets reach the postseason (NFL Wild Card; CFB bowls under
`groups=80`)?_ — **STILL AN ASSUMPTION.** Cannot be probed until January 2027.
_Exit criterion_: on the first January date target, confirm postseason games come
back. _If they do not_, the remedy is additive and does not change the key scheme:
the planner emits a second target per date carrying `seasontype=3`. Flagged in the
M8 runbook so it is checked before the first bowl weekend rather than discovered
by a friend who cannot find a game to bet.

---

## 19. Open questions for Alex

1. **Workers Paid ($5/mo) — confirmed as LAST resort only?** You have said $0/month
   is the target and $5 is a last resort; the plan is built that way. The 10 ms free
   CPU limit is what forces the split-KDF design (§10.1), and workerd's hard 100k
   PBKDF2 cap independently forces it too. R1's fallback ladder now has four free
   rungs before Workers Paid. Confirm you want me to exhaust all four (the last
   being a CPU-splitting internal self-`fetch`, which adds real complexity) before
   escalating. **Default if you say nothing: exhaust all four, escalate only then.**
2. **Leaderboard ranking metric** — §11.5 ranks by realized `balanceCents` with equity
   shown alongside. Do you want equity (balance + open stakes) to be the ranked column
   instead? It changes who is "winning" mid-weekend.
3. **Mixed-league parlays** — v1 rejects a parlay with NFL and NCAAF legs, because a
   bet belongs to exactly one `(league, season)` bankroll. Is that acceptable, or do
   you want a combined bankroll? (The combined option is a bigger change: it makes
   `league` a property of the leg, not the bet.)
4. **ROI treatment of pushes** — §11.5 excludes pushes and voids from both sides of
   the ROI fraction (standard). Confirm.
5. **Season definition for CFB bowls / NFL playoffs** — ESPN puts January bowls and
   playoff games in the _previous_ season year with `seasontype=3`. v1 keeps them on
   that season's bankroll, so the 2026 bankroll stays open until mid-January 2027.
   This is now load-bearing in two places: ingest targets are keyed by ET **date**
   rather than by week specifically so postseason games are reachable (§8.2), and
   `bets.season` is read from the legs' own game rows rather than from a wall clock
   so a January bowl cannot be charged to the 2027 bankroll (§4.4). Confirm that is
   what you want; the alternative is closing the bankroll at the end of the regular
   season, which would need an explicit cutoff rule.
6. **Invite code**: one shared code for the whole friend group, or do you want
   single-use codes? v1 is one shared secret.
7. **Bet limits** — any cap on a single bet's stake, or is "up to your whole bankroll"
   the intent? v1 allows all-in.
8. **`docs/samples/*.json` in the repo** — 1.5 MB of fixtures committed. Fine, or
   should they be trimmed to ~10 events each? (Trimming makes tests faster but
   weakens the "parses the real thing" guarantee. v1 keeps them; the `worker` test
   project uses small synthesised slates instead, so the big files only cost the
   fast node project.)
9. **Max payout cap** — `MAX_PAYOUT_CENTS = $1,000,000`. It exists mainly so money
   columns provably cannot overflow into floats (§5.2b), and it is unreachable at
   realistic prices (a 10-leg −110 parlay at a $1000 stake returns ~$643k). Happy
   with $1M, or would you rather it were lower so a lucky 10-leg parlay does not
   end the season's leaderboard on day one?
10. **`display_clock` in the UI** — keeping a live game's clock current is still the
    single biggest remaining D1 write stream (§8.6), but the question is now much
    less pressing than it was when it was first asked. The M4 A/B split took a
    measured CFB Saturday from **33,196** rows to **2,979** (5% of the daily cap,
    all streams in), and a clock change now costs exactly 1 row rather than 4.
    Dropping `display_clock` from the compare tuple would save roughly 1,200 rows
    a Saturday — worth having if we ever run hot, not worth a worse UI now. So:
    **no decision needed from you today**; the answer is only wanted if
    `GET /api/admin/jobs`'s `dayRowsWritten` starts approaching 50,000.

---

## 20. Out of scope for v1 (future work)

Player props · live/in-play betting · teasers · round robins · futures ·
multi-book line shopping (the schema is ready: `game_lines` is keyed by provider) ·
line-movement history (`line_history` table) · email/push notifications ·
password reset UI (admin script only) · private leagues/groups (one global friend
group) · other sports (NBA, MLB, CBB) · custom domain · social feed / bet comments ·
CSV export · mobile app · half-point buy · cash-out · season archives and pruning of
old `games` rows · mixed-league parlays (see Q3).
