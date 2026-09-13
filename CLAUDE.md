# CLAUDE.md — SpicyBettingSimulator

Fake-money sports-betting simulator (NFL + FBS college football) for Alex and a
few friends. Real lines, real odds, real payouts, **no real money**.

**Read `PLAN.md` before changing anything.** It is the architecture of record:
data model, odds math, settlement algorithm, ingestion design, milestones and the
parallel-execution map.

---

## Commands

```bash
npm install                 # first time only

npm run dev                 # fixture ESPN server + wrangler dev (:8787) + vite (:5173)
npm run db:migrate:local    # apply migrations/ to the local D1

npm run typecheck           # tsc -b across all six TS projects
npm run lint                # eslint
npm run format:check        # prettier
npm test                    # vitest: `unit` + `worker` projects
npm run test:unit           # pure logic only (fast)
npm run test:worker         # Worker + real D1 via vitest-pool-workers
npm run build               # vite build + wrangler dry-run bundle

npm run deploy              # build the SPA then wrangler deploy
```

### Pre-PR gate — run ALL of these, in this order, and get them green

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Do not open a PR with any of these red. Green CI is necessary, not sufficient —
every PR also gets an adversarial review before merge.

---

## Non-negotiable conventions

1. **TDD.** Tests first for all pure logic: odds math, grading, parlay pricing,
   the ESPN parser, validation. `tests/**/*.spec.ts` currently hold `it.todo`
   contracts — turn the relevant ones into real failing tests _before_ writing
   the implementation, and delete none of them without saying why.
2. **Money is integer cents. Lines are integer tenths of a point. Prices are
   integer American; exact decimal odds are BigInt rationals held only in
   memory.** No float ever appears in a code path that produces a cent.
   `Math.round`/`floor`/`ceil`/`trunc` and `parseFloat` are banned by eslint
   throughout `src/shared` and `src/worker` — the real failure mode is
   `Math.floor(stake * decimalOdds)`, not `Math.round`. See PLAN.md §5.
   - **Never persist a decimal-odds rational.** A 10-leg parlay numerator reaches
     20+ digits; an SQLite `INTEGER` column silently stores that as `REAL`, and
     `bind()` truncates past 2^53. `bets` stores none; the price is always
     recomputed from `bet_legs.american_price` via `priceFromLegs()`.
   - Every money column is `CHECK`-bounded by `MAX_PAYOUT_CENTS` ($1,000,000,
     defined in `constants.ts` because the browser needs it too) so it provably
     cannot overflow into a float.
   - **Never write an arithmetic claim you have not pasted from a REPL.** Two
     review rounds were spent on a float-regression vector that was wrong; the
     canonical one is now `-110/+120/-105` at a **100¢** stake → exact 820, float 819. Divergence is stake-dependent — at 1000¢ the same parlay agrees — so
     spot-checking one stake proves nothing.
