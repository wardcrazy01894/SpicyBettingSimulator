# CLAUDE.md — SpicyBettingSimulator

Fake-money sports-betting simulator (NFL + FBS college football) for Alex and a
few friends. Real lines, real odds, real payouts, **no real money**.

**Read `PLAN.md` before changing anything.** It is the architecture of record:
data model, odds math, settlement algorithm, ingestion design, milestones and the
parallel-execution map.

**Status: v1 is feature-complete AND DEPLOYED.** M0–M8 plus M5b (account
balances, cross-league bets, teasers) are done. The app is live at
**https://spicybetting.wardcrazy01894.workers.dev**, first deployed 2026-09-14,
and that is permanent — this is the real instance Alex and his friends bet on,
not a preview. `docs/OPERATIONS.md` is the runbook.

Two consequences hang off being deployed:

- **`migrations/0001_init.sql` is FROZEN** (rule 9). It has been applied to the
  remote D1 and recorded in D1's `d1_migrations` table, so every schema change
  from here is a new numbered `migrations/000N_*.sql`. Editing `0001` now means
  the file and the live database say different things and nothing ever
  reconciles them.
- **Spikes S1 and S2 are simply UNMEASURED** (PLAN.md §18), not blocked. Both
  wanted a deployed Worker and now have one: run a refresh and read `cpuTime`
  off the `wrangler tail` log line. The only genuinely date-blocked item left is
  S4(c), the January postseason check.

---

## Commands

```bash
npm install                 # first time only

npm run dev                 # fixture ESPN server + wrangler dev (:8787) + vite (:5173)
npm run db:migrate:local    # apply migrations/ to the local D1

npm run typecheck           # tsc -b across all seven referenced TS projects
npm run lint                # eslint
npm run format:check        # prettier
npm test                    # vitest: `unit` + `worker` + `web` projects
npm run test:unit           # pure logic + the docs-drift guard (fast)
npm run test:worker         # Worker + real D1 via vitest-pool-workers
npm run coverage            # vitest --coverage; gate is on src/shared/** only
npm run build               # vite build + wrangler dry-run bundle

npm run db:reconcile        # SUM(ledger) === balance_cents for every bankroll
npm run admin:hash          # derive a `dk` for an admin password reset
npm run deploy              # build the SPA then wrangler deploy
```

### Pre-PR gate — run ALL of these, in this order, and get them green

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Do not open a PR with any of these red. Green CI is necessary, not sufficient —
every PR also gets an adversarial review before merge. The checklist in
`.github/pull_request_template.md` is that gate written down; fill it in rather
than deleting it.

**The PR template is a CHECKLIST, not a CI gate.** Nothing verifies that its
boxes are ticked, or that a ticked box is true — `.github/workflows/ci.yml` runs
the five gate commands and gitleaks and knows nothing about the template. It is
there so a human (and the adversarial reviewer) can see what the author claims to
have checked. Ticking a box you did not do is therefore invisible to CI and is
the one failure mode the whole checklist has.

---

## Non-negotiable conventions

1. **TDD.** Tests first for all pure logic: odds math, grading, parlay pricing,
   the ESPN parser, validation, the slip reducer. The `it.todo` contracts M0
   seeded are all discharged — the suite is real and green — so the rule now
   reads forward: write the failing test before the implementation, and delete an
   existing test only with a reason in the PR description.
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
     (`OR IGNORE` on `bankrolls` is allowed in general — it is not the ledger —
     but the balance-opening statements use `INSERT … SELECT … WHERE NOT EXISTS`
     anyway, and the reason is specifically the **uuid**: `bankrolls.id` is a
     fresh uuid, so a duplicate would NOT collide on the primary key. It collides
     on the PARTIAL unique index `idx_bankrolls_main`, `OR IGNORE` swallows that
     silently, and the `deposit_initial` that follows then fires against a
     bankroll id that does not exist — aborting the whole batch on
     `ledger_bi_bankroll_exists`. The explicit `NOT EXISTS (… kind = 'main')`
     states the real intent and makes a second run a complete no-op. PLAN.md §4.4.)
7. **Grading reads the line from the `bet_legs` snapshot, never from
   `game_lines`.** `settle.ts` must not import a `game_lines` accessor.
