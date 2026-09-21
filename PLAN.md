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
19. [Decisions (answered 2026-09-14)](#19-decisions-answered-2026-09-14)
20. [Out of scope for v1](#20-out-of-scope-for-v1)
21. [Secondary odds provider (The Odds API)](#21-secondary-odds-provider-the-odds-api)
22. [Board window ends on Monday](#22-board-window-ends-on-monday)

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
same payload), and is the PRIMARY feed for both scores and lines. The interface
exists so that `ingest.ts` never mentions ESPN directly.

**A SECOND provider now exists** (§21): `TheOddsApiProvider`, in
`src/worker/odds-api.ts`, fills markets the primary is missing. It deliberately
does NOT implement `OddsProvider`, and the reason is worth stating so nobody
"fixes" it: `OddsProvider.fetchLines(league, target: SlateTarget)` is keyed by an
ET calendar DATE and returns `GameLines[]` keyed by OUR game id. The Odds API is
keyed by league and a time RANGE — one call covers a whole league — and its
events carry the API's own ids, so turning a response into `GameLines` requires
reading the `games` table, which an HTTP adapter must not do. It therefore
declares its own smaller `SecondaryOddsProvider` interface (one league, one call,
parsed events plus credit headers) and the match-to-`games` step is a separate
pure function, `matchOddsApiEvents` in `src/shared/odds-api.ts`. `providers.ts`
keeps meaning "providers of a SLATE".

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
  **CONSTANTS OF RECORD.** These live in `src/shared/constants.ts`, which is the
  source of truth; the values are restated here because the rest of this document
  reasons about them, and `tests/unit/docs.spec.ts` fails if the two ever disagree.
  Change the constant and this table in the same PR.

| Constant                              | Value           | Meaning                                                                                                                                                                               |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INITIAL_BANKROLL_CENTS`              | `100_000`       | $1,000, deposited once per ACCOUNT in the signup batch (§4.4)                                                                                                                         |
| `MIN_STAKE_CENTS`                     | `100`           | $1.00; also `CHECK(stake_cents >= 100)` on `bets`                                                                                                                                     |
| `MAX_PAYOUT_CENTS`                    | `100_000_000`   | $1,000,000 payout cap; also the float-proof on money columns (§5.2b)                                                                                                                  |
| `BET_CUTOFF_BUFFER_MS`                | `60_000`        | betting closes 1 min before the stored kickoff (§14.1)                                                                                                                                |
| `LINE_STALE_MS`                       | `10_800_000`    | FLOOR of the staleness window: 3 h since `game_lines.seen_at` → not bettable; the window is `max(this, 3 × the game's refresh cadence)`, so 18 h for a game more than 48 h out (§8.5) |
| `SESSION_TTL_MS`                      | `2_592_000_000` | 30 d cookie/session lifetime (§10.5)                                                                                                                                                  |
| `MAX_SETTLE_ATTEMPTS`                 | `96`            | 24 h at the 15-min settle cadence before a bet is parked (§7.1)                                                                                                                       |
| `VOID_AFTER_MS`                       | `604_800_000`   | 7 d past ORIGINAL kickoff → a postponed/vanished game auto-voids (§7.5)                                                                                                               |
| `MAX_PARLAY_LEGS`                     | `10`            | also `CHECK(leg_count BETWEEN 1 AND 10)` on `bets`; the teaser card stops here too (§5.8)                                                                                             |
| `MIN_TEASER_LEGS`                     | `2`             | a teaser is a parlay shape — one leg is never a teaser (§5.8)                                                                                                                         |
| `NFL_WEEK_ROLLOVER_ET_HOUR`           | `20`            | Sunday 20:00 ET: the NFL board rolls over to next week's Monday (§22)                                                                                                                 |
| `NCAAF_WEEK_ROLLOVER_ET_HOUR`         | `0`             | Sunday 00:00 ET: the CFB board rolls over to next week's Monday (§22)                                                                                                                 |
| `MONEYLINE_NOT_OFFERED_SPREAD_TENTHS` | `300`           | 30.0 pt: past this a missing moneyline is normal, not a gap — the UI hint and the sweep rule (§21.2)                                                                                  |
| `SECONDARY_RETRY_MS`                  | `14_400_000`    | 4 h before the secondary re-attempts a game it could not fill (§21.5)                                                                                                                 |
| `SECONDARY_RESWEEP_MARGIN_MS`         | `2_700_000`     | re-confirm a secondary fill this long before its staleness window closes (§21.5)                                                                                                      |
| `SECONDARY_MIN_SWEEP_INTERVAL_MS`     | `7_200_000`     | floor between two sweeps of the SAME league; the blast-radius limiter (§21.5)                                                                                                         |
| `SECONDARY_MATCH_WINDOW_MS`           | `5_400_000`     | kickoff tolerance of the mascot fallback matcher (§21.7)                                                                                                                              |
| `ODDS_API_MONTHLY_CREDITS`            | `500`           | the free tier's monthly allowance; also the literal 0007 seeds (§21.3)                                                                                                                |
| `ODDS_API_COST_PER_SWEEP`             | `3`             | credits one league sweep costs: markets (3) × regions (1), MEASURED (§21.5)                                                                                                           |
| `ODDS_API_CREDIT_RESERVE`             | `25`            | sweeping stops below this — a cushion for debit drift, not for the probe, which is FREE (§21.5)                                                                                       |
| `ODDS_API_BUDGET_PROBE_MS`            | `86_400_000`    | while the reserve blocks, one FREE `GET /v4/sports` a day to notice the monthly reset (§21.5)                                                                                         |
| `ODDS_API_COOLDOWN_MS`                | `3_600_000`     | first cooldown after a 429 or a transport failure (§21.9)                                                                                                                             |
| `ODDS_API_COOLDOWN_MAX_MS`            | `28_800_000`    | ceiling on the doubling of that cooldown across consecutive failures (§21.9)                                                                                                          |
| `ODDS_API_TIMEOUT_MS`                 | `8_000`         | request timeout, same as ESPN's; a slow provider must not eat the CPU budget (§21.6)                                                                                                  |

`TEASER_POINTS_TENTHS = [30, 40, 50, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140]`
— the 3-to-14-point tiers (plus 6.5), in TENTHS, matching every other line
quantity in the system (§5.8). The schema bound is wider than the offer on
purpose: since migration `0005_bets_teaser_tiers.sql`, `bets` carries
`CHECK (typeof(teaser_points_tenths) = 'integer' AND teaser_points_tenths BETWEEN 30 AND 140 AND teaser_points_tenths % 5 = 0)`,
so a future half-point tier is a constants change and not another table
rebuild (§16.2). The constant is the offer; the CHECK is the envelope.

- `bankrolls.id` is an ordinary uuid. It **used** to be the deterministic
  `"<userId>:<league>:<season>"`, which is what made lazy per-season creation a
  plain `INSERT OR IGNORE`; M5b creates the one balance in the signup batch
  instead, so there is nothing left to derive and nothing left to create lazily.

### 3.2 Tables

**`users`** — one row per friend.
`id, username` (lowercased, `UNIQUE`), `display_name` (original case), `kdf_version`,
`client_iterations`, `server_salt BLOB(16)`, `server_iterations`, `password_hash BLOB(32)`,
`is_admin`, `is_disabled`, `created_at`, `updated_at`,
`deleted_at INTEGER NULL` (**migration `0002_users_deleted_at.sql`**).
Storing the KDF parameters per row is what makes a future parameter bump migratable
without a forced reset (§10.4).

`deleted_at` is the SOFT DELETE stamp and the first post-0001 schema change: `NULL`
means a live account, a value is the epoch-ms instant it was deleted. It exists
because a HARD delete is impossible by design — `bankrolls.user_id` and
`ledger.bankroll_id` are `ON DELETE RESTRICT` and `ledger_bd_block` refuses
`DELETE FROM ledger`, so there is no statement order that removes a user without
destroying the money history `POST /api/admin/reconcile` exists to check (§4.1).
A deleted row is disabled, renamed, evicted and off the leaderboard; its bets and
ledger rows stay exactly where they are. §10.5 and §11.6.

**`sessions`** — `id` is the **SHA-256 hex of the session token**, never the token
itself, so a D1 dump does not hand an attacker live sessions. Plus `user_id`,
`created_at`, `expires_at`, `last_seen_at`. Index on `expires_at` for pruning.

**`auth_throttle`** — `key TEXT PRIMARY KEY` (`u:<username>` or `ip:<sha256-prefix>`),
`window_start`, `fail_count`, `locked_until`. One upsert per failed login. §10.5.

**`games`** — the canonical game row.
Notable columns:

- `home_conference_id` / `away_conference_id` (migration `0004_games_conference.sql`)
  — ESPN `team.conferenceId` as a TEXT id (`"8"` = SEC; the FBS list is
  `CFB_CONFERENCES` in constants.ts), NULL for the NFL. Denormalized like rank
  and logo so the CFB board can filter by conference (§12.1) from the slate it
  already has. Written by the live update (B), so realignment self-corrects.
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

**`bankrolls`** — **ACCOUNT BALANCES** (M5b). `id` (uuid), `user_id`, `name`,
`kind ∈ {main, custom}`, `balance_cents INTEGER NOT NULL DEFAULT 0
CHECK(balance_cents >= 0)`, timestamps, `UNIQUE(user_id, name)` plus a PARTIAL
unique index `ON bankrolls(user_id) WHERE kind = 'main'`.
The `CHECK` is the real overdraft protection — see §4.

A balance is **one pot of fake money that belongs to an account**. It is not
scoped to a league or a season, it never rolls over, and it is created in the
SIGNUP batch — not lazily. It is modelled as a LIST (a table keyed by user, not
a column on `users`) because side pots are wanted later; `bets.bankroll_id` and
`ledger.bankroll_id` already key off a balance id, so a second one is a row
rather than a migration. `kind='custom'` is reserved for those and nothing in v1
writes one. The partial unique index is what makes "exactly one main balance per
user" a schema fact rather than a convention — a plain `UNIQUE(user_id, kind)`
would also forbid two custom pots.

**`ledger`** — append-only, the source of truth for money.
`id, bankroll_id, kind, ref_id, bet_id, amount_cents (signed), created_at, memo`
with `UNIQUE(bankroll_id, kind, ref_id)`.
`kind ∈ {deposit_initial, bet_stake, bet_payout, bet_refund, admin_adjust}`.
`ref_id` is the **idempotency key**: the bet id for bet-related kinds, the literal
`'init'` for the opening deposit, a caller-supplied UUID for admin adjustments.
Five triggers (§4.2): TWO `BEFORE INSERT` value guards that `INSERT OR IGNORE`
cannot suppress (`ledger_bi_bankroll_exists`, `ledger_bi_sufficient_funds`), an
`AFTER INSERT` (`ledger_ai_apply`) that applies the amount to
`bankrolls.balance_cents`, and `BEFORE UPDATE` / `BEFORE DELETE` blocks
(`ledger_bu_block`, `ledger_bd_block`). Two more triggers sit on `bankrolls`
itself and make "the `AFTER INSERT` is the only writer" enforceable rather than
merely intended — §4.2 again.

**`bets`** — `id, user_id, bankroll_id, league, season, bet_type,
teaser_points_tenths, leg_count, stake_cents, american_price,
potential_payout_cents, status, payout_cents, placed_at, earliest_kickoff_at,
settled_at, cancelled_at, settle_run_id, settle_attempts, settle_error,
replaces_bet_id, replaced_by_bet_id, created_at, updated_at`.

- `league ∈ {nfl, ncaaf, mixed}` and `season` are **informational labels** since
  M5b. `mixed` means the legs span both leagues; `season` is the season of the
  EARLIEST-KICKOFF leg. Neither selects a balance any more (`bankroll_id` does),
  so neither constrains what a bet may contain — they drive the stats filters and
  the UI, and nothing else.
- `bet_type ∈ {straight, parlay, teaser}`; `teaser_points_tenths` is the teaser
  tier in TENTHS of a point — one of `TEASER_POINTS_TENTHS` (30 … 140), with
  the schema allowing any integer multiple of 5 in that range since 0005 — and
  `CHECK ((bet_type = 'teaser') = (teaser_points_tenths IS NOT NULL))` makes the
  type and the tier the same fact. The leg-count CHECKs are written against
  `'straight'` (`bet_type <> 'straight' OR leg_count = 1` and its mirror) rather
  than against `'parlay'`, so adding `teaser` to the enum did not silently make a
  1-leg teaser legal.

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
original_line_tenths, american_price, provider, line_captured_at, snapshot_at,
kickoff_at_snapshot, home_abbr, away_abbr, result, graded_at`.

- `original_line_tenths` is the BOOK's line before a tease, for display and
  audit; `NULL` on a straight or parlay leg, which is never moved. `line_tenths`
  remains **the line the leg is graded on** in every case — for a teaser leg
  that is the TEASED number — which is exactly what lets `gradeLeg` stay
  completely unaware that teasers exist (§5.8).

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

**`bug_reports`** (migration `0003_bug_reports.sql`) — `id, user_id → users
(RESTRICT), title, description, page, user_agent, app_version, created_at,
issue_number, issue_url, error`. One row per `POST /api/bugs`, written BEFORE
the GitHub issue is filed so a GitHub outage loses nothing; `issue_number` /
`issue_url` are set on success, `error` on failure. The `(user_id, created_at)`
index is the rate-limit guard. §11.7.

**`secondary_budget`** (migration `0007_secondary_odds.sql`, shipped in M9b from §21.3) — `id (CHECK id = 1),
remaining_credits, checked_at, last_attempt_at, nfl_last_sweep_at,
ncaaf_last_sweep_at, cooldown_until, consecutive_failures, last_status,
last_error, updated_at`. **Exactly one row.** It holds The Odds API's credit
balance and the rate limiters that make exhausting a 500-credit month impossible.
It is NOT a money table and carries no trigger: the guard is a conditional
`UPDATE` whose `WHERE` is every limit at once, and `meta.changes = 1` is the
permission to make the request. §21.3 / §21.5.

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

| Invariant                                                          | Enforcement                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Balance is never negative                                          | `BEFORE INSERT ON ledger` trigger `RAISE(ABORT)` (unsuppressable, §4.2) **plus** `CHECK(balance_cents >= 0)` on `bankrolls`     |
| No ledger row against a non-existent balance                       | a SECOND `BEFORE INSERT` trigger, `ledger_bi_bankroll_exists`, testing `NOT EXISTS` — never a `COALESCE(…, -1)` sentinel (§4.2) |
| Balance always equals the sum of its ledger rows                   | `AFTER INSERT ON ledger` trigger `ledger_ai_apply` is the _only_ writer of `balance_cents`                                      |
| …and nothing else may write `balance_cents`                        | `bankrolls_bu_balance_guard` (`BEFORE UPDATE OF balance_cents`) aborts any UPDATE that leaves it ≠ `SUM(ledger)` (§4.2)         |
| A balance always opens at 0                                        | `bankrolls_bi_balance_guard` (`BEFORE INSERT`) aborts a row inserted with a non-zero `balance_cents` (§4.2)                     |
| Ledger is append-only                                              | `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT)`                                                                         |
| A bet is paid at most once                                         | `UNIQUE(bankroll_id, kind, ref_id)` on `ledger`                                                                                 |
| A bet is refunded at most once                                     | same unique key, `kind='bet_refund'`                                                                                            |
| Exactly one opening deposit per balance                            | same unique key, `kind='deposit_initial'`, `ref_id='init'`                                                                      |
| Exactly one `main` balance per user                                | partial `UNIQUE INDEX ON bankrolls(user_id) WHERE kind = 'main'`                                                                |
| A bet is staked against a balance its owner owns                   | `AND EXISTS (SELECT 1 FROM bankrolls WHERE id = :bankrollId AND user_id = :userId)` inside the placement INSERT (§14.2)         |
| Stake ≥ $1.00                                                      | `CHECK(stake_cents >= 100)` on `bets`                                                                                           |
| A teaser has a tier and nothing else does                          | `CHECK ((bet_type = 'teaser') = (teaser_points_tenths IS NOT NULL))` + `CHECK (teaser_points_tenths IN (60,65,70))`             |
| Payout ≤ `MAX_PAYOUT_CENTS` (so no money column can become `REAL`) | `CHECK(potential_payout_cents BETWEEN 0 AND 100000000)` and the same on `payout_cents`                                          |
| A leg price is a small bounded integer                             | `CHECK(abs(american_price) BETWEEN 100 AND 100000)` on `bet_legs`                                                               |
| 1–10 legs                                                          | `CHECK(leg_count BETWEEN 1 AND 10)` + validation                                                                                |
| No duplicate game in a parlay                                      | `UNIQUE(bet_id, game_id)` on `bet_legs`                                                                                         |

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

-- (5)(6) THE OTHER HALF of "trigger (2) is the ONLY writer of balance_cents":
-- two guards on `bankrolls` that make that sentence enforced rather than merely
-- asserted. Without them "only writer" is a convention, and any stray
-- `UPDATE bankrolls SET balance_cents = …` — an admin fix, a migration, a
-- well-meant repair script — silently breaks SUM(ledger) = balance_cents in a
-- table that cannot be repaired.
CREATE TRIGGER bankrolls_bu_balance_guard BEFORE UPDATE OF balance_cents ON bankrolls
WHEN NEW.balance_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger
                            WHERE bankroll_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'bankrolls: balance_cents may only be written by the ledger trigger');
END;

CREATE TRIGGER bankrolls_bi_balance_guard BEFORE INSERT ON bankrolls
WHEN NEW.balance_cents <> 0
BEGIN
  SELECT RAISE(ABORT, 'bankrolls: balance_cents may only be written by the ledger trigger');
END;
```

**Why the two `bankrolls_*_balance_guard` triggers are not redundant.** Trigger
(2) is the only thing that is _supposed_ to write `balance_cents`; (5) is what
makes that true of every other statement in the system. It passes exactly when
the post-update value equals `SUM(ledger)` for that bankroll — which is what
(2)'s own `balance_cents + NEW.amount_cents` computes, since the ledger row has
already landed by the time the `AFTER INSERT` fires — and aborts otherwise. So
(2) sails through and a hand-written balance UPDATE aborts, with no way to tell
the trigger "I meant it".

(6) is the INSERT half, and it is deliberately `<> 0` rather than
`<> SUM(ledger)`: a `BEFORE INSERT` fires _before_ `OR IGNORE` resolves a
uniqueness conflict, so an idempotent insert aimed at an already-funded row would
abort the whole batch under a SUM comparison. For a genuinely new id no ledger
rows can exist (trigger (1a) guarantees it), so `<> 0` is equivalent for every
real insert. A balance therefore always opens empty and is funded by a
`deposit_initial` ledger row — never by an opening `balance_cents` literal.

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

| Event                 | Ledger rows written                                                           |
| --------------------- | ----------------------------------------------------------------------------- |
| **Signup**            | `deposit_initial` `+100000`, `ref_id='init'` — once per account, for its life |
| Bet placed            | `bet_stake` `-stake`, `ref_id=betId`                                          |
| Bet won               | `bet_payout` `+payout` (= stake + profit), `ref_id=betId`                     |
| Bet pushed / voided   | `bet_payout` `+stake`, `ref_id=betId`                                         |
| Bet lost              | **none** — the stake row already debited it                                   |
| Bet cancelled by user | `bet_refund` `+stake`, `ref_id=betId`                                         |
| Admin adjustment      | `admin_adjust` `±n`, `ref_id=<uuid>`                                          |

A loss writing no row is deliberate: it keeps the ledger a pure cash-movement log,
and `SUM(amount_cents) = balance_cents` stays trivially checkable
(`scripts/reconcile.mjs`, M7).

### 4.4 Account balances (M5b — replaces lazy season rollover)

**A user has exactly one balance, it is opened at signup, and it lasts forever.**
No rollover, no per-league pot, no lazy creation on a read path. The two
statements live in the SIGNUP batch, next to the `users` INSERT:

```sql
-- Guarded, NOT `OR IGNORE`. The id is a fresh uuid, so a duplicate would not
-- collide on the primary key -- it would collide on the partial unique index
-- `idx_bankrolls_main`, `OR IGNORE` would swallow THAT, and the ledger insert
-- below would then fire against a bankroll id that does not exist, aborting the
-- whole batch on `ledger_bi_bankroll_exists`. The NOT EXISTS states the intent.
INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
SELECT ?1, ?2, 'Main', 'main', 0, ?3, ?3
 WHERE NOT EXISTS (SELECT 1 FROM bankrolls WHERE user_id = ?2 AND kind = 'main');

-- The ledger may never use `OR IGNORE` at all: it can swallow a value-guard
-- failure (§4.2). Express idempotency explicitly.
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT ?4, ?1, 'deposit_initial', 'init', NULL, 100000, ?3, 'opening balance'
 WHERE EXISTS (SELECT 1 FROM bankrolls WHERE id = ?1)
   AND NOT EXISTS (
     SELECT 1 FROM ledger
      WHERE bankroll_id = ?1 AND kind = 'deposit_initial' AND ref_id = 'init');
```

The balance opens at `0` and the trigger raises it to `100000` — application code
never writes a balance. Both statements are idempotent, so the same pair is also
`ensureMainBalance()`, a **repair primitive for an account that somehow has no
balance**. It is tested (`tests/worker/schema.spec.ts` runs it against an
already-funded row and asserts a complete no-op) but **there is no endpoint for
it**: signup opens the balance in its own batch, no account can reach production
without one, and an admin route nobody can demonstrate a use for is a surface
rather than a safety net. Nothing on any request path calls it. If a
`POST /api/admin/users/:id/repair-balance` is ever added, it goes in §11.6.

**What this deleted, and why it is a simplification rather than a loss.** `GET
/api/bankroll`, `GET /api/games` and `POST /api/bets` each used to run the lazy
prelude, because a new season needed a new bankroll. Consequences that are now
simply gone:

- a GET that durably wrote two rows (including, for a while, on a request that
  answered 404 — see §14.2);
- `MIXED_LEAGUE_PARLAY` / `MIXED_SEASON_PARLAY`, which existed ONLY to keep every
  leg pointing at the one bankroll a bet implied. Legs may now span leagues and
  seasons freely. The codes stay in the vocabulary for wire stability and are
  documented as deprecated; nothing throws them;
- a leaderboard that had to sum across bankrolls to answer "all-time".

**Which balance is charged** is now an explicit request field, `bankrollId`,
defaulting to the caller's `main`. A balance that is not the caller's is
`404 BANKROLL_NOT_FOUND` — never 403, for the same no-existence-oracle reason
`GET /api/bets/:id` is a 404. The pre-flight read exists only to produce that
specific error; the REAL guard is an `EXISTS` over `bankrolls` inside the
placement INSERT (§14.2), because a read followed by an unguarded write is the
read-then-write the house rules forbid.

**Season and league provenance.** `bets.season` and `bets.league` are still read
from the legs' own `games` rows and never guessed from a wall clock — but they
are now LABELS rather than a partition of the money. `league` is the legs' one
league, or `'mixed'` when they span both. `season` is the season of the
EARLIEST-KICKOFF leg, which is the one a human would name. A January-2027 bowl
bet is still labelled season 2026.

`currentSeason` — used only to _default_ the board and the stats filters — is the
season of the **next game to kick off** (`MIN(kickoff_at) >= now − BOARD_LOOKBACK_MS`),
falling back to the most recent game when nothing is upcoming. It is deliberately
not `MAX(games.season)`: once 2027 preseason lands in August 2027, `MAX` would
label a January-2027 bowl as 2027.

**Admin adjustment.** `POST /api/admin/users/:id/adjust {amountCents, memo}`
writes one `admin_adjust` ledger row against the target's main balance, either
sign, with a fresh uuid `ref_id` — so an admin who types "+5000" twice means it
twice. There is no overdraft branch in the application code: a debit larger than
the balance is refused by `ledger_bi_sufficient_funds`, which rolls the batch
back, and that abort is mapped to `409 INSUFFICIENT_FUNDS`.

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

### 5.8 Teasers (M5b)

A **teaser** is a parlay whose spread/total legs are all moved the same number of
points in the bettor's favour, priced from a **fixed card** instead of from the
product of its legs. Implemented across `constants.ts` (`TEASER_PAYOUTS`),
`odds.ts` (`teaserPrice`, `teasedLineTenths`) and `grading.ts` (`BetPricing`).

**The card.** `TEASER_PAYOUTS[pointsTenths][legCount]`, integer American, 13
tiers × 9 leg counts. Generated by `node scripts/teaser-card.mjs --markdown`;
`tests/unit/docs.spec.ts` checks it against the constant cell for cell:

| legs | 3 pt   | 4 pt  | 5 pt  | 6 pt  | 6.5 pt | 7 pt  | 8 pt  | 9 pt | 10 pt | 11 pt | 12 pt | 13 pt | 14 pt |
| ---- | ------ | ----- | ----- | ----- | ------ | ----- | ----- | ---- | ----- | ----- | ----- | ----- | ----- |
| 2    | +155   | +130  | +105  | −120  | −130   | −140  | −165  | −185 | −250  | −300  | −375  | −475  | −600  |
| 3    | +325   | +250  | +200  | +150  | +135   | +120  | +105  | −115 | −150  | −185  | −225  | −275  | −350  |
| 4    | +575   | +450  | +350  | +260  | +225   | +200  | +155  | +130 | −105  | −125  | −155  | −200  | −250  |
| 5    | +1000  | +725  | +550  | +400  | +350   | +325  | +225  | +185 | +140  | +110  | −115  | −145  | −185  |
| 6    | +1700  | +1200 | +825  | +600  | +500   | +450  | +300  | +250 | +190  | +145  | +115  | −115  | −145  |
| 7    | +2800  | +1900 | +1300 | +900  | +800   | +700  | +425  | +325 | +250  | +190  | +145  | +110  | −120  |
| 8    | +4500  | +2900 | +1900 | +1400 | +1100  | +900  | +600  | +425 | +325  | +225  | +175  | +135  | +105  |
| 9    | +7500  | +4500 | +2800 | +1900 | +1500  | +1200 | +750  | +550 | +400  | +300  | +225  | +160  | +120  |
| 10   | +12500 | +7000 | +4000 | +2500 | +2000  | +1500 | +1000 | +700 | +500  | +350  | +250  | +195  | +145  |

The 6 / 6.5 / 7 / 8 / 9-point columns are Bovada's published "classic
standard" card verbatim — the only fully populated 2-10-leg grid any book
prints. The other eight tiers are GENERATED from one model fitted to those 45
cells (`docs/teaser-odds.md` §5): a teased leg wins with probability
Φ(points / 14.65) — margin-against-the-spread treated as normal, σ fitted — and
the book keeps a flat 3.25 % hold, so an n-leg price is (1 − hold) / pⁿ, rounded
as a card is printed (to 5 under ±200, to 25 to +1000, to 100 to +3000, to 500
above; a cell that would round to ±100 is printed −105, because even money has
no American form, §5.5). Sanity checks the model was NOT fitted to: DraftKings'
10-point 3-leg "Super" teaser is −120 and its 13-point 4-leg "Monster" is −140,
both with ties LOSING; our card says −150 and −200 with ties REDUCING (below),
which is the side to err on. Script output, not arithmetic done by hand
(CLAUDE.md rule 2): the worst cell is the 10-leg 3-point +12500, which at the
full 100,000¢ bankroll returns 12,600,000¢ — an 8× margin under
`MAX_PAYOUT_CENTS`. Every cell is monotone: more points is a worse price at the
same leg count, more legs a better one at the same tier (both pinned by
`tests/unit/odds.spec.ts`).

Tiers are stored and transported in **TENTHS** (30 … 140), for the same reason
lines are: 6.5 has no integer representation in points, and a client that sends
`6` where `60` is meant would otherwise tease by 0.6 of a point. `teaserPoints:
6` is rejected (`TEASER_INVALID`).

**Line adjustment**, at placement, in integer tenths (REPL-verified):

```
spread:  teased = lineTenths + points     // the line already carries the bettor's
                                          // sign, so ADDING always helps:
                                          //   home -7.5 (-75) @6 -> -1.5 (-15)
                                          //   away +3.5 (+35) @6 -> +9.5 (+95)
total over:  teased = lineTenths - points //   o45.5 (455) @6 -> o39.5 (395)
total under: teased = lineTenths + points //   u45.5 (455) @6 -> u51.5 (515)
moneyline:   REJECTED — there is no line to move
```

`teasedLineTenths` checks the `(market, side)` pair **before** it branches on the
market, so an incoherent leg — `('spread','over')`, `('total','home')` — throws
`VALIDATION` rather than being answered by whichever branch it happened to reach.
The schema forbids those legs outright
(`CHECK ((market = 'total') = (side IN ('over','under')))`), so reaching the
function with one is a caller bug, and returning a plausible number for a leg
that cannot exist is the worst available response. Pinned by a test.

The teased value goes into `bet_legs.line_tenths` and the book's into
`bet_legs.original_line_tenths`. That is the single most important design choice
here: **grading reads one column and has no idea teasers exist.** A 6.5-point
tier off a half-point line lands on a whole number, which is a real push risk —
exactly and deliberately representable.

**Pricing.** `bets.american_price = TEASER_PAYOUTS[tier][legCount]` and
`potential_payout_cents = payoutCents(stake, americanToPrice(that))`. Each LEG
stores `american_price = 100` — a placeholder the schema's
`CHECK (abs(american_price) BETWEEN 100 AND 100000)` requires, not a price.
Nothing reads it; `priceFromLegs` is meaningless for a teaser.

**Push rules** (confirmed across Bovada, covers.com, Wizard of Odds and
FanDuel-derived sources):

- **any loss → the whole teaser loses**, however many legs pushed. A loss is
  never cured by a push elsewhere.
- **a push or void reduces** the bet to the card's row for the SURVIVING leg
  count, same tier. A 4-leg 6-point teaser with one push pays as a 3-leg one.
- **fewer than two survivors → NO ACTION**: status `push` (or `void` when every
  leg voided), payout = stake, `american_price = 100`. There is no such thing as
  a one-team teaser, and a 2-leg teaser with one push is universally refunded
  rather than re-graded as a priced single.
- a postponed or cancelled game grades exactly like a push.

**Worked examples, all REPL-verified at a 1000¢ stake, 6-point tier:**

| Outcome         | Effective price                            | Payout ¢ |
| --------------- | ------------------------------------------ | -------- |
| 3 legs, all win | **+150**                                   | **2500** |
| …one leg pushes | **−120** (2-leg row)                       | **1833** |
| …two legs push  | 1/1 (no action)                            | **1000** |
| any leg loses   | +260 if placed as 4 legs (placement price) | **0**    |

Contrast: those same three −110 legs as a PARLAY pay 6957¢. The card is the
price, not the legs.

**Scope.** 2-10 legs; spread and total only; cross-league allowed (NFL and CFB
share a point schedule, which is the industry condition for mixing); no two legs
from the same game, as for any parlay. The payout cap is checked on the same
shared path but is unreachable in practice — the worst cell at the full
bankroll, 10 legs at 6 points (+2500) on 100,000¢, returns **2,600,000¢** against
a 100,000,000¢ cap (verified).

**Big tiers keep push protection.** The 10-to-14-point tiers overlap the range
of DK-style "Super"/"Monster" specialty teasers, whose defining rule is that
ties LOSE. Ours do not: every tier on this card grades by the push rules above
(a push reduces, never loses). That is a deliberate single rule set — one
`gradeBet` for every tier — and the card's prices at those tiers are set worse
than DK's precisely to pay for the protection (see the card note). Nothing here
implements a ties-lose product, and `docs/teaser-odds.md` §4 is still the
warning against conflating the two.

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

gradeBet(bet, legs, games, pricing) -> BetOutcome
  // `pricing` comes from the BET ROW, never from the legs:
  //   bet_type = 'teaser' -> { kind: 'teaser', pointsTenths: teaser_points_tenths }
  //   otherwise           -> { kind: 'parlay' }   (the default)
  if any leg 'pending'                          -> { status: 'pending' }          // no writes
  if any leg 'loss'                             -> { status: 'lost',  payout: 0 }
  live = legs where result === 'win'
  minSurvivors = pricing.kind === 'teaser' ? 2 : 1
  if live.length < minSurvivors:
      allVoid = every leg is 'void'
      -> { status: allVoid ? 'void' : 'push', payout: stake }
  price = pricing.kind === 'teaser'
            ? americanToPrice(TEASER_PAYOUTS[pointsTenths][live.length])
            : Π live[i].price
  payout = floorDiv(stake * price.num, price.den)
  -> { status: 'won', payout }
```

Note the ordering: **a losing leg beats everything**, evaluated before push removal —
a parlay with 1 loss and 4 pushes still loses. And a straight bet is just the
1-leg case of the same function; there is no separate straight code path.

**Push semantics, confirmed 2026-09-14 (§19 Q4), in one sentence:** a pushed
STRAIGHT bet is refunded as if it never happened and is excluded from record and
ROI entirely; a parlay or teaser DROPS the pushed leg and is re-priced from the
survivors (the card's lower row, for a teaser); and an all-push bet — like one
that reduces below a teaser's two-leg minimum — is refunded at even money.

**`pricing` is an ARGUMENT, not an inference (M5b).** The legs of a teaser and of
a parlay are deliberately indistinguishable — the teased line is already in
`bet_legs.line_tenths`, which is what keeps `gradeLeg` teaser-unaware — so the
only place the difference lives is the bet row. Omitting the argument defaults to
`{kind:'parlay'}` and would pay a 3-leg teaser at 2.0³ instead of the card's
+150. §7.1's selection query must therefore read `bet_type` and
`teaser_points_tenths` alongside `stake_cents`. Everything downstream is
unchanged: every card value round-trips exactly through `priceToAmerican`, and a
teaser reduced below two survivors comes back as `push` with `payout = stake`,
which is a shape settlement already handles. Full rules in §5.8.

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
and no batch. A run therefore issues four fixed calls — reset sweep, select, stuck
report, load legs — plus at most one per selected bet, i.e. `4 + ≤20 batches`:
**24 D1 calls** at the chunk of 20 if a batch counts as one, or **244 statements**
worst case if it counts per-statement (4 + 20 × 12). That is why Spike **S2** must
confirm the accounting before we raise `chunk` above 20; `runSettle`'s docblock in
`src/worker/settle.ts` carries the same two numbers. With ≤ 10 users the realistic
volume is a few bets per run.

**If the Worker dies mid-run**: each bet's transition + leg results + payout are one
atomic batch, so every bet is either fully settled or fully pending. Bets not yet
reached are simply picked up by the next run 15 minutes later. There is no
"half-settled" state to repair. The lease (§9.2) expires on its own.

**What "already settled" means, and why it is not just layer 1.** A run reports a
bet as `skippedAlreadySettled` when it turns out not to be the run that paid, by
any of the three routes above: it lost the conditional UPDATE, the payout
`INSERT`'s `NOT EXISTS` found the ledger row already there, or the ledger UNIQUE
fired and aborted the batch. None is an error and none moved money. Layer 2 is
**not** redundant with layer 1: a bet pushed back to `pending` by hand — an
operator repairing a game, or `retry-settlement` after a manual fix — wins the
conditional UPDATE on the next run even though its `bet_payout` row already
exists, so statement 1's `changes = 1` alone would have the run claim a second
payment in `stats.settled`/`stats.paidCents` that the ledger correctly refused.
When money is owed, the PAYOUT statement's `changes` is what decides whether this
run paid. That statement is addressed by the INDEX the batch builder returns,
never by `results.length - 1`, so appending a statement later cannot silently
make every paying settlement read as already-settled. (`changes > 0`, not
`=== 1`: D1 reports **2** for the payout insert — measured — because
`ledger_ai_apply`'s `bankrolls` UPDATE is counted too.)

**A bet whose BATCH THROWS is deferred as well as reported.** It goes into
`stats.errors[]`, and it also takes the same single no-money
`settle_attempts` UPDATE a `pending` outcome takes. Leaving the counter alone
would pin twenty such bets at the head of `ORDER BY settle_attempts ASC`, where
they would re-fail ahead of every healthy bet on every run forever — the exact
head-of-line starvation §7.1's counter exists to prevent, entered through a
different door. If even that UPDATE fails, it is logged and the chunk continues;
the run is already reported through `errors`.

**The run's recorded status.** `runSettle` throws `SettleRunError` when
`stats.errors` is non-empty — **after** the whole chunk is processed, so a bad
bet never costs the healthy ones their settlement. `withJobRun` decides
`job_runs.status` purely on whether the body threw, so without this a run that
failed to settle every bet it selected would be recorded `ok` and
`GET /api/admin/jobs` — the one place an operator looks when money looks wrong —
would show green. The error carries its `stats` (see §9.2's `carriedStats`), so
the full per-bet detail is recorded alongside the one-line message.

**`SettleStats`, as written to `job_runs.stats`:**

| Field                      | Meaning                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selected`                 | bets §7.1's query returned this run                                                                                                                                                                                       |
| `settled`                  | bets THIS run transitioned and paid                                                                                                                                                                                       |
| `deferred`                 | selected but graded `pending`; `settle_attempts` incremented                                                                                                                                                              |
| `reset`                    | deferred bets handed a fresh budget by the opening sweep (`meta.changes`)                                                                                                                                                 |
| `stuck[]`                  | ids parked at `MAX_SETTLE_ATTEMPTS`, capped at 50 — an alarm, not a work queue                                                                                                                                            |
| `won`/`lost`/`push`/`void` | outcome counts among `settled`                                                                                                                                                                                            |
| `paidCents`                | Σ payout among `settled`                                                                                                                                                                                                  |
| `skippedAlreadySettled`    | see above                                                                                                                                                                                                                 |
| `rowsWritten`              | D1 `meta.rows_written` summed over **every** statement the run issued, the opening reset sweep included — the unit the hard-enforced 100k/day cap counts, and the field `jobs.ts::dayRowsWritten` sums across jobs (§8.6) |
| `errors[]`                 | `{betId, error}` per failed bet                                                                                                                                                                                           |

`reset` and the sweep's `rowsWritten` are tracked separately on purpose: the
sweep writes `settle_attempts`, which `idx_bets_pending` indexes, so the number
the cap counts exceeds the bets touched — and omitting it would under-report the
settle job's share of the budget.

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

**How many dates the planner emits is §22's question, not this one.** The unit of
work is unchanged — one ET date, one request — but the RANGE of dates ends on the
Monday that closes the football week rather than ten days out. §22 owns that
rule, its two rollover instants and its operator-visible consequences; everything
else in this section reads the same either way.

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
  lowest `provider.priority`. **The primary's row is keyed on the ID, never on the
  display name**: id `100` is always written as `LINE_PROVIDER_PRIMARY` (`'DraftKings'`),
  because ESPN served the same book as `DraftKings` and `Draft Kings` within one day
  (2026-09-17) and `game_lines` is keyed on this string — a drifting name forked every
  game's line into two rows and made the merge rank the fresh one as an unknown
  provider, below the secondary. Any other book keeps its own name. `providerRank`
  (§21.4) compares NORMALISED strings for the same reason, so rows already written
  under the variant still rank as the primary.
- `close` preferred, `open` as fallback, otherwise that market is `NULL`.
- `"o50.5"` / `"u50.5"` / `"+3.5"` / `"-3.5"` / `"EVEN"` / `"PK"` are all handled by
  `parseLineToTenths` / `parseAmericanPrice` with explicit unit tests.
- Cross-check: if `pointSpread.home.close.line` is missing but the top-level
  `spread` number is present, use `spread` (home perspective). `details` (`"CIN -3.5"`)
  is **never** parsed — it is a display string and abbreviation-dependent.
- Sanity bounds: `|line_tenths| <= 1000` (±100 pts), `100 <= |american| <= 100000`.
  Out-of-range → drop the market + warning.
- **`"OFF"` means the book has pulled the market.** DraftKings serves the literal string
  `OFF` in every field of a suspended market (line and price, `close` and `open`; captured
  live for CFB 401856811 on 2026-09-16, spread up, total and moneyline OFF). The market is
  dropped with the note `<market>: off the board` — distinct from `unusable`, which is
  reserved for a malformed value — and the top-level `spread` number is NOT consulted as a
  fallback for an OFF spread, because a bet must never snapshot a line the book withdrew.
  One `pulled()` helper runs before any market parser reads a leaf, so no parser can get
  the order wrong, and a one-sided OFF node is still a pull.
- **A withdrawal is a WRITE.** When every market is pulled, `parseLines` still returns a
  row with all three markets null, so the upsert NULLs the columns and bumps `seen_at`.
  Without that, "no market → no row → no write" would leave the previously stored line on
  the board, and bettable, until its staleness window (3–18 h) ran out. An odds entry whose
  markets are merely ABSENT still yields no row: there is nothing to withdraw, and writing
  empty rows for never-priced games would spend the write budget for nothing.
- Every warning carries `label`, the event's `shortName` (`"HOU @ TTU"`), so the admin view
  can name the game; it is null only for a structural warning raised before the teams parsed.
  Ingest renders warnings as `<eventId> (<label>): <provider>: <notes>`.

**Board coverage measurement.** ESPN carries exactly one book, so a missing market has no
in-feed fallback. Rather than build a second `OddsProvider` (§2.4) on a hunch, every
refresh run records in `job_runs.stats`:

- `upcomingGames` — games that are `scheduled` AND whose kickoff is still ahead of the run's
  clock (a game ESPN still calls "pre" a minute after kickoff is not a gap);
- `lineGaps` — those with no line row or any market null (absent at the book, or OFF), with
  `noLine` / `noSpread` / `noTotal` / `noMoneyline` saying which. Discount `noMoneyline`: a
  heavy favourite has no moneyline at any book (§14.9);
- `lineGapDetails` — `"HOU @ TTU: no total, no moneyline"`, capped once per run at
  `ESPN_MAX_WARNINGS_RECORDED`; the counts are never capped;
- `coverage[]` — the same counts PER TARGET (`{ targetId, upcomingGames, lineGaps }`). The
  run totals conflate the live date's board with the discovery slot's future date, where
  the book has often posted nothing yet; only the per-target rows are comparable run to run.

`lineGapsOf(slate, now)` in `ingest.ts` is the pure function, counting each game once
however many times a payload lists it. It measures the PARSED slate, like `warnings`: a
target with no slate (fetch or parse failed) reports zeros, and a slate whose upsert threw
is still measured, next to its `error`. The decision rule: if a few Saturdays of the live
date's `lineGaps` are a handful of obscure CFB games, a second provider is not worth its
request budget; if they are material, the per-market counters say which markets to buy.

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
conference     team.conferenceId, kept as a string id (asIdString). NULL when
               absent, which is every NFL competitor. Stored on `games` as
               home/away_conference_id (migration 0004).
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
   `(league, ET date)` covering `now … boardWindowEnd(league, now)` — the window
   that ends on the Monday closing the football week (§22): 2 ET dates on a
   Sunday morning for the NFL, 7 on a Tuesday, 8 on a Monday, at most 9 on a
   Sunday after the rollover, so **≤ 18 rows**, created once and then reused. The two leagues differ by a week for
   part of every Sunday, which is why the planner walks the dates PER LEAGUE.
   Delete targets whose window ended more than 2 days ago and that have no
   non-final games. Beyond that weekday rule the planner still needs no league
   calendar, which is what keeps bowls and the NFL postseason free (§8.2).
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

   Budget check, computed (under §22's window): at most 9 ET dates × 2 leagues =
   **18 targets**, 16 on a Monday and 14 from Tuesday on. Worst case 2
   are live, leaving **16** discovery targets that each want a +6 h refresh =
   4/day = **64 slot-uses/day**, against a supply of **96** — fits with 32 to
   spare, where the 10-day window it replaced left 16. The DST footnote that used
   to sit here (a 23 h day makes a 10-day window span twelve ET dates) no longer
   binds: a weekday-anchored window spans at most 9 dates however long its days
   are. If two targets are live simultaneously they alternate
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
-- for a clock, score, rank or conference change, and 1 for an L3 "seen" touch.
UPDATE games SET
  period = ?, display_clock = ?,
  home_score = COALESCE(?, home_score), away_score = COALESCE(?, away_score),
  status_detail = ?,
  home_rank = ?, away_rank = ?,
  home_conference_id = COALESCE(?, home_conference_id),   -- absent != left the conference
  away_conference_id = COALESCE(?, away_conference_id),
  home_logo = ?, away_logo = ?,
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
against a 3-hour `LINE_STALE_MS` floor.

**The staleness window scales with the refresh tier.** A line is stale once
`now - seen_at` exceeds `lineStaleAfterMs(kickoff, seen_at)` =
`max(LINE_STALE_MS, LINE_STALE_MULTIPLIER (3) × expectedRefreshMs(kickoff, seen_at))`
(both in `src/shared/time.ts`, next to the refresh tiers they read): 3 h for a
line confirmed inside 48 h of kickoff (cadence hourly or faster, so 3 h
unconfirmed means ingestion is broken), **18 h** for one confirmed further out
(cadence 6 h). A flat 3 h window declared every far-off game's line stale for
half of each early-week day — three of every six hours — and hid the whole
Saturday slate on a Monday. The window exists to catch a broken ingest, not to
police line movement; with fake money, a stale-by-an-hour price is nobody's
loss. The tier is judged at `seen_at`, NOT at `now`, so the window is fixed
the moment a line is confirmed and is monotone in wall-clock time: a line that
is fresh cannot flip to stale merely because the game crossed the 48 h boundary
since. That is also what lets `toLinesView` (board) and `resolveLegSnapshots`
(placement, `bets.ts`) — which evaluate at different instants — agree: for a
given row they compute the same window, so the board never offers a price the
server then refuses as `MARKET_UNAVAILABLE`.

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
board hides that market once `now - seen_at > lineStaleAfterMs(kickoff, seen_at)`
(3 h if confirmed inside 48 h of kickoff, 18 h if further out — see L3 above) — rendering an explicit
"line unavailable" state rather than a silently missing button.

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

**How much work each run does** is two `wrangler.jsonc` vars, not constants —
they are the knobs Spikes S1 and S2 exist to justify, and `env.ts` bounds-checks
both at startup:

| Var                       | Value | What it caps                                                                   |
| ------------------------- | ----- | ------------------------------------------------------------------------------ |
| `REFRESH_TARGETS_PER_RUN` | `2`   | ET-date targets ingested per `refresh` run (§8.4). Spike S1 blocks raising it. |
| `SETTLE_CHUNK`            | `20`  | bets settled per `settle` run (§7.1). Spike S2 blocks raising it.              |

`docs/OPERATIONS.md` lists the same three cron expressions from the operator's
side, and `tests/unit/docs.spec.ts` asserts all of it against `wrangler.jsonc`.

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

**The body contract: throwing is how a job says "record me as `error`".**
`withJobRun` always resolves — an error in the body, or in any of the three
`job_runs` writes, is recorded or logged and never rethrown, so one bad job (or a
D1 hiccup while recording it) cannot take the `scheduled()` handler down.
`acquireLease` is the single call left unguarded, deliberately: if the lock table
itself is unreachable there is nothing to run and nowhere to record it, and the
caller should see that.

A body that did real work and **then** failed may hang a plain `stats` object off
the thrown error; `carriedStats(err)` picks it up and it is recorded in
`job_runs.stats` alongside the message. That is how a settle run with one failed
bet is reported as `error` **and** keeps its full per-bet detail (§7.4's
`SettleRunError`) — and it is why `dayRowsWritten` can sum `stats.rowsWritten`
over failed runs too, rather than under-counting the write budget exactly when
something is going wrong. `carriedStats` is job-agnostic on purpose: `jobs.ts`
knows nothing about settlement, only that an error MAY carry a plain object.
Anything else — an array, a primitive, a cycle — yields `null`, and the JSON
encoder still has the final say on whether it can be serialised.

### 9.3 Manual trigger

`POST /api/admin/jobs/:job` (`refresh | settle | maintenance`) runs the identical
function with `trigger='admin'`, takes the same lease, and returns the `job_runs` row
including stats. This is how we test in production without waiting 15 minutes, and
it is the documented recovery action if a job wedges.

**What ships: INLINE, returning `200` with the run.** The admin trigger runs in
an HTTP invocation with the same 10 ms budget, so `refreshTargetsPerRun()` drops
an admin `refresh` to ONE target. `ctx.waitUntil` was considered and rejected: it
grants extra wall time, not extra CPU, so if S1 comes back bad the remedy is
R1's fallback ladder, not `waitUntil`. There is no `202` path in the code.

**Per-game refresh.** `POST /api/admin/games/:id/refresh` is "refresh this
game" for an operator staring at a stale card. The unit of an ESPN request is a
DATE slate (§8.2), so it does not fetch one event: `bumpTargetForGame` sets the
game's own target to `next_run_at = 0` (re-creating it if `planTargets` retired
it, so an old STUCK game can be re-pulled), then the identical admin `refresh`
runs — ONE target, and that target is now the most due thing in the queue.
`priority` is untouched, because the post-run reschedule writes `next_run_at`
only and a lowered priority would pin the target at the head of every later run.
A slate `planTargets` would retire — ended more than two days ago with every
game final or canceled — is refused with `400 VALIDATION` before anything is
touched, because the run starts with `planTargets`, which would delete the
bumped row and then quietly refresh something else. Same lease, same
`409 JOB_LOCKED`, same `job_runs` row; `404 GAME_NOT_FOUND` for an unknown id.
The button lives on the board's game card and is rendered only for admins.
ACCEPTED RACE: the bump and the run are two round trips, so a cron tick that
takes the lease in between claims the bumped slate itself and the admin's own
run refreshes the next most due one — the game is refreshed either way, but
that run's `job_runs` row describes a different slate. Rare (one tick per 15
min) and not worth moving the bump inside the lease.

**A job whose BODY threw still returns `200`, with `run.status === 'error'` and
the message in `run.error`.** That is deliberate. The HTTP status answers "did
the trigger work", and it did: the lease was taken, the run was recorded, and the
failure is now visible in `GET /api/admin/jobs` exactly as a failed CRON run
would be. Mapping it to a 500 would throw away the run id and the stats — which,
for `settle`, are the whole point (§7.4). The only non-`200` here is
`409 JOB_LOCKED`, meaning the lease is held by the cron or by another admin.

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
- **Disabling an account EVICTS its live sessions**, in the same `batch()` as the
  flag. Disabling is a containment tool ("this account is compromised"), and a
  flag that leaves a 30-day cookie working is not containment. Re-enabling
  therefore requires a fresh login. `resolveSession` additionally joins on
  `is_disabled = 0`, belt to braces. The eviction `DELETE` is guarded on the flag
  actually having been written, so a refused disable evicts nothing.
- **You cannot disable the LAST enabled admin**, and you cannot disable
  yourself. `is_admin` is only ever written by the first-signup `CASE` — there is
  no promotion path — so locking out the last admin would be unrecoverable
  without `wrangler d1 execute`. The guard is a `WHERE` conjunct inside the same
  UPDATE, not a read-then-write, and a refusal is reported as a distinct
  `400 VALIDATION` on `disabled` rather than a silent no-op:

  ```sql
  … OR (SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_disabled = 0) > 1
  ```

**Deleted accounts** (`users.deleted_at IS NOT NULL`, migration 0002). `DELETE
/api/admin/users/:id` (§11.6) soft-deletes: in ONE batch it sets `is_disabled = 1`
and `deleted_at = now`, renames `username` to `deleted_<first 12 hex of the id>`,
sets `display_name = 'Deleted user'`, and deletes every `sessions` row for the user.
What that buys, in order:

- **Cannot log in.** `login`'s lookup is `WHERE username = ?1 AND deleted_at IS NULL`,
  so a deleted account falls into the unknown-user branch: dummy PBKDF2 against the
  decoy salt and the identical `401 INVALID_CREDENTIALS`. It is _not_
  `ACCOUNT_DISABLED` — that would confirm both the (renamed) username and the
  password, which is exactly the oracle the rest of this section exists to avoid.
- **Sessions are dead** twice over: the rows are gone, and `resolveSession`'s JOIN
  carries `u.deleted_at IS NULL` as well as `u.is_disabled = 0`.
- **Off the leaderboard** (§11.5), which is the reason the feature exists: a
  throwaway test account was still being ranked after being disabled.
- **The old username is free.** The rename is what releases it, so somebody else can
  register it; the deleted row keeps `deleted_<hex>` (20 chars, inside the
  `length(username) BETWEEN 3 AND 24` CHECK) forever.
- **Still in `GET /api/admin/users`**, with `isDeleted: true` and `deletedAt`. That is
  the one surface that shows them, so an operator can see the row and understand the
  renamed username.
- **`POST /users/:id/disabled`, `/users/:id/password` and `/users/:id/adjust` all
  return 404** for a deleted account. A re-enable would be a half-resurrection with no
  visible effect except a confusing chip; an adjustment would move money into or out
  of a balance nobody can reach again, which is either money that can never be spent
  or a silent rewrite of the history `db:reconcile` vouches for. `/adjust`'s guard is
  a `WHERE EXISTS (… deleted_at IS NULL)` inside the ledger INSERT — a money path
  gets no read-then-write (rule 5), and `INSERT … SELECT … WHERE` rather than
  `INSERT OR IGNORE`, which rule 6 bans from `ledger` outright.

**THE TOMBSTONE NAME IS RESERVED, AND THE RENAME CAN STILL COLLIDE.**
`deleted_<12 hex>` satisfies every rule in `validateUsername`, and
`GET /api/leaderboard` hands every authenticated user everybody else's uuid — so it
was, until this was fixed, a username anybody could register. A squatter who did so
made the targeted account permanently undeletable: the rename lost to
`UNIQUE(users.username)` and the route answered `500 INTERNAL` forever, on
attacker-chosen input. Two changes, because one is not enough:

1. **`validateUsername` rejects the `deleted_` prefix** (`RESERVED_USERNAME_PREFIX`),
   with `400 VALIDATION` and "that prefix is reserved". It is in `src/shared`, so the
   browser refuses it before spending a second on the KDF, and it applies on LOGIN as
   well as signup — a purely syntactic refusal, identical for a tombstone that exists
   and one that never will, so it is no enumeration oracle. This closes the reachable
   half.
2. **`deleteUser` retries once at 16 hex** (`deleted_` + 16 = 24 characters, exactly
   the CHECK's ceiling) when the 12-hex name collides anyway — another DELETED row
   sharing the first 12 hex digits of a uuid. Astronomically unlikely and not
   attacker-controlled, but it is still a collision, and a second value for the same
   id cannot lose to the row that just beat it. If even that collides the answer is
   `409 USERNAME_TAKEN` naming the tombstone, never a bare `INTERNAL`: an operator who
   is told which name is in the way can rename it and retry.

**Nothing else is deleted and no money moves** — not one ledger row, not one
`balance_cents` write. Settled bets, cancelled bets and the whole ledger stay, because
the ledger is append-only by DDL and `SUM(ledger) = balance_cents` has to keep
reconciling for that bankroll after the delete exactly as it did before.

Guards, all expressed as `WHERE` clauses inside the UPDATE (CLAUDE.md rule 5), with a
single follow-up read used only to _diagnose_ a zero-change write:

| Guard                                                  | Result                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target is the caller                                   | `400 VALIDATION`                                                                                                                                                                                                                                                                                                                |
| target is an admin and only one _enabled_ admin exists | `400 VALIDATION`, "Cannot delete an admin while only one enabled admin remains." — the same subquery `setDisabled` uses. Conservative on purpose: a disabled admin is the recovery path if the enabled one is lost, which is also why the message does not say "the last _enabled_ admin": the account refused is often not one |
| target has any `status = 'pending'` bet                | `409 ACCOUNT_HAS_PENDING_BETS`                                                                                                                                                                                                                                                                                                  |
| no such id                                             | `404 NOT_FOUND`                                                                                                                                                                                                                                                                                                                 |
| already deleted                                        | `204` — idempotent no-op, not an error                                                                                                                                                                                                                                                                                          |
| both tombstone names taken                             | `409 USERNAME_TAKEN` — never `500 INTERNAL`; see the reservation note above                                                                                                                                                                                                                                                     |

The pending-bet refusal is about open money: the stake has already left the balance
and settlement would credit a payout to an account nobody can reach. Cancel or settle
first. There is no promotion path for `is_admin` (it is only ever written by the
first-signup CASE), so deleting the last admin is as unrecoverable as disabling them.

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
`X-SBS-Client: 1` header. **`Content-Type: application/json` is REQUIRED on any
request with a body** — a wrong or missing media type is `400 VALIDATION` on
field `content-type`, before the body is even parsed. That is defence in depth on
top of the custom header (a cross-site `text/plain` form can set neither) and it
stops a proxy from ever mis-parsing us. A body that is absent or unparseable is
`400 MALFORMED_JSON`, never a 500.

**THE WHOLE VOCABULARY.** Every code in `ERROR_CODES`, where it comes from, and
its canonical status. The list is the wire contract: a code is never repurposed
and never removed, only added.

| Code                       | Status | Raised by                                                                                                                                                                                                                                 |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION`               | 400    | any malformed field, and a wrong `Content-Type`                                                                                                                                                                                           |
| `MALFORMED_JSON`           | 400    | a body that is absent or not valid JSON                                                                                                                                                                                                   |
| `TEASER_INVALID`           | 400    | a teaser with no tier, or a tier on a non-teaser (§5.8)                                                                                                                                                                                   |
| `UNAUTHENTICATED`          | 401    | no session on a private route                                                                                                                                                                                                             |
| `INVALID_CREDENTIALS`      | 401    | login; identical for an unknown user (§10.2)                                                                                                                                                                                              |
| `BAD_INVITE_CODE`          | 401    | signup when `INVITE_CODE` is set and wrong                                                                                                                                                                                                |
| `ACCOUNT_DISABLED`         | 403    | login by a disabled account; also placement/edit when the account is disabled or soft-deleted BETWEEN authentication and the batch (§14.2's account-state guard)                                                                          |
| `CSRF_BLOCKED`             | 403    | missing `X-SBS-Client`, or a cross-origin `Origin` (§10.5) — on every state-changing method, `DELETE` included                                                                                                                            |
| `NOT_FOUND`                | 404    | any unclaimed `/api/*` path, an unknown `:job`, and an admin user route naming an unknown OR soft-deleted account (§10.5)                                                                                                                 |
| `GAME_NOT_FOUND`           | 404    | a leg or board lookup naming a game that does not exist                                                                                                                                                                                   |
| `BET_NOT_FOUND`            | 404    | a bet that is not yours OR does not exist — never 403 (§11.4)                                                                                                                                                                             |
| `BANKROLL_NOT_FOUND`       | 404    | a balance that is not yours OR does not exist (§4.4)                                                                                                                                                                                      |
| `USERNAME_TAKEN`           | 409    | signup; also a soft delete whose 12- AND 16-hex tombstone names are both taken (§10.5) — a coded, actionable refusal instead of an `INTERNAL`                                                                                             |
| `ACCOUNT_HAS_PENDING_BETS` | 409    | `DELETE /api/admin/users/:id` while the target holds an open bet (§10.5). A NEW code, not a reused one: `BET_NOT_PENDING` is about one bet's status and says the opposite thing, and `VALIDATION` is a 400                                |
| `GAME_NOT_BETTABLE`        | 409    | `status <> 'scheduled'`                                                                                                                                                                                                                   |
| `BETTING_CLOSED`           | 409    | past `lockAt`                                                                                                                                                                                                                             |
| `MARKET_UNAVAILABLE`       | 409    | no line for that market, or `seenAt` stale                                                                                                                                                                                                |
| `LINE_CHANGED`             | 409    | `expected` disagrees and `acceptLineChange` is not set                                                                                                                                                                                    |
| `INSUFFICIENT_FUNDS`       | 409    | the `ledger_bi_sufficient_funds` trigger, mapped (§4.2) — never a pre-read                                                                                                                                                                |
| `MIXED_LEAGUE_PARLAY`      | 409    | **DEPRECATED (M5b), never thrown** — legs may span leagues                                                                                                                                                                                |
| `MIXED_SEASON_PARLAY`      | 409    | **DEPRECATED (M5b), never thrown** — legs may span seasons                                                                                                                                                                                |
| `DUPLICATE_GAME_IN_PARLAY` | 409    | two legs on one game; also `UNIQUE(bet_id, game_id)` underneath                                                                                                                                                                           |
| `PAYOUT_LIMIT_EXCEEDED`    | 409    | potential payout over `MAX_PAYOUT_CENTS` (§5.2b)                                                                                                                                                                                          |
| `BET_LOCKED`               | 409    | cancel/edit after a leg's game locked (§14.2)                                                                                                                                                                                             |
| `BET_NOT_PENDING`          | 409    | cancel/edit/retry on a bet that is not `pending`                                                                                                                                                                                          |
| `JOB_LOCKED`               | 409    | an admin trigger while the lease is held (§9.3)                                                                                                                                                                                           |
| `RATE_LIMITED`             | 429    | login/signup throttle, with `Retry-After` (§10.5)                                                                                                                                                                                         |
| `UPSTREAM_UNAVAILABLE`     | 503    | **RESERVED — never thrown today.** An ESPN failure is a job-level event: it backs the target off and is recorded in `job_runs`, so no user request is waiting on it. The code is kept for the day a request path reads upstream directly. |
| `INTERNAL`                 | 500    | anything unrecognised, deliberately generic — the original message may carry SQL or a stack                                                                                                                                               |

### 11.1 Public

| Method | Path            | Response                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`   | `200 {ok, version, now, inviteRequired, bugReportsEnabled}` — no DB access; `bugReportsEnabled` is whether `GITHUB_TOKEN` is set (§11.7)                                                                                                                                                                                                                                          |
| GET    | `/api/config`   | `200 {leagues, currentSeason:{nfl,ncaaf}, minStakeCents, maxParlayLegs, cutoffBufferMs, initialBankrollCents, maxPayoutCents, teaserPoints, teaserPayouts}` — these field names match `ConfigResponse` in `src/shared/api-types.ts` exactly; `maxPayoutCents` exists because the bet slip calls `exceedsPayoutCap()` for pre-flight (§5.2b) and must not disagree with the server |
| GET    | `/api/auth/kdf` | `200 {version, algorithm, hash, iterations, keyLengthBytes, saltPrefix}`                                                                                                                                                                                                                                                                                                          |

### 11.2 Auth

| Method | Path                     | Body                                        | Success                                                                                             | Errors                                                                                  |
| ------ | ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/auth/signup`       | `{username, displayName?, dk, inviteCode?}` | `201 {user}` + cookie                                                                               | `400 VALIDATION`, `401 BAD_INVITE_CODE`, `409 USERNAME_TAKEN`, `429 RATE_LIMITED`       |
| POST   | `/api/auth/login`        | `{username, dk}`                            | `200 {user}` + cookie                                                                               | `400 VALIDATION`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_DISABLED`, `429 RATE_LIMITED` |
| POST   | `/api/auth/logout`       | —                                           | `204`                                                                                               | —                                                                                       |
| POST   | `/api/auth/logout-all`   | —                                           | `204` — revokes every session for the caller (§10.5)                                                | `401 UNAUTHENTICATED`                                                                   |
| POST   | `/api/auth/display-name` | `{displayName}`                             | `200 {user}` — renames the caller; leaderboard and admin list read the new name on their next fetch | `400 VALIDATION` (blank, >40 code points, invisible chars), `401 UNAUTHENTICATED`       |
| GET    | `/api/auth/me`           | —                                           | `200 {user}`                                                                                        | `401 UNAUTHENTICATED`                                                                   |

`user = {id, username, displayName, isAdmin, createdAt}`.
`username`: 3–24 chars, `^[a-z0-9_]+$` after lowercasing. `dk`: exactly 64 lowercase
hex chars.

### 11.3 Games

| Method | Path             | Query                                                         | Response                                        |
| ------ | ---------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/games`     | `league` (req), `season?`, `week?`, `from?`, `to?`, `status?` | `200 {league, season, week, games: GameCard[]}` |
| GET    | `/api/games/:id` | —                                                             | `200 {game: GameCard}` / `404 GAME_NOT_FOUND`   |

`?season=` here is **not** a public season filter in the §19-Q5 sense — it is a
board narrowing over `games.season`, which survives internally for ingestion and
the week default. No money endpoint takes one.

```ts
GameCard = {
  id, league, season,
  seasonType: number,             // ESPN: 1 pre, 2 regular, 3 post — labels "Week 1" vs "Wild Card"
  week: number | null,
  kickoffAt, status, statusDetail,
  period: number | null,
  displayClock: string | null,
  neutralSite: boolean,
  home: { teamId, abbr, name, logo, rank, conferenceId, score }, away: {...},
  lockAt: number,                 // kickoffAt - cutoffBufferMs
  bettable: boolean,              // status==='scheduled' && now < lockAt && lines fresh
  lines: null | {
    provider: string,
    capturedAt: number,           // when the BOOK's price last CHANGED
    seenAt: number,               // when we last CONFIRMED the line exists
    stale: boolean,               // now - seenAt > lineStaleAfterMs(kickoff, seenAt)
    spread: null | { homeTenths, homePrice, awayTenths, awayPrice },
    total:  null | { tenths, overPrice, underPrice },
    moneyline: null | { homePrice, awayPrice }
  }
}
```

`rank` is `curatedRank.current` kept only for 1..25 (`null` otherwise, and always
`null` for the NFL); it is in the card because on a CFB board the rank is the
most visible thing about a matchup. `conferenceId` is ESPN's `team.conferenceId`
(`null` for the NFL); the CFB board's Top 25 / conference filter (§12.1) is
computed CLIENT-SIDE from these two fields over the week's slate — there is no
`?conference=` or `?ranked=` query, because it is a board narrowing, not a money
slice, and the whole week is already in hand. `period`/`displayClock` render a live game's
"Q3 07:12".

**Reading the board WRITES NOTHING.** It used to run §4.4's lazy bankroll
prelude, because a new season needed a new bankroll. A balance is account-level
and opened at signup, so a GET is a GET again.

Default window when `from`/`to` are absent: `now - BOARD_LOOKBACK_MS` (12 h) …
`boardWindowEnd(league, now)` — the end of the Monday that closes the football
week, per league (§22) — capped at `BOARD_MAX_GAMES` (300) GAMES. A games cap,
not a rows cap: once a game can have more than one `game_lines` row (§21.3) the
`LIMIT` moves into a subquery over `games`, or the board silently halves
(§21.10). Requires auth (this is a private app; the whole API is behind a session except
§11.1).

### 11.4 Bets

**`POST /api/bets`**

```ts
{
  league: 'nfl'|'ncaaf'|'mixed',            // ADVISORY since M5b — see below
  betType: 'straight'|'parlay'|'teaser',
  stakeCents: number,                       // integer, >= 100
  acceptLineChange?: boolean,               // default false
  teaserPoints?: 60|65|70,                  // TENTHS; required iff betType='teaser'
  bankrollId?: string,                      // default: the caller's main balance
  legs: Array<{
    gameId: string,
    market: 'moneyline'|'spread'|'total',
    side: 'home'|'away'|'over'|'under',
    expected?: { americanPrice: number, lineTenths: number | null }
  }>
}
```

**`league` is advisory (M5b).** The server derives the bet's league from the
legs' own `games` rows — `'mixed'` when they span both — and never compares the
two, because a balance is no longer scoped to a league and a disagreement has no
money consequence to protect against. It is still validated as a legal value.

**`bankrollId`** names the balance to charge; absent means the caller's `main`.
One that is not the caller's is `404 BANKROLL_NOT_FOUND`, identical to one that
does not exist.

**Teasers** (§5.8): `teaserPoints` is required iff `betType === 'teaser'` and
rejected otherwise; legs must be spread or total (a moneyline is
`400 VALIDATION` on `legs[i].market`); 2-10 legs. `expected` still refers to the
**book** line — the tease is applied by the server afterwards — so `LINE_CHANGED`
means exactly what it always did.

The client **never** sends the price it will be charged. The server reads the current
`game_lines` row and snapshots it. `expected` is an optional optimistic-concurrency
check: if it is supplied and differs from the server's current line, the request fails
`409 LINE_CHANGED` with `details.legs[i].current`, unless `acceptLineChange` is true.
This is how a real book behaves and it closes the "the screen said −110 but I got
−130" complaint.

Success `201 { bet: BetView }`. Error codes:
`400 VALIDATION` (stake, leg count, market/side mismatch, duplicate game, straight
with ≠1 leg, multi with <2 legs, a teaser tier that is missing / off the card /
on a non-teaser, a moneyline leg in a teaser), `404 GAME_NOT_FOUND`,
`404 BANKROLL_NOT_FOUND`, `409 GAME_NOT_BETTABLE` (status ≠ scheduled),
`409 BETTING_CLOSED` (past `lockAt`), `409 MARKET_UNAVAILABLE` (no line for that
market, or `seenAt` stale), `409 LINE_CHANGED`, `409 INSUFFICIENT_FUNDS`,
`409 PAYOUT_LIMIT_EXCEEDED` (potential payout above `MAX_PAYOUT_CENTS`).

**`MIXED_LEAGUE_PARLAY` and `MIXED_SEASON_PARLAY` are never thrown (M5b).** They
existed only to keep every leg pointing at the one bankroll a bet implied; legs
may now span leagues and seasons freely. The codes stay in `ERROR_CODES` for wire
stability — a code is never repurposed — and are marked deprecated there.

Server-side placement is **one `batch()`** (§14.2).

| Method | Path            | Notes                                                                                                                                                                                                                                               |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/bets`     | `?status=open\|settled\|all&league=&limit=&cursor=` (no `season` — §11.5). Returns `BetView[]` with legs; for open bets each leg carries a live `projected: 'win'\|'loss'\|'push'\|'pending'` computed from the current game row (never persisted). |
| GET    | `/api/bets/:id` | `404 BET_NOT_FOUND` if not yours (not `403` — no existence oracle)                                                                                                                                                                                  |
| DELETE | `/api/bets/:id` | Cancel + full refund. `409 BET_LOCKED`, `409 BET_NOT_PENDING`                                                                                                                                                                                       |
| PUT    | `/api/bets/:id` | Edit = atomic cancel + place. Body identical to `POST`. Returns `200 {bet, replacedBetId}`. All `POST` errors plus `409 BET_LOCKED`. **Must keep the bet's BALANCE** — see below.                                                                   |

**`status=open` / `status=settled` PARTITION a user's bets, so `settled`
INCLUDES `cancelled`.** `open` is exactly `status = 'pending'` and `settled` is
its complement. A cancelled bet is not "settled" in the betting sense, but the
two filters are the history UI's two tabs and a bet that appeared in neither
would simply vanish from the app. Cancelled bets remain excluded from every
_statistic_ (§11.5's record and ROI count only `won`/`lost`/`push`/`void`), so
nothing downstream is skewed; a caller wanting true settlements only filters on
`bet.status` itself.

**`PUT` may not change the bet's BALANCE.** An edit is one atomic cancel + place,
so allowing it would refund one balance and stake a _different_ one in the same
batch — moving money between balances under the banner of "editing a bet", and
linking two rows through `replaces_bet_id` / `replaced_by_bet_id` that never
shared a ledger. A caller who names a different `bankrollId` is refused with
`400 VALIDATION` on that field rather than silently overridden.

That rule used to be spelled `(league, season)`, because a balance was implied by
them. **It no longer is, so an edit may freely change the replacement's league
and season** — the refund and the new stake land on the same pot whatever the
legs are. The check is safe outside the batch because `bets.bankroll_id` and
`bets.user_id` are immutable once written (every mutable condition still lives in
the `WHERE` of the UPDATE — §14.2).

`BetView = { id, bankrollId, league ('nfl'|'ncaaf'|'mixed'), season, betType
('straight'|'parlay'|'teaser'), teaserPoints (tenths | null), stakeCents,
americanPrice, decimalOdds (string, for display), potentialPayoutCents,
toWinCents, status, payoutCents, placedAt, earliestKickoffAt, lockAt, settledAt,
cancelledAt, cancellable, replacesBetId, replacedByBetId, legs: BetLegView[] }`.

`BetLegView` gains `league` (the LEG's own — always a real one, since
`BetView.league` may be `'mixed'`) and `originalLineTenths` (the book's line
before a tease; `null` on a straight or parlay leg). `BetLegView.americanPrice`
on a teaser leg is the +100 placeholder, not a price — the bet is priced once,
from the card.

**`americanPrice` is the EFFECTIVE price, not always the placement price.** While
`status === 'pending'` it is what the bet was placed at. Once the bet settles,
§7.4's UPDATE writes back the price of the surviving (won) legs, so a parlay with
a pushed leg reports the price it was actually paid at rather than the one it was
placed at. `decimalOdds` is derived from `americanPrice` for display and is never
parsed back into arithmetic. `potentialPayoutCents` is frozen at placement (it is
what the slip promised); `payoutCents` is what was actually paid.

### 11.5 Balances, ledger, leaderboard

| Method | Path                                      | Response                                                                                                                                      |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/bankroll?league=`                   | `200 {balances: BankrollView[]}` — every balance the caller owns, `main` first. Creates nothing.                                              |
| GET    | `/api/ledger?bankrollId=&limit=&cursor=`  | `200 {entries: LedgerEntry[], nextCursor}`. `bankrollId` defaults to the main balance.                                                        |
| GET    | `/api/leaderboard?league=all\|nfl\|ncaaf` | `200 {league, rows: LeaderboardRow[]}`. `league` optional; `all` / absent is the default. **Enabled, non-deleted accounts only** — see below. |
| GET    | `/api/leaderboard/all-time`               | `200 {league:'all', rows}` — an ALIAS of the unfiltered board, kept for the shipped client.                                                   |

`BankrollView = { id, name, kind ('main'|'custom'), balanceCents,
pendingStakeCents, equityCents, record:{w,l,p,v}, roi, settledCount }`.

A LIST even though v1 always returns exactly one, because the schema models
balances as a list for future side pots and a single-object response would have
to be replaced rather than extended the day a second one exists.

**Who is ON the leaderboard: `users.is_disabled = 0 AND users.deleted_at IS NULL`.**
The board is the scoreboard of people who are playing; a disabled throwaway test
account is neither competing nor able to answer for its ranking, and leaving it there
is the bug this rule fixes. The predicate lives on the row-producing
`bankrolls JOIN users` query, so an excluded user's bets never reach an accumulator
either — none of their stake or ROI leaks into anybody else's numbers. It is a
VISIBILITY filter: nothing is deleted, no money moves, and re-enabling an account puts
it straight back on the board with the same balance and the same record.
`GET /api/admin/users` still lists everyone (§11.6).

**Semantics (explicit, because this is the classic ambiguity):**

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

**`?league=` NARROWS `record`, `roi` AND `settledCount` — NOTHING ELSE.**
`balanceCents`, `pendingStakeCents` and `equityCents` are always the whole
account, on both endpoints. Money is account-level now, so "my NFL balance" is
not a quantity that exists anywhere in the ledger; publishing one would mean
ranking on a number no reconciliation could check, and filtering the exposure but
not the balance would break `equity = balance + pending`. The tabs answer "who is
best at college football", which is a question about W-L and ROI.

`league` matches `bets.league` EXACTLY, so a cross-league (`'mixed'`) bet counts
under `all` and under neither single league. A mixed bet is not an NFL bet, and
splitting one across both records would double-count its stake in the ROI
denominator. The same rule governs `GET /api/bets?league=`.

**THERE IS NO `?season=` ANYWHERE IN THE PUBLIC API** (decided 2026-09-14, §19
Q5). The product has no concept of a season: balances never roll over, so "the
2026 leaderboard" would be a slice of a number that was never reset.
`LeaderboardResponse` has no `season` field either — one that could only ever be
`null` is worse than none. `bets.season` and `games.season` survive INTERNALLY,
for ingestion (§8.2) and the board's `week` default (`currentSeason`), and are
simply not exposed as a filter. An unknown query parameter is ignored, as
everywhere else, so a stale client that still sends `?season=` gets a board
rather than a 400.

**Ranking is by `equityCents` descending** — `balanceCents + pendingStakeCents` —
tie-broken by `roi` then `username`. Decided 2026-09-14 (§19 Q2), reversing the
original choice of realized balance. The reasoning that reversed it: `balanceCents`
excludes stakes that are still in flight, so ranking on it puts a player holding
$2,000 with $1,500 riding on tonight's game BELOW one sitting on $600, which is
not what "who is winning" means to anyone playing. Equity is what the account is
worth if every open bet were voided, so a bet neither helps nor hurts your
position until it settles. The counter-argument — "equity lets someone lead purely
by having money in flight" — is wrong on inspection: staking money does not
CREATE equity, it moves the same cents from one column to the other. All three
figures are in the row and the table leads with equity, because a table whose
first money column is not the sorted one reads as if the sort is broken.

ROI is pooled, never averaged: the numerator and denominator are summed across
every bet in scope before dividing, so a $10 week and a $10,000 week do not count
equally. (That used to be the interesting part of the all-time view, which summed
across per-season bankrolls. With one balance per account there is nothing left
to sum, and `/all-time` is now literally the unfiltered board.)

### 11.6 Admin (requires `users.is_admin = 1`)

| Method | Path                                   | Notes                                                                                                                                                                                                         |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin/games/:id/refresh`         | pulls the slate this game is on, now (§9.3) → `200 {run}`; `404 GAME_NOT_FOUND`, `400 VALIDATION` (slate retired: all final > 2 days), `409 JOB_LOCKED`                                                       |
| POST   | `/api/admin/jobs/:job`                 | `job ∈ {refresh, settle, maintenance}` → `200 {run}` or `409 JOB_LOCKED`                                                                                                                                      |
| GET    | `/api/admin/jobs`                      | last 50 `job_runs`, each with a rolling-24h `stats.dayRowsWritten` folded IN (see below)                                                                                                                      |
| GET    | `/api/admin/users`                     | list — `AdminUserView[]`, **including deleted accounts** (`isDeleted`, `deletedAt`). The only surface that still shows them.                                                                                  |
| POST   | `/api/admin/users/:id/password`        | `{dk}` → resets. `404` for a deleted account.                                                                                                                                                                 |
| POST   | `/api/admin/users/:id/disabled`        | `{disabled: boolean}` → `204`. Disabling EVICTS every live session in the same batch. Refused with `400 VALIDATION` for your own account, or for the last enabled admin (§10.5). `404` for a deleted account. |
| DELETE | `/api/admin/users/:id`                 | **SOFT delete** → `204` (also `204` when already deleted). Guards: `400` self, or an admin while only one enabled admin remains, `404` unknown, `409 ACCOUNT_HAS_PENDING_BETS`. Full semantics in §10.5.      |
| POST   | `/api/admin/users/:id/adjust`          | `{amountCents, memo?}` → `204`. Either sign; one `admin_adjust` ledger row. An overdraft is `409 INSUFFICIENT_FUNDS` **from the trigger** (§4.4), never an application check. `404` for a deleted account.    |
| POST   | `/api/admin/bets/:id/retry-settlement` | zeroes `settle_attempts`/`settle_error` on a parked bet (§7.1). Never changes status or money.                                                                                                                |
| POST   | `/api/admin/reconcile`                 | recomputes `SUM(ledger) vs balance_cents` per bankroll, returns any drift (read-only; never auto-fixes)                                                                                                       |
| GET    | `/api/admin/bugs`                      | last 50 `bug_reports`, newest first — `{reports: BugReportView[]}`, INCLUDING the ones GitHub refused (`issueNumber: null`, `error` set), which is the reason the list exists (§11.7)                         |

Non-admins get `404` on `/api/admin/*` (not `403`), so the surface is invisible.
Anonymous callers get `401`, like every other private route.

**`stats.dayRowsWritten`** is the sum of `job_runs.stats.rowsWritten` over the
last **rolling 24 hours**, across every job — the number to check against D1's
hard-enforced 100,000-rows-per-day cap (§8.6), where past the cap D1 ERRORS and
blocks bet placement and settlement, not just the board. It rides INSIDE `stats`
rather than beside it because `api-types.ts` is frozen after M2d and
`JobRunView.stats` is already `Record<string, unknown>`; the admin page reads it
off any run. Rolling rather than a UTC day, because the operator's question is
"are we running hot right now" and a UTC-day total is misleading at 00:05. Failed
runs are summed too (§9.2's `carriedStats`), so a bad day is not under-reported.
The query's `json_valid` guard is load-bearing: SQLite's `json_extract` RAISES on
malformed JSON rather than returning NULL (verified — `D1_ERROR: malformed
JSON`), so one corrupt `stats` blob would otherwise take down the whole admin
jobs page, which is the one place you look when something is already wrong.

**`POST /api/admin/users/:id/repair-balance` does NOT exist.** `ensureMainBalance`
is implemented and tested as a repair primitive (§4.4) but is deliberately not
routed; if that changes, it belongs in the table above.

`DELETE /api/admin/users/:id` is the ONE destructive admin route, and it is destructive
only to identity, never to money: the whole change is one `db.batch()` that disables,
stamps `deleted_at`, renames the username out of the way, blanks the display name and
drops the session rows. It writes no ledger row and no `balance_cents`, so
`POST /api/admin/reconcile` gives the same answer before and after. `ACCOUNT_HAS_PENDING_BETS`
is a NEW code in `src/shared/errors.ts` (409) rather than a reused one — `BET_NOT_PENDING`
is about one bet's status and says the opposite thing, and `VALIDATION` is a 400.

---

### 11.7 Bug reports

| Method | Path                      | Response                                                                                                                                                           |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/bugs`               | `{title, description, page?, diagnostics?}` → `201 {id, issueNumber, issueUrl}`; `400 VALIDATION`, `429 RATE_LIMITED`, `503 UPSTREAM_UNAVAILABLE`. Signed-in only. |
| POST   | `/api/bugs/client-errors` | `{diagnostics}` → `204`. The uncaught-error beacon: logged as one `[client-error]` line, never stored. Signed-in only; ≤ `CLIENT_ERROR_BEACON_MAX` (2,000) chars.  |

The in-app "Report a bug" form, reachable from the header button on EVERY
page; the open/close state lives in `AppShell` above the
router (`state/bug-report.tsx`). The person types a title and a description;
the client adds the SPA path they are on (`page`, path + query, never the
origin) and the **diagnostics log**: the browser's own record of the last 60
events — uncaught errors and unhandled rejections (name, message, first stack
frame), `console.error`/`console.warn` calls, every API call as
`METHOD path status [code] ms` (never a body or a query string), and route
changes — plus app version, viewport, language, online state and user agent.
`src/web/lib/diagnostics.ts` is the pure ring buffer and renderer (tested
without a DOM); `src/web/diagnostics.ts` installs the `window` listeners
before React mounts and patches `console.error`/`warn` and
`history.pushState`/`replaceState`; `api/client.ts` records each request. The
form shows the block under "What gets attached" before sending. It is bounded
to `BUG_REPORT_DIAGNOSTICS_MAX` (8,000) chars, cut from the OLD end so the
latest events survive, stored in `bug_reports.diagnostics` (migration 0006) and
filed as a second fenced block, so an issue can be diagnosed without asking
the reporter to open devtools. `page` is optional on the wire and derived rather than typed,
so if the validator refuses it (a 200+ char query string, say) the client files
the report WITHOUT it instead of disabling Send over something the person
cannot fix. The SERVER adds everything else — reporter username, app
version, request time, `User-Agent` — so a report can never claim to be from
someone else or from a version that was not running (rule 8, applied to
provenance instead of prices).

**The beacon.** An uncaught error or unhandled rejection also POSTs the
current diagnostics (≤ 2,000 chars) to `/api/bugs/client-errors`, at most once
per 30 s and only while a session is live, fire-and-forget. The Worker logs it
as one `[client-error] user=<name> …` line and stores nothing, so a browser
crash is visible in `wrangler tail` / Workers Logs even when nobody files a
report (docs/OPERATIONS.md "Logs"). There is no server-side rate limit: the
client throttle is bypassable with `curl`, and a signed-in account looping the
beacon spends Worker invocations against the free plan's daily budget exactly
as looping `GET /api/games` would — the same exposure every authenticated route
has, answered the same way (disable the account). API paths in the log have
uuids collapsed to `:id`; the log is cleared when the session ends, so a shared
browser cannot carry one person's activity into another's public issue.

**Row first, issue second.** `createBugReport` (`src/worker/bugs.ts`) INSERTs
into `bug_reports` and only then POSTs to GitHub's Issues API
(`GITHUB_API_BASE_URL/repos/GITHUB_REPO/issues`, bearer `GITHUB_TOKEN`, 8 s
timeout). If GitHub fails for any reason the row is kept with `error` set and the
caller gets `503 UPSTREAM_UNAVAILABLE` with `details.reportId`; the report is
then visible on `GET /api/admin/bugs` for an admin to file by hand. Nothing
retries automatically — the volume is a few reports a season and a retry loop
against a revoked token would only spend subrequests. (The flip side: if the
8 s timeout fires on a request GitHub actually completed, a client retry files
a duplicate and spends a second rate-limit slot. Accepted at this volume.)

**Rate limit: `BUG_REPORTS_PER_WINDOW` (5) per `BUG_REPORT_WINDOW_MS` (1 h) per
user**, enforced INSIDE the INSERT
(`WHERE (SELECT COUNT(*) FROM bug_reports WHERE user_id = ? AND created_at > ? - window) < 5`),
so there is no read-then-write and two concurrent requests cannot both slip
under the bar (rule 5). `meta.changes === 0` is the `429`. Failed filings count
too — they are rows — which is deliberate: a broken token should not turn into an
unbounded write stream.

**What GitHub sees** is built by the pure `formatBugIssue` in
`src/shared/bugs.ts` (unit-tested): title `[user report] <title>`, labels
`bug` + `user-report`, and a body with the description in a fenced `text` block
and a context table (reporter, page, version, time as ISO-8601 UTC, user agent).
Every request-supplied string in the BODY — description, page, and the
`User-Agent` header, which is attacker-controlled — lands inside the fence or
inside an inline-code table cell, so a `#123` or an `@mention` is rendered as
text, not as GitHub markup. The fence is neutralised (` ``` ` → `` ` ` ` ``) so
a description cannot close it. Cells are made escape-FREE rather than escaped:
backtick → `'`, backslash → `∖` (U+2216), pipe → `¦` (U+00A6), newline → space,
so a cell holds nothing any table or code-span parser treats as syntax and there
is no renderer variant to reason about — a lossy but visible transform, in the
issue body only (the `bug_reports` row keeps the raw value).
`validateBugReport` also refuses backticks in `page`. The TITLE is the one
string filed raw: GitHub renders issue titles as plain text everywhere, so it
needs no escaping. `User-Agent` is trimmed, NULL when blank, and cut at
`BUG_REPORT_USER_AGENT_MAX` (300) code points before it is stored or filed.

**Configuration** (`src/worker/env.ts`): vars `GITHUB_REPO` (`owner/name`,
validated as two GitHub-legal slugs so it can be interpolated into a URL path)
and `GITHUB_API_BASE_URL` (`https://api.github.com`; a stub host in tests), and
the secret `GITHUB_TOKEN` — a fine-grained PAT with **Issues: read and write on
that one repository and nothing else**. With the token unset the feature is OFF:
`/api/health` reports `bugReportsEnabled: false`, the account page hides the
button, and `POST /api/bugs` is `503`. The same OFF state applies when the token
IS set but either var is missing or malformed — `readConfig` runs on every
request, so that case logs and degrades rather than 500ing the whole app (which
is what would otherwise happen if the secret were put before the deploy that
ships the vars). No new error code: the four outcomes map onto codes that
already mean exactly those things.

Limits are in `constants.ts`: title 3–120 chars, description 10–4,000, page ≤
200 and path-shaped (must start with a single `/`, no whitespace).
`validateBugReport` runs in both the browser (to enable the Send button) and the
Worker (as the gate).

### 11.8 Players — another user's bets

| Method | Path                  | Response                                                                                                                                                      |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/users/:id/bets` | `200 {player: PlayerView, bets: BetView[], nextCursor}`. `?status=open\|settled\|all&league=&limit=&cursor=` — **`GET /api/bets`'s query string, unchanged.** |

The product is a few friends finding out who knows football, and "what did
Tyler take this week, and how did it go" is half of that conversation (added
2026-09-21, M10). Any signed-in user may read any PLAYING account's bets — open
ones with their live per-leg `projected` grade, settled ones with the
`payoutCents` settlement actually paid — through the SAME query that feeds
My Bets (`listBets`), over a different owner. The route lives in
`src/worker/routes/users.ts`; the owner check and the read-only mapping in
`src/worker/players.ts`.

`PlayerView = { id, username, displayName }` — deliberately NOT `UserSummary`:
another player's admin flag and signup date are nobody's business on a bets
page. The stats (rank, equity, balance, exposure, record, ROI) are NOT repeated
here; the page reads them from the leaderboard's `all` row (§11.5), so there is
one source for every number and it is the one the board ranks on.

**WHO IS VISIBLE is the leaderboard's predicate**, `users.is_disabled = 0 AND
users.deleted_at IS NULL`. An account off the board is `404 NOT_FOUND`,
indistinguishable from an id that never existed — the same answer the admin
routes give a soft-deleted account, and for the same reason: a disabled account
is not playing and cannot answer for its bets. Nothing is deleted; re-enabling
puts the history straight back.

**EVERY `BetView` in the response is `cancellable: false`, whoever asks —
including when you look at yourself.** The page is read-only by contract. The
viewer could not act on the bet anyway (`DELETE`/`PUT /api/bets/:id` are scoped
to the owner and answer `404 BET_NOT_FOUND` to anybody else), but a `true` would
tell the client to draw Edit and Cancel buttons it cannot honour, and one flag
whose meaning depends on who is asking is exactly the kind of thing that gets
misread. My Bets is where you act on your own bets.

The query string is read by ONE function, `readBetListFilter` in
`routes/bets.ts`, shared with `GET /api/bets`, so the two lists can never
disagree about what `status=settled` (the complement of `open`, cancelled
included — §11.4) or `league=mixed` means. `BetView.bankrollId` is on the wire
unchanged: it names the owner's balance, and every endpoint that accepts a
`bankrollId` resolves it against the CALLER (`resolveBankrollId`, and the
`EXISTS` inside placement's INSERT), so knowing somebody else's id buys nothing.
No `?season=`, as everywhere (§19 Q5). No new error code: `NOT_FOUND`,
`VALIDATION` and `UNAUTHENTICATED` already mean exactly the three failures.

`tests/worker/players.spec.ts` pins all of it: the read-only flag against the
owner's own `true`, the open/settled partition, the exact-league match, the
cursor, the 404 for disabled / deleted / unknown alike, and the 400s.

## 12. Frontend design

React 19 + TypeScript + Vite, `react-router-dom` for routing, **no UI framework** —
one `styles.css` with CSS custom properties plus a handful of co-located
`*.module.css` files. Mobile-first: single column, 44px minimum tap targets, sticky
bet slip bar at the bottom on small screens.

### 12.1 Component tree

This is the tree as SHIPPED. A few named boxes in the original sketch turned out
not to want their own file — `<DayGroup>`, `<WeekendGroup>`, `<BankrollSummary>`
are a `map` over a pure grouping helper in `lib/grouping.ts`, and the three
tab strips (`<BetFilterTabs>`, `<ScopeTabs>`, `<SlipModeToggle>`) collapsed into
ONE generic `<Segmented<T>>`. The slip's teaser tier picker is the one exception:
a native `<select>`, because thirteen tiers do not fit a segmented row, with
each option showing the card price for the slip's current leg count.

```
main.tsx
└── <App>                                   BrowserRouter + providers
    ├── <SessionProvider>                   { user, status, login, signup, logout }
    │   └── <ConfigProvider>                /api/config, cached for the session
    │       └── <BetSlipProvider>           ONE cross-league slip, localStorage `sbs.slip.v3`
    │           ├── <AppShell>              header + <BankrollBadge> + <NavTabs> + <Outlet>
    │           │   │                       + <BetSlipBar> + <BetSlip>; redirects anon to /login
    │           │   ├── route "/"           <GamesPage>
    │           │   │   ├── <LeagueTabs>    moves the BOARD only — never the slip
    │           │   │   ├── <WeekPicker>
    │           │   │   ├── <BoardFilterSelect>   CFB only: All / Top 25 / conference / Other
    │           │   │   │                          → filterGames() in lib/board-filter.ts, client-side;
    │           │   │   │                            a game matches when EITHER team does; reset on league change
    │           │   │   └── groupGamesByLocalDate()   (viewer's LOCAL tz)
    │           │   │       └── <GameCard game now>
    │           │   │           ├── <TeamRow team score rank>
    │           │   │           └── <MarketButton market side line price selected>   ×6
    │           │   ├── route "/bets"       <MyBetsPage>
    │           │   │   ├── <Segmented<Filter> open|settled>
    │           │   │   ├── groupBetsByWeek()
    │           │   │   │   └── <BetCard bet>         cancel + edit live here
    │           │   │   │       └── <BetLegRow leg projected>
    │           │   │   └── <LoadMore paged>          usePages() cursor paging
    │           │   ├── route "/leaderboard" <LeaderboardPage>
    │           │   │   ├── <Segmented<Scope> all|nfl|ncaaf>
    │           │   │   └── <LeaderboardTable rows meUserId>   each name links to /players/:userId
    │           │   ├── route "/players/:userId" <PlayerBetsPage>   another player's bets, read-only (§11.8)
    │           │   │   ├── (stats header, inline)   from the leaderboard's `all` row: rank, equity, balance, exposure, W-L-P, ROI
    │           │   │   ├── <Segmented<Filter> open|settled>
    │           │   │   ├── groupBetsByWeek()
    │           │   │   │   └── <BetCard bet readOnly>    never Edit/Cancel; the server says cancellable:false too
    │           │   │   └── <LoadMore paged>
    │           │   ├── route "/account"    <AccountPage>
    │           │   │   ├── <DisplayNameForm>      POST /api/auth/display-name, session.setDisplayName()
    │           │   │   ├── (balances, inline)
    │           │   │   ├── <LedgerList entries>
    │           │   │   └── <LoadMore paged>
    │           │   ├── route "/admin"      <AdminPage>      (admin only)
    │           │   │   ├── <Tabs> jobs|reconcile|users|bugs   role="tablist"; active tab in ?tab=
    │           │   │   └── <TabPanel> ×4         all mounted, inactive ones `hidden`; each owns its data hook
    │           │   └── route "*"           <NotFoundPage>
    │           └── <BetSlip>               role="dialog" sheet, useFocusTrap()
    │               ├── <Segmented straight|parlay|teaser>
    │               ├── <select> 3 … 14 pt (teaser mode only): each option "6-pt · -120" from config.teaserPayouts for the slip's leg count
    │               ├── leg rows w/ NFL·CFB badge and "-7.5 → -1.5" tease preview
    │               ├── <StakeInput cents quickChips>
    │               └── <SlipSummary preview stakeCents>
    └── route "/login"                      <AuthPage>  (login + signup tabs)
```

`<ErrorBanner>` / `<EmptyState>` and `<Spinner>` are shared by every page.
Pure, DOM-free helpers live in `src/web/lib/` (`grouping`, `datetime`, `labels`,
`lines`, `paging`, `stake-text`, `tabs`, `admin-tabs`) and in `src/web/state/` (`slip-reducer`,
`slip-preview`, `edit-bet`) precisely so the `web` test project can exercise them
in a node environment — see §13.

### 12.2 State

Three contexts, each a `useReducer`; no Redux, no react-query.

- **SessionContext** — `{ status: 'loading'|'anon'|'authed', user }`. Bootstraps from
  `GET /api/auth/me`. A global `fetch` wrapper (`src/web/api/client.ts`) attaches
  `X-SBS-Client: 1`, `credentials: 'same-origin'`, parses the error envelope into a
  typed `ApiError`, and on `401` dispatches `SESSION_EXPIRED`, which bounces to
  `/login`.
- **BetSlipContext** — `{ mode, legs: SlipLeg[], stakeCents, teaserPointsTenths }`,
  plus `boardLeague`. **ONE CROSS-LEAGUE SLIP (M5b).** It used to be a
  `Record<League, Slip>` with the league tab selecting which draft you were
  looking at, because a bet belonged to exactly one `(league, season)` bankroll
  and a cross-league parlay was a 409. Neither is true now, and the product owner
  asked for the flow directly: "tease Michigan and the Steelers together". So:

  - there is ONE draft, and a leg carries its own `league`;
  - **the league tabs move the BOARD only** (`SET_BOARD`) — switching tabs to go
    find a college game must never add, remove, hide or reorder a leg, which the
    reducer spec pins by IDENTITY (`moved.slip` is the same object);
  - every existing slip rule is unchanged: no two legs from one game, 2+ legs is
    a multi (parlay unless the user picked teaser), teaser mode refuses
    moneylines, the MAX chip is the whole balance, the payout cap is pre-flighted;
  - each leg shows an NFL / CFB badge, and the collapsed bar shows `NFL + CFB`,
    because the tab you are on no longer tells you where a pick came from;
  - `buildPlaceBetRequest` derives the advisory `league` from the legs
    (`'mixed'` when they span both), which is the same value the server derives
    and stores.

  Persisted to `localStorage` under ONE key, `sbs.slip.v3`. There is no honest
  migration from v2 — there were two drafts and they can disagree about mode,
  stake and even hold the same game twice — so the provider deletes the old
  per-league keys on first hydrate instead of leaving dead JSON behind forever.
  Validation mirrors `src/shared/validate.ts` (the _same_ pure functions the
  Worker uses) so the UI can grey out an invalid slip before submitting — the
  server still re-validates, the client copy is purely for UX.

- **Data fetching** — `useResource<T>(key, fetcher)` in `src/web/hooks/useResource.ts`,
  over a plain module-level `resource-store.ts`: in-memory cache, `refetch()`,
  stale-while-revalidate and an `invalidate(keyPrefix)` used after a successful
  bet mutation. `hooks/useApi.ts` wraps it into the named calls
  (`useGames`, `useBets`, `usePlayerBets`, `useBalances`, `useLedger`,
  `useLeaderboard`), and `hooks/useNow.ts` supplies the ticking clock and the
  poll interval. `usePlayerBets` keys under the `bets:` prefix on purpose, so
  placing or cancelling your own bet invalidates your own player page too.
  Deliberately not a dependency.

- **Cursor paging** — `hooks/usePages.ts` over `lib/paging.ts`, for the two
  endpoints that return a `nextCursor` (`/api/bets`, `/api/users/:id/bets`,
  `/api/ledger`). Page 1 lives
  in the `useResource` cache and is re-read by polling and by `invalidate()`;
  pages 2..n sit next to it. A poll can therefore hand back a page 1 that
  OVERLAPS what is already loaded — placing a bet shifts every row down by one —
  so pages are **merged by id, first occurrence winning** (the freshest copy)
  rather than concatenated, which would emit duplicate React keys.

- **Editing a bet** re-prices against CURRENT lines, never the old snapshot
  (§11.4). `state/edit-bet.ts` names the games to re-fetch and rebuilds the slip
  legs from the fresh `GameCard`s, and `<BetCard>` does that before opening the
  slip. Seeding from the snapshot instead meant the sheet quoted hours-old odds
  AND resubmitted them as `expected`, so a stake-only edit drew a
  `409 LINE_CHANGED` on a screen still showing the old number. A leg whose market
  is no longer posted keeps its snapshot and is reported in `unrefreshed[]`, for
  the server to refuse on its own terms (`409 MARKET_UNAVAILABLE`). The BALANCE
  is fixed either way: `PUT` may not move a bet between balances.

- **The slip sheet traps focus** (`hooks/useFocusTrap.ts`, §12.4): on open it
  remembers what had focus and moves into the dialog, Tab/Shift+Tab cycle within
  it, Escape closes, and on close focus returns to the element that opened it.
  `onClose` is read through a ref so it is NOT an effect dependency — otherwise a
  new callback identity on every render would re-arm the trap and yank focus back
  to the first control mid-typing. `tests/web/focus-trap-deps.spec.ts` pins that.

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

**THREE vitest projects** (`vitest.config.ts` → `unit`, `worker`, `web`), and
`npm test` runs all three. The `web` project was not in the original plan: it
exists because the SPA's real logic — the slip reducer, the payout preview, the
grouping and paging helpers, the edit re-pricer — is deliberately DOM-free, and
`environment: 'node'` tests it without adding jsdom as a dependency.

**Project 1 — `unit` (node env, `tests/unit/`)**: everything in `src/shared/`,
plus the docs-drift guard. No Workers runtime, instant feedback.

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
- `errors.spec.ts` — every `ErrorCode` has a canonical status; the wire envelope
  omits `details` when absent; `fromThrown` maps the trigger messages.
- `docs.spec.ts` — **the docs-drift guard**. Reads `PLAN.md`, `CLAUDE.md`,
  `README.md`, `wrangler.jsonc`, `package.json` and `migrations/0001_init.sql`
  with `node:fs` and fails when the prose and the code disagree on a mechanical
  fact: an `ERROR_CODES` entry missing from §11 (or a §11 code absent from the
  enum), a constant quoted at a value `constants.ts` does not hold, a
  `TEASER_PAYOUTS` cell §5.8's card renders differently, a cron expression in
  `wrangler.jsonc` that §9.1 does not list, a route literal in
  `src/worker/routes/*.ts` that §11 never mentions, a table in `0001_init.sql`
  that §3 never names, a pre-PR gate in `CLAUDE.md` that is not what
  `package.json` actually runs, or a banned stale phrase outside a history note.
  See CLAUDE.md rule 11.

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
  a parlay rejected by the DB; a January bowl is labelled season 2026 even after
  2027 games exist; `PAYOUT_LIMIT_EXCEEDED`; cancel refunds exactly once;
  **double-cancel returns 409, never a 500, and writes no second refund**; the
  three `INSERT OR IGNORE` ledger behaviours from §4.2; edit is atomic (force a
  failure in the place half and assert the old bet is still pending). **M5b adds**:
  a cross-league parlay lands as `league='mixed'`; `bankrollId` defaults to main,
  and someone else's is a 404 that writes nothing; the in-batch ownership guard
  holds when the pre-flight read is bypassed; a teaser stores the teased line, the
  book line and the card price; `expected` on a teaser is still the BOOK line.
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
  non-admins; unknown `/api/*` returns the JSON 404 envelope; the seven canonical
  leaderboard semantics of §11.5.
- `leaderboard.spec.ts` — `GET /api/bankroll` creates NOTHING and returns the one
  balance signup opened; ledger paging; `?league=` narrows record/ROI and never
  the money; `/all-time` is byte-identical to the unfiltered board; **a
  `kind='custom'` side pot is invisible to the ranking — equity is the MAIN
  balance plus MAIN pending only**; `POST /api/admin/users/:id/adjust` both signs,
  with the overdraft coming from the trigger.
- `maintenance.spec.ts` — the §7.5 sweeps: postponed → auto-void past
  `VOID_AFTER_MS`, a game stuck `in_progress` is reported and NOT voided, expired
  sessions and old throttle rows pruned, `job_runs` trimmed per job.
- `schema.spec.ts` — the §4.2 money invariants against a REAL D1: both
  `ledger_bi_*` triggers and their distinct messages, `OR IGNORE` not suppressing
  `RAISE(ABORT)`, the append-only blocks, the `balance_cents` write guards, the
  partial `idx_bankrolls_main`, and `ensureMainBalance` as a complete no-op
  against an already-funded row.

**Project 3 — `web` (node env, `tests/web/`)**: the SPA's pure logic. No jsdom,
no rendering — every module under test is deliberately DOM-free and React-free,
which is what makes this project possible at all.

- `slip-reducer.spec.ts` — ONE cross-league draft; switching the league tab moves
  the BOARD and leaves the slip identical **by object identity**; storage key
  `sbs.slip.v3` and the abandoned per-league v1/v2 keys named for cleanup; mode
  follows the leg count and a teaser stays a teaser as legs are added.
- `slip-preview.spec.ts` — parlay vs teaser pricing off the server's card, the
  payout-cap pre-flight, the MAX chip.
- `slip-edit-flow.spec.ts`, `edit-bet.spec.ts` — rebuilding a bet's legs from
  CURRENT quotes, and `unrefreshed[]` when a market is gone.
- `paging.spec.ts` — overlapping pages merge by id, first occurrence winning.
- `focus-trap-deps.spec.ts` — `onClose` is not an effect dependency.
- `grouping.spec.ts`, `datetime.spec.ts`, `lines.spec.ts`, `stake-text.spec.ts`,
  `resource-store.spec.ts` — the remaining helpers.

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

**Coverage gate**: `src/shared/**` must be ≥ 90% lines / 90% functions / 90%
statements / 85% branches (`vitest.config.ts`). No gate on `src/web/**` or
`src/worker/**` in v1.

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

**Placement**, one `batch()` (`n` = leg count). **THERE IS NO BANKROLL PRELUDE
(M5b)** — statements 0a/0b are gone from both halves, because the balance is
opened in the signup batch (§4.4) and named on the request:

```sql
-- 1. the bet, guarded on ALL legs being bettable AND on the balance being the
--    caller's own.
INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type,
                  teaser_points_tenths, ..., earliest_kickoff_at, status, ...)
SELECT :betId, :userId, :bankrollId, :league, :season, :betType,
       :teaserPointsTenths, ..., :earliestKickoff, 'pending', ...
 WHERE (SELECT COUNT(*) FROM games
         WHERE id IN (:g1,…,:gn)
           AND status = 'scheduled'
           AND kickoff_at > :nowPlusBuffer) = :n
   AND EXISTS (SELECT 1 FROM bankrolls
                WHERE id = :bankrollId AND user_id = :userId)
   AND EXISTS (SELECT 1 FROM users
                WHERE id = :userId AND is_disabled = 0 AND deleted_at IS NULL);

-- 2..n+1. legs, each guarded on the bet existing. For a teaser, `line_tenths`
--         is the TEASED line and `original_line_tenths` the book's (§5.8).
INSERT INTO bet_legs (...) SELECT ... WHERE EXISTS (SELECT 1 FROM bets WHERE id = :betId);

-- n+2. stake
INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
SELECT :ledgerId, b.bankroll_id, 'bet_stake', b.id, b.id, -:stake, :now, :memo
  FROM bets b WHERE b.id = :betId;
```

**The ownership `EXISTS` REPLACES the `AND league = :league AND season = :season`
conjuncts the COUNT subquery used to carry.** Those pinned a bet to the one
bankroll its legs implied; legs imply no bankroll now, so the thing that must be
re-checked inside the batch is that the named balance belongs to the caller.
`resolveBankrollId()` reads it beforehand ONLY to produce a specific
`404 BANKROLL_NOT_FOUND` — a read followed by an unguarded write is exactly the
read-then-write the house rules forbid, so the guard lives in the `WHERE` too.

**THE ACCOUNT-STATE `EXISTS` is the third guard, and it is about the window rather
than the market.** `requireAuth` resolved the session at the top of the request;
by the time the batch runs, several D1 reads have gone by, and
`POST /api/admin/users/:id/disabled` and `DELETE /api/admin/users/:id` both fit in
that gap — both of them things an admin does precisely BECAUSE they want the
account to stop betting. Without the conjunct the bet commits anyway and the stake
lands in a balance nobody can reach again; worse, since a soft delete is refused
while a pending bet exists (§10.5), the bet the delete was racing makes the account
undeletable. It is on the EDIT's cancel half too — see the edit batch below — so a
cancel + refund cannot land alone for an account whose replacement INSERT is
refused.

`:league` and `:season` are computed from the resolved legs in process
(`betLeagueOf` / `betSeasonOf`) and are informational labels, not guards.

Then `results[0].meta.changes === 1`? → `201`. If `0`, nothing else in the batch
matched either (every subsequent statement is guarded on the bet row existing), so
the batch is a clean no-op; we re-query the games to produce a _specific_ error
(`BETTING_CLOSED` vs `GAME_NOT_BETTABLE` vs `GAME_NOT_FOUND`) — **checking the
account first**, because no amount of staring at the games would explain a refusal
that came from the account-state conjunct, and "betting closed" about a wide-open
game is a lie. That read happens AFTER a batch which has already declined to write
anything, so it diagnoses a completed write rather than gating one; the guard
itself never leaves the `WHERE`. A disabled or deleted account gets
`403 ACCOUNT_DISABLED` (deleted reports as disabled: it IS disabled, and the
alternative tells a caller holding a stale cookie more than it should). Insufficient funds
surfaces as the `ledger_bi_sufficient_funds` `RAISE(ABORT)` (§4.2), which throws
and rolls the batch back → `409 INSUFFICIENT_FUNDS`. `PAYOUT_LIMIT_EXCEEDED` is
checked in-process before the batch is built, and again by the `CHECK` on
`potential_payout_cents`.

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

Before anything is built, the handler loads the target bet's `bankroll_id` by
`(id, user_id)`. Not yours or not there → `404 BET_NOT_FOUND`, having written
nothing. That read is also what pins the edit's scope: **an edit must keep the
bet's BALANCE** (see §11.4), so `bankroll_id` is identical on both halves and the
refund and the new stake can never straddle two balances. The replacement's
league and season may differ freely — they no longer select anything.

(Historically this section also warned that the edit batch must carry no bankroll
prelude, because the prelude was unguarded and a 404 `PUT` on somebody else's bet
still committed the CALLER's bankroll rows. There is no prelude in either half
any more, so the hazard is gone rather than avoided.)

```sql
-- 1. cancel half. TWO guards, and the second is NOT optional:
--      (a) the SAME leg->game lock guard as the plain cancel above, over the
--          OLD bet's legs' CURRENT game rows, and
--      (b) the PLACEMENT guard — the identical `COUNT(*) … = :n` that statement
--          3's INSERT carries, over the NEW legs' games, and
--      (c) the ACCOUNT-STATE guard, for the same symmetry reason.
UPDATE bets
   SET status = 'cancelled', cancelled_at = :now,
       replaced_by_bet_id = :newBetId, updated_at = :now
 WHERE id = :oldId AND user_id = :userId AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM bet_legs l JOIN games g ON g.id = l.game_id
      WHERE l.bet_id = :oldId
        AND (g.status <> 'scheduled' OR g.kickoff_at <= :nowPlusBuffer))
   AND (SELECT COUNT(*) FROM games
         WHERE id IN (:g1,…,:gn)
           AND status = 'scheduled'
           AND kickoff_at > :nowPlusBuffer) = :n
   AND EXISTS (SELECT 1 FROM users
                WHERE id = :userId AND is_disabled = 0 AND deleted_at IS NULL);

-- 2. refund, guarded on this call having won it
INSERT INTO ledger (...)
SELECT :refundId, b.bankroll_id, 'bet_refund', b.id, b.id, b.stake_cents, :now, 'replaced by edit'
  FROM bets b
 WHERE b.id = :oldId AND b.status = 'cancelled' AND b.replaced_by_bet_id = :newBetId
   AND NOT EXISTS (SELECT 1 FROM ledger
                    WHERE bankroll_id = b.bankroll_id AND kind = 'bet_refund' AND ref_id = b.id);

-- 3..  the placement sequence above, with replaces_bet_id = :oldId and
--      bankroll_id = the OLD bet's, and its statement 1 ADDITIONALLY guarded on
--      the cancel having applied:
--        AND EXISTS (SELECT 1 FROM bets
--                     WHERE id = :oldId AND status = 'cancelled'
--                       AND replaced_by_bet_id = :newBetId)
```

**Why the guard is symmetric, and why "neither half can land alone" is otherwise
false.** There are two kinds of failure inside a `batch()` and they behave
completely differently:

- A statement that **throws** — a `CHECK`, a `UNIQUE`, or a trigger's
  `RAISE(ABORT)` such as `ledger_bi_sufficient_funds` — rolls the entire batch
  back. Nothing lands. Validation and insufficient funds are this kind.
- A guarded `INSERT … SELECT … WHERE` whose guard **matches zero rows** throws
  nothing at all. It is a successful statement that wrote 0 rows, and every
  statement around it still commits.

Guarding the place half on the cancel (statement 3's `EXISTS`) therefore only
covers the first direction, and only for throwing failures. Take the second
direction: the user's replacement leg is rescheduled, or flips to `in_progress`,
in the window between the handler's pre-flight read and the batch. Statement 1's
lock guard is about the OLD bet's games and still passes, so the cancel applies
and statement 2 refunds — then statement 3's own `COUNT(*) = :n` matches nothing,
so the new bet is never inserted, its legs and stake are guarded off it, and the
batch **commits**. The user's position has silently disappeared and the response
is a 409 that claims nothing happened. That is the single worst outcome this
milestone can produce, and no throwing failure is involved anywhere.

Repeating the placement guard on the cancel closes it: each half is now
conditioned on the other, so the batch is either a complete swap or a clean
no-op, whichever way the world moves. **With the symmetric guard — and only with
it — neither half can land alone.**

Failure verdicts: cancel guard fails → nothing applied → `409 BET_LOCKED`.
Placement guard fails → nothing applied → the specific `BETTING_CLOSED` /
`GAME_NOT_BETTABLE` / `GAME_NOT_FOUND` from a re-query. Throwing failure →
rollback, old bet untouched and still `pending` → e.g. `409 INSUFFICIENT_FUNDS`.
The new bet is priced from **current** `game_lines`, never from the old snapshot.

**These in-batch guards are invisible to an ordinary test.** The handler's
pre-flight read rejects every input the guard would catch, so with the world held
still, deleting `AND status = 'scheduled' AND kickoff_at > :nowPlusBuffer`, or
making either `COUNT(*) = :n` vacuous, changes nothing observable —
three such mutations once survived the whole suite. `tests/worker/bets.spec.ts`
therefore (i) asserts the generated SQL literally contains each conjunct and
(ii) uses `BetHooks.beforeBatch`, a test-only seam that is `undefined` on every
production call site, to mutate the game row in exactly the window a concurrent
ingestion write occupies. `kickoff_at > :nowPlusBuffer` is **strictly** greater —
a kickoff exactly at `lockAt` is closed — and that boundary is pinned by a test
on both sides.

### 14.3 Line snapshot immutability and provenance

`bet_legs` stores `provider`, `market`, `side`, `line_tenths`, `american_price`,
`line_captured_at` (when the book's price last _changed_) and `snapshot_at` (when
the user locked it). Grading reads only these; the exact price is recomputed from
`american_price` (§5.2). `settle.ts` does not import the `game_lines` accessor,
and `tests/worker/settle.spec.ts` proves the payout is unaffected by mutating —
or deleting — the `game_lines` row after placement.

**THE TRIO IS PER MARKET, NOT PER ROW (M9b).** With a second provider a game can
have two `game_lines` rows and the effective line is merged per market (§21.4):
the spread may be DraftKings' and the total FanDuel's, captured at different
instants. So `provider`, `line_captured_at` **and the staleness decision that let
the leg be placed at all** must every one of them come from
`EffectiveLine.<market>` — `MarketSource` carries `provider`, `capturedAt` and
`seenAt` precisely so they travel together. Taking `provider` from the market and
`line_captured_at` from "the line" (as `resolveLegSnapshots` does today, reading
`line.captured_at`) would write an audit record of a quote that never existed:
FanDuel's price stamped with DraftKings' capture time. `MARKET_UNAVAILABLE` is
likewise decided per market — a game whose spread is fresh and whose total's only
row is stale accepts a spread leg and refuses a total leg, and the board shows
exactly that.

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

**STATUS — v1 is feature-complete on `main` AND DEPLOYED.**
Live at https://spicybetting.wardcrazy01894.workers.dev, first deployed
2026-09-14, permanently. Runbook: `docs/OPERATIONS.md`.

| Milestone                                     | Status                                                              |
| --------------------------------------------- | ------------------------------------------------------------------- |
| M0 toolchain                                  | **DONE**                                                            |
| M1 local dev loop                             | **DONE**                                                            |
| M2a/b/c/d pure domain                         | **DONE**                                                            |
| M3 auth                                       | **DONE**                                                            |
| M4 ingestion                                  | **DONE**                                                            |
| M5 betting                                    | **DONE**                                                            |
| M5b account balances / cross-league / teasers | **DONE** — the one sanctioned contract change (§16.1)               |
| M6 settlement                                 | **DONE**                                                            |
| M7a–e frontend                                | **DONE**                                                            |
| M8 deploy + operate                           | **DONE** — deployed 2026-09-14; see the two open measurements below |
| M9-0 / M9a–c board window, secondary odds     | **DONE** — 2026-09-16 / 2026-09-17 (§21, §22)                       |
| M10 player bet history                        | **DONE** — 2026-09-21 (§11.8)                                       |

Two things follow from the deploy having happened:

- **`migrations/0001_init.sql` is FROZEN.** It was applied to the remote D1 on
  2026-09-14 and D1 recorded it in `d1_migrations`, so it will never be replayed
  and an edit to it can never reach production. Every schema change is a new
  numbered `000N_*.sql`. §16.1 and the file's own header say the same thing; all
  three must move together.
- **Spikes S1 and S2 are UNMEASURED, not blocked** (§18). Both were waiting for
  a deployed Worker and now have one; they are two `wrangler tail` runs away
  from an answer, and until somebody does them `REFRESH_TARGETS_PER_RUN` stays
  at 2 and `SETTLE_CHUNK` at 20. S3 and S4(a)/(b) are resolved. The one item
  still genuinely blocked on the calendar is **S4(c)**, the January postseason
  reachability check, which is also a `docs/OPERATIONS.md` runbook item.

### M0 — Repo skeleton and toolchain — **DONE** _(no parallelism; everything depends on it)_

**Files**: `package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest*.config.ts`,
`eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `wrangler.jsonc`,
`index.html`, `.github/workflows/ci.yml`, `.dev.vars.example`, `README.md`,
`CLAUDE.md`.
**Tasks**: `npm install`; `wrangler d1 create spicybetting` and paste the id into
`wrangler.jsonc`; confirm the five gate commands run (tests may be `it.todo`).
**DoD**: fresh clone → `npm ci && npm run typecheck && npm run lint && npm test`
passes; CI green on a throwaway PR.

**Toolchain pinning — read before "upgrading" anything.** The versions in
`package.json` are not "whatever was newest on npm today"; four of them are
constrained:

| Package                | Pinned    | Why not latest                                                                                                                                                                                                                |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`               | `^4.1.11` | `@cloudflare/vitest-pool-workers@0.22.0` declares `peerDependencies: { vitest: "^4.1.0" }`. Vitest **5.0.0** exists but is not supported by the pool. Bumping vitest without the pool breaks the whole `worker` test project. |
| `@vitest/*`            | `^4.1.11` | `@vitest/coverage-v8` declares `peerDependencies: { vitest: "4.1.11" }` — an EXACT version — so it bumps in the same PR as `vitest` and never past it. Ignored alongside `vitest` for that reason.                            |
| `typescript`           | `~6.0.3`  | `typescript-eslint@8.70` declares `typescript: ">=4.8.4 <6.1.0"`. 6.0.x is inside that range; TypeScript **7.0.2** (the Go port) is not, so `npm run lint` would fail on it.                                                  |
| `@vitejs/plugin-react` | `^5.2.0`  | 5.2.0 is the first v5 that accepts `vite@^8`. v6 accepts vite 8 too but pulls in extra optional peers (`oxc-transform-react`, `@rolldown/plugin-babel`) we do not need.                                                       |

`vite@^8`, `react@19`, `eslint@10`, `wrangler@^4.131` are current and unconstrained.

**One `overrides` entry, scoped: `@cloudflare/vitest-pool-workers → miniflare
→ sharp: 0.35.4`** (package.json). `sharp` is not our dependency:
`@cloudflare/vitest-pool-workers@0.22.0` → `miniflare@5.20260815.0-alpha` pins
it EXACTLY at 0.35.2, which carries GHSA-rgj7-g3m4-5g8c (libheif, high;
dev-only here — miniflare uses sharp to emulate the Images binding, which this
project has no binding for). No pool release moves that pin yet, so the
scoped override forces that one copy to the patched version (wrangler's own
miniflare already wants 0.35.4, so both dedupe); `npm audit` is clean and the
worker pool runs unchanged. Drop the override once a pool bump carries a
miniflare with `sharp >= 0.35.4` — docs/OPERATIONS.md "Dependencies" has the
check. Scoped rather than global so it can never silently pin a future
`sharp` 0.36 requirement elsewhere.

If a dependency bump is proposed, check these four first — and note Alex's
standing rule that dependency-bump PRs also get an adversarial review.
`.github/dependabot.yml` proposes the bumps (weekly, Monday 06:00 ET): minor and
patch bumps arrive as ONE grouped PR, majors one PR each, GitHub Actions as one
PR, and `wrangler` + `@cloudflare/*` as one PR so the two toolchain constraints
are reviewed side by side: `compatibility_date` in `wrangler.jsonc` is pinned to
the newest date the workerd bundled with `@cloudflare/vitest-pool-workers`
supports (the pool ships its own nested wrangler, so the top-level `wrangler`'s
workerd is allowed to differ and does today), and the pool pins the `vitest`
major through its peerDependencies. The three ceilings above are `ignore`
entries there — `vitest` and `@vitest/*` (`@vitest/coverage-v8` peers on an
EXACT vitest version, so the two must bump together), `typescript` at
`>=6.1.0` (the real edge of typescript-eslint's range; 6.0.x is not ignored),
and `@vitejs/plugin-react` majors — and `tests/unit/docs.spec.ts` asserts that
this table and that file name the same packages, so lifting a ceiling means
editing both. Dependabot security updates are enabled on the repo as well; note
that `ignore` filters those too.

**`tsconfig` layout.** SEVEN projects wired as a `tsc -b` solution, not one
config: `shared` (lib ES2023, `types: []`), `worker` (Workers types), `web`
(DOM + JSX), `tests-unit`, `tests-worker`, `tests-web`, `node` (config files).
(`tests-web` arrived with the third vitest project — §13.) This is what keeps
`Request`/`Response` from meaning two different things in one program, and it is
why `src/shared` must stay platform-free (§2.2). Referenced projects are
`composite` + `emitDeclarationOnly` into `.tsbuild/`, which is gitignored — no
JavaScript is emitted by the typecheck.

### M1 — Runnable local dev loop with mocked ESPN — **DONE**

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

### M2 — Pure domain core — **DONE**

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

### M3 — Auth — **DONE** _(depends on M1; independent of M2 except constants)_

**Files**: `src/worker/crypto.ts`, `src/worker/session.ts`, `src/worker/auth.ts`,
`src/worker/middleware.ts`, `src/worker/routes/auth.ts`, `src/web/api/kdf.ts`,
`scripts/admin-hash.mjs`, `tests/worker/auth.spec.ts`, `tests/unit/kdf-parity.spec.ts`.
**DoD**: signup → cookie → `GET /api/auth/me` round-trips in the pool-workers test;
first user is admin; invite gate enforced; 10 bad logins → 429; CSRF header required;
`admin-hash.mjs` output actually logs in.

### M4 — Ingestion — **DONE** _(depends on M1 + M2c)_

**Files**: `src/worker/providers.ts`, `src/worker/espn.ts`, `src/worker/ingest.ts`,
`src/worker/jobs.ts`, `tests/worker/ingest.spec.ts`, `tests/worker/jobs.spec.ts`.
**DoD**: `POST /api/admin/jobs/refresh` against the fixture server populates
`games` and `game_lines`; **re-running an unchanged slate writes ZERO rows**
(`meta.changes === 0` — L1); a slate of started games writes zero `game_lines`
rows (L2); `last_seen_at`/`seen_at` only move past their touch intervals (L3); the
write-budget regression assertion in `ingest.spec.ts` passes; a final game is not
regressed; date targets reach a January postseason date; lease prevents overlap;
every §8.4 backoff branch tested. **Run Spike S1 at the end of this milestone.**

### M5 — Betting — **DONE** _(depends on M1 + M2a/b/d + M3)_

**Files**: `src/worker/bankroll.ts`, `src/worker/bets.ts`, `src/worker/routes/bets.ts`,
`src/worker/routes/games.ts`, `src/worker/routes/bankroll.ts`,
`tests/worker/bets.spec.ts`.
**DoD**: every error code in §11.4 has a test; the atomicity tests in §13 pass;
`SUM(ledger) === balance_cents` asserted after each scenario.

### M6 — Settlement — **DONE** _(depends on M4 + M5)_

**Files**: `src/worker/settle.ts`, `src/worker/maintenance.ts`,
`tests/worker/settle.spec.ts`.
**DoD**: the §13 settle scenarios pass, including double-run idempotency,
post-placement `game_lines` mutation/deletion, and the head-of-line-blocking test
(20 undecidable bets must not prevent a settleable bet behind them from settling
on the next run).

### M7 — Frontend — **DONE** _(M7a–M7e parallelizable once M1 + the relevant API exists)_

- **M7a** shell/routing/session: `App.tsx`, `AppShell.tsx`, `AuthPage.tsx`,
  `SessionContext.tsx`, `api/client.ts`, `hooks/useResource.ts` — needs M3.
- **M7b** games board + bet slip: `GamesPage.tsx`, `GameCard.tsx`, `MarketButton.tsx`,
  `BetSlip*.tsx`, `BetSlipContext.tsx` — needs M4 + M5.
- **M7c** my bets: `MyBetsPage.tsx`, `BetCard.tsx`, `BetActions.tsx` — needs M5.
- **M7d** leaderboard + account: `LeaderboardPage.tsx`, `AccountPage.tsx` — needs M5.
- **M7e** admin page: `AdminPage.tsx` — needs M4/M6.
  **DoD**: mobile viewport (390×844) walk-through of place → view → edit → cancel with
  no horizontal scroll; every API error code renders a human message.

### M8 — Deploy + operate — **DONE** _(deployed 2026-09-14)_

**Files**: `README.md` deploy section, `docs/OPERATIONS.md` (the runbook),
`scripts/reconcile.mjs`.
**Tasks** (all done): `wrangler d1 migrations apply --remote` — this is the
moment `0001_init.sql` froze; `wrangler secret put INVITE_CODE`;
`wrangler secret put IP_HASH_SALT`; `wrangler deploy`; `ESPN_BASE_URL` left at
the real host in `wrangler.jsonc` (only `.dev.vars` overrides it).
**DoD**: a real NFL week ingests, a real bet grades correctly, `reconcile` reports
zero drift, and the free-tier dashboard shows usage within budget — specifically,
check `job_runs.stats.rowsWritten` against the §8.6 model after the first full
Saturday, since the D1 write cap is hard-enforced.

**What M8 did NOT close**, stated plainly so it is not mistaken for done:

- Spikes **S1** (ingest CPU) and **S2** (D1 statement accounting) are
  **unmeasured**. They are no longer blocked — the Worker they needed exists —
  and §18 gives the exact commands.
- **S4(c)** (January postseason reachability) cannot be checked until January.
- A manual deploy job in `.github/workflows/ci.yml` was dropped: deploy stays a
  local `npm run deploy` (`docs/OPERATIONS.md`), because a deploy job would need
  a Cloudflare API token in repository secrets for a two-command manual step.

**Runbook items with a date attached** (do not let these be discovered by a
friend who cannot find a game to bet):

- **Before the first bowl / Wild Card weekend**: resolve Spike S4(c) — confirm a
  January date target actually returns postseason games. If not, add the
  `seasontype=3` companion target (§8.2).
- **After the first live Saturday**: compare measured rows-written to the §8.6
  model and, if it is running hot, drop `display_clock` from the compare tuple.
  `GET /api/admin/jobs` reports `stats.dayRowsWritten` (rolling 24 h) for exactly
  this check; §8.6 predicts ≈ 5,100/day.

### M9-plan — This chapter, the constants and the stubs — **DONE** _(2026-09-16, PR #37)_

One PR that adds NO behaviour and NO schema: PLAN §21 + §22, the CLAUDE.md
rules they change, the `src/shared/constants.ts` values, the type-only stubs
(`src/shared/{lines,odds-api}.ts`, `src/worker/{odds-api,secondary}.ts`,
`boardWindowEnd` in `src/shared/time.ts` — every body throws), the two captured
API samples, the `tests/unit/docs.spec.ts` entries that pin the new constants,
and TODO comments pointing at the milestone that fills each stub.
**It ships no migration.** `migrations/0007_secondary_odds.sql` is written by
**M9b**, from §21.3, which carries the file verbatim; a migration that lands
before the code that reads it is a schema change nobody can test and that the
Deploy workflow applies to production on merge.
**DoD**: the five gate commands green; every stub throws with a milestone
reference; `git status` shows no file under `migrations/`.

### M9-0 — The board window ends on Monday — **DONE** _(2026-09-16; shipped FIRST of the code changes)_

The product owner's rule, and the only milestone here that changes what a user
sees without adding a feature: the board and the ingest planner stop at the end
of the Monday that closes the football week instead of ten days out. **§22 is the
specification**; this entry is the shipping order.

**Files it changes** (the plan PR already landed §22 and the two rollover
constants, so M9-0 is the code):

| File                              | Change                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/shared/time.ts`              | implement `boardWindowEnd` (the stub throws today); import `WEEK_ROLLOVER_ET_HOUR`                    |
| `src/shared/constants.ts`         | none — the two ET-hour constants and `INGEST_WINDOW_MS`'s new comment are already in                  |
| `src/worker/ingest.ts`            | `planTargets` walks the days PER LEAGUE against the clamped window; `claimDueTargets`' budget comment |
| `src/worker/routes/games.ts`      | the default `to` becomes `boardWindowEnd(league, now)`; drop the `INGEST_WINDOW_MS` import            |
| `tests/unit/time.spec.ts`         | §22.5's pure cases, including both DST Sundays                                                        |
| `tests/worker/ingest.spec.ts`     | §22.5's planner cases (Tue 14 / Sun 9+2 / Mon 8 each) and the re-based slot soak                      |
| `tests/worker/routes.spec.ts`     | the board's default window, and the §22.5 rollover burst                                              |
| `CLAUDE.md`                       | rule 3 loses its "(planned — M9-0)" marker (done)                                                     |
| `docs/OPERATIONS.md`, `README.md` | §22.6's two operator effects and the rollover-burst answer                                            |

**Depends on**: the plan PR. **Blocks**: M9b (§21's candidate bound is this
window); M9a does not import it.
**DoD**: §22.2's table is a passing test; `npm run db:migrate:local` is untouched
(no schema change); §22.6's operator effects are in `docs/OPERATIONS.md` BEFORE
the deploy, not after.

Why it ships first and alone: it is a behaviour change to a live app with real
bettors, it touches two hot read paths, and it has nothing to do with a second
odds provider. Bundling it into M9a–c would mean a rollback of the provider work
also rolls back the owner's window, or vice versa.

### M9a / M9b / M9c — Secondary odds provider — **DONE** _(M9a, M9b 2026-09-16; M9c 2026-09-17)_

Three PRs, each independently mergeable and green on its own; the file lists,
the tests-first lists and the DoD for each are **§21.11**. In dependency order:

| PR      | What lands                                                                                                           | Depends on            |
| ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **M9a** | pure parse + match (`src/shared/odds-api.ts`), the merged ESPN captures                                              | M2d only              |
| **M9b** | **writes `migrations/0007_secondary_odds.sql`** from §21.3, the per-market merge, the board and placement read paths | M9a (types), **M9-0** |
| **M9c** | the sweep, the budget, the three refresh paths, the docs                                                             | M9a + M9b             |

**M9b is the schema PR.** It creates `0007` from §21.3 (which carries the file
verbatim), and `0007` is FROZEN from the moment M9b merges — the Deploy workflow
applies it to the live D1 on that merge, so every later change to those columns
is a new numbered `0008` (CLAUDE.md rule 9). Nothing before M9b puts a file under
`migrations/`.

M9b is also where behaviour could regress, and it does so in exactly ONE visible
way: **a STALE all-NULL primary row stops rendering the "Line is stale" banner
and renders "no line" instead.** ESPN writes such a row when DraftKings pulls
every market ("OFF"); today `toLinesView` computes `stale` from the row's
`seen_at` alone, and after M9b `stale` requires that some row offered a COMPLETE
market (§21.4). `bettable` is unaffected in both cases (no market → not
bettable), and the correction is the point: the banner means "ingestion has gone
quiet", and a game nobody has priced is not a broken ingest. Everything else must
be byte-identical while only primary rows exist, and
the parity test in `tests/worker/bets.spec.ts` (and the list/detail case in `tests/worker/routes.spec.ts`) is the proof. M9c is the only PR that spends
money (credits), and it is off entirely without `ODDS_API_KEY`.

### M10 — Player bet history — **DONE** _(2026-09-21)_

"I want to see which ones Tyler has placed that won and which have lost, and
for how much." One endpoint, one page, no schema change, no new error code.

**Files owned**: `src/worker/players.ts`, `src/worker/routes/users.ts` (one
`app.route('/api/users', …)` line in `index.ts`), `src/web/pages/PlayerBetsPage.tsx`,
the `readOnly` prop on `BetCard`, the name link in `LeaderboardTable`,
`getPlayerBets` / `usePlayerBets`. `api-types.ts` gains `PlayerView` and
`PlayerBetsResponse` (additive — §16.2). `routes/bets.ts` exports
`readBetListFilter` so both lists parse one query vocabulary.

**Tests first**: `tests/worker/players.spec.ts` — the read-only flag against the
owner's own `cancellable: true`, the open/settled partition with a cancelled
bet, the exact-league match with a `mixed` bet, the cursor, the 404 for a
disabled, soft-deleted and unknown id alike (and the 200 again after
re-enabling), the 400s. No new pure logic in `src/shared` or `src/web/lib`: the
page is a composition of `groupBetsByWeek`, `usePages` and `BetCard`, all of
which already have their own specs.

**DoD**: §11.8 is the contract; `docs.spec.ts` sees the new route in §11 and
the new file mounted in `index.ts`; the gate is green.

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

| File                                                               | Touched by                                                                                                                                                     | Protocol                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`, `api-types.ts`, `errors.ts`, `constants.ts` | everyone                                                                                                                                                       | **M2d writes them first and freezes at end of M2d.** Read-only thereafter; changes go through one PR that M2d's owner reviews. **M5b is that PR** — see below. |
| `src/worker/middleware.ts`                                         | **M1** (`contextMiddleware`, `errorHandler`) and **M3** (`sessionMiddleware`, `csrfMiddleware`, `requireAuth`, `requireAdmin`)                                 | M1 lands the file with all six exports stubbed; M3 fills only its four. Function-level ownership, no structural edits.                                         |
| `src/worker/db.ts`                                                 | **M1** (`runBatch`, `queryOne`, `queryAll`, `newId`, `nowMs`, `changesAt`), **M5** (`isOverdraftError`, `isUniqueViolation`), **M7/M8** (`reconcileBankrolls`) | Same rule: M1 lands every export stubbed; later milestones fill their own functions only.                                                                      |
| `src/worker/routes/admin.ts`                                       | **M4** (job triggers/history), **M3** (user admin, password reset), **M8** (reconcile)                                                                         | M4 lands the router skeleton with one commented placeholder per group; each milestone adds its own `app.get/post` block.                                       |
| `src/worker/index.ts` (route table)                                | E, F, M5                                                                                                                                                       | Table is a flat list of `app.route('/api/x', xRoutes())` lines; each track adds exactly one. Conflicts are one line.                                           |
| `src/worker/env.ts`                                                | all                                                                                                                                                            | Additive only; append your binding/var, never reorder.                                                                                                         |
| `migrations/0001_init.sql`                                         | —                                                                                                                                                              | **Editable until M8's first remote deploy**, then frozen for good. See below.                                                                                  |
| `package.json`                                                     | M0                                                                                                                                                             | Only M0 adds dependencies. A track that needs one raises it.                                                                                                   |

### 16.1 M5b — the one sanctioned contract change

`types.ts`, `api-types.ts`, `errors.ts` and `constants.ts` were frozen at the end
of M2d, and M5b is the single PR that re-opens them, by the owner's decision and
after M5/M7 were already built. Recorded here so "the contract is frozen" keeps
meaning something afterwards:

- **`types.ts`** — `BetType` gains `'teaser'`; `BetLeague = League | 'mixed'` is
  ADDED rather than `League` being widened, so every `Record<League, …>` label
  table and every board query still means "one real league"; `Bankroll` becomes
  `{id, userId, name, kind, balanceCents}`.
- **`constants.ts`** — `TEASER_POINTS_TENTHS`, `TEASER_PAYOUTS`, `MIN_TEASER_LEGS`.
- **`api-types.ts`** — `PlaceBetRequest` gains `teaserPoints?` and `bankrollId?`
  and widens `league`; `BetView` gains `bankrollId` / `teaserPoints` and widens
  `league`; `BetLegView` gains `league` and `originalLineTenths`;
  `BankrollResponse` is REPLACED by `BankrollView` + `BankrollsResponse`;
  `ConfigResponse` gains `teaserPoints` and `teaserPayouts`; `AdminAdjustRequest`
  is new. `LeaderboardResponse` LOSES `season` (§19 Q5 — a field that could only
  ever be `null` is worse than none) and its `rows` are ranked by `equityCents`
  rather than `balanceCents` (§19 Q2); `LeaderboardRow` and `LedgerResponse` are
  otherwise unchanged.
- **`errors.ts`** — `BANKROLL_NOT_FOUND` (404) and `TEASER_INVALID` (400) added;
  `MIXED_LEAGUE_PARLAY` / `MIXED_SEASON_PARLAY` kept in the enum, marked
  `@deprecated`, and never thrown. **A code is never repurposed or removed**, so a
  deployed client's copy of the vocabulary stays valid.

**`migrations/0001_init.sql` is now FROZEN.** M5b's schema half was folded into
`0001` for the same "the contract re-opens exactly once" reason — at the time
nothing had been deployed, so a `0002` would have immediately rebuilt tables
nobody had ever populated. **That window closed on 2026-09-14**, when
`wrangler d1 migrations apply spicybetting --remote` applied `0001` to the live
D1 and D1 recorded it in `d1_migrations`. Since then the file is frozen for good
and **every schema change is a new numbered `migrations/000N_*.sql`** — an edit
to `0001` is never replayed, so it would silently desynchronise the repo from
production. (Comment-only edits are fine; they change no DDL.) CLAUDE.md rule 9
and the header of the file itself say the same thing, and
`tests/unit/docs.spec.ts` fails if any of the four stops saying it.

### 16.2 Post-deploy additions

The freeze held. Everything after M8's first `--remote` apply is additive and lands
as its own numbered file:

- **`migrations/0002_users_deleted_at.sql`** — `ALTER TABLE users ADD COLUMN
deleted_at INTEGER NULL`, for the soft delete (§3.2 / §10.5 / §11.6). One nullable
  column, no table rebuild, nothing in 0001 touched. Deploying it needs
  `npx wrangler d1 migrations apply spicybetting --remote` BEFORE `npm run deploy` —
  see docs/OPERATIONS.md.
- **`api-types.ts`** — `AdminUserView` gains `deletedAt: EpochMs | null` and
  `isDeleted: boolean`. Purely additive: a field appearing on a response cannot
  break a deployed client.
- **`errors.ts`** — `ACCOUNT_HAS_PENDING_BETS` (409) added, under the same rule as
  M5b's additions: a code is never repurposed or removed, so an existing 409 could
  not be borrowed for a meaning it does not have.
- **`migrations/0006_bug_reports_diagnostics.sql`** — `bug_reports.diagnostics
TEXT NULL` for the browser diagnostics log a report now attaches (§11.7). One
  nullable `ADD COLUMN`. (Numbered after 0005, which is on a parallel branch;
  either order applies — different tables.)
- **Logging (§11.7, docs/OPERATIONS.md "Logs").** `requestLogMiddleware` is
  now the outermost middleware and writes ONE line per request that failed
  (status ≥ 400, with the error code the handler set on `c.var.errorCode`) or
  took over `SLOW_REQUEST_MS` (1 s): `[api] METHOD path status CODE user=name
ms`. `console.error` for 5xx, `console.warn` otherwise; never a body, token or
  query string. Successful fast requests stay silent. Together with the
  existing `[cron]`, `[bugs]`, `[config]` lines and the new `[client-error]`
  beacon this is what `wrangler tail` and the dashboard's Workers Logs
  (`observability.enabled` in wrangler.jsonc) show.
- **`migrations/0003_bug_reports.sql`** — the `bug_reports` table and its two
  indexes, for the in-app bug report → GitHub issue feature (§3.2 / §11.7). A new
  table, nothing in 0001 or 0002 touched. Applied by the Deploy workflow on merge.
- **`api-types.ts`** — `HealthResponse.bugReportsEnabled`; new `BugReportRequest`,
  `BugReportResponse`, `BugReportView`, `AdminBugReportsResponse`. All additive.
- **`env.ts`** — vars `GITHUB_REPO`, `GITHUB_API_BASE_URL`; secret `GITHUB_TOKEN`
  (optional; feature off without it). `RuntimeConfig.github` is the parsed form.
- **`constants.ts`** — `BUG_REPORT_*` limits and `BUG_REPORTS_PER_WINDOW` /
  `BUG_REPORT_WINDOW_MS`. No error code added: `VALIDATION`, `RATE_LIMITED` and
  `UPSTREAM_UNAVAILABLE` already mean exactly the three failures.
- **`migrations/0004_games_conference.sql`** — `games.home_conference_id` /
  `away_conference_id TEXT NULL`, for the CFB board's conference filter (§3.2 /
  §8.3 / §12.1). Two nullable `ADD COLUMN`s; the parser, the ingest live update
  (B) and `GameTeamView.conferenceId` are the code half. Applied by the Deploy
  workflow on merge; the old Worker neither reads nor writes the columns, so the
  order is harmless in both directions. After the apply every existing `games`
  row has NULL in both until its ingest target next runs the (B) pass — and a
  target for a game days away refreshes only every ~6 h (§8.4), so the CFB board
  filter showed every game under "Other" for HOURS after the first deploy, not
  minutes. A backfill needs the feed, so the remedy is to make the targets due
  (`UPDATE ingest_targets SET next_run_at = 0 WHERE league = 'ncaaf'`) and let
  the crons run; one-time cost of about one row write per active game.
- **`migrations/0005_bets_teaser_tiers.sql`** — the teaser tiers 3–14 points
  (§5.8). `bets.teaser_points_tenths` carried `CHECK (... IN (60, 65, 70))`,
  SQLite cannot alter a CHECK, and on D1 a table with children cannot be
  rebuilt the textbook way: foreign-key enforcement cannot be turned off inside
  a migration, only deferred, and `ledger.bet_id` is `ON DELETE RESTRICT`
  (checked immediately even when deferred) while `bet_legs.bet_id` CASCADEs. A
  throwaway worker test on 2026-09-14 proved both `RENAME` + copy and a plain
  `DROP TABLE bets` fail with `FOREIGN KEY constraint failed` and roll back, and
  that `PRAGMA foreign_keys = OFF` is accepted but ignored. The migration
  therefore rebuilds ALL THREE tables children-first: copy `bets`, `bet_legs`
  and `ledger` to plain temp tables, drop the three (leaf first), recreate them
  from 0001's DDL with the one CHECK widened to an integer multiple of 5 in
  [30, 140], copy back — ledger last and BEFORE its five triggers are
  recreated, so `ledger_ai_apply` cannot re-apply history to `balance_cents` —
  then indexes, triggers, drop temps. Locally wrangler runs the file as one
  `db.batch()`; remotely it posts the whole file to D1's query endpoint in one
  request, which 0001 (also multi-statement, with triggers) went through fine —
  but that is D1's transactional guarantee, not one this repo can test, which
  is why the post-deploy `npm run db:reconcile -- --remote` is not optional and
  docs/OPERATIONS.md names Time Travel as the way back.
  `tests/worker/migration-0005.spec.ts` seeds a full money history through the
  real triggers, re-runs the file, and asserts every row and balance is
  byte-identical, `SUM(ledger) = balance_cents` holds, every trigger and index
  is back, and the CHECK accepts every offered tier and refuses 25 / 145 / 33 /
  65.5. Run `npm run db:reconcile -- --remote` after the deploy anyway.
- **`api-types.ts`** — `PlaceBetRequest.teaserPoints` is `number` (one of
  `TEASER_POINTS_TENTHS`) instead of the literal `60 | 65 | 70`. Additive on the
  wire: every value the old client sends is still accepted.
- **`scripts/teaser-card.mjs`** — generates `TEASER_PAYOUTS` and the §5.8 table
  from one model, so the two are regenerated together.
- **`migrations/0007_secondary_odds.sql`** — the secondary odds provider (§21).
  Three metadata-only `ADD COLUMN`s (`game_lines.spread_book` / `total_book` /
  `ml_book`, `games.secondary_tried_at`) plus one new table, `secondary_budget`,
  seeded with its single row. Nothing existing is rewritten, so it is safe on the
  populated remote database and the order against the deploy is harmless in both
  directions: the old Worker neither reads nor writes any of it.
  **Written by M9b, not by the plan PR** — §21.3 carries the file verbatim until
  then, and it is frozen from M9b's merge like every numbered migration before
  it.
- **`api-types.ts`** — `GameLinesView`'s three market objects each gain
  `provider: string`, the per-market provenance the merge produces (§21.4).
  Response-only and additive, under the same rule as M5b's additions: a field
  appearing on a response cannot break a deployed client, and no existing field
  changes meaning. **`stale` DOES change meaning, in one direction only**: it
  becomes "some row offered a COMPLETE market and every row that did is stale at
  `now`" (§21.4), where today `toLinesView` computes it from the row's `seen_at`
  alone. `GameCard.tsx`'s `game.lines?.stale` check is untouched and `bettable`
  is unaffected; the one visible difference is a STALE all-NULL primary row,
  which renders the "Line is stale" banner today and renders "no line" after
  M9b. That is the intended correction — the banner says ingestion is broken, and
  a game DraftKings has simply not priced is not a broken ingest — and it is
  called out in M9b's §15 entry as the milestone's only live behaviour change.
- **`constants.ts`** — `LINE_PROVIDER_PRIMARY` / `LINE_PROVIDER_SECONDARY` /
  `LINE_PROVIDER_PRIORITY`, `ODDS_API_*` (bookmakers, markets, cost, reserve,
  probe, cooldown + its ceiling, timeout), `SECONDARY_*` (retry, re-sweep margin,
  sweep interval, match window); `MONEYLINE_NOT_OFFERED_SPREAD_TENTHS` is
  already on `main` via PR #36. Every numeric one is in §3.1's
  constants-of-record table and `tests/unit/docs.spec.ts` asserts it —
  **including `ODDS_API_MONTHLY_CREDITS` and `ODDS_API_TIMEOUT_MS`**, which an
  earlier draft of this bullet claimed without it being true. The first of those
  matters most: 500 is the number hard-coded in 0007's seed (§21.3), and a seed
  that silently disagrees with the constant is exactly the drift the guard is
  for.
- **`constants.ts`, again, for M9-0** — `NFL_WEEK_ROLLOVER_ET_HOUR`,
  `NCAAF_WEEK_ROLLOVER_ET_HOUR` and the `WEEK_ROLLOVER_ET_HOUR` record (§22).
  `INGEST_WINDOW_MS` is NOT deleted: it stops being the window and becomes the
  planner's hard ceiling, which is a doc-comment change plus a `min(...)` in
  `planTargets`. Keeping the name keeps the blast-radius bound and keeps the
  diff readable; a constant that no longer means what it says is exactly what
  the doc guard exists to catch, so its comment says so in full.
- **`src/shared/time.ts`** — `boardWindowEnd(league, now)`, the one definition of
  where the board and the planner stop (§22). ET now appears in TWO places in
  that file rather than one; CLAUDE.md rule 3 says so.
- **`src/shared/lines.ts`** — `mergeEffectiveLine`, `marketProvider`,
  `providerRank`, `missingMarkets`. New file, pure, imported by the board, by
  placement and by the sweep.
- **`src/worker/secondary.ts`** — new file: `runSecondary`, `sweepSecondary` and
  the secondary's OWN upsert SQL. Deliberately not more of `ingest.ts`, whose
  `LINE_UPSERT_SQL` M9c must not edit (§21.3).
- **`env.ts`** — var `ODDS_API_BASE_URL`; secret `ODDS_API_KEY` (optional; the
  whole feature is OFF without it, exactly like `GITHUB_TOKEN`).
  `RuntimeConfig.oddsApi` is the parsed form and is `null` when the key is unset.
- **No error code is added.** The secondary never produces a user-visible error:
  a market it could not fill is a market that is simply absent, which
  `MARKET_UNAVAILABLE` already means.
- **`api-types.ts`, for M10** — `PlayerView` and `PlayerBetsResponse`
  (§11.8), the response of the new `GET /api/users/:id/bets`. New types only;
  no existing field changes meaning. `BetView` is reused as-is, with
  `cancellable` always `false` in that one response — a value the field could
  already take, so no client reads it differently.
- **`src/worker/routes/users.ts`** — a new router, mounted at `/api/users` by
  one line in `index.ts` like every other. `src/worker/players.ts` holds the
  visibility check and the read-only mapping over `listBets`. No migration, no
  env var, no error code.

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

Status at a glance: **S1 UNMEASURED** (no longer blocked — the Worker is
deployed; nobody has read the number yet), **S2 UNMEASURED** (same),
**S3 RESOLVED**, **S4(a)/(b) RESOLVED**, **S4(c) OPEN until January**,
**S5 RESOLVED** (2026-09-16: `GET /v4/sports` returns the credit headers with
`x-requests-last: 0`, so the budget probe is free — §21.5, §21.12).

**How to measure S1 and S2, now that there is a deployed Worker.** Both answers
come off `wrangler tail`, which prints one JSON log line per invocation carrying
a **`cpuTime`** field (milliseconds) alongside `outcome` and any exception:

```bash
npx wrangler tail --format json                 # leave running in one terminal
# in another, as an admin, force one ingest:
curl -X POST -b "$COOKIE" -H 'x-csrf: 1' https://spicybetting.wardcrazy01894.workers.dev/api/admin/jobs/refresh
# then read `cpuTime` off the tailed line for that invocation (S1).
```

Do it on a Saturday ET date target (the 86-game CFB slate is the worst case) and
take a handful of runs for a p95 rather than one sample. `GET /api/admin/jobs`
gives the matching `stats.rowsWritten` for the same run, so CPU and rows are read
together. For **S2**, the same tail shows whether a `batch()` of 60 statements
returns an error — the probe below — and `outcome` says whether the invocation
was killed for exceeding limits rather than failing in application code.

**S1 — CPU cost of ingesting a full CFB Saturday (RE-SCOPED). UNMEASURED.**
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
_Method_: `POST /api/admin/jobs/refresh` against the deployed Worker on a real
Saturday date; read the `cpuTime` field off that invocation's `wrangler tail`
line (see the recipe above) and cross-check the dashboard. Also instrument
`performance.now()` around map/bind separately from parse in a pool-workers test.
_Exit criterion_: a p95 CPU number for the worst target, plus a decision between (a) ship as is,
(b) `REFRESH_TARGETS_PER_RUN=1`, (c) drop `display_clock` from the comparison
tuple (§8.6), (d) split the mapping across two invocations via an internal
self-`fetch`, (e) escalate to Alex re: Workers Paid.
**Blocks raising `REFRESH_TARGETS_PER_RUN` above 2.**

**S2 — D1 statement accounting per invocation. UNMEASURED.**
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

**S3 — `@cloudflare/vitest-pool-workers` + D1 migrations ergonomics. RESOLVED.**
`readD1Migrations('./migrations')` + `applyD1Migrations` in
`tests/worker/setup.ts` applies `0001_init.sql` in full — all seven triggers and
every `CHECK` — and `tests/worker/schema.spec.ts` exercises them directly,
including the `INSERT OR IGNORE` overdraft abort. The `better-sqlite3` fallback
was not needed. The secondary question is answered too: the pool tolerates
`assets.directory` pointing at a `dist/client` that `npm run pretest` creates, so
`wrangler.configPath` stayed. (Pool 0.22 on vitest 4 exposes itself as the
`cloudflareTest` Vite plugin rather than `defineWorkersProject`; same options,
new location.) Original framing, kept for the record:
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

## 19. Decisions (answered 2026-09-14)

These were the ten open questions the plan carried. All are now ANSWERED, and
each is stated with the decision first so nothing below reads as still open.
Where an answer reversed an earlier default, the reversal is called out.

1. **Workers Paid ($5/mo) is a LAST RESORT.** Free tier first: exhaust all four
   free rungs of R1's fallback ladder — the last being a CPU-splitting internal
   self-`fetch` — before escalating. The 10 ms free CPU limit is what forces the
   split-KDF design (§10.1) and the plan is built around it; nothing in v1
   assumes paid capacity.
2. **The leaderboard ranks by EQUITY** (`balanceCents + pendingStakeCents`), then
   ROI, then username. **REVERSES the original choice of realized balance.** "If
   I have $2,000 but $1,500 is tied up in a bet, that should be ahead of someone
   with $600." A stake in flight neither helps nor hurts your position until it
   settles. Full reasoning, including why the old "equity lets you lead on money
   in flight" objection does not hold, is in §11.5.
3. **No per-league bankrolls — ONE account balance.** Opened at signup, never
   rolled over, shared across NFL and CFB. `league` is therefore a property of
   the LEG, cross-league parlays and teasers are legal, and a bet spanning both
   is labelled `'mixed'`. §4.4, §11.4. **This reaches the UI as ONE cross-league
   bet slip** — "tease Michigan and the Steelers together" — with the league tabs
   moving only the board. §12.2. (M5b.)
4. **A push is a refund.** A pushed straight bet is refunded as if it never
   happened and is excluded from record and ROI on both sides of the fraction; a
   parlay or teaser drops the pushed leg and is re-priced from the survivors;
   all-push is refunded at even money. §7.3.
5. **There are NO SEASONS in the product.** Removed from every public filter —
   `GET /api/bankroll`, `GET /api/bets`, `GET /api/leaderboard` — and from the
   UI, which filters by league only (All / NFL / NCAAF). `bets.season` and
   `games.season` survive INTERNALLY for ingestion (§8.2) and the board's `week`
   default, and are not exposed. Balances never reset, so a per-season slice of
   one would describe a boundary that does not exist. This also settles what used
   to be a question about CFB bowls and NFL playoffs: ESPN labels a January bowl
   with the PREVIOUS season year and so do we, but since nothing hangs off that
   label any more it is bookkeeping rather than a money decision. Ingest targets
   are still keyed by ET **date** rather than by week, which is what makes the
   postseason reachable at all (§8.2).
6. **One shared invite code** for the whole friend group. Not single-use codes.
7. **All-in is allowed.** No cap on a single bet's stake beyond the balance
   itself — which already excludes money riding on open bets — and
   `MAX_PAYOUT_CENTS`, which limits the PAYOUT rather than the stake. The slip's
   MAX chip is the full available balance and nothing may cap it lower.
8. **Keep `docs/samples/*.json` committed** (~4.5 MB since M9a: the two ESPN
   week samples, the two Odds API samples, and the two merged same-date ESPN
   captures that turn §21.7's match counts into CI). Trimming them would make
   the fast node project marginally faster at the cost of the "parses the real
   thing" guarantee. The `worker` project already uses small synthesised slates,
   so the big files only cost the project that can afford them.
9. **`MAX_PAYOUT_CENTS = $1,000,000` stands.** It exists mainly so money columns
   provably cannot overflow into floats (§5.2b) and is unreachable at realistic
   prices — a 10-leg −110 parlay at a $1,000 stake returns ~$643k, and the worst
   teaser on the card returns $26k (§5.8).
10. **Keep `display_clock` live.** It is still the single biggest remaining D1
    write stream (§8.6), but the M4 A/B split took a measured CFB Saturday from
    **33,196** rows to **2,979** (5% of the daily cap, all streams in), and a
    clock change now costs 1 row rather than 4. Dropping it from the compare
    tuple would save roughly 1,200 rows a Saturday — worth revisiting only if
    `GET /api/admin/jobs`'s `dayRowsWritten` starts approaching 50,000.

---

## 20. Out of scope for v1 (future work)

Player props · live/in-play betting · round robins · futures ·
multi-book line shopping (the schema is ready: `game_lines` is keyed by provider) ·
line-movement history (`line_history` table) · email/push notifications ·
password reset UI (admin script only) · private leagues/groups (one global friend
group) · other sports (NBA, MLB, CBB) · custom domain · social feed / bet comments ·
CSV export · mobile app · half-point buy · cash-out · pruning of old `games` rows ·
side pots (`bankrolls.kind = 'custom'` — the schema is ready, nothing writes one) ·
DK-style "Super"/"Monster" specialty teasers (10/13 points, ties LOSE — a
materially different rule set, §5.8).

**Moved OUT of this list by M5b, and shipped:** teasers (6 / 6.5 / 7 point, 2-10
legs, spread and total, §5.8) and mixed-league parlays (§19 Q3 answered "one
account balance", which is what made a cross-league leg legal). "Season archives"
is gone from the list too — not because it shipped, but because §19 Q5 removed
the concept of a season from the product entirely.

---

## 21. Secondary odds provider (The Odds API)

Numbered **21** rather than 20 because §20 ("Out of scope for v1") already
exists and renumbering a chapter every cross-reference points at is a worse
trade than a section that is not the last one in the file.

### 21.1 Goal, and what is deliberately not in it

**Goal.** Fill any market — spread, total, moneyline — that the primary feed
(DraftKings via ESPN) is missing, for NFL games and for CFB games with a top-25
team, on The Odds API's FREE 500-credit/month tier, with a guard that makes
exhausting the quota impossible.

The measurement §8.3 built to answer "is a second provider worth it" answered
yes: on 2026-09-16 ESPN reported the Texas Tech–Houston total and moneyline as
`OFF` while the API carried both from nine books **including DraftKings** (total
53.5, −105/−115). So the common case is not "a worse book's number" — it is
DraftKings' own quote arriving through a different pipe.

**Settled, not up for re-litigation:**

1. The primary stays DraftKings-via-ESPN. The secondary fills only what the
   primary lacks, PER MARKET. A whole market — the line AND both prices — comes
   from ONE bookmaker; never a line from one book and a price from another.
   Bookmaker preference: `draftkings, fanduel, betmgm, betrivers, bovada`
   (`ODDS_API_BOOKMAKERS`). When the primary market reappears it takes the board
   back on the next refresh, with no extra machinery: see §21.4.
2. Eligible for a fill attempt: `status = 'scheduled'`, kickoff in the future and
   inside the **board window** (§22 — the same one the board and the planner
   use), league is `nfl`, OR league is `ncaaf` and `home_rank` or `away_rank` is
   1–25; AND the effective line is missing a market **by §21.2's rule**, which is
   not the same as "any market is null": a missing moneyline past a 30-point
   spread is normal, not a gap.
3. It rides the existing `refresh` cron. No fourth trigger. At most ONE odds call
   per league per run, plus at most one FREE credit probe, so at most 4 external
   subrequests against a limit of 50.
4. The feature is OFF when `ODDS_API_KEY` is absent, exactly like `GITHUB_TOKEN`
   (§11.7): `readConfig` returns `oddsApi: null`, the sweep is never attempted,
   and `job_runs.stats.secondary.enabled` is `false`.

**Out of scope, stated so it is not re-proposed:** the paid tier; a fourth cron;
a dedicated admin sweep endpoint (the three existing refresh paths cover it,
§21.2); filling UNRANKED CFB games; player props; showing more than one book's
price for a market; any change to `settle.ts` (grading reads the `bet_legs`
snapshot and nothing else — CLAUDE.md rule 7); any edit to migrations 0001–0006.

### 21.2 Where the sweep runs, and what counts as a gap

There are three ways a refresh happens and **all three fill**, because an
operator who presses a Refresh button and gets a board that is still missing a
total has been told nothing useful.

| Path                                      | Entry point                                                      | Secondary behaviour                                    |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| cron `*/15 * * * *`                       | `scheduled()` → `runJob('refresh','cron')` → `runRefresh`        | normal decision (§21.5)                                |
| admin `POST /api/admin/jobs/refresh`      | `runJob('refresh','admin')` → `runRefresh`                       | normal decision                                        |
| admin `POST /api/admin/games/:id/refresh` | `bumpTargetForGame` → `runJob('refresh','admin')` → `runRefresh` | `force` for THAT game: skips `SECONDARY_RETRY_MS` only |

The third path already re-ingests through the ordinary refresh job — it makes the
game's ET-date target the most due thing and then takes the **same `refresh`
lease** (`routes/admin.ts`, §9.3). That is load-bearing here: every sweep, from
every path, runs inside one lease, so the credit claim is already serialised and
two operators hammering Refresh cannot both sweep. The conditional `UPDATE` in
§21.5 is the belt to that braces, not a substitute for it.

**ONE implementation**, in `src/worker/secondary.ts` — not in `ingest.ts`, whose
`LINE_UPSERT_SQL` M9c must not touch (§21.3). `runRefresh` gains exactly one call
and one stats field:

```ts
runSecondary(env, now, { force: string | null }): Promise<SecondaryStats>
  // loops LEAGUES, at most one call each, folds secondary_budget into the stats

sweepSecondary(env, league, now, { force }): Promise<SecondarySweep>
  // ALWAYS a value, never null: a refusal is `{ skipped: 'throttled', … }`
```

`sweepSecondary` returning `SecondarySweep | null` was a round-1 mistake and is
corrected here: `null` and "skipped, and here is why" are different facts, and
the stats contract (§21.8) needs the second one. There is no `skipped: 'disabled'`
either — when `ODDS_API_KEY` is unset, `SecondaryStats.enabled` is `false` and
`sweeps` is empty, so nobody has to learn that a disabled feature emits one row
per league saying so.

`runRefresh` calls it once, AFTER the ESPN targets have been ingested (so the
decision sees the board the primary just wrote, and a gap the primary closed this
run costs no credits), and passes `force` through from the route. The route
returns the sweep stats in the SAME shape as a cron run's, inside the
`JobRunResponse` it already returns — no new route, no second stats vocabulary.

`force` waives the 4-hour retry backoff and **nothing else**. It does not waive
the credit reserve, the per-league sweep interval, the failure cooldown, or the
one-call-per-league-per-run rule. That is a decision, not an oversight: if the
league was swept 40 minutes ago, the fill on the board IS the freshest thing the
API has, and spending three credits to re-learn it is the behaviour the reserve
exists to prevent. When a claim is refused the reason travels back in the stats
(`skipped: 'throttled' | 'budget' | 'cooldown'`), so the operator sees why rather
than seeing nothing happen.

#### Eligibility, and the moneyline rule

A game is a CANDIDATE when all of:

- `status = 'scheduled'` and `kickoff_at > now`;
- `kickoff_at <= boardWindowEnd(league, now)` — **the same window the board and
  the planner use** (§22). Not a separate horizon constant: a second definition
  of "how far ahead the app looks" is a second thing to keep in sync, and the
  sweep must never pay for events no candidate could match;
- league is `nfl`, OR league is `ncaaf` and `home_rank` or `away_rank` is 1–25.

A candidate is GAPPED when `missingMarkets()` (src/shared/lines.ts) says so:

| Market missing from the effective line | Counts as a gap?                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| spread                                 | always                                                                          |
| total                                  | always                                                                          |
| moneyline                              | only when `abs(spread.homeTenths) < MONEYLINE_NOT_OFFERED_SPREAD_TENTHS` (30.0) |
| moneyline, and there is no spread      | always — with nothing to judge by, assume it is fillable                        |

**The moneyline rule is measured, not guessed.** In
`docs/samples/odds-api-ncaaf.json` (75 events, nine books) fifteen events carry
no moneyline at the five preferred books — and no moneyline at ANY of the nine
either. Every one of them has `|spread| >= 33.5`. The largest spread that DOES
carry a DraftKings moneyline is 35.5, and the largest below the fifteen is 30.5,
so 30.0 sits in a real gap in the data rather than on a cliff edge. The NFL
sample has no moneyline-less event at all.

Without the rule those fifteen games are permanently unfillable AND permanently
gapped: each re-triggers a three-credit sweep every `SECONDARY_RETRY_MS`,
forever. Simulated over a 30-day month (§21.5), four of them cost **471 credits**
of a 500-credit tier and move the reserve block from "never" to **day 19** —
which does not break anything, but does spend the month on games no book prices
and starve the fills that work. With the rule they are not gaps, and the typical
month costs 318 credits with the reserve never blocking.

This is the SWEEP's predicate and deliberately not the COVERAGE measurement in
`ingest.ts` (§8.3), which keeps counting every absent market including those
fifteen. One describes the feed; the other spends money. A single predicate doing
both would have to pick, and picking would silently change the §8.3 series that
justified this whole chapter.

### 21.3 Data model — `migrations/0007_secondary_odds.sql`

**THIS SECTION IS THE FILE.** The plan PR ships NO schema (§15): the block below
is the complete text `M9b` writes to `migrations/0007_secondary_odds.sql`, and
`0007` is frozen from the moment M9b merges, like every numbered migration before
it (CLAUDE.md rule 9, §16.1). Nothing existing is rewritten — three metadata-only
`ADD COLUMN`s and one new table — so it is safe on the populated remote D1 and
the apply/deploy order is harmless in either direction: the old Worker neither
reads nor writes any of it.

```sql
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
```

**ONE secondary row per game, `provider = 'odds-api'`** — not one row per
bookmaker. The reasons, in order of how much they matter:

- It makes "two secondary rows for one game with different `seen_at`"
  **impossible by construction**: the primary key is `(game_id, provider)` and
  the provider is a constant. There is no tie-break to get wrong.
- A WITHDRAWAL becomes free. When a later sweep no longer has a total for the
  game, the next write simply sets `total_tenths = NULL`, bumps `seen_at`, and
  the market leaves the board. With a row per bookmaker we would have to SELECT
  the rows we wrote last time in order to know which ones to blank — an extra
  read per game and an orphan row the first time we got it wrong. (§8.3
  established the same rule for the primary: a withdrawal is a write.)
- Write budget. One row per MATCHED candidate per sweep — not only the gapped
  ones, because a game the secondary un-gapped must keep being re-confirmed or
  the re-sweep rule cannot keep its fill fresh — subject to compare-and-skip,
  instead of up to nine rows per game. The consequence is worth knowing: a game
  with a complete primary line also carries a secondary row, so when a primary
  market goes stale the board switches to the other book's number rather than
  showing no line. Writing all nine books for 75 CFB games would be ~675
  rows a sweep against a 100k/day cap that a Saturday already spends ~5,100 of
  (§8.6).

`games.secondary_tried_at` is stamped **only for a game that still lacks a market
after the sweep's writes**. A game the sweep filled is not stamped and does not
need to be: it is no longer missing a market on the effective line, so the retry
rule cannot select it. That turns the write cost from "one row per eligible game
per sweep" into "one row per genuinely unfillable game per sweep" — on a normal
Saturday, a handful. The column is deliberately NOT indexed: the candidate scan
is already bounded by `(league, kickoff_at)` via `idx_games_board`, and an index
would double the cost of every stamp for a predicate that is never selective on
its own.

#### The secondary's OWN upsert, and why it cannot reuse the primary's

`ingest.ts`'s `LINE_UPSERT_SQL` compares nine price/line columns and **no book
columns**. Reusing it — or copying "the same `WHERE` shape", which is what round 1
said — is a correctness bug, not a style one:

> DraftKings withdraws its total. FanDuel offers 53.5 at the identical
> −105 / −115. The nine-column compare tuple is UNCHANGED, the write is skipped,
> `total_book` stays `draftkings`, and every leg placed afterwards snapshots a
> book that is not quoting that number.

So M9c adds its own constants in `src/worker/secondary.ts` and **edits
`LINE_UPSERT_SQL` not at all**. Two statements, because the all-NULL case must
never INSERT:

**(S1) `SECONDARY_LINE_UPSERT_SQL`** — used when at least one of the three
markets is non-null. Same shape as the primary's, with `spread_book`,
`total_book` and `ml_book` added to the column list, the `SET` list and **both
halves of the compare tuple**:

```sql
INSERT INTO game_lines (
  game_id, provider, spread_home_tenths, spread_home_price, spread_away_tenths,
  spread_away_price, spread_book, total_tenths, total_over_price,
  total_under_price, total_book, ml_home_price, ml_away_price, ml_book,
  captured_at, seen_at
) VALUES (?, 'odds-api', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id, provider) DO UPDATE SET
  … every column above …,
  captured_at = CASE WHEN <OLD12> IS NOT <NEW12> THEN excluded.captured_at
                     ELSE game_lines.captured_at END,
  seen_at = excluded.seen_at
WHERE <OLD12> IS NOT <NEW12>
   OR game_lines.seen_at < excluded.seen_at - <LINE_SEEN_TOUCH_MS>;
```

where `<OLD12>` / `<NEW12>` are the nine market columns **plus the three book
columns**. A book change alone is therefore a write — and, because the same
tuple is inside the `captured_at` CASE, it also advances `captured_at`. That is
correct and deliberate: FanDuel quoting 53.5 at −105/−115 is a DIFFERENT quote
from DraftKings quoting the same numbers, and `bet_legs.line_captured_at` must
say when the quote a leg snapshots was actually captured (§14.3), not when a
book we are no longer reading last moved.

**(S2) `SECONDARY_LINE_BLANK_SQL`** — used when all three markets are null. A
plain `UPDATE … WHERE game_id = ? AND provider = 'odds-api' AND <OLD12> IS NOT
<NEW12>`, which **cannot create a row**.

The split is the answer to a real failure: an INSERT of an all-null secondary row
would give a never-priced game (a ranked CFB matchup in early week, say, or one
whose match yielded no usable market) a fresh `game_lines` row with three null
markets. `mergeEffectiveLine` would then see rows that exist and no market — and
under the naive definition of `stale` the card would read "Line is stale — not
accepting bets right now" on a game that has never been priced at all. Two
guards, both stated so neither is "simplified" away later: **never INSERT an
all-null secondary row**, and `stale` means "some row offered a complete market
and every such row is stale" (§21.4).

### 21.4 The merge — `mergeEffectiveLine`, and why not a merged row

```ts
// src/shared/lines.ts — pure, platform-free, no D1, no DOM
mergeEffectiveLine(
  rows: readonly LineRowView[],   // EVERY game_lines row for one game
  kickoffAt: EpochMs,
  now: EpochMs,
): EffectiveLine | null           // null == the game has never been priced
```

Per market, independently:

1. drop rows that do not offer the market COMPLETE (a spread needs both tenths
   and both prices; a total needs the number and both prices; a moneyline needs
   both prices). A half-market is not a market.
2. drop rows that are stale at `now`:
   `now - seenAt > lineStaleAfterMs(kickoffAt, seenAt)`. Judged **per row**, so a
   fresh secondary fill survives next to a primary row that has gone stale.
3. of what is left, take the first by `LINE_PROVIDER_PRIORITY`
   (`['DraftKings', 'odds-api']`, unknown providers last), then `seenAt` DESC,
   then `provider` ASC. The priority match is NORMALISED (lowercase,
   alphanumerics only), because the string on a row is whatever the feed said
   the day it was written — ESPN served `Draft Kings` for a day (§8.3) — and a
   variant primary row must still outrank the secondary.

Step 3's primary-first ordering is the whole of "when the primary market
reappears it wins": no state, no timer, no cleanup of the secondary row.

**THREE CALL SITES, ONE FUNCTION** — and round 1 named two, which is how the
detail card would have ended up disagreeing with the slip it feeds:

| Caller                             | Must                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/games` (routes/games.ts) | select ALL rows per game; `LIMIT` moves into a games subquery (§21.10)                            |
| `GET /api/games/:id`               | `queryAll` + merge — **not** `queryOne`, which takes whichever row D1 returns first               |
| `resolveLegSnapshots` (bets.ts)    | select ALL rows per game; take provider, `line_captured_at` and staleness from the MARKET (§14.3) |

All three pass the request's single captured clock (`c.var.now`), never a fresh
`Date.now()`.

**Worked example.** Texas Tech (home) vs Houston, kickoff `K` 20 h away. Two
rows:

| provider     | spread                            | total                                        | moneyline                    | captured_at | seen_at    |
| ------------ | --------------------------------- | -------------------------------------------- | ---------------------------- | ----------- | ---------- |
| `DraftKings` | home `-35` −110 / away `+35` −110 | NULL (`OFF`)                                 | NULL (`OFF`)                 | now − 2 h   | now − 30 m |
| `odds-api`   | NULL                              | `535` o−105 / u−115, `total_book=draftkings` | −180/+150, `ml_book=fanduel` | now − 10 m  | now − 10 m |

`lineStaleAfterMs(K, seen_at)` is 3 h for both rows (each was seen inside 48 h of
kickoff), and both are fresh. Result:

```
spread    { homeTenths: -35, homePrice: -110, awayTenths: 35, awayPrice: -110,
            provider: 'DraftKings',        capturedAt: now-2h,  seenAt: now-30m }
total     { tenths: 535, overPrice: -105, underPrice: -115,
            provider: 'odds-api:draftkings', capturedAt: now-10m, seenAt: now-10m }
moneyline { homePrice: -180, awayPrice: 150,
            provider: 'odds-api:fanduel',  capturedAt: now-10m, seenAt: now-10m }
provider 'DraftKings'   capturedAt now-2h   seenAt now-30m   stale false
```

The headline `provider`/`capturedAt`/`seenAt` describe the highest-priority row
that contributed anything, so the card still reads "DraftKings"; the per-market
strings are the audit trail, and `bet_legs.provider` gets exactly the string the
board showed.

**`stale` means: some row offered a COMPLETE market, and every row that did is
stale at `now`.** The qualifier is not pedantry. `src/shared/espn.ts` writes an
ALL-NULL primary row when DraftKings pulls every market ("OFF"), and that row is
FRESH — today it renders `stale: false` with three null markets, i.e. "no line",
which is the truth and what `GameCard.tsx` shows. The looser definition ("rows
exist, no market survived") would flip that card to the stale banner and tell the
operator ingestion is broken when it is working perfectly. A card with one
surviving market renders that one button and no banner, as before.

One consequence to know before it looks like a bug: once M9c writes secondary
rows, a game with a FRESH all-null primary row and a STALE complete secondary row
renders the stale banner — some row DID offer a complete market and every such
row is stale. That is the definition doing its job (the secondary's market was
real and has gone unconfirmed), and it is unreachable until M9c ships.

**The rejected alternative: ingestion writes a merged `provider='board'` row.**
Its appeal is real — board and placement would each read one row and could not
disagree. It loses on three counts:

- **Provenance.** `bet_legs.provider` would read `board`, which names no book. §14.3
  makes the leg's `provider`/`line_captured_at`/`snapshot_at` trio the audit
  record of a bet; a value that identifies no counterparty empties it.
- **A fabricated `seen_at`.** A merged row's confirmation stamp would have to be
  a min or a max over its sources, and neither is a moment at which anybody
  confirmed anything. Every staleness decision in the app then keys off a
  synthetic number, and the one property the board and placement rely on —
  monotonicity in `now` — becomes an argument instead of a fact.
- **Writes.** A third row per game per refresh, rewritten whenever EITHER source
  moves, against a hard 100k/day cap.

The pure function's own risk is that two call sites feed it different inputs. It
is closed by contract and by test: every call site selects ALL rows for the game
(`WHERE game_id IN (…)`, never `ORDER BY … LIMIT 1`), and
the parity test in `tests/worker/bets.spec.ts` (and the list/detail case in `tests/worker/routes.spec.ts`) asserts that the board's `GameCard.lines`,
the DETAIL route's card and placement's resolved snapshot agree for a crafted
three-row set — including a row that is fresh for one market's window and stale
for another's.

**The "screen said −110, charged −115" hazard is closed by monotonicity, as
before.** `lineStaleAfterMs` keys on `seenAt`, not on `now`, so a market present
at time T is present for every T′ in `[T, T + window]`. The board read and the
placement read happen milliseconds apart in the same direction of time. Do not
"improve" the merge into a window measured from `now`.

**ACCEPTED RISK: a withdrawn secondary market stays bettable for up to ~3 h.**
The same monotonicity that closes the hazard above means a market the API stops
carrying does not leave the board until its row goes stale (3 h inside 48 h of
kickoff; 18 h further out) or until a sweep overwrites it with NULL — and near
kickoff the sweep may not run again in time. So a user can, for up to about three
hours, take a price no book is currently offering. This is accepted, explicitly:
the money is fake, the exposure is bounded by the same window the PRIMARY feed
has always had, and the alternative — suppressing fills inside `LIVE_HORIZON_MS`,
or shortening the window near kickoff — would either remove the markets people
actually bet or break monotonicity and reintroduce the board/placement
disagreement. §21.9 lists it as a failure mode with this resolution so nobody
re-discovers it as a bug.

### 21.5 The sweep decision, and the credit guard

**Decision (per league, per refresh run). One row read, then at most one
candidate scan.** The decision itself writes nothing — with one exception,
flagged in the pseudocode: when the reserve is blocking, `maybeProbe` may issue
the reset probe's claim, which writes the single `secondary_budget` row (and
never a `game_lines` or `games` row).

```
sweepSecondary(league, now, { force }):
  cfg = readConfig(env).oddsApi            # null -> runSecondary never called us

  # 0. Cheap pre-check: ONE row. If the league cannot possibly sweep (missing
  #    row, cooldown, interval, reserve) we never pay for the candidate scan.
  budget = SELECT * FROM secondary_budget WHERE id = 1
  if budget is null:                                    return skipped('no-budget-row')
  if now < budget.cooldown_until:                       return skipped('cooldown')
  if now - budget[league + '_last_sweep_at'] < SECONDARY_MIN_SWEEP_INTERVAL_MS:
                                                        return skipped('throttled')
  if budget.remaining - COST < RESERVE:
      maybeProbe(budget, now)                           # FREE, at most 1/day
      return skipped('budget')

  # 1. Candidates: scheduled, ahead, inside the §22 board window, NFL or top-25 CFB.
  rows = SELECT g.id, g.kickoff_at, g.home_name, g.away_name, g.short_name,
                g.secondary_tried_at, l.*             -- ALL line rows, both providers
           FROM games g LEFT JOIN game_lines l ON l.game_id = g.id
          WHERE g.league = :league AND g.status = 'scheduled'
            AND g.kickoff_at > :now
            AND g.kickoff_at <= :boardWindowEnd
            AND (:league = 'nfl'
                 OR g.home_rank BETWEEN 1 AND 25 OR g.away_rank BETWEEN 1 AND 25)
  for each game:
      eff     = mergeEffectiveLine(itsRows, kickoff_at, now)
      gapped  = missingMarkets(eff).any            # §21.2's table, NOT "any null"

  # 2. Two reasons to spend three credits, plus the operator's.
  retry   = ANY gapped game with (secondary_tried_at IS NULL
                                  OR now - secondary_tried_at >= SECONDARY_RETRY_MS)
  resweep = ANY game where a SECONDARY market survived the merge and
                  now >= m.seenAt + lineStaleAfterMs(kickoff, m.seenAt)
                                  - SECONDARY_RESWEEP_MARGIN_MS
  forced  = force is a candidate id AND that game is gapped
  if not (retry or resweep or forced):                   return skipped('no-gap')
```

`retry` is what discovers a gap; `resweep` is what stops a fill from silently
vanishing three hours after it appeared; `forced` is the operator. Note that a
game the LAST sweep filled satisfies neither `retry` (it is not gapped any more)
nor a stamp — which is why `secondary_tried_at` only ever records failures.

**Claim, then call. The guard is a `WHERE`, never a read-then-write** (CLAUDE.md
rule 5). One statement per league — two constant SQL strings chosen from a
literal map, so the column name is never interpolated from input:

```sql
UPDATE secondary_budget
   SET remaining_credits = remaining_credits - :cost,
       last_attempt_at   = :now,
       nfl_last_sweep_at = :now,          -- or ncaaf_last_sweep_at
       updated_at        = :now
 WHERE id = 1
   AND remaining_credits - :cost >= :reserve
   AND :now - nfl_last_sweep_at >= :minInterval
   AND :now >= cooldown_until;
```

`meta.changes = 1` is the permission to make the call. The debit happens BEFORE
the request, pessimistically: a request that times out has already been paid for,
because we cannot know whether the provider counted it and over-counting is the
safe direction. After a 2xx the row is overwritten from the authoritative
`x-requests-remaining` header, which corrects any drift the pessimism introduced.

**The budget probe is FREE, and that changes its design.** `GET /v4/sports?apiKey=…`
answers 200 with `x-requests-last: 0` and both `x-requests-used` and
`x-requests-remaining` present — **verified twice against the live API on
2026-09-16** (spike S5, §21.12, now RESOLVED). So:

- neither claim may decrement `remaining_credits`;
- there are **TWO probes with two different claims**, and they must not share
  one, because the obvious single gate deadlocks. **(a) THE RESET PROBE**, while
  the reserve is blocking, is what lets us notice the monthly reset without month
  arithmetic or trusting anyone's timezone:

  ```sql
  -- (a) reset probe: global daily throttle, respects the cooldown.
  UPDATE secondary_budget
     SET last_attempt_at = :now, updated_at = :now       -- NO credit arithmetic
   WHERE id = 1
     AND :now - last_attempt_at >= :probeMs
     AND :now >= cooldown_until;
  ```

  **(b) THE POST-FAILURE PROBE**, which replaces the pessimistic debit with the
  provider's own number after a sweep failed, **cannot use that gate at all**:
  the sweep it follows has just set `last_attempt_at = now` AND
  `cooldown_until = now + cooldown`, so both clauses are false by construction
  and the un-debit could never run. It gets its own claim, throttled on
  `checked_at` and **exempt from `cooldown_until`**:

  ```sql
  -- (b) post-failure probe: no daily throttle, no cooldown gate. It costs
  -- nothing and it follows a request that has ALREADY been made, so neither
  -- limiter is protecting anything here.
  UPDATE secondary_budget
     SET updated_at = :now                                -- NOT last_attempt_at
   WHERE id = 1
     AND :now - checked_at >= :postFailureProbeMinMs;     -- 60_000, anti-loop only
  ```

  The `checked_at` floor is one minute and exists solely so a pathological retry
  storm cannot issue a probe per failed request; it is not a budget guard,
  because there is no budget to guard. Deliberately NOT bumping
  `last_attempt_at`: that column means "when did we last spend a credit", and a
  free probe writing it would push the reset probe a day further out every time
  the provider hiccuped.

- **Both** probes, on a 2xx, write `remaining_credits = :fromHeader, checked_at = :now`
  — the only statement in the feature that raises the balance, and it only ever
  copies a header. Only the RESET probe (and a successful sweep) also writes
  `consecutive_failures = 0`; the post-failure probe must NOT, because it runs
  right after a failure whose whole point is to advance the counter — `GET
/v4/sports` usually still answers 200 during an odds-endpoint outage, so a
  probe that cleared the counter would pin the cooldown at its 1 h floor
  forever. A probe that itself fails writes nothing at all: the pessimistic
  debit simply stands, which is the safe direction.
- `ODDS_API_CREDIT_RESERVE` is therefore **25, not 100**. The old figure existed
  to out-size a paid probe ("31 × 3 = 93 < 100"); that arithmetic is dead and is
  deleted rather than left to be quoted. 25 is a cushion for debit drift plus one
  in-flight sweep, i.e. eight sweeps' worth.

**Credit model — simulated, not estimated.** 15-minute ticks, 30-day month, the
rules above, `COST=3`, `RESERVE=25`, `RETRY=4 h`, `MARGIN=45 m`,
`MIN_INTERVAL=2 h`, the real `lineStaleAfterMs` tiers, the §21.2 gap rule and the
§22 window. Re-run from scratch for round 2; the script's numbers, pasted:

| Scenario                                                                       | Sweeps | Credits | Remaining | Reserve first blocks  |
| ------------------------------------------------------------------------------ | ------ | ------- | --------- | --------------------- |
| (a) quiet: one NFL gap, 6 h, once a week                                       | 12     | **36**  | 464       | never                 |
| (b) typical: NFL 1 gap/day for 6 h + CFB Saturday, 4 ranked gaps, 8 h          | 106    | **318** | 182       | never                 |
| (c) pathological: an unfillable ranked CFB game all week + a permanent NFL gap | 158    | **474** | 26        | day 15                |
| (c) with the guard removed — what the DEMAND actually is                       | 337    | 1011    | —         | —                     |
| (d) a decision bug stuck on "yes", with `SECONDARY_MIN_SWEEP_INTERVAL_MS`      | 158    | 474     | 26        | day 7                 |
| (d) the same bug WITHOUT the per-league floor                                  | 158    | 474     | 26        | **day 1**             |
| (e) PRE-(C): four big-spread moneyline chases, guard on                        | 157    | **471** | 29        | never (but see below) |
| (e) POST-(C): the same four games are not gaps at all                          | 0      | **0**   | 500       | never                 |
| (b) + (e) PRE-(C): a typical month PLUS that chase                             | 158    | 474     | 26        | **day 19**            |
| (b) + (e) POST-(C): the same month with §21.2's rule                           | 106    | **318** | 182       | never                 |

Read: (b) fits with 182 credits of headroom. (c) wants 1,011 credits — twice the
tier — and the guard clamps it to 474 and turns the feature off on day 15;
**exhaustion is impossible**, because the reserve refuses the claim and the probe
that rediscovers the reset costs nothing. And the last two rows are why §21.2's
moneyline rule is in the plan rather than in a backlog: without it, a perfectly
ordinary month spends its credits on fifteen games no book prices and stops
filling the ones it can from day 19 onward.

**What degrades when the reserve bites.** Nothing breaks and no bet is affected.
Existing secondary rows stop being re-confirmed, so each one goes stale on its own
schedule (3 h near kickoff, 18 h further out) and those markets leave the board —
which is precisely the pre-§21 behaviour, a card with a spread and no total. Bets
already placed on a secondary market are untouched: grading reads the `bet_legs`
snapshot (§14.3). `job_runs.stats.secondary.budgetSkipped` counts every refusal
and `GET /api/admin/jobs` shows the balance, so "the feature went quiet" is
visible rather than mysterious.

**Row writes.** Per sweep: 1 row on `secondary_budget` (no indexes, so 1 row per
statement — a claim, plus a correction after the response), one `game_lines` row
per MATCHED candidate the sweep actually CHANGED — a filled game keeps being
re-confirmed, §21.3 — (compare-and-skip, §21.3's own SQL),
and one `games` row per game it could NOT fill. A worst-case CFB Saturday sweep
touching 12 ranked gapped games is under 30 rows; four sweeps in a day is ~120
against the ~5,100/day the app already writes (§8.6).

**Row reads.** The pre-check is 1 row. The candidate scan is one league's games
inside the §22 window joined to their line rows: on a CFB Saturday that is ~80
ranked-or-not games before the rank filter and ~12 after, each with 1–2 line
rows — call it 100 rows marshalled, twice per run at the very most. At 96 runs a
day that is under 20k rows read against D1's 5,000,000/day free allowance. The
scan is bounded by the window, which is the second reason §22 ships first: under
the old 10-day window the same scan covered ~40% more games.

### 21.6 The parse contract, and the CPU budget

Pure, in `src/shared/odds-api.ts`, total like `src/shared/espn.ts`: a malformed
event is SKIPPED with a warning, a malformed market is dropped and the rest of
the event survives, and nothing throws. A feed that changes shape must degrade to
"no fill", never to an exception inside a refresh run that has already written
the ESPN slate.

Request: `GET {base}/v4/sports/{sportKey}/odds` with
`apiKey`, `bookmakers=draftkings,fanduel,betmgm,betrivers,bovada`,
`markets=spreads,totals,h2h`, `oddsFormat=american`, `dateFormat=iso`,
`commenceTimeFrom=now`, `commenceTimeTo=boardWindowEnd(league, now)` (§22 — the
same window the board and the planner use; there is no secondary-only horizon).

The probe is a different endpoint and carries none of this: `GET {base}/v4/sports`
with `apiKey` alone, which is free (§21.5).

- `bookmakers=` rather than `regions=us` because a bookmaker list of up to ten
  keys **counts as one region**, so both cost the same three credits
  (`x-requests-last = markets × regions`), while the list cuts the payload.
- `commenceTimeFrom/To` cost nothing and bound the response to the window the
  board covers.
- The URL contains the api key. It is never logged, never put in an error
  message, never echoed into `job_runs.stats`; `redactUrl` is the only form that
  may leave the module.

Parsing rules:

- `commence_time` is ISO-8601 UTC and goes through the existing
  `parseIsoToEpochMs`. **No US Eastern logic appears anywhere in the secondary
  path** — ET exists only for ESPN's `dates=` bucket (§14.10), `games.kickoff_at`
  is already epoch ms, and the API is keyed by an instant range. Nothing here
  needs a calendar.
- `point` arrives as a JS `number` (`7.5`, `53`, `-3.5`) and goes through
  `parseLineToTenths`, which stringifies and does digit arithmetic and REJECTS
  anything finer than a tenth rather than rounding it. `price` is an integer and
  goes through `parseAmericanPrice`. Both enforce `MAX_ABS_LINE_TENTHS` and
  `MIN/MAX_ABS_AMERICAN_PRICE`. eslint bans `Math.round`/`floor`/`ceil`/`trunc`
  and `parseFloat` in this directory, and no float reaches a column.
- `spreads` and `h2h` outcomes are named by FULL TEAM NAME; `totals` outcomes are
  named "Over"/"Under". A spread's two `point` values must MIRROR exactly in
  tenths (`homeTenths === -awayTenths`) and a total's two must be EQUAL; a book
  that disagrees with itself is dropped for that market — the note is recorded as
  a warning only if the market ends up EMPTY after every preferred book has been
  tried, and only against the market it is about; a book out-voted by the next
  book is not an operator problem — the price of that quiet is that "DraftKings
  failed every spread this sweep, FanDuel filled them" is visible only as the
  `*_book` columns on the rows, not as a warning. A market missing a side
  is dropped.
- Books are visited in `ODDS_API_BOOKMAKERS` order, not response order, and the
  first book offering a COMPLETE market wins that market — independently per
  market, which is how a game ends up with a DraftKings total and a FanDuel
  moneyline.
- An event whose three markets are all null is still returned, so the stats can
  tell "the API does not carry this game" (a matching miss) from "the API carries
  it with nothing usable" (a real dead end).

**CPU.** Measured on this machine with node, on the committed samples — not
workerd, but it bounds the order of magnitude:

| Payload                                   | Bytes   | `JSON.parse` + a full walk |
| ----------------------------------------- | ------- | -------------------------- |
| ESPN CFB scoreboard (already in this run) | 1.33 MB | **1.827 ms** (parse only)  |
| Odds API NCAAF, all nine books            | 320 KB  | 0.663 ms                   |
| Odds API NCAAF, five books                | 197 KB  | **0.401 ms**               |
| Odds API NFL, all nine books              | 134 KB  | 0.293 ms                   |
| Odds API NFL, five books                  | 78 KB   | **0.169 ms**               |

Three costs that table omits, because they are not parsing — named here so the
10 ms budget is accounted honestly rather than optimistically:

- **the candidate scan's marshalling**: ~100 D1 result rows per league per run,
  mapped into `LineRowView`s. Bounded by the §22 window and by the rank filter.
- **the per-game merge on the BOARD hot path**: `mergeEffectiveLine` runs once
  per game on every `GET /api/games`, over 1–2 rows and 3 markets. It is a
  handful of comparisons per game and it replaces work `toLinesView` already
  did, but it is now in a request that a person is waiting for, not in a cron
  job. The board is capped at `BOARD_MAX_GAMES` (300) games, which is the bound.
- **the matcher**: pass 1 is a map lookup, but pass 2 is O(leftover ×
  unclaimed) with mascots precomputed once per side. Measured (node): 0.15 ms on
  the real 140 × 75 captures, where nearly everything matches in pass 1; ~1.9 ms
  at 100 × 75 and ~6.6 ms at 300 × 100 if EVERY candidate fell through to pass
  2 — the feed-renames-everything case, measured BEFORE the mascots were
  precomputed; with them (M9a as merged) the same benchmarks are **0.50 ms** and
  **1.19 ms**. Eligibility bounds `leftover` to the NFL plus ranked CFB games,
  which is what keeps that case out of the budget.

The worst refresh invocation sweeps both leagues: `0.401 + 0.169 = 0.57 ms` of
parsing on top of an ESPN parse that already costs ~1.8 ms, plus the scan, inside
a 10 ms budget. The `bookmakers=` narrowing is what keeps the parse half from
being 0.96 ms, which is why it is a requirement and not a nicety. Spike S1 (§18) still owns the real measurement:
the number to read is `cpuTime` off `wrangler tail` for a refresh invocation that
swept, and if it lands anywhere near 10 ms the first lever is
`REFRESH_TARGETS_PER_RUN`, not the sweep.

### 21.7 Matching ESPN games to API events

The two feeds share no id, so the join is on names and kickoffs. Pure, in
`src/shared/odds-api.ts`, and NEVER across leagues.

**Pass 1 — exact and ORIENTED.** Key both sides on
`${normaliseTeamName(home)}|${normaliseTeamName(away)}` — a name that normalises
to NOTHING has no key and never matches, in either pass — where
`normaliseTeamName` is NFD → strip the combining marks (U+0300–U+036F) → lowercase
→ strip everything that is not `[a-z0-9]`. (NFD, not NFC: a precomposed `é`
would survive NFC and then be deleted by the character class, turning "San José
State" into `josstate` and breaking the very match below.) **MEASURED and reproduced by `tests/unit/odds-api.spec.ts`
against the committed same-date captures: 32/32 NFL and 68/75 NCAAF on this key
alone.** (The 2026-09-16 live figure of 69 counted one neutral-site game whose
orientation the live script tried both ways; the committed test does not, and
68 is the honest pass-1 number.) The mascot fallback then recovers ALL FIVE
abbreviation misses, for **73/75**, and the two events left are neutral-site
games the feeds orient the other way round — "Kansas @ Arizona State" and
"Virginia @ West Virginia", which ESPN lists as `ASU VS KU` / `WVU VS UVA` with
the teams swapped — refused and counted in `swappedCandidates` exactly as the
orientation rule below says. Whether a `neutralSite` game should be allowed to
match swapped, with its markets re-oriented BY TEAM NAME (which the parser
already does per outcome, so the spread sign would be right), is an open
question for M9c — §21.12.

**The capture is one MERGED file per league, not one date.** ESPN's unit is a
single ET date (§8.1) and each API sample spans several — measured exactly:

| API sample                         | events | ET dates its `commence_time`s fall in                            | merged capture                                         |
| ---------------------------------- | ------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `docs/samples/odds-api-nfl.json`   | 32     | `20260917, 20260920, 20260921, 20260924, 20260927, 20260928` (6) | `docs/samples/espn-nfl-scoreboard-2026-09-17..28.json` |
| `docs/samples/odds-api-ncaaf.json` | 75     | `20260917, 20260918, 20260919, 20260926` (4)                     | `docs/samples/espn-cfb-scoreboard-2026-09-17..26.json` |

M9a's capture script (`scripts/capture-espn-range.mjs`, committed with the
samples so the next person can re-run it):

1. read the API sample, map every `commence_time` through `etDateKey`, dedupe and
   sort — never hard-code the date list, or the samples and the capture drift
   apart silently;
2. fetch each key from §8.1's URL for that league (`dates=YYYYMMDD&limit=100` for
   the NFL, `groups=80&limit=300&dates=YYYYMMDD` for CFB) with the existing
   `ESPN_USER_AGENT`, in series;
3. keep the FIRST response's root object and replace its `events` with the
   concatenation of every response's `events`.

The merged file is therefore not a byte-real ESPN response: its root `season` and
`week` describe the first date only, and the test must not assert them. That is
fine, because it exists for ONE purpose — feeding `matchOddsApiEvents` a
candidate list drawn from the same days as the events — and the parser's own
tests keep using the untouched per-week samples. A headline measurement that only
its author can reproduce is a claim, not a measurement.
It is what makes "San José State Spartans" equal "San Jose State Spartans" and
"Louisiana Ragin' Cajuns" equal "Louisiana Ragin Cajuns" — verified in a REPL,
both pairs collapse to the same key.

Orientation is part of the key deliberately. If a neutral-site game arrives with
home and away the other way round, pass 1 fails, pass 2 fails, the game is NOT
filled and the candidate is counted in `swappedCandidates`. Accepting such a
match would invert every spread sign on the card; refusing it costs one unfilled
market and leaves a visible counter.

**Pass 2 — mascot fallback.** A candidate matches an unclaimed event only when
ALL of: same league; `|kickoffAt − commenceAt| ≤ SECONDARY_MATCH_WINDOW_MS`
(90 min); `mascotOf(home)` AND `mascotOf(away)` both equal in that orientation;
and **uniqueness IN BOTH DIRECTIONS** — exactly one event satisfies this for the
candidate, AND exactly one candidate satisfies it for that event.

One direction is not enough, and the counterexample is committed to this repo. In
`docs/samples/espn-cfb-scoreboard.json`, "Southern Miss Golden Eagles @ Auburn
Tigers" and "Georgia Southern Eagles @ Clemson Tigers" are both `(eagles, tigers)`
and kick off within 90 minutes of each other. If the API carries only one of the
two, the other candidate finds "exactly one unclaimed event" and takes the wrong
game's spread onto a bettable card. Requiring the event to be unambiguous about
the candidate too makes that a refusal.

This exists for the measured residual mismatches, every one an abbreviation
difference in the PREFIX: "Massachusetts" vs "UMass", "App State" vs
"Appalachian State", "Sam Houston" vs "Sam Houston State", "Southern Miss" vs
"Southern Mississippi", "Nicholls" vs "Nicholls State", "SE Louisiana" vs
"Southeastern Louisiana". The mascot is the token they agree on, and on the
committed captures the fallback recovers every one of them (the five games
those six names appear in), with both-direction uniqueness never refusing a
real match on that data.

The obvious objection — CFB is full of Tigers, Bulldogs and Wildcats — was
measured rather than argued. On the API SIDE (the 75-event
`docs/samples/odds-api-ncaaf.json`) "Tigers" appears 5 times, "Eagles" 5,
"Panthers" 4, "Bulldogs" 4, "Bears" 4, "Wildcats" 4, and the biggest simultaneous
kickoff bucket is 12 games; no pair of API events within 90 minutes shares both
mascots in either orientation. The ESPN side is NOT as clean — see the Auburn /
Clemson pair above — which is exactly why the rule is two-way uniqueness and not
"the API is unambiguous, therefore we are safe". Eligibility does the rest: only
NFL games and top-25 CFB games are candidates, so pass 2 chooses among a handful
of games rather than a 75-game Saturday.

**No alias table.** All six residual mismatches are UNRANKED CFB teams, which are
not eligible for a fill in the first place. An alias table is a hand-maintained
list that goes stale in silence; instead, `unmatchedGames` names the candidates
nothing matched, so if a RANKED team ever appears there the signal is in
`GET /api/admin/jobs` rather than in nobody's head.

**A rescheduled game** — ESPN moved the kickoff, the API has not — still matches
in pass 1, which does not look at the clock at all. Only the fallback is
time-sensitive, and `SECONDARY_MATCH_WINDOW_MS` (90 min) is drawn from the data:
**live-measured 2026-09-16, 106 of 107 matched events agreed to the minute and
the one exception was 30 minutes apart**. Like the match counts above, that is a
live measurement until M9a lands; then the SAME test reproduces it from the
merged captures, asserting the median and max `|kickoffAt − commenceAt|` over the
matched pairs — so the constant has a number behind it in CI rather than only in
this paragraph.

Unmatched API events are counted, not named: most of them are games we do not
carry at all.

### 21.8 Stats

`job_runs.stats.secondary`, on every `refresh` run from every path. The types are
`SecondaryStats` / `SecondarySweep` in `src/worker/secondary.ts`:

```ts
secondary: {
  enabled: boolean,              // false when ODDS_API_KEY is unset; `sweeps` is then []
  remaining: number | null,      // secondary_budget.remaining_credits
  checkedAt: EpochMs | null,     // when that number last came from a real header
  budgetSkipped: number,         // sweeps the reserve refused this run
  sweeps: [{
    league: 'nfl' | 'ncaaf',
    reason: 'retry' | 'resweep' | 'forced' | null,   // null iff skipped
    skipped: null | 'no-gap' | 'throttled' | 'budget' | 'cooldown' | 'no-budget-row' | 'error',
    cost: number,                // credits claimed; 0 when skipped, 0 for a probe
    remaining: number | null,    // from THIS response's header
    events: number,              // events in the response
    matched: number,
    unmatchedEspn: string[],     // eligible games nothing matched, capped
    swapped: string[],           // home/away disagreement, refused
    filled: { spread: number, total: number, moneyline: number },
    stamped: number,             // games still gapped afterwards (secondary_tried_at)
    rowsWritten: number,         // meta.rows_written, folded into the run total
    warnings: string[],          // parser warnings, same rendering as ESPN's
    error: string | null,        // 'unauthorized' | 'rate_limited' | …
  }]
}
```

`reason` and `skipped` are exclusive: exactly one of them is non-null on every
entry. `skipped: 'error'` is the exception boundary firing BEFORE the claim (no
credits spent; `error` says what threw); a throw AFTER the claim reports the
real `reason` and `cost: 3`. If `runSecondary` itself fails (it cannot read
`secondary_budget`, say), the run carries `enabled: true` with `sweeps: []` and
`remaining: null` — distinguishable from the key being unset, where `enabled`
is false. That is what makes the admin view readable — "ncaaf: retry, 3 credits,
filled 2 totals" or "ncaaf: throttled" — and it is why `sweepSecondary` returns a
value rather than `null` (§21.2).

The admin Jobs tab renders unknown stat values as JSON today, which is enough;
Each run's own `secondary.remaining` / `checkedAt` are the balance AS OF THAT
RUN, recorded by the run itself (`runSecondary` reads the row after its sweeps),
which is what an operator reading a history of runs wants; nothing is folded in
at read time. Each sweep's `rowsWritten` is added to the run's existing
`rowsWritten` total so the §8.6 write budget stays one number.

### 21.9 Failure modes

| Failure                                                  | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ODDS_API_KEY` unset                                     | feature OFF. `readConfig().oddsApi === null`, no candidate scan, `secondary.enabled: false`, `sweeps: []`. `npm run dev` and the fixture server work with no key.                                                                                                                                                                                                                                                                                                                                                   |
| `secondary_budget` has NO row                            | `skipped: 'no-budget-row'`, zero writes, run still `ok`. **Never a throw**: this is reached inside a refresh that has already written the ESPN slate. It means 0007's seed did not run; the runbook says to insert the row by hand.                                                                                                                                                                                                                                                                                 |
| 401 / 403 (key revoked or wrong)                         | sweep abandoned for the run, `last_status='unauthorized'`, warning logged, budget row otherwise untouched — which means the pessimistic debit STANDS (the post-failure probe would 401 too), so a revoked key burns `ODDS_API_COST_PER_SWEEP` per claim, throttled only by `SECONDARY_MIN_SWEEP_INTERVAL_MS` (≈ 36 phantom credits/day) until the reserve blocks. Bounded, visible, and corrected by the first successful probe after the key is fixed. **No cooldown** — a timer would hide a configuration error. |
| 429                                                      | `cooldown_until = now + cooldownFor(consecutive_failures)`. No claim of either league succeeds until it passes.                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5xx / timeout / DNS / TLS                                | same cooldown, and the FREE POST-FAILURE PROBE runs immediately afterwards to replace the pessimistic debit with the provider's own `x-requests-remaining`. It is exempt from `cooldown_until` and does not touch `last_attempt_at` — both of which the failing sweep just set, so the obvious shared gate would make the un-debit unreachable. Throttled only by a 60 s `checked_at` floor. An outage costs ~0 credits. §21.5.                                                                                     |
| A provider outage that lasts for days                    | `consecutive_failures` doubles the cooldown from `ODDS_API_COOLDOWN_MS` (1 h) to `ODDS_API_COOLDOWN_MAX_MS` (8 h), so the burn settles at ≤ 3 attempts × 2 leagues a day instead of 24, and recovery is noticed within 8 h. A successful sweep or the daily reset probe clears it; the post-failure probe never does.                                                                                                                                                                                               |
| 2xx whose body is not JSON, or not an array              | cooldown + a loud warning. Zero events, zero writes. This is the schema-drift alarm.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| An exception anywhere in the sweep                       | caught at the `sweepSecondary` boundary and returned as a stat, exactly as `ingestTarget` isolates a target's error. It can never fail the ESPN ingest that ran FIRST in the same run.                                                                                                                                                                                                                                                                                                                              |
| Budget exhausted by a pathological gap                   | impossible: the reserve refuses the claim (§21.5) and the probe that rediscovers the monthly reset is free. The feature goes quiet; nothing else changes.                                                                                                                                                                                                                                                                                                                                                           |
| A bug that sweeps every run                              | `SECONDARY_MIN_SWEEP_INTERVAL_MS` turns "the month is gone in a day" into "the month is gone in seven", and `secondary.remaining` in the admin view is the thing to watch.                                                                                                                                                                                                                                                                                                                                          |
| Clock skew at the monthly reset                          | no month arithmetic exists. The balance comes only from the header; the daily FREE probe rediscovers a reset within 24 h whatever timezone it happened in. Worst case: nothing, since the probe costs nothing.                                                                                                                                                                                                                                                                                                      |
| Two Workers refreshing at once                           | both sweeps are inside the `refresh` lease (§9.2), including the per-game admin Refresh. The conditional `UPDATE` claim is the second line: `meta.changes` is the only permission.                                                                                                                                                                                                                                                                                                                                  |
| A row fresh on the board, stale at placement             | cannot happen while `lineStaleAfterMs` keys on `seenAt`: the window is fixed at confirmation and monotone in `now`. All THREE call sites run the SAME `mergeEffectiveLine`. §21.4.                                                                                                                                                                                                                                                                                                                                  |
| **A secondary market withdrawn near kickoff**            | **ACCEPTED**: it stays bettable for up to ~3 h (its own staleness window) unless a sweep NULLs it sooner. Fake money, bounded by the same window the primary has always had, and the alternatives break monotonicity. §21.4.                                                                                                                                                                                                                                                                                        |
| A never-priced game showing "Line is stale"              | cannot happen: no all-NULL secondary row is ever INSERTed (§21.3), and `stale` requires that some row offered a COMPLETE market (§21.4).                                                                                                                                                                                                                                                                                                                                                                            |
| A leg snapshotting the wrong book's capture time         | closed by §14.3: `provider`, `line_captured_at` and the staleness decision all come from `EffectiveLine.<market>`, never from a row.                                                                                                                                                                                                                                                                                                                                                                                |
| Two secondary rows for one game with different `seen_at` | impossible: `PRIMARY KEY (game_id, provider)` with `provider` a constant. §21.3.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A book change the compare-and-skip hides                 | closed by the secondary's own upsert: the three `*_book` columns are in BOTH halves of the compare tuple, so FanDuel replacing DraftKings at the identical number is a write. §21.3.                                                                                                                                                                                                                                                                                                                                |
| A secondary fill vanishing mid-Saturday                  | the re-sweep rule fires `SECONDARY_RESWEEP_MARGIN_MS` (45 min = three cron ticks) before the row's own staleness window closes. If the reserve is blocking it DOES vanish — see §21.5's degradation note, and `budgetSkipped` says why.                                                                                                                                                                                                                                                                             |
| Matching false positive (shared mascots, same kickoff)   | pass 2 requires BOTH mascots AND uniqueness in BOTH directions; the Auburn/Clemson pair in the committed ESPN sample is why one direction is not enough. Pass 1 is oriented, so a neutral-site home/away swap refuses rather than inverting.                                                                                                                                                                                                                                                                        |
| Chasing a moneyline no book posts                        | §21.2's rule: a missing moneyline is a gap only below a 30.0-point spread. Measured: 15 of 75 NCAAF events have no moneyline anywhere, every one at ≥ 33.5.                                                                                                                                                                                                                                                                                                                                                         |
| A rescheduled game                                       | pass 1 ignores kickoff entirely and still matches. Only the fallback is time-sensitive.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Timezones                                                | the API path has none: `commence_time` is UTC and `games.kickoff_at` is epoch ms. ET enters only through the window bound the caller passes in (`boardWindowEnd`, §22), which is a calendar question and is answered in one place.                                                                                                                                                                                                                                                                                  |
| D1 write amplification                                   | one row per game per sweep, compare-and-skip, plus one `games` stamp per game the sweep could not fill. §21.3 / §21.5.                                                                                                                                                                                                                                                                                                                                                                                              |

### 21.10 File-by-file

**New**

| File                                                                                                       | Contents                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `migrations/0007_secondary_odds.sql`                                                                       | §21.3 verbatim — written by **M9b**; the plan PR ships no migration (§15)           |
| `src/shared/odds-api.ts`                                                                                   | `parseOddsApi`, `normaliseTeamName`, `mascotOf`, `matchOddsApiEvents`               |
| `src/shared/lines.ts`                                                                                      | `mergeEffectiveLine`, `marketProvider`, `providerRank`, `missingMarkets`            |
| `src/worker/odds-api.ts`                                                                                   | `TheOddsApiProvider`, `buildOddsUrl`, `redactUrl`, `readCredits`, `fetchCredits`    |
| `src/worker/secondary.ts`                                                                                  | `runSecondary`, `sweepSecondary`, the secondary's own upsert SQL, the budget claims |
| `docs/samples/odds-api-{nfl,ncaaf}.json`                                                                   | the captured payloads (committed, §19 Q8)                                           |
| `docs/samples/espn-nfl-scoreboard-2026-09-17..28.json`                                                     | ESPN, 6 ET dates MERGED — every date the NFL API sample spans (§21.7)               |
| `docs/samples/espn-cfb-scoreboard-2026-09-17..26.json`                                                     | ESPN, 4 ET dates MERGED — every date the CFB API sample spans (§21.7)               |
| `scripts/capture-espn-range.mjs`                                                                           | the one-shot that produced them, driven off the API samples' own dates (§21.7)      |
| `tests/unit/odds-api.spec.ts`                                                                              | parse + match, against the samples                                                  |
| `tests/unit/lines.spec.ts`                                                                                 | the merge and `missingMarkets`                                                      |
| `tests/worker/secondary.spec.ts`                                                                           | the sweep, the budget, the three refresh paths                                      |
| the parity test in `tests/worker/bets.spec.ts` (and the list/detail case in `tests/worker/routes.spec.ts`) | board, detail route and placement agree                                             |

**Changed**

| File                         | Change                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/constants.ts`    | the `LINE_PROVIDER_*` / `ODDS_API_*` / `SECONDARY_*` block (done, in the plan PR); `MONEYLINE_NOT_OFFERED_SPREAD_TENTHS` is already on main via PR #36                                    |
| `src/shared/api-types.ts`    | `provider: string` on each of `GameLinesView`'s three market objects (§16.2)                                                                                                              |
| `src/worker/env.ts`          | `ODDS_API_BASE_URL` var, `ODDS_API_KEY` secret, `RuntimeConfig.oddsApi`                                                                                                                   |
| `src/worker/ingest.ts`       | ONE call to `runSecondary` at the end of `runRefresh`, and `SecondaryStats` folded into `IngestStats.secondary`. `LINE_UPSERT_SQL` is NOT touched                                         |
| `src/worker/jobs.ts`         | `runJob`/`runRefresh` take an optional `{ forceSecondaryGameId }`; additive parameter, every existing call unchanged                                                                      |
| `src/worker/routes/admin.ts` | `POST /games/:id/refresh` passes the game id as `forceSecondaryGameId`                                                                                                                    |
| `src/worker/routes/games.ts` | `BOARD_JOIN` selects ALL rows for a game; the `LIMIT` moves into a games subquery; `GET /:id` uses `queryAll`; `toLinesView` becomes a thin map over `mergeEffectiveLine`                 |
| `src/worker/bets.ts`         | `loadLines` returns ALL rows per game; `quoteFor` reads an `EffectiveLine`; `provider`, `line_captured_at` AND the staleness test all come from `EffectiveLine.<market>` (§14.3)          |
| `src/web/lib/lines.ts`       | nothing — `quoteFor` already reads `GameLinesView`, and no component renders `provider` today                                                                                             |
| `wrangler.jsonc`             | `"ODDS_API_BASE_URL": "https://api.the-odds-api.com"` var + the secret comment                                                                                                            |
| `.dev.vars.example`          | commented `ODDS_API_KEY=` and an `ODDS_API_BASE_URL` override to the fixture server                                                                                                       |
| `scripts/fixture-server.mjs` | serve the two samples at `/v4/sports/{sportKey}/odds` and a credit-header stub at `/v4/sports`, never requiring a key                                                                     |
| `tests/worker/fixtures.ts`   | an Odds API event builder + `stubOddsApi` with `x-requests-*` header injection                                                                                                            |
| `tests/unit/fixtures.ts`     | `oddsApiNfl()` / `oddsApiNcaaf()` and the two same-date ESPN loaders                                                                                                                      |
| `tests/unit/docs.spec.ts`    | the new constants in the §3.1 expected map, `ODDS_API_MONTHLY_CREDITS` and `ODDS_API_TIMEOUT_MS` among them (done, in the plan PR)                                                        |
| `PLAN.md` / `CLAUDE.md`      | this chapter, §2.4, §3.1, §3.2, **§14.3**, §15, §16.2; CLAUDE.md rule 9's migrations bullet and rule 10's secrets list (done, in the plan PR)                                             |
| `docs/OPERATIONS.md`         | **M9b** adds the `0007_secondary_odds.sql` row to the migrations table, in the PR that creates the file; M9c adds `ODDS_API_KEY` to Secrets, a "Data feed" note and a weekly credit check |
| `README.md`                  | M9c: `ODDS_API_KEY` in prerequisites, "optional — the board is primary-only without it"                                                                                                   |

**The board's `LIMIT` is a correctness item, not a tidy-up.** `GET /api/games`
today ends `ORDER BY g.kickoff_at, g.id LIMIT ?` with `BOARD_MAX_GAMES = 300`,
and that `LIMIT` counts JOINED rows. The moment a game can have two line rows,
a full board silently caps at ~150 GAMES with no error anywhere — the last games
of the week just stop existing. The fix is to bound the GAMES, not the rows:
`WHERE g.id IN (SELECT id FROM games WHERE … ORDER BY kickoff_at, id LIMIT 300)`
(or the equivalent subquery join), and then join the line rows to that set.
`tests/worker/routes.spec.ts` gets a case with 300+ games each carrying two rows.

**`GET /api/games/:id` is the second half of the same bug.** It uses `queryOne`,
which returns the FIRST row D1 hands back — so the detail card would render one
provider's markets while `resolveLegSnapshots` merges both. That is exactly the
"screen said −110, charged −115" divergence §21.4 exists to kill, reintroduced on
a route nobody was looking at. It must use `queryAll` + `mergeEffectiveLine`, and
the parity test in `tests/worker/bets.spec.ts` (and the list/detail case in `tests/worker/routes.spec.ts`) asserts the DETAIL route against placement,
not only the list route.

`settle.ts` is NOT in either list, and must not be: grading reads the `bet_legs`
snapshot (CLAUDE.md rule 7).

### 21.11 Milestones

Three PRs, each independently mergeable and each green on its own — **after the
plan PR**, which lands this chapter, the constants and the stubs and **no schema
at all** (§15). `migrations/0007_secondary_odds.sql` does not exist until M9b
writes it from §21.3, and it is FROZEN from M9b's merge, because the Deploy
workflow applies pending migrations to the live D1 on every merge to `main`
(CLAUDE.md rule 9).

**M9a — pure parse + match.** No schema, no HTTP, no behaviour change.
Owns `src/shared/odds-api.ts`, `docs/samples/odds-api-*.json`,
`tests/unit/odds-api.spec.ts`, the `tests/unit/fixtures.ts` loaders and the
`tests/worker/fixtures.ts` builder + `stubOddsApi` (landed early so M9c has it).

**First task, before any test is written**: run `scripts/capture-espn-range.mjs`
to produce `docs/samples/espn-nfl-scoreboard-2026-09-17..28.json` (6 merged ET
dates) and `docs/samples/espn-cfb-scoreboard-2026-09-17..26.json` (4), exactly as
§21.7 specifies — the date list comes from the API samples' own `commence_time`s,
never from a literal. ESPN serves ONE ET date per request, so a single-date
capture cannot cover an API sample that spans six; that is the mistake §21.7's
table exists to prevent. Without these files §21.7's 32/32, 68/75 (73/75 with
the fallback) and the 90-min window all rest on one person's terminal session. Commit them under the §19-Q8
rule that already covers the other samples.

Tests, written first:

- `parseOddsApi` on the real NFL sample: 32 events, every one with a kickoff, two
  team names and a DraftKings-preferred spread/total/moneyline where present.
- Same on the real NCAAF sample: 75 events, zero warnings, zero throws.
- Bookmaker preference: an event where `draftkings` lacks a total picks
  `fanduel`'s, and the two other markets stay DraftKings'.
- A whole market comes from ONE book: never `spread_book != null` with a price
  taken from a different book (asserted structurally by construction).
- `point` of `7.5` → `75` tenths; `53` → `530`; `-3.5` → `-35`.
- `point` of `7.55` → market DROPPED with a warning, never rounded.
- A spread whose two `point`s do not mirror → dropped + warning.
- A total whose two `point`s differ → dropped + warning.
- A market with one outcome → dropped.
- A price of `-99`, `0`, `100001` → dropped (bounds).
- An outcome named neither team → dropped + warning, other markets survive.
- `commence_time` unparseable / absent → event skipped + warning.
- Payload is `{}` / `null` / `"x"` / an array of nulls → zero events, one
  structural warning, no throw.
- An event with all three markets unusable is still returned.
- `normaliseTeamName`: the eight measured discrepancy pairs — asserting exactly
  which two collapse (San José State, Ragin' Cajuns) and which six do not.
- `mascotOf`: "Southern Miss Golden Eagles" and "Southern Mississippi Golden
  Eagles" both give `eagles`.
- `matchOddsApiEvents` pass 1 against the MERGED same-date ESPN captures:
  **32/32 NFL and 68/75 NCAAF**, and the full matcher **73/75** with the two
  neutral-site swaps named in `swappedCandidates`, asserted as numbers so a
  future normalisation change cannot quietly lose matches.
- the same test asserts the kickoff agreement that sizes
  `SECONDARY_MATCH_WINDOW_MS`: over the matched pairs the median
  `|kickoffAt − commenceAt|` is 0 and the max is ≤ 30 min, comfortably inside the
  90-minute fallback window.
- Pass 2 fires for "Massachusetts Minutemen" vs "UMass Minutemen".
- Pass 2 REFUSES when two events within 90 min share both mascots.
- Pass 2 REFUSES in the other direction too: two CANDIDATES sharing both mascots
  within 90 min and one event — the committed "Southern Miss Golden Eagles @
  Auburn Tigers" / "Georgia Southern Eagles @ Clemson Tigers" pair, driven
  straight from `docs/samples/espn-cfb-scoreboard.json` rather than synthesised,
  because that is the shape the data actually has.
- Pass 2 refuses at 91 minutes.
- An oriented swap is refused and lands in `swappedCandidates`.
- Never matches across leagues, even on identical names and kickoffs.
- A rescheduled candidate (kickoff moved 6 h) still matches in pass 1.
- Unmatched events are counted, unmatched candidates are named.

**M9b — schema, merge, adoption. No sweep yet, and exactly one visible change: a
STALE all-NULL primary row renders "no line" instead of the stale banner (§15).**
CREATES `migrations/0007_secondary_odds.sql`, copying §21.3 — the first file this
work puts under `migrations/`, frozen from this PR's merge. Also owns
`src/shared/lines.ts`, `src/shared/api-types.ts`, and the `routes/games.ts` /
`bets.ts` read paths.

Tests, written first:

- `tests/unit/lines.spec.ts`: one primary row, all three markets → the same
  effective line the old `toLinesView` produced, `provider: 'DraftKings'` on each
  market.
- Zero rows → `null`.
- **An all-NULL primary row that is FRESH → three null markets and
  `stale: false`** (the ESPN "OFF" case, §21.4). The card says "no line", not
  "Line is stale"; this is the one place the merge must NOT simplify.
- `missingMarkets`: spread absent → gap; total absent → gap; moneyline absent at
  a −29.5 spread → gap; moneyline absent at −30.0 and at −40.5 → NOT a gap;
  moneyline absent with no spread at all → gap; `null` line → three gaps.
- A row with a half-spread (one price missing) → spread dropped, others survive.
- The §21.4 worked example, exactly: a primary spread, a secondary DraftKings
  total, a secondary FanDuel moneyline; assert all three provider strings and
  the headline trio.
- Primary comes back: add a total to the primary row → the primary's total wins,
  same call, no other change.
- Staleness is PER ROW: primary `seen_at` 4 h old and secondary 10 min old, game
  20 h out → primary's markets gone, secondary's survive, `stale: false`.
- All rows stale → every market null, `stale: true`, and `bettable` false.
- Monotonicity: for a fixed row set, a market present at `now` is present at
  `now + 1 ms` … up to exactly its window, and never reappears after.
- Unknown provider string sorts last but is still usable when it is the only one.
- `tests/worker/schema.spec.ts`: 0007 composes on 0001–0006 — the three
  `game_lines` book columns, `games.secondary_tried_at`, and
  `secondary_budget` with exactly one row and a `CHECK` that refuses `id = 2`.
- the PARITY test (in `tests/worker/bets.spec.ts`, next to the placement it
  compares against): with a two-row set, the `GameCard` the board returns,
  **the card `GET /api/games/:id` returns** and the snapshot
  `resolveLegSnapshots` produces all agree on line, price and provider for every
  market — including one market whose only row is stale, which the board must not
  offer and placement must refuse with `MARKET_UNAVAILABLE`.
- `tests/worker/routes.spec.ts`: **300+ games, each with TWO line rows** →
  `GET /api/games` still returns `BOARD_MAX_GAMES` GAMES, not half of them. This
  is the test that fails today if the `LIMIT` stays on the joined rows (§21.10).
- A leg's `line_captured_at` comes from ITS market's row: a game whose spread row
  and total row have different `captured_at` values produces two legs with
  different `line_captured_at`, each matching its own market (§14.3).
- `tests/worker/bets.spec.ts`: a leg placed on a secondary market snapshots
  `provider = 'odds-api:draftkings'`, and deleting the `game_lines` row
  afterwards changes nothing about the bet (the §14.3 assertion, extended).
- Regression: the existing board and placement suites pass unchanged.

**M9c — the sweep, the budget, the three paths, the docs.** Owns
`src/worker/odds-api.ts`, `src/worker/{ingest,jobs,env}.ts`,
`src/worker/routes/admin.ts`, `wrangler.jsonc`, `.dev.vars.example`,
`scripts/fixture-server.mjs`, `docs/OPERATIONS.md`, `README.md`.

Tests, written first — `tests/worker/secondary.spec.ts` unless noted:

- Feature OFF with no key: no fetch, `secondary.enabled === false`, the ESPN
  ingest is byte-for-byte what it was.
- A gapped NFL game (primary has a spread, no total, no moneyline) → one sweep,
  one `game_lines` row with `provider='odds-api'`, `total_book`/`ml_book` set,
  and the board now offers all three markets.
- A fully-lined slate → NO fetch at all (`stub.callCount === 0`).
- An unranked CFB gap → no fetch. A top-25 CFB gap → a fetch.
- A game past kickoff, or `in_progress`, or `final` → not a candidate.
- The 4 h backoff: after a sweep that could not fill game X, X is stamped; a
  second run 1 h later does not sweep; a run 4 h 1 min later does.
- A game the sweep FILLED is not stamped (`secondary_tried_at IS NULL`) and does
  not re-trigger.
- The re-sweep rule: with a fill in use on a game 20 h from kickoff, advance the
  clock to `seen_at + 3 h − 45 min` and assert a sweep fires; at
  `seen_at + 3 h − 46 min` assert it does not.
- The fill does NOT vanish: stepping the clock through a simulated Saturday with
  the sweep enabled, the total is bettable at every step.
- Withdrawal: the second sweep's response has no total for a game that had one →
  the row's `total_tenths` is NULLed, `seen_at` advances, the board stops
  offering it.
- Compare-and-skip: an identical second sweep writes 0 rows.
- `SECONDARY_MIN_SWEEP_INTERVAL_MS`: two runs 30 min apart, both with gaps → one
  fetch, the second reports `skipped: 'throttled'`.
- The reserve: with `remaining_credits` at `RESERVE + 2`, a gapped slate produces
  NO odds fetch, `budgetSkipped: 2` (one refusal per league — the reserve is
  checked before the candidate scan, so a league is refused before anyone knows
  whether it had a gap), and the board is unchanged.
- The probe: with the reserve blocking and `last_attempt_at` 25 h old, exactly
  one `GET /v4/sports` happens, `remaining_credits` is NOT decremented by it,
  `checked_at` advances, and a second run 1 h later probes nothing.
- The probe rediscovers a reset: the probe's response says `remaining: 500` and
  the next run sweeps normally.
- The probe cannot exhaust: 40 simulated days of a blocked reserve leave
  `remaining_credits` exactly where it started.
- `secondary_budget` deleted → `skipped: 'no-budget-row'`, run still `ok`, the
  ESPN slate still landed, and nothing throws.
- The moneyline rule: a ranked CFB game with a spread of −40.5 and no moneyline
  is NOT a candidate for a sweep (`stub.callCount === 0`); the same game at −20.5
  is.
- 401 → no rows written, `last_status='unauthorized'`, `cooldown_until`
  UNCHANGED, the run is still `ok`, the ESPN slate still landed.
- 429 → cooldown set; the next run makes no call; after the cooldown it does.
- 500 and a timeout → cooldown set, zero `game_lines`/`games` rows written, and
  the FREE post-failure probe that follows restores `remaining_credits` to the
  provider's number **in the same run**. This is the test that fails if the
  un-debit is gated on `last_attempt_at`/`cooldown_until`, both of which the
  failing sweep has just set (§21.5).
- the post-failure probe does NOT bump `last_attempt_at`: after a failure the
  daily reset probe is still due at its original time.
- two failures a second apart issue ONE post-failure probe, not two (the 60 s
  `checked_at` floor).
- Cooldown escalation: three consecutive failures give 1 h, 2 h then 4 h, capped
  at `ODDS_API_COOLDOWN_MAX_MS`; one success resets `consecutive_failures` to 0.
- A 200 with `"not json"` → cooldown, one warning, zero rows.
- A response that throws inside the parser (forced) → caught, the run is `ok`,
  the ESPN counts are intact.
- Headers: `x-requests-remaining` from the response overwrites the pessimistic
  debit; a MISSING header leaves the stored balance alone (and does not set it
  to 0).
- `POST /api/admin/jobs/refresh` sweeps on the same rules as the cron.
- **(c)** `POST /api/admin/games/:id/refresh` on a gapped eligible game inside
  its 4 h backoff → a sweep happens, and the response's `run.stats.secondary`
  carries the sweep in the run-stats shape.
- **(c)** The same route on a game that is fully lined → no fetch.
- **(c)** The same route on an unranked CFB game → no fetch.
- **(c)** The same route with the reserve hit → no fetch, `budgetSkipped: 2`
  (one per league), still HTTP 200.
- **(c)** The same route while the lease is held → `409 JOB_LOCKED` and no
  fetch (unchanged behaviour, asserted so the sweep cannot smuggle a call out
  from under the lock).
- Two leagues gapped in one run → at most 2 fetches, one per league.
- `tests/unit/docs.spec.ts` stays green: every new constant is in §3.1, 0007 is
  in the OPERATIONS table, `ODDS_API_KEY` is in the OPERATIONS secrets list.
- `npm run dev` with NO `ODDS_API_KEY` starts and serves a board (manual, listed
  in the PR checklist).

### 21.12 Open questions, and the spike that is now closed

**S5 — RESOLVED, 2026-09-16.** _Does `GET /v4/sports?apiKey=…` return the
`x-requests-*` headers with `x-requests-last: 0`?_ **Yes** — verified twice
against the live API with the real key: HTTP 200, `x-requests-last: 0`, and both
`x-requests-used` and `x-requests-remaining` present. Consequences, all already
folded into this chapter: the budget probe is free, its claim `UPDATE` must not
decrement `remaining_credits`, a failed sweep is un-debited for nothing, and
`ODDS_API_CREDIT_RESERVE` drops from 100 to **25** — the reserve now cushions
debit drift only, and the "31 × 3 = 93 < 100" arithmetic that justified the old
figure is deleted rather than left to be quoted at somebody.

**Q — neutral-site games the two feeds orient the other way round (found by
M9a's committed test).** "Kansas @ Arizona State" and "Virginia @ West Virginia"
(ESPN: `ASU VS KU`, `WVU VS UVA`, both `neutralSite`) are the ONLY two NCAAF
events on the captured week that nothing matches, and both are the kind of game
the owner wants filled. The orientation rule refuses them because a swapped
match would put the wrong sign on every spread — but the parser already orients
every outcome BY TEAM NAME, so a swapped match re-oriented by name would carry
the right sign. Proposal for M9c: when the ESPN game is `neutralSite`, accept a
swapped pass-1 / pass-2 match and map the API's markets onto the ESPN sides by
team name (home spread = the API outcome named for ESPN's home team; moneyline
likewise; the total is symmetric). Needs the owner's yes, a test on exactly
those two games, and `swappedCandidates` becomes "swapped AND not neutral-site".

Nothing else here needs the product owner. The two choices that are genuinely
his — "is a partly-secondary board acceptable at all" and "what should happen
when the month's credits run out" — are answered by §21.1 (yes, per market, with
the book named) and §21.5 (the board quietly reverts to primary-only, no bet is
affected, and the admin view says so). The third, "may a withdrawn secondary
market stay bettable for up to three hours", is answered in §21.4: yes, on the
record, because the money is fake and the alternative breaks the one property the
board and placement rely on.

---

## 22. Board window ends on Monday

The product owner's rule, decided 2026-09-16 and not up for re-litigation:
**never show a game past the Monday that closes next week.** In days that is
"about a week, at most ~9" rather than a flat seven — the window is anchored to a
weekday, not to a duration, so its width breathes between 1.17 and 9.04 days
across the week (§22.2 measures it). Lines move too much after the weekend for a
number posted nine days early to be worth betting into, and a board full of
next-week games buries this week's.

This chapter replaces `now … now + INGEST_WINDOW_MS` as the definition of the
window. It ships as **M9-0**, on its own, BEFORE the secondary-provider work
(§21), because it is a behaviour change to a live app and has nothing to do with
a second odds feed.

### 22.1 The rule

All of it is US Eastern, and all of it is a CALENDAR question — there is no UTC
expression of "Monday Night Football" that is not wrong twice a year.

A football week runs **Tuesday through Monday**, and the window ends at the close
of a Monday ET date — inclusive, because MNF _is_ a Monday ET date and an
exclusive end would hide the one game the week finishes on. Exactly:

> Let **M** be the next Monday ET date at or after today's ET date (today, if
> today is a Monday). The window end is the **last instant of M**, except that
> (a) on a **Sunday** at or after the league's rollover hour, and (b) on a
> **Monday**, it is the last instant of **M + 7 days**.

Clause (b) is what keeps the rollover a rollover: without it the board would show
next week on Sunday evening and hide it again for the whole of Monday. With it,
what Sunday night showed is what Monday shows — MNF plus next week's slate — and
the window then narrows a day at a time from Tuesday on.

The rollover instants are per league, because the two leagues finish their slates
at different times:

| Constant                      | Value | Instant         | Why there                                                                          |
| ----------------------------- | ----- | --------------- | ---------------------------------------------------------------------------------- |
| `NCAAF_WEEK_ROLLOVER_ET_HOUR` | `0`   | Sunday 00:00 ET | Saturday's games are over the moment the ET day ends                               |
| `NFL_WEEK_ROLLOVER_ET_HOUR`   | `20`  | Sunday 20:00 ET | the early and late windows are done; SNF is in flight but its date is already past |

Both are hours of the ET calendar day (minutes are always `:00`), they are
constants of record in §3.1, and `tests/unit/docs.spec.ts` asserts them against
`src/shared/constants.ts`. `WEEK_ROLLOVER_ET_HOUR` is the `Record<League, number>`
the code reads.

### 22.2 `boardWindowEnd(league, now)`

One pure function in `src/shared/time.ts`, returning the **inclusive** last
instant of the window:

```ts
boardWindowEnd(league: League, now: EpochMs): EpochMs;
```

Inclusive, i.e. `etDayBounds(thatMonday).endAt - 1`, because every caller wants
`kickoff_at <= end` and because `etDateKeyRange(from, end)` is inclusive too:
handing it the exclusive midnight would plan an extra ET-date target for the
Tuesday, which is precisely the game the owner does not want shown.

The whole of it: take `now`'s ET calendar date, find the next Monday on or after
it (Monday → 0 days, Tuesday → 6, Sunday → 1), add 7 more days when `now` is a
**Monday** or a **Sunday at or past the league's rollover hour**, and take the end
of that ET day. The weekday comes from the ET parts via
`new Date(Date.UTC(y, m - 1, d)).getUTCDay()` — no second
`Intl.DateTimeFormat`, because constructing one is the expensive part (§1's 10 ms
budget) and this runs per league per planner run.

**Worked, computed in a REPL against the real ET helpers** (around the week of
Tue 2026-09-15 … Mon 2026-09-21; `end` is the last instant of the named ET day):

| `now` (ET)               | league  | window end     | span   | ET date keys planned |
| ------------------------ | ------- | -------------- | ------ | -------------------- |
| Fri 2026-09-18 12:00     | both    | Mon 2026-09-21 | 3.50 d | 0918…0921 (4)        |
| Sat 2026-09-19 12:00     | both    | Mon 2026-09-21 | 2.50 d | 0919…0921 (3)        |
| Sat 2026-09-19 23:59     | both    | Mon 2026-09-21 | 2.00 d | 0919…0921 (3)        |
| **Sun 2026-09-20 00:00** | `ncaaf` | Mon 2026-09-28 | 9.00 d | 0920…0928 (9)        |
| Sun 2026-09-20 00:00     | `nfl`   | Mon 2026-09-21 | 2.00 d | 0920…0921 (2)        |
| Sun 2026-09-20 19:59     | `nfl`   | Mon 2026-09-21 | 1.17 d | 0920…0921 (2)        |
| **Sun 2026-09-20 20:00** | `nfl`   | Mon 2026-09-28 | 8.17 d | 0920…0928 (9)        |
| Mon 2026-09-21 12:00     | both    | Mon 2026-09-28 | 7.50 d | 0921…0928 (8)        |
| Tue 2026-09-22 12:00     | both    | Mon 2026-09-28 | 6.50 d | 0922…0928 (7)        |
| Wed 2026-09-23 12:00     | both    | Mon 2026-09-28 | 5.50 d | 0923…0928 (6)        |

Scanned over August 2026 – January 2027 at 10-minute steps, the span runs from
**1.17 days** (NFL, the last moment before its Sunday 20:00 rollover) to **9.04
days** (CFB, a Sunday-00:00 window that crosses the November fall-back). The
ET-date count is **2 at minimum** (NFL on a Sunday morning: the rest of today and
Monday) and **9 at maximum**, which is where §8.4's "≤ 18 targets" comes from.

**The shortest window is the last moment before a league's Sunday rollover**, and
it is still a day and a half of board: a Sunday-afternoon NFL board covers the
rest of Sunday plus Monday's nighter, which is exactly the set of games that can
still be bet. It is never a sub-day window — clause (b) of §22.1 removed that
case, and removing it is the point: Monday's board IS Sunday night's board, so
nothing visible at 9 pm on Sunday has vanished by breakfast, and the window
narrows only by the day passing.

### 22.3 Who calls it, and what happens to `INGEST_WINDOW_MS`

| Caller                                          | Before                                                                 | After                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `planTargets` (src/worker/ingest.ts)            | `etDaysInWindow(now, now + INGEST_WINDOW_MS)` for BOTH leagues at once | per league: `etDaysInWindow(now, min(boardWindowEnd(league, now), now + INGEST_WINDOW_MS))` |
| `GET /api/games` default `to` (routes/games.ts) | `now + INGEST_WINDOW_MS`                                               | `boardWindowEnd(league, now)` — the route already has the league                            |
| the secondary sweep's candidate bound (§21.5)   | (would have been a new 48 h constant)                                  | `boardWindowEnd(league, now)` — the SAME window, no second horizon                          |

Every reader of `INGEST_WINDOW_MS` in the repo, listed so none is missed (line
numbers as of the plan PR):
`src/shared/constants.ts:203` (the definition);
`src/worker/routes/games.ts:11` (import) and `:118` (the default `to`);
`src/worker/ingest.ts:52` (import), `:194` and `:276` (doc comments), `:292`
(the `planTargets` call) and `:413` (the DST footnote inside
`claimDueTargets`, which M9-0 rewrites along with its 22-target budget);
`tests/worker/ingest.spec.ts:6/467/617/915`.
`src/worker/odds-api.ts` does NOT name it — its `SweepWindow` doc and its header
both say `boardWindowEnd`, and they must keep saying that. PLAN's own mentions
are in this chapter, §8.2, §8.4, §11.3 and §21.

**`INGEST_WINDOW_MS` is KEPT, and demoted to a hard ceiling** rather than
deleted. It never binds — the widest window measured is 9.04 days against a
10-day ceiling — and that is deliberate: `planTargets` walks ET day boundaries
and writes one row per day per league, so a bug in the week arithmetic that
returned a date years out would turn a cron invocation into thousands of
statements under a 10 ms CPU budget. The clamp is the blast-radius bound, exactly
as `SECONDARY_MIN_SWEEP_INTERVAL_MS` is for the credit spend. Its doc comment
says all of this, because a constant whose name no longer matches its job is
precisely the drift CLAUDE.md rule 11 exists to catch.

**The retirement rule does not change.** `planTargets` still deletes targets whose
`window_end_at` is more than `TARGET_RETIRE_AFTER_MS` (2 days) old AND which
contain no non-final game. The owner asked for a narrower window, not for faster
cleanup, and the existing rule is what keeps a postponed game's slate alive
(§7.5).

Two consequences of leaving it alone, both intended:

- **A target outside the window keeps refreshing until its own date passes.** The
  window only ever narrows day by day, from Tuesday through to the Sunday
  rollover, and a target already created keeps its cadence until the retirement
  rule takes it — so a game that leaves the BOARD keeps being ingested. Nothing
  discovered is ever un-discovered; the board is a view, not the queue.
- **At deploy there is a one-off tail.** The live database currently has targets
  up to 10 days out. M9-0 stops CREATING them past the Monday; the existing ones
  age out normally, so within ~12 days the queue is at its new size. During that
  window a handful of extra discovery targets consume refresh slots — visible as
  a slightly higher `targetsProcessed` in `GET /api/admin/jobs`, harmless against
  the 96-slot/day supply, and self-healing. No cleanup script, because a script
  that deletes `ingest_targets` rows is a script somebody runs against the wrong
  environment.

### 22.4 DST, and the edges that actually break

DST is handled by **not doing arithmetic**: the Monday is located by ET calendar
date and its end by `etMidnight(y, m, d + 1)`, which re-measures the UTC offset
around the boundary (`src/shared/time.ts` already does this two-pass for
`etDayBounds`). Adding `7 * MS_PER_DAY` would be wrong by an hour twice a year,
in the direction that silently drops or duplicates an ET date key.

Measured at the two 2026 transitions:

- **Fall back, Sun 2026-11-01** (25 h ET day): CFB at 00:30 ET → Mon 2026-11-09,
  span 9.02 d; NFL at 19:59 → Mon 11-02 (1.17 d), at 20:00 → Mon 11-09 (8.17 d).
- **Spring forward, Sun 2026-03-08** (23 h ET day): CFB at 00:30 ET → Mon
  2026-03-16, span 8.94 d; NFL at 20:00 → Mon 03-16, 8.17 d.

**The repeated hour on fall-back Sunday cannot hit either rollover.** When the
clocks go back, 01:00–01:59 ET happens twice, so an `hour` of 1 is ambiguous —
`etParts` reports the same wall clock for two different instants an hour apart.
Neither rollover hour is 1: CFB's is 0 and the NFL's is 20, and midnight and
8 pm are unaffected by a 02:00 transition. The comparison is `>=` anyway, so even
if an ambiguous hour were involved both readings would fall on the same side of
it. No special case, and none is needed.

Other edges, each a test in §22.5: a month boundary (Wed 2026-09-30 → Mon
2026-10-05), a year boundary (Sun 2026-12-27 20:00 → Mon 2027-01-04, which is
also the postseason case §8.2 cares about), and the exact rollover instants —
`hour >= rollover`, so Sunday 20:00:00.000 ET has rolled over and 19:59:59.999
has not.

### 22.5 Tests, written first

`tests/unit/time.spec.ts` (pure, node env):

- every row of §22.2's table, both leagues, asserted as an ET date key pair
  (`etDateKey(now)` … `etDateKey(boardWindowEnd(...))`) rather than as a raw
  epoch, so a failure reads as a date;
- the end is the LAST INSTANT of its Monday: `boardWindowEnd(...) + 1` is the
  `startAt` of the following ET day;
- Sunday, both leagues, at `rollover - 1 ms` and at `rollover`, for each league's
  hour — four assertions, and the CFB pair straddles ET midnight;
- **Monday at 00:00:00.000 and at 23:59:59.999 both give the FOLLOWING Monday's
  end** (clause (b)): spans of 8.00 d and 7.00 d, 8 ET date keys each;
- **Tuesday at 00:00 gives the Monday six days later — 7 ET date keys**, i.e. the
  window does NOT extend again on Tuesday. This is the assertion that pins clause
  (b) to Monday alone;
- a Sunday after the rollover and the Monday that follows it return the SAME
  instant, so the board a user saw on Sunday night is the board they see on
  Monday;
- the two DST Sundays above, and a window that CONTAINS a transition (a Tuesday
  in the week of the fall-back);
- month-boundary and year-boundary cases;
- monotonic and bounded: over a year of 10-minute steps, `boardWindowEnd` is
  always `>= now`, always an ET Monday's last instant, and the span never exceeds
  `INGEST_WINDOW_MS`;
- `etDateKeyRange(now, boardWindowEnd(...))` never exceeds 9 keys.

`tests/worker/ingest.spec.ts`:

- `planTargets` on a Tuesday creates 7 dates × 2 leagues = 14 targets, and is
  idempotent on a second run;
- `planTargets` on a Sunday at 10:00 ET creates 9 CFB dates and 2 NFL dates — the
  test that proves the leagues are planned SEPARATELY;
- `planTargets` on a Monday plans 8 dates per league — and creates none it did
  not already create on Sunday, so `created === 0` on that rerun — and does NOT
  delete the existing future targets;
- the existing slot-starvation soak test is re-based on the new target count.

`tests/worker/routes.spec.ts`:

- `GET /api/games?league=nfl` with no `to` returns a game on the closing Monday
  and does NOT return one on the Tuesday after it;
- an explicit `?to=` still overrides the default, unchanged;
- `GET /api/games/:id` returns a game OUTSIDE the current window (§22.7) — the
  assertion that stops somebody adding a window filter to the detail route.

`tests/worker/ingest.spec.ts`, the ROLLOVER BURST (§22.6, effect 3):

- seed a Sunday just before the CFB rollover, step the clock past it, and run
  `planTargets` + `claimDueTargets` for successive cron ticks: the seven new date
  targets are created at once but are drained at most `REFRESH_TARGETS_PER_RUN`
  per run (one of them through the reserved discovery slot), oldest-overdue
  first. Assert that all seven have been claimed within 7 runs of an idle queue
  and that no single run claims more than `REFRESH_TARGETS_PER_RUN`. This is the test behind the runbook's "it fills
  in over an hour or four" answer; without it that sentence is a guess.

### 22.6 What an operator sees, and the docs that must move with it

M9-0 is a user-visible change to a deployed app. The PR updates, in the same PR
(CLAUDE.md rule 11):

- **`docs/OPERATIONS.md`** — the line that says the refresh job "usually fetches
  today's date AND a discovery date up to 10 days out" becomes the Monday rule,
  plus a short "why did next week's games disappear?" note naming the two
  rollover instants. This is the single most likely support question.
- **`README.md`** — **none found**: grepped at plan time, the README describes
  the app and the dev loop and never states the board's range, so there is
  nothing to correct. Listed anyway so the next person does not have to grep it
  again, and so a range sentence added in the meantime gets caught.
- **`PLAN.md`** — this chapter, §8.2, §8.4, §11.3 (done).
- **`CLAUDE.md`** — rule 3's "the only place a timezone appears" sentence, which
  is otherwise false the moment `boardWindowEnd` lands (done).

The two effects to expect, stated for the runbook:

1. **The board shrinks from 10 days to at most ~9, and usually 3–7.** Nobody
   loses a bet: every game that disappears is one whose kickoff is further out
   than the owner wants shown.
2. **On Friday, next week's CFB games are not on the board at all** — they appear
   at Sunday 00:00 ET, the NFL's next week appears at Sunday 20:00 ET, and both
   STAY through the Monday that follows. Before that they are not ingested
   either: `planTargets` creates a target only for dates inside the window, so
   `games` has nothing for next week on a Friday, and that is correct rather
   than a stalled feed. Only already-created targets keep refreshing outside
   the window — the one-off deploy tail of §22.3.
3. **Next week's board fills in over about an hour or four, not at the stroke of
   the rollover.** This is the support answer, so it belongs in the runbook
   rather than being rediscovered at 1am. At the rollover the window gains SEVEN
   ET dates for that league at once, and each is a brand-new `ingest_targets` row
   with `next_run_at = now`. But a run claims at most `REFRESH_TARGETS_PER_RUN`
   (2) targets, of which exactly ONE is the reserved discovery slot (§8.4), and
   `ORDER BY priority ASC, next_run_at ASC` serves the OLDEST overdue discovery
   target first — the new rows are the least overdue thing in the queue. With a
   cron tick every 15 minutes and an otherwise idle queue (where slot 1 also
   takes a discovery target) that is about an hour to pull all seven; with a
   live Saturday or a backlog competing for slot 1 it can be ~4 h. So at 00:15 ET on a Sunday a CFB board can legitimately be a
   handful of games with no lines yet, filling as the runs go by. Nothing is
   broken and nothing needs kicking; `GET /api/admin/jobs` shows the targets
   being taken. (An operator in a hurry can force it with the per-game Refresh
   button, which bumps one date to the head of the queue.)

### 22.7 What this does NOT change

The unit of ingest work (one ET date, one request — §8.2), the reschedule tiers
(§8.4), the staleness window (§8.5), the write-budget levers (§8.5/§8.6),
`BOARD_LOOKBACK_MS`, the retirement rule, the cron schedule, and every money
path. No schema change, so no migration: M9-0 adds no column and touches no
table. A rollback is a revert of the PR.

**`GET /api/games/:id` stays UNWINDOWED, deliberately.** It takes an id and
applies no `from`/`to` at all, and M9-0 must not "fix" that for symmetry. The
edit flow reads a bet's games through it (§12), so a bet placed on Sunday night
on a game the window later stops listing must still render, re-price and take an
edit right up to that game's own lock (§14.2's `NOT EXISTS` over
`bet_legs JOIN games`, which is the only thing that decides it). Bettability is decided per game by `kickoff_at`,
`status` and the line's freshness — never by whether the game is inside the
board's current window — so a narrowing window can hide a game from the LIST
without ever making an existing bet unreachable. The list route is the browse
surface; the detail route is an identity lookup.