3. **Timestamps are epoch milliseconds, UTC, everywhere** — DB, API, code. The
   only place a timezone appears is `etDateKey()` (ESPN's `dates=` parameter) and
   display formatting in the browser.
4. **`src/shared/` is platform-free.** No `fetch`, no `Request`/`Response`, no
   DOM, no Workers globals. Enforced by tsconfig (`types: []`) and eslint. This
   is what makes it unit-testable and importable from both sides.
5. **Atomicity is a single `db.batch()`.** D1 has no interactive transactions.
   Never read-then-write: express the guard as a `WHERE` clause inside the write.
6. **Money invariants live in the schema**, not in application code: the
   `ledger_ai_apply` trigger is the only writer of `balance_cents`, the
   `ledger_bi_sufficient_funds` `BEFORE INSERT` trigger is the overdraft guard
   (and its sibling `ledger_bi_bankroll_exists` rejects orphan rows with a
   _different_ message, so `db.ts` can map one to `409 INSUFFICIENT_FUNDS` and
   the other to `500 INTERNAL`), and
   `UNIQUE (bankroll_id, kind, ref_id)` is what makes double-payment impossible.
   Don't route around them.
   - **NEVER write `INSERT OR IGNORE` or `INSERT OR REPLACE` into `ledger`.**
     `OR IGNORE` suppresses a `CHECK` violation raised from the AFTER trigger, so
     the row lands with _no balance effect, permanently_, in an append-only table
     — `SUM(ledger) = balance_cents` is then broken forever and unrepairable.
     Use `INSERT … SELECT … WHERE NOT EXISTS (…)`, which states the idempotency
     intent explicitly. The two `ledger_bi_*` triggers use `RAISE(ABORT)`, which
     `OR IGNORE` _cannot_ suppress, as the backstop for when somebody does it
     anyway.
     (`OR IGNORE` on `bankrolls` is fine — it is not the ledger.)
7. **Grading reads the line from the `bet_legs` snapshot, never from
   `game_lines`.** `settle.ts` must not import a `game_lines` accessor.
8. **The server is the only authority on whether a bet may be placed.** The
   client never sends a price, never sends a timestamp, and its `bettable` flag
   is a server-supplied boolean.
   8b. **The cancel/edit lock is a `NOT EXISTS` over `bet_legs JOIN games`, never
   `bets.earliest_kickoff_at`.** That column is a placement-time snapshot that
   ingestion never updates; guarding on it alone lets a user cancel a game that
   ESPN rescheduled earlier and which has already kicked off. PLAN.md §14.2.
   8c. **`bets.season` comes from the legs' `games` rows, never from a wall clock.**
   Otherwise a January bowl lands on next season's bankroll. PLAN.md §4.4.
9. `migrations/0001_init.sql` is **frozen**. Schema changes are new numbered files.
10. Never commit `.dev.vars`. The only secrets are `INVITE_CODE` and
    `IP_HASH_SALT`; there is no ESPN key.

---

## Platform constraints you will trip over

| Constraint                          | Value                                                     | Why you care                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker CPU per invocation (free)    | **10 ms**                                                 | No server-side heavy PBKDF2 (hence the split KDF, PLAN.md §10). No parsing a full CFB week in one go (hence per-ET-date ingest, §8.1).                                                            |
| `crypto.subtle` PBKDF2 iterations   | **capped at 100,000 in workerd** (`OperationError` above) | Server KDF is 1,000. Worker-project tests must use precomputed `dk` vectors, never derive them in-pool.                                                                                           |
| D1 statements per invocation        | 50 (docs) / 1000 (2026 changelog)                         | Budget ≤ 40. Chunk settlement at 20 bets. See Spike S2.                                                                                                                                           |
| D1 bound params per statement       | 100                                                       | A 10-leg parlay inserts legs as 10 separate statements, not one.                                                                                                                                  |
| D1 rows written per day (free)      | 100,000, **hard-enforced since 2026-09-01**               | Past the cap D1 **errors**, which blocks bet placement and settlement. ~16k/day modelled on a CFB Saturday _with_ the three levers in §8.5; ~48k without them. Treat write budget as correctness. |
| D1 `INTEGER` column                 | i64; larger values silently become `REAL`                 | Never store a parlay rational.                                                                                                                                                                    |
| External subrequests per invocation | 50                                                        | We make ≤ 2 ESPN calls per cron run.                                                                                                                                                              |
| Cron triggers                       | min interval 1 min; docs say 5/account or 3/Worker        | We use exactly 3. Don't add a fourth without re-checking.                                                                                                                                         |

D1 `batch()` is atomic: sequential execution, full rollback if any statement
errors. That is the ONLY transaction you get.

---

## Layout

```
src/shared/   pure domain: types, odds, grading, espn parser, validation, time
src/worker/   Hono API + cron jobs + D1 access
src/worker/routes/  one file per API area; index.ts holds the route table
src/web/      React SPA (pages, components, contexts, api client)
migrations/   D1 schema (0001 is frozen)
tests/unit/   node-env tests for src/shared; fixtures.ts reads docs/samples via fs
tests/worker/ vitest-pool-workers tests with a real D1; fixtures.ts SYNTHESISES
              small slates (workerd has no fs, and the tsconfig project boundary
              does not span tests/unit)
docs/samples/ captured ESPN payloads — read only by the unit project
scripts/      fixture server, admin password tool, ledger reconcile
```

**Local dev gotcha**: `wrangler.jsonc` defaults `ESPN_BASE_URL` to real ESPN.
`.dev.vars` (copied from `.dev.vars.example`) overrides it to the local fixture
server. Without that file, `npm run dev` talks to production ESPN.

## Merge-conflict etiquette (multi-agent work)

- `src/shared/{types,api-types,errors,constants}.ts` are frozen after M2d;
  changes go through one PR owned by that track.
- `src/worker/index.ts` route table: add exactly one `app.route(...)` line.
- `src/worker/env.ts`: additive only.
- `src/worker/middleware.ts`, `db.ts` and `routes/admin.ts` are each touched by
  more than one milestone. M1 (or M4, for admin) lands every export stubbed;
  later milestones fill **only their own functions** and make no structural
  edits. See PLAN.md §16 for the per-file ownership table.
- `package.json` dependencies: raise it, don't add unilaterally.

## Operating the deployed app

```bash
wrangler d1 migrations apply spicybetting --remote
wrangler secret put INVITE_CODE
wrangler secret put IP_HASH_SALT
wrangler tail                      # live logs
npm run db:reconcile -- --remote   # assert SUM(ledger) === balance for every bankroll
```

Jobs can be kicked manually as an admin: `POST /api/admin/jobs/{refresh|settle|maintenance}`.
`GET /api/admin/jobs` shows the last 50 runs with stats, parser warnings and
auto-void decisions — check it first when something looks wrong.

## Git identity

Commits and `gh` calls made by Claude run as `wardcrazy01894` via environment
variables (see the global CLAUDE.md). Don't set `git config user.*` in this repo.
Push remote should be `git@github-wardcrazy:wardcrazy01894/SpicyBettingSimulator.git`.