8. **The server is the only authority on whether a bet may be placed.** The
   client never sends a price, never sends a timestamp, and its `bettable` flag
   is a server-supplied boolean.
   8b. **The cancel/edit lock is a `NOT EXISTS` over `bet_legs JOIN games`, never
   `bets.earliest_kickoff_at`.** That column is a placement-time snapshot that
   ingestion never updates; guarding on it alone lets a user cancel a game that
   ESPN rescheduled earlier and which has already kicked off. PLAN.md §14.2.
   8c. **`bets.season` and `bets.league` come from the legs' `games` rows, never
   from a wall clock or from the request.** Both are labels since M5b — `season`
   is the season of the earliest-kickoff leg and `league` is `'mixed'` when the
   legs span both — so neither constrains what a bet may contain.
   `PlaceBetRequest.league` is advisory and the server never compares it.
   **`season` is INTERNAL ONLY**: it exists for ingestion and the board's `week`
   default, and appears in no public MONEY filter and no UI copy, because the
   product has no concept of a season (PLAN.md §19 Q5). `GET /api/games?season=`
   is the one exception and is a board narrowing, not a money slice; there is no
   `?season=` on `/api/bankroll`, `/api/bets` or `/api/leaderboard`, and
   `LeaderboardResponse` has no `season` field. Do not add any of them back.
   PLAN.md §4.4.
   8d. **Money is ACCOUNT-level: one balance per user, opened in the SIGNUP
   batch, never per league, per season or lazily.** Nothing on a read path
   creates a balance. `bets.bankroll_id` comes from `PlaceBetRequest.bankrollId`
   (default: the caller's `main`), and the guard that it is the caller's own is an
   `EXISTS` inside the placement INSERT — the pre-flight read exists only to
   produce a specific `404 BANKROLL_NOT_FOUND`. `MIXED_LEAGUE_PARLAY` /
   `MIXED_SEASON_PARLAY` are deprecated and never thrown. PLAN.md §4.4.
   8e. **A teaser's `bet_legs.line_tenths` is the TEASED line and
   `original_line_tenths` the book's**, which is what lets `gradeLeg` stay
   completely unaware teasers exist. Its per-leg `american_price` is a +100
   PLACEHOLDER, not a price: the bet is priced once, at the bet level, from
   `TEASER_PAYOUTS[tier][legCount]`. `gradeBet` therefore needs its `pricing`
   argument built from the BET ROW (`bet_type` / `teaser_points_tenths`) — the
   legs cannot tell you. PLAN.md §5.8.
9. `migrations/0001_init.sql` is **FROZEN**. It was applied to the remote D1 on
   2026-09-14 and D1 recorded it in `d1_migrations`; re-running migrations will
   never replay it. **Every schema change is a new numbered
   `migrations/000N_*.sql`** — never an edit to `0001`, not even "just a column
   default", because the live database will not pick it up and the file stops
   describing production. Comment-only edits to `0001` are fine (they change no
   DDL). The pre-deploy window in which the M5b contract change was folded into
   `0001` is closed and is history, not precedent. PLAN.md §16.1.
   - `0002_users_deleted_at.sql` is the first of those new files;
     `0003_bug_reports.sql` (the `bug_reports` table) the second,
     `0004_games_conference.sql` adds `games.home/away_conference_id`,
     `0005_bets_teaser_tiers.sql` REBUILDS `bets`/`bet_legs`/`ledger` children-first
     to widen the teaser-tier CHECK (the only way on D1; proof in §16.2), and
     `0006_bug_reports_diagnostics.sql` adds `bug_reports.diagnostics`. PLAN.md §16.2.
   - A new migration is a deploy step. The Deploy workflow
     (`.github/workflows/deploy.yml`) applies pending migrations automatically on
     every merge to `main`, before it deploys. For a MANUAL deploy the order is
     yours to get right: **`npm run db:migrate:remote` FIRST, then
     `npm run deploy`** — code that names a column the remote database does not
     have 500s every request that touches it. Add the new file to the table in
     docs/OPERATIONS.md either way.
   - `readD1Migrations('./migrations')` in `vitest.workers.config.ts` hands the
     worker pool EVERY file in order, so tests already run against the composed
     schema; a `schema.spec.ts` assertion for the new column is the cheap proof
     that it composes on top of 0001.
   - **Deleting a user is a SOFT delete and there is no other kind.**
     `bankrolls.user_id` / `ledger.bankroll_id` are `ON DELETE RESTRICT` and
     `ledger_bd_block` refuses `DELETE FROM ledger`, so a hard delete cannot be
     written without destroying money history. `users.deleted_at` + a rename is the
     delete. The tombstone username is `deleted_<hex>`, and `validateUsername`
     rejects that prefix at signup so nobody can squat one. PLAN.md §10.5.
10. Never commit `.dev.vars`. The only secrets are `INVITE_CODE`, `IP_HASH_SALT`
    and `GITHUB_TOKEN` (a fine-grained PAT with Issues: read+write on this ONE
    repo, for the in-app bug report form — optional; the feature is off without
    it); there is no ESPN key.
11. **Docs are part of the change.** Any PR that changes behaviour updates
    `PLAN.md` / `CLAUDE.md` / `README.md` / `docs/OPERATIONS.md` **in the same
    PR** — not in a follow-up,
    because a follow-up is a promise and this file is supposed to be the thing
    you can trust without reading the code. `npm test` runs
    `tests/unit/docs.spec.ts`, which FAILS when the docs disagree with the code
    on the mechanical facts below:
    - every `ERROR_CODES` entry appears in PLAN §11, and every code named in §11
      exists in the enum;
    - `MAX_PAYOUT_CENTS`, `MIN_STAKE_CENTS`, `INITIAL_BANKROLL_CENTS`,
      `MAX_SETTLE_ATTEMPTS`, `LINE_STALE_MS`, `BET_CUTOFF_BUFFER_MS` and
      `SESSION_TTL_MS` match PLAN §3.1's constants-of-record table;
    - PLAN §5.8's teaser card equals `TEASER_PAYOUTS` **cell for cell**;
    - `VOID_AFTER_MS`, `MAX_PARLAY_LEGS`, `MIN_TEASER_LEGS` and
      `TEASER_POINTS_TENTHS` match that table too, as do the `wrangler.jsonc`
      vars `REFRESH_TARGETS_PER_RUN` and `SETTLE_CHUNK` against PLAN §9.1;
    - every cron expression in `wrangler.jsonc` appears in PLAN §9.1 **and** in
      `docs/OPERATIONS.md`;
    - every route literal in `src/worker/routes/*.ts` — every file in that
      directory, listed at test time, never a hard-coded list — at its mounted
      prefix, appears in PLAN §11;
    - every table AND every `CREATE TRIGGER` in `migrations/0001_init.sql` is
      named in PLAN §3 / §4;
    - the live URL is byte-identical in README, `docs/OPERATIONS.md`, CLAUDE.md and PLAN §15;
    - CLAUDE.md rule 9, the PR template, PLAN §16.1 and the `0001_init.sql`
      header all say `0001` is FROZEN and that changes are new numbered
      migrations;
    - the pre-PR gate command above is exactly what `package.json` runs;
    - the stale phrases `per-league bankroll`, `season rollover`,
      `ensureBankroll prelude`, `MIXED_LEAGUE_PARLAY is thrown`,
      `editable until` and `edit 0001 in place` appear nowhere in
      PLAN/CLAUDE/README/OPERATIONS except inside an explicit history or
      "superseded" note.
      The guard is deliberately mechanical. It cannot tell you the prose is
      _wrong_, only that a number, a code, a route or a table no longer exists —
      which is the drift that actually happens. Judgement is still the reviewer's
      job; see `.github/pull_request_template.md`.

---

## Platform constraints you will trip over

| Constraint                          | Value                                                                                            | Why you care                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker CPU per invocation (free)    | **10 ms**                                                                                        | No server-side heavy PBKDF2 (hence the split KDF, PLAN.md §10). No parsing a full CFB week in one go (hence per-ET-date ingest, §8.1).                                                                                                                           |
| `crypto.subtle` PBKDF2 iterations   | Cloudflare documents a 100,000 cap; local workerd 1.20260911 did NOT enforce it (measured in M3) | Design does not depend on it: the 10 ms CPU budget is why the heavy KDF runs in the browser. Server KDF is 1,000. Worker tests still use precomputed `dk` vectors.                                                                                               |
| D1 statements per invocation        | 50 (docs) / 1000 (2026 changelog)                                                                | `MAX_BATCH_STATEMENTS = 40` is the size of ONE `batch()`, not a per-invocation total. Chunk settlement at 20 bets. **Ingest is the deliberate exception**: ~172 statements (2 per game + 1 per line) across ~5 batches. See Spike S2.                            |
| D1 bound params per statement       | 100                                                                                              | A 10-leg parlay inserts legs as 10 separate statements, not one.                                                                                                                                                                                                 |
| D1 rows written per day (free)      | 100,000, **hard-enforced since 2026-09-01**                                                      | Past the cap D1 **errors**, which blocks bet placement and settlement. **Measured** ≈ 5.1k/day on a CFB Saturday with the §8.5 levers (L1 + the A/B split + L2 + L3); 33k for the `games` stream alone without the A/B split. Treat write budget as correctness. |
| D1 `INTEGER` column                 | i64; larger values silently become `REAL`                                                        | Never store a parlay rational.                                                                                                                                                                                                                                   |
| External subrequests per invocation | 50                                                                                               | We make ≤ 2 ESPN calls per cron run.                                                                                                                                                                                                                             |
| Cron triggers                       | min interval 1 min; docs say 5/account or 3/Worker                                               | We use exactly 3. Don't add a fourth without re-checking.                                                                                                                                                                                                        |

D1 `batch()` is atomic: sequential execution, full rollback if any statement
errors. That is the ONLY transaction you get.

---

## Layout

```
src/shared/   pure domain: types, odds, grading, espn parser, validation, time
src/worker/   Hono API + cron jobs + D1 access
src/worker/routes/  one file per API area; index.ts holds the route table
src/web/      React SPA: pages/, components/, state/ (contexts + pure reducers),
              hooks/ (useResource, usePages, useFocusTrap, useNow), lib/ (pure,
              DOM-free helpers), api/ (client, kdf, error copy)
public/       static files vite copies into dist/client as-is: the site icon
              (favicon.svg is the source; the PNG/ICO copies are generated by
              `npm run icons`) and site.webmanifest
migrations/   D1 schema. 0001 is FROZEN (applied to the remote D1 2026-09-14);
              every change is a new numbered 000N_*.sql (rule 9) — 0002 adds
              users.deleted_at, 0003 adds bug_reports, 0004 adds
              games.home/away_conference_id, 0005 rebuilds bets for 3–14-pt teasers,
              0006 adds bug_reports.diagnostics
tests/unit/   node-env tests for src/shared + docs.spec.ts (the docs-drift guard);
              fixtures.ts reads docs/samples via fs
tests/worker/ vitest-pool-workers tests with a real D1; fixtures.ts SYNTHESISES
              small slates (workerd has no fs, and the tsconfig project boundary
              does not span tests/unit)
tests/web/    node-env tests for src/web's PURE logic — slip reducer, payout
              preview, grouping, paging, edit re-pricing. No jsdom: the modules
              under test are deliberately DOM-free
docs/samples/ captured ESPN payloads (NFL 16 events, CFB 86) — read only by the
              unit project, and deliberately committed (PLAN.md §19 Q8) so the
              parser is tested against the real thing
docs/         teaser-odds.md — the sourcing behind TEASER_PAYOUTS
scripts/      fixture server, admin password tool, ledger reconcile, branch
              protection, icon rasteriser, teaser card generator
.github/      ci.yml (gate + gitleaks), deploy.yml, dependabot.yml (weekly grouped
              bumps; every one still gets CI + adversarial review), PR template
```

**Local dev gotcha**: `wrangler.jsonc` defaults `ESPN_BASE_URL` to real ESPN.
`.dev.vars` (copied from `.dev.vars.example`) overrides it to the local fixture
server. Without that file, `npm run dev` talks to production ESPN.

## Merge-conflict etiquette (multi-agent work)

- `src/shared/{types,api-types,errors,constants}.ts` are frozen after M2d;
  changes go through one PR owned by that track. **M5b was that PR** — the
  account-balance / cross-league / teaser contract change. What it added, and why
  no error code was removed or repurposed, is PLAN.md §16.1.
- `src/worker/index.ts` route table: add exactly one `app.route(...)` line.
- `src/worker/env.ts`: additive only.
- `src/worker/middleware.ts`, `db.ts` and `routes/admin.ts` are each touched by
  more than one milestone. M1 (or M4, for admin) lands every export stubbed;
  later milestones fill **only their own functions** and make no structural
  edits. See PLAN.md §16 for the per-file ownership table.
- `package.json` dependencies: raise it, don't add unilaterally.

## Operating the deployed app

Live: **https://spicybetting.wardcrazy01894.workers.dev**. The full runbook —
deploy, secrets, the schema-change policy, the ESPN User-Agent probe, the weekly
checks — is `docs/OPERATIONS.md`; this is the short version.

```bash
wrangler d1 migrations apply spicybetting --remote
wrangler secret put INVITE_CODE
wrangler secret put IP_HASH_SALT
wrangler secret put GITHUB_TOKEN   # turns on in-app bug reports (PLAN.md §11.7)
wrangler tail                      # live logs
npm run db:reconcile -- --remote   # assert SUM(ledger) === balance for every bankroll
```

Jobs can be kicked manually as an admin: `POST /api/admin/jobs/{refresh|settle|maintenance}`,
and one game's slate with `POST /api/admin/games/:id/refresh` (the Refresh button admins see on
each game card).
`GET /api/admin/jobs` shows the last 50 runs with stats, parser warnings and
auto-void decisions — check it first when something looks wrong. A refresh run's
`lineGaps` / `lineGapDetails` count the scheduled games whose DraftKings line is
missing a market or absent (PLAN.md §8.3); a market the book has pulled shows as
`off the board`, not as a parser failure.
`GET /api/admin/bugs` (and the Bug reports section of `/admin`) lists what users
filed through "Report a bug", including reports GitHub refused, each with the
browser's diagnostics log. `wrangler tail` shows one `[api]` line per failed or
slow request and one `[client-error]` line per browser crash — the "Logs"
section of `docs/OPERATIONS.md` is the key to the prefixes.

## Git identity

Commits and `gh` calls made by Claude run as `wardcrazy01894` via environment
variables (see the global CLAUDE.md). Don't set `git config user.*` in this repo.
Push remote should be `git@github-wardcrazy:wardcrazy01894/SpicyBettingSimulator.git`.
