# Operations runbook — SpicyBettingSimulator

Live: **https://spicybetting.wardcrazy01894.workers.dev** (Cloudflare Workers free plan, $0/month).
First deployed 2026-09-14. Everything below runs from a checkout of `main` with `wrangler` logged in
to the owner's Cloudflare account (`npx wrangler whoami`).

## Deploy

```bash
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build   # the gate
npx wrangler d1 migrations apply spicybetting --remote   # idempotent; applies anything pending
npm run deploy                                           # vite build + wrangler deploy
curl -s https://spicybetting.wardcrazy01894.workers.dev/api/health
```

**Automatic deploys:** `.github/workflows/deploy.yml` runs on every push to `main` (and via
"Run workflow"): `npm ci` → build the SPA → `wrangler d1 migrations apply --remote` → `wrangler deploy`
→ health check. It needs two repo secrets — `CLOUDFLARE_API_TOKEN` (dashboard: My Profile → API Tokens →
"Edit Cloudflare Workers" template, plus Account → D1 → Edit) and `CLOUDFLARE_ACCOUNT_ID`
(`npx wrangler whoami`) — set with `gh secret set <NAME>`. Until they exist the workflow fails at the
first wrangler step and the manual deploy above is the path. The `production` GitHub environment is
restricted to protected branches (only `main` can deploy), so "Run workflow" cannot ship an unreviewed
branch.

**Rollback rolls back CODE only.** `git checkout <previous sha> && npm run deploy` (or re-run the older
Deploy run) restores the Worker, but `wrangler d1 migrations apply` never un-applies. Two rules follow:
migrations must be **expand-only and backward-compatible** with the currently deployed code (add
nullable columns/tables now; drop or rename in a later deploy once no live code reads the old shape),
and a rollback leaves the newer schema in place, which the expand-only rule makes safe.

The one exception so far is `0005_bets_teaser_tiers.sql`, which recreates `bets`, `bet_legs` and
`ledger` with every row copied across (SQLite cannot alter a CHECK; PLAN §16.2 has the proof that no
gentler route exists on D1). It is still backward-compatible in the sense that matters: the new CHECK
accepts everything the old Worker writes, so rolling the code back after it is safe. **If
`npm run db:reconcile -- --remote` reports drift after a rebuild-style migration, do not hand-fix —
restore the database** with D1 Time Travel — point-in-time history that Cloudflare keeps for **7
days on the free plan** (30 on Workers Paid), so do it the same week:

```bash
npx wrangler d1 time-travel info spicybetting                         # current bookmark
npx wrangler d1 time-travel restore spicybetting --timestamp <ISO>     # or --bookmark <id>
```

Restore to just before the Deploy run's "Apply migrations" step, then fix the migration and re-run.

**A red Deploy run past the "Deploy the Worker" step means the new version IS live** (only the smoke
check failed). Roll back manually if the site is actually broken; the workflow does not auto-revert.

## Secrets (set once; rotate with the same command)

```bash
printf '%s' 'new-code'  | npx wrangler secret put INVITE_CODE    # shared signup code (one code for everyone)
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put IP_HASH_SALT   # rotating this resets IP throttle keys only
printf '%s' 'github_pat_…' | npx wrangler secret put GITHUB_TOKEN   # in-app bug reports + ops alerts → GitHub issues (optional)
printf '%s' 'odds-api-key…' | npx wrangler secret put ODDS_API_KEY   # secondary odds provider, The Odds API (optional)
```

`GET /api/health` reports `inviteRequired: true` once `INVITE_CODE` is set, and
`bugReportsEnabled: true` once `GITHUB_TOKEN` is. The values currently in use are in the
(gitignored) `.env.deploy.local` on the deploying machine.

**`GITHUB_TOKEN`** is a GitHub _fine-grained_ personal access token (Settings → Developer settings
→ Personal access tokens → Fine-grained), owned by `wardcrazy01894`, with **Repository access:
only `SpicyBettingSimulator`** and **Permissions: Issues → Read and write**, nothing else. Set an
expiry and put the renewal date in your calendar: when it lapses `POST /api/bugs` starts returning
`503`, the account page still shows the button (health only knows the secret is _set_), and the
reports pile up on `GET /api/admin/bugs` with `error: "GitHub responded 401"`. Rotate with the same
`secret put`. Never use a classic token or the `gh` CLI's OAuth token here — both are account-wide.

**`ODDS_API_KEY`** is The Odds API key from https://the-odds-api.com (free Starter tier, **500
credits a calendar month**, reset on the 1st). It turns on the SECONDARY odds provider (PLAN §21):
each refresh run may spend 3 credits per league to fill a spread, total or moneyline that
DraftKings-via-ESPN is missing on an NFL game or a top-25 CFB game. Without it the board is
primary-only and every refresh run's `stats.secondary.enabled` is `false`. Locally, `.dev.vars`
must ALSO set `ODDS_API_BASE_URL=http://127.0.0.1:8788` so `npm run dev` hits the fixture server
(which serves the committed samples with real credit headers) rather than the real API.

## Schema changes

`migrations/0001_init.sql` is **FROZEN**: it was applied to the remote D1 on 2026-09-14 and D1
recorded it in the `d1_migrations` table, so `wrangler d1 migrations apply` will never replay it.
From now on **never edit 0001** — every schema change is a new numbered `migrations/000N_*.sql`,
applied with the command above. An edit to `0001` reaches nothing and leaves the repo describing a
database that does not exist. Comment-only edits are fine. (History, so the rule is not
re-derived: before the first remote deploy `0001` WAS the live schema and was revised in place;
that window is closed. Same rule in CLAUDE.md rule 9, PLAN §16.1 and the file's own header.)

Applied migrations, newest last:

| File                               | What                                                                                                                                                                                                                                                      | Applied remotely                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_init.sql`                    | the whole schema                                                                                                                                                                                                                                          | 2026-09-14                                                                                                                                                                                                                                                                       |
| `0002_users_deleted_at.sql`        | `users.deleted_at INTEGER NULL` — account soft delete                                                                                                                                                                                                     | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0003_bug_reports.sql`             | `bug_reports` table + 2 indexes — in-app bug reports                                                                                                                                                                                                      | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0004_games_conference.sql`        | `games.home/away_conference_id TEXT NULL` — CFB board filter                                                                                                                                                                                              | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0005_bets_teaser_tiers.sql`       | REBUILDS `bets` + `bet_legs` + `ledger` (rows copied) to widen the teaser CHECK to 3–14 pt                                                                                                                                                                | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards                                                                                                                                                                                   |
| `0006_bug_reports_diagnostics.sql` | `bug_reports.diagnostics TEXT NULL` — the browser log a report attaches                                                                                                                                                                                   | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0007_secondary_odds.sql`          | `game_lines.{spread,total,ml}_book TEXT NULL`, `games.secondary_tried_at INTEGER NULL`, and the single-row `secondary_budget` table seeded at 500 credits (PLAN §21.3)                                                                                    | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0008_bet_legs_same_game.sql`      | REBUILDS `bet_legs` (rows copied; `bets` and `ledger` untouched) so `UNIQUE (bet_id, game_id)` becomes `UNIQUE (bet_id, game_id, market)`, plus the `bet_legs_bi_one_side_per_game` trigger — same-game parlays (PLAN §5.2c)                              | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards                                                                                                                                                                                   |
| `0009_mlb_league.sql`              | **Ships in the M12a PR** (with the code that writes `'mlb'`). REBUILDS `games`, `game_lines`, `bets`, `bet_legs`, `ledger` and `ingest_targets` (rows copied, ledger triggers recreated after the copy) to add `'mlb'` to four league CHECKs (PLAN §23.3) | on merge of M12a, by the Deploy workflow — count the rows first (below) and run `npm run db:reconcile -- --remote` afterwards                                                                                                                                                    |
| `0010_parlay_25_legs.sql`          | REBUILDS `bets` + `bet_legs` + `ledger` (rows copied, triggers recreated after the copy) so `bets.leg_count` allows 1–25 (parlays up to 25 legs) and a new CHECK holds a teaser to 10 legs (PLAN §16.2)                                                   | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards                                                                                                                                                                                   |
| `0011_ledger_refill_buyout.sql`    | REBUILDS `ledger` alone (rows copied, the five triggers recreated after the copy) so `ledger.kind` admits `deposit_refill` and `bust_buyout` — bust refills and badge buyouts (PLAN §4.5)                                                                 | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards                                                                                                                                                                                   |
| `0012_ingest_guard.sql`            | Four plain `ADD COLUMN`s on `ingest_targets` (`attempt_started_at`, `incomplete_attempts`, `last_ok_at`, `conference_id`) and the `alerts` table, with no rebuild (PLAN §24.4, §24.6b) — the poison-target guard and the in-app alerts (M13a)             | on merge to `main`, by the Deploy workflow                                                                                                                                                                                                                                       |
| `0013_basketball_leagues.sql`      | REBUILDS `games`, `game_lines`, `bets`, `bet_legs`, `ledger` and `ingest_targets` (rows copied, each table from its LAST definer, ledger triggers recreated after the copy) so four league CHECKs admit `'ncaab'` and `'nba'` (PLAN §24.9, M13c)          | on merge of M13c, by the Deploy workflow — **GATED**: only on a Tuesday or Wednesday, right after a refresh tick, and only after the write estimate below is under 60,000 rows (PLAN §24.9); above it, stop and ask the owner. Run `npm run db:reconcile -- --remote` afterwards |

(0003, 0004, 0005 and 0006 were written on parallel branches and numbered by reservation; wrangler
applies whatever is unapplied by name, so a gap or an out-of-order merge is not an error.)

**You do not normally run a migration by hand.** `.github/workflows/deploy.yml` runs
`wrangler d1 migrations apply --remote` on every push to `main`, BEFORE `wrangler deploy` — so
merging the PR that adds `0002` applies `0002` and then ships the code that needs it, in that
order, with no window in between. The order below is for a MANUAL deploy (or a hand-fixed one),
and getting it wrong is the failure mode worth naming:

```bash
npx wrangler d1 migrations apply spicybetting --remote   # adds users.deleted_at
npm run deploy
```

Order matters in that direction only: the new Worker's `SELECT`s and `UPDATE`s name
`deleted_at`, so deploying the code first would 500 every auth and admin request until the column
exists. The reverse is harmless — `0002` is a nullable `ADD COLUMN`, which the currently deployed
Worker neither reads nor writes, so the migration can go out minutes or days ahead of the code.
Confirm it landed:

```bash
npx wrangler d1 execute spicybetting --remote --command "SELECT name FROM pragma_table_info('users') WHERE name = 'deleted_at'"
```

Rollback note: there is no `DROP COLUMN` step and none is wanted. Rolling the Worker back to a
previous sha leaves the column in place and unused.

## Accounts

- The FIRST signup becomes admin. Signup needs the invite code.
- **Inviting someone**: `/admin` → Users → "Invite a friend" shows the join link
  (`/login?invite=<code>`) with Copy and Share buttons. It opens the signup form with the code
  filled in. It carries the shared code, so treat it like the code; rotating `INVITE_CODE`
  (above) kills every link already sent.
- Users rename themselves under Profile on `/account` (`POST /api/auth/display-name`). The
  display name is what the leaderboard shows; the username never changes (it salts the KDF).
- **Refresh one game**: admins see a Refresh button on every game card. It pulls that game's
  whole date slate from ESPN now (`POST /api/admin/games/:id/refresh`) and shows up in the Jobs
  tab as an admin-triggered refresh run.
- **Void one game**: on a SHORT basketball final's card (below regulation — the `undecidable`
  case; the card never offers it for MLB) and beside each game under a SETTLE run's `stuckGames`
  on the Jobs tab, admins see **Void game…**. That Jobs list can also hold a NULL-period MLB final
  (§23.6): that is missing data, so correct its `period` (the SQL under Basketball below) rather
  than void it. It cancels the game (`POST /api/admin/games/:id/void`, optional
  reason) so the next settle run voids every leg on it — the remedy for a stuck short basketball
  final (procedure under Basketball below). It moves no money itself. The route also accepts a
  scheduled, live, postponed or ordinary final game (voiding a scheduled game refunds its open
  bets on the next settle run, the same path as an ESPN cancellation); the buttons do not invite
  that, and a void cannot be undone — `canceled` is terminal in ingest, so ESPN's later result is
  ignored.
- Admin page: `/admin` in the SPA, four tabs — **Jobs** (run refresh / settle / maintenance by
  hand, last 50 runs), **Ledger** (reconcile), **Users** (disable, password reset, delete),
  **Bug reports**. The tab is in the URL (`/admin?tab=users`), so links to a section work.
- Reset a password from the CLI: `node scripts/admin-hash.mjs <username> <new-password>` prints a
  `wrangler d1 execute` statement to run with `--remote`.
- Adjust a balance: `POST /api/admin/users/:id/adjust {amountCents, memo}` (ledger row; cannot
  overdraft; `404` on a deleted account, like `/password` and `/disabled`).
- **Delete an account** (the Delete button on `/admin`, or
  `DELETE /api/admin/users/:id`): a SOFT delete. The account is disabled, stamped
  `users.deleted_at`, renamed to `deleted_<12 hex of its id>`, given the display name
  `Deleted user`, and has all its sessions dropped — one atomic batch. Afterwards it cannot log
  in (plain `401 INVALID_CREDENTIALS`, no "this account is disabled" tell), it is **off the
  leaderboard**, and its old username is free for someone else to register. It still appears in
  the admin user list with a `deleted` chip. Like every state-changing call it needs the
  `X-SBS-Client` header (`403 CSRF_BLOCKED` without it) — `curl` it with `-H 'X-SBS-Client: 1'`.
  - **No money moves.** Settled bets and every ledger row stay: the ledger is append-only by DDL
    and `bankrolls`/`ledger` are `ON DELETE RESTRICT`, so a hard delete would destroy the history
    `npm run db:reconcile` checks. Reconcile gives the same answer before and after.
  - **Refused with `409 ACCOUNT_HAS_PENDING_BETS` while the account has open bets** — cancel or
    settle them first, otherwise a payout would land in an account nobody can reach. Also refused
    for your own account, and for an admin while only one enabled admin remains (`400`).
  - The `deleted_` prefix is RESERVED: signup and login refuse it (`400 VALIDATION`), so nobody
    can squat an account's tombstone name and make it undeletable. If you ever see
    `409 USERNAME_TAKEN` from a delete, both the 12- and the 16-hex tombstone are occupied — find
    them and rename them, then delete again:

    ```bash
    npx wrangler d1 execute spicybetting --remote --command "SELECT id, username FROM users WHERE username LIKE 'deleted_%'"
    ```

  - Disabling alone is enough to get someone off the leaderboard; delete is for when you also want
    the username back.

## Logs

Two places, same lines: `npx wrangler tail` streams them live; the Cloudflare dashboard → Workers &
Pages → `spicybetting` → Logs keeps them (Workers Logs, `observability.enabled` in wrangler.jsonc;
the free plan retains a few days). Every line is prefixed so you can filter:

| Prefix                  | Written by                     | When                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[api]`                 | `requestLogMiddleware`         | any request with status ≥ 400 (with the error code, e.g. `409 LINE_CHANGED`) or slower than 1 s. Format: `METHOD path status CODE user=name ms`.                                                                                                                                                 |
| `[api] unhandled error` | `errorHandler`                 | a 500 — the only time a stack trace is logged. Since wrangler 4.150 (PR #71) `wrangler deploy` uploads source maps by default (stored with the version, never served); uncaught-exception traces are mapped to `src/`, and this line is a caught error, so its frames may still be bundle frames |
| `[client-error]`        | `POST /api/bugs/client-errors` | a browser hit an uncaught error; the line is that browser's diagnostics log (last errors, API calls, routes), at most one per 30 s per user                                                                                                                                                      |
| `[cron]`                | the scheduled handler          | every job run: name, status, error                                                                                                                                                                                                                                                               |
| `[bugs]`                | bug filing                     | GitHub refused a report, or the row could not be marked filed                                                                                                                                                                                                                                    |
| `[config]`              | `readConfig`                   | `GITHUB_TOKEN` (or `ODDS_API_KEY`) set but a var is missing — that feature stays OFF; or `ALERT_MENTION_LOGIN` is not a GitHub login — alerts mention nobody                                                                                                                                     |
| `[alert]`               | the in-app alerts (M13a)       | a job run recorded or sent an alert (its stats as JSON), a GitHub call failed (fingerprint, action, status — the run is still `ok`), or an evaluation threw and was contained (PLAN §24.6b)                                                                                                      |
| `[jobs]`                | `withJobRun`                   | a `job_runs` write, the reaper, or the alert-stats fold failed — the run itself still completed                                                                                                                                                                                                  |
| `[secondary]`           | the secondary odds sweep       | `unauthorized — check ODDS_API_KEY`; a malformed 2xx (schema drift); or a sweep that threw and was contained (the run is still `ok`; PLAN §21.9)                                                                                                                                                 |

```bash
npx wrangler tail --format pretty                    # everything, live
npx wrangler tail --search '[api]'                   # only failures and slow requests
npx wrangler tail --search '[client-error]'          # only browser crashes
```

Diagnosing a user's problem: ask them to press "Report a bug" (any page) — the issue carries
their diagnostics log — or find their `[api]` / `[client-error]` lines by `user=<name>`. No log line
carries a request or response body, a token or a password; `[client-error]` does carry the browser's
page path + query string and uuid-redacted API paths, which is the point of it.

## Bug reports

Users file bugs from the "Report a bug" button in the header, on every page while bug reports are enabled. Each
one is a `bug_reports` row AND a GitHub issue in this repo, labelled `bug` + `user-report`, titled
`[user report] …`, with the reporter's username, page, app version, time, browser and the browser's
diagnostics log (recent errors, API calls with status, page changes) in the body (PLAN §11.7). Five
per user per hour.

- **GitHub said no** (token expired/revoked, GitHub down): the reporter saw a 503, but the row is
  kept. `/admin` → Bug reports shows it with `not filed` and the GitHub error; the description is
  printed in full so you can open the issue by hand. Fix the token (see Secrets) — nothing retries
  on its own.
- **Feature off**: unset `GITHUB_TOKEN` (`npx wrangler secret delete GITHUB_TOKEN`) and the button
  disappears on the next page load; the route returns 503 to anyone who still has the form open.
- **Spam**: it is signed-in users only and rate-limited in the INSERT itself, PER ACCOUNT — so the
  ceiling is five issues an hour per account, times however many accounts the invite code has let
  in. Disable the account (`/admin` → Users) and, if it was a leaked invite code, rotate the code.
- **Ordering on first setup**: `secret put GITHUB_TOKEN` is safe to run before or after the deploy
  that ships the `GITHUB_REPO` var — with the token set and the var missing, the Worker logs
  `[config] GITHUB_TOKEN is set but bug reports are OFF` on every request and keeps serving. Check
  `wrangler tail` if the button never appears.

```bash
npx wrangler d1 execute spicybetting --remote --command "SELECT created_at, user_id, title, issue_number, error FROM bug_reports ORDER BY created_at DESC LIMIT 20"
```

## Data feed

- Source: ESPN's public scoreboard API (no key). Crons, exactly as `wrangler.jsonc` deploys them
  (PLAN §9.1): `*/3 * * * *` refresh (every 3 minutes, the refresh TICK), `1-59/3 * * * *` settle
  (one minute after each refresh tick), `30 8 * * *` maintenance (08:30 UTC) — ~960 cron
  invocations a day. Manual: `POST /api/admin/jobs/{refresh|settle|maintenance}` as admin.
- **The rhythm (since M13b, PLAN §24.7).** A slate with a game in progress or a kickoff within 3 h
  is refreshed on EVERY tick, in every league; within 48 h hourly; otherwise every 6 h; all final
  daily. Every cadence counts whole ticks from the tick's scheduled instant, so a live slate is
  claimed on consecutive ticks. One refresh run takes the most-due slate and adds more only while
  their summed game counts stay ≤ 40 (`REFRESH_WEIGHT_BUDGET`): a CFB Saturday or a slate never
  fetched before always runs ALONE; an NFL date and an MLB day share. Every fifth tick (:00 :15 :30
  :45) serves a non-live slate first, so next week's lines are discovered behind any live load.
  With two or three big live slates at once they take turns, each every 2nd or 3rd tick. A NEW date
  (the Sunday rollover burst, a midnight's new days) is due at its own discovery tick, one per tick
  from the next one, so the new week's dates appear over ≤ 2.5 h after 00:00 ET (≤ 1¾ h after the
  NFL's 20:00 ET) strictly behind live load, and live slates are never starved (one tick's slip is possible; PLAN §24.7) (PLAN §24.7, F2).
  With nothing live and nothing due — a fresh database, `npm run dev`'s first board load — new
  dates are due at once instead.
- Per-run work is capped by two `wrangler.jsonc` vars: `REFRESH_TARGETS_PER_RUN` (5: a COUNT cap
  under the weight budget above) and `SETTLE_CHUNK` (20 bets per settle). Do not raise
  `SETTLE_CHUNK` before PLAN Spike S2 is measured — see below.
- **Write budget at the 3-minute tick.** The worst day grows from ≈ 5,100 rows to ≈ 41–45k of the
  100,000 hard cap once basketball lands (PLAN §24.13; the CFB Saturday slate alone measured 7,922
  rows over 480 ticks in CI). **If `dayRowsWritten` passes 60,000, set `REFRESH_LIVE_TICKS` to 2**
  in `src/shared/constants.ts` (it halves the live stream; 5 restores the old 15 minutes) and
  deploy.
- **Verify after the M13b deploy** (PLAN §24.17): 30 minutes of `npx wrangler tail` show a refresh
  invocation on every 3-minute tick and a settle a minute after each; a live slate claimed on
  CONSECUTIVE ticks (its `coverage[]` entry in back-to-back runs on the Jobs page); an NFL and an
  MLB target in the SAME run's `coverage[]`. The next day, read `dayRowsWritten` and record it in
  the PR.
- **ESPN's edge filters on User-Agent, and the rule is opaque.** Measured 2026-09-14: no UA, an empty
  UA, `Mozilla/5.0 (compatible; …)`, a real Chrome UA, and the BARE product token
  `SpicyBettingSimulator/0.1` all get **403**; the token WITH the GitHub comment
  (`ESPN_USER_AGENT` in `src/worker/espn.ts`) gets 200 (12/12 live runs). Do not shorten or edit
  that string without re-running this probe:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -A 'SpicyBettingSimulator/0.1 (+https://github.com/wardcrazy01894/SpicyBettingSimulator)' \
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260914'   # expect 200
  ```

  If 403s reappear in `GET /api/admin/jobs` → `stats.failures[]`, run the probe first: if the
  laptop gets 200 with the same string, it is the Worker's shared egress IP being scored (what
  has been happening since 2026-11-08, PLAN §14.8), not the UA — nothing to change. Only if the
  probe 403s too, re-run it with candidate strings, change the constant, `npm run deploy`. A 403
  degrades gracefully (rows untouched). Since 2026-11-08 every 403 is retried once at once inside
  the same fetch: `stats.espnRecovered` counts the fetches that recovered (they are `'200'` in
  `espnStatus`), and `espnStatus['403']` counts only the ones the retry did not save.

- **Failure backoff (since F5, PLAN §8.4 / §14.8).** A slate whose fetch fails (403, 429, 5xx,
  timeout, bad JSON) retries on the **next tick**; only from the second consecutive failure does it
  back off — 15 min, 30, 60, 120, 240, then every 6 h — so a sustained outage costs at most 4
  fetches an hour per slate. ESPN's edge intermittently 403s the Worker's shared egress IP (2 of 13
  fetches on 2026-11-08, the same URLs 200 from a laptop); such an answer is first retried once
  inside the same fetch, and one that survives the retry costs a live slate one tick, not 15
  minutes. It opens NO alert: `espn-status` fires only at 3 consecutive failures on one target
  (≈ 18 min of failing), for 403 and 429 like every other outcome (since 2026-11-08; before that
  the first 403 alerted, and intermittent ones made the issue reopen for nothing). A
  `consecutive_failures` above 1 on the Jobs page is a real outage, not a blip. A date target that
  has never fetched OK (`last_ok_at` NULL — a brand-new date) is the exception: it retries on the
  15-minute discovery grid, never on a general tick, so a failed first fetch of a new day never
  takes a tick from the live slates (PLAN §24.7 (c)).

- **Swapped home/away (since 2026-11-08, PLAN §8.5, CLAUDE.md rule 8j).** ESPN re-publishes some
  neutral-site events with the two teams' `homeAway` exchanged between the day the event appears and
  game day. A game's orientation is fixed when its row is first inserted; a payload that arrives the
  other way round is swapped back onto the row before the upsert (scores, names, logos, ranks,
  conference ids and the line's spread/moneyline sides), so a bet leg's `side` keeps meaning the team
  it was placed on. The count is `stats.sidesReoriented` on the Jobs page (normally 0) and one
  `[ingest] … re-oriented onto stored sides` line in `wrangler tail`. A card that reads one team's
  abbreviation beside the other team's name and score is the symptom of a swap the code missed. Before
  the fix two rows had it (Houston–Cal and USC–Wichita State, 11-08); the repair was: swap the six
  side-field pairs (`home_name`/`away_name`, `_logo`, `_rank`, `_conference_id`, `_score`, never the
  team ids or abbrs) and the line's `spread_home_*`/`spread_away_*` and `ml_home_*`/`ml_away_*`, then
  put the ONE mis-graded bet back to `pending` (`status`, `payout_cents = NULL`, `settled_at`,
  `settle_run_id`, `settle_attempts = 0`) with its legs' `result`/`graded_at` NULL, and let the next
  settle run grade and pay it through the normal path. Do that only AFTER the fix is deployed, or the
  next refresh re-swaps the rows.
- Budget: `GET /api/admin/jobs` → newest run's `stats.dayRowsWritten` is the rolling 24 h rows-written
  total against D1's hard 100,000/day. Measured ≈ 8k for the CFB soak, modelled ≈ 17k with the
  fixed streams on a college Saturday at the 3-minute tick, ≈ 11k of it on the gauge (PLAN §24.13).
  The gauge EXCLUDES the job bookkeeping's own ≈ 5.8k/day (deferred, §24.13) and the request-path
  writes (bets, ledger, sessions: < 800/day), so read the 60,000 retreat line as ≈ 54,000 on the
  gauge. Basketball (M13c) measured 12,032 rows for a synthetic 155-game CBB day and 1,295 for a
  15-game NBA night (PLAN §24.13). A refresh run's `stats.offTheBoard` counts markets DraftKings
  pulled ("OFF"); since M13c they are counted there, never in `warnings`.
- **Board coverage:** ESPN carries exactly ONE book (DraftKings), so there is no in-feed fallback
  when a market is missing. Each refresh run records `stats.upcomingGames` (scheduled, not yet
  kicked off, in the slates it fetched), `stats.lineGaps` (how many of those have no line or are
  missing a market) with `noLine` / `noSpread` / `noTotal` / `noMoneyline` saying which,
  `stats.lineGapDetails` (`"HOU @ TTU: no total, no moneyline"`, capped at 20) and
  `stats.coverage[]`, the counts per target. **Read `coverage[]`, not the totals**: a refresh run
  usually fetches today's date AND a discovery date later in the week where nothing is posted yet,
  so the run total mixes the two. Discount `noMoneyline` — heavy favourites have none at any book.
  A warning reading `off the board` means DraftKings has pulled that market (its feed says the
  literal `OFF`, usually an injury / QB question or a number under review) — a book decision, not a
  feed regression, and it usually comes back before kickoff. A full pull NULLs the stored row on
  that refresh, so the game stops being bettable immediately rather than 3 h later. `unusable` is
  the word for a genuinely malformed value and IS worth a look. Read a few Saturdays of the live
  date's `lineGaps` before deciding whether a second odds provider (PLAN §2.4) is worth its request
  budget; obscure CFB games with no line all week are the expected bulk of it.
- **The board window ends on Monday (PLAN §22).** The board and the ingest planner stop at the end
  of the Monday ET date that closes the football week (weeks run Tuesday–Monday), never ten days
  out. Each league rolls over to NEXT week's slate at a fixed ET instant on Sunday — **CFB at
  Sunday 00:00 ET** (Saturday's games are done), **NFL at Sunday 20:00 ET** (the early and late
  windows are done) — and stays there through Monday. So "why did next week's games disappear?" on a
  Friday is the rule working: next week's college games appear Sunday morning, the NFL's Sunday
  night, and MNF plus next week are what Monday shows. **Next week's dates are not ingested either
  until the rollover**: the planner creates an `ingest_targets` row only for dates inside the
  window, so `games` having nothing for next week on a Friday is correct, not a stalled feed. (Only
  targets that already exist keep refreshing outside the window — the one-off tail of 10-day-out
  targets from before this rule, which ages out within ~12 days of its deploy.) Right after a
  rollover the new week fills in over about 1–4 hours: at most two dates per refresh run, one of
  them through the reserved discovery slot, so a sparse board at 00:15 ET on a Sunday is expected,
  not a stall — `GET /api/admin/jobs` shows the dates being
  taken, and the per-game Refresh button jumps one date to the front. `GET /api/games/:id` is
  deliberately unwindowed so a bet placed on a game the list no longer shows still renders and edits.
- **Provider-name drift (seen 2026-09-17).** ESPN served DraftKings as `Draft Kings` for a day,
  which wrote a second `game_lines` row per game under that string. The ingest now keys the
  primary on ESPN's provider id (always `DraftKings`), and the merge ranks provider strings
  normalised, so the variant rows are harmless — but they never get re-confirmed and sit stale.
  One-off cleanup, SELF-GUARDING: a variant row is deleted only when the canonical `DraftKings` row
  for the same game is at least as fresh, so running it too early (before a refresh has re-stamped
  the canonical row — up to ~2 h after the fix deploys) deletes nothing rather than the only fresh
  line on a Saturday. Run it once, then again a few hours later:
  `npx wrangler d1 execute spicybetting --remote --command "DELETE FROM game_lines WHERE provider = 'Draft Kings' AND EXISTS (SELECT 1 FROM game_lines c WHERE c.game_id = game_lines.game_id AND c.provider = 'DraftKings' AND c.seen_at >= game_lines.seen_at)"`.
  Note the fix makes drift UNDER id 100 silent by design (a warning per game per refresh would
  flood the cap), so `SELECT DISTINCT provider FROM game_lines` only catches a variant that also
  arrives without id 100 — a third spelling there is the same bug in a new coat, handled by the id
  mapping in `src/shared/espn.ts`.
- **The secondary odds provider (PLAN §21).** ESPN carries one book, so when DraftKings is
  missing a market on an NFL game or a top-25 CFB game, the refresh job asks The Odds API for it
  (draftkings first, then fanduel, betmgm, betrivers, bovada) and writes ONE `game_lines` row per
  game with `provider='odds-api'` and the book named per market; the board and placement merge it
  under the primary, and a leg on such a market records `odds-api:<book>`. Every refresh run —
  cron, "Run refresh", and the per-game Refresh button (which waives that game's 4 h retry
  backoff) — reports `stats.secondary`: `enabled`, `remaining` (credits, from the provider's own
  header), `budgetSkipped`, and one entry per swept league (NFL and NCAAF — MLB is primary-only) saying `retry` / `resweep` / `forced` with the
  cost and what it filled, or `skipped: no-gap | throttled | budget | cooldown | no-budget-row`.
  Guards you should never see tripped: a sweep is refused below a reserve of 25 credits, at most
  once per 2 h per league, and not at all during the 1–8 h cooldown a 429 or 5xx sets. A FREE probe
  (`GET /v4/sports`, 0 credits) re-reads the balance daily while the reserve blocks and right after
  a failed sweep, so the monthly reset is noticed without any date arithmetic and an outage costs
  ~0 credits. If `remaining` sits under 25 for days: the month is spent; nothing is broken and the
  board is primary-only until the 1st. If `last_status` in `secondary_budget` reads `unauthorized`:
  the key was revoked — `wrangler secret put ODDS_API_KEY` again. A ranked game whose two feeds
  disagree on home/away (neutral sites) is refused on purpose and named under `swapped`.
- **MLB (M12, PLAN §23; board live since M12a; MLB betting OPEN since M12b).** One ingest target
  per US-Eastern day, id `mlb:date:YYYYMMDD`, created by the first refresh after 00:00 ET — the
  MLB board shows TODAY only, so tomorrow's games appear at midnight, not when DraftKings posts
  them — which loses nothing, because ESPN carries MLB lines on game day only (measured
  2026-09-24: none of 2026-09-25's 16 games had one the afternoon before). **Empty price cells
  before ~noon ET are expected**; read the target's row in `stats.coverage[]` (`lineGaps`) before
  assuming a parser failure. MLB is **primary-only**:
  `stats.secondary.sweeps` never has an MLB entry, by design. **MLB betting is open**; the kill
  switch is `LEAGUE_BETTING_OPEN` in `src/worker/bets.ts` — set `mlb: false` and deploy, and the
  board shows `bettable: false` while `POST /api/bets` answers `409 GAME_NOT_BETTABLE` for an MLB
  leg (open bets still settle). An MLB leg in a teaser is refused with `400 TEASER_INVALID`.
  **The void rule** (PLAN §23.6/§23.7): a final that went 9+ innings (extras included) grades
  every market; a final called in innings 5–8 grades the moneyline, VOIDS the run line, and grades
  the total only if it was already decided (runs strictly over the line; otherwise void); a final
  under 5 innings voids everything. A final with no inning count (`period` NULL, never observed)
  is held pending and reaches settle's `stuck[]`. A rained-out game reads `postponed` all day and
  is voided by the NEXT morning's maintenance run (`stats.autoVoidedGames`, `status_detail`
  `auto-void: MLB postponed, not played on its date`) — but only once a SUCCESSFUL refresh of its
  own date at or after 03:00 ET still saw it postponed (the planner schedules that fetch); the
  settle run after it refunds the stakes. If that 03:00 fetch failed, the void is simply a day
  late, never wrong. `canceled` is terminal: a later refresh can never un-cancel a game. The
  makeup is a separate game under a new id. **`stats.mlbRescheduled[]`** on a maintenance run
  names any MLB game whose current start is on a different ET date from its original one
  (`originalDate` → `currentDate`) — never observed (makeups get new ids), so a row there is worth
  a look: its bets will grade on the rescheduled game rather than void. Before merging M12a, size the 0009 rebuild against the daily write cap (each row is
  written twice plus its indexes):
  `npx wrangler d1 execute spicybetting --remote --command "SELECT (SELECT COUNT(*) FROM games) AS games, (SELECT COUNT(*) FROM game_lines) AS lines, (SELECT COUNT(*) FROM bets) AS bets, (SELECT COUNT(*) FROM bet_legs) AS legs, (SELECT COUNT(*) FROM ledger) AS ledger, (SELECT COUNT(*) FROM ingest_targets) AS targets"`.
  **Deploying M12a (0009) — verify the rebuild before M12b opens betting:** run the count above;
  merge right after a refresh tick (:00 :15 :30 :45) completes — watch `npx wrangler tail` — since
  the Deploy workflow applies 0009 only after its install, gate and build steps (its last four runs
  took 78–87 s end to end), so the apply lands well before the next tick and clear of the settle
  ticks (:05 :20 :35 :50); after
  the deploy, `npm run db:reconcile -- --remote` must be clean and `npx wrangler tail` on the next
  refresh must show the `mlb:date:<today>` target fetched with no CHECK error. Only then merge
  M12b. The first postseason morning (Wild Card, 2026-09-29): check the `mlb:date:20260929` row in
  `coverage[]`; if it is missing, `stats.failures[]` names the target, and the Refresh button on
  any MLB game card (`POST /api/admin/games/:id/refresh`) or `POST /api/admin/jobs/refresh`
  forces it.
- **January (postseason):** verify a `dates=` target returns bowl / NFL playoff games (PLAN Spike S4(c)).
  If not, add the `seasontype=3` companion target described in PLAN §8.2.

- **Basketball (since M13c, PLAN §24).** Two more leagues, `ncaab` (every Division I men's game,
  `groups=50`) and `nba`, each one target per ET date: three `ncaab:date:*` (today + 2) and two
  `nba:date:*` (today + 1) in `coverage[]`. **Basketball betting is OPEN since M13d
  (2026-11-07).** The kill switch is `LEAGUE_BETTING_OPEN` in `src/worker/bets.ts`, one key per
  league — `nfl`, `ncaaf`, `mlb`, `ncaab`, `nba` — set one `false` and deploy, and that board shows
  `bettable: false` while `POST /api/bets` answers `409 GAME_NOT_BETTABLE` for its legs (open bets
  still settle). No teasers and no secondary sweeps, ever. A final
  has action on every market, overtime included — EXCEPT a final short of regulation (NBA
  `period` < 4, college < 2: an abandoned game), which is held `undecidable`: the bet stays
  `pending`, reaches `stats.stuck[]` after `MAX_SETTLE_ATTEMPTS`, and the `settle-stuck` alert
  opens a GitHub issue (PLAN §24.11). **Procedure for a stuck short final** — decide from the box score, then either VOID it, so
  the next settle voids every leg on that game (a straight is refunded; a parlay drops the leg
  and grades the rest at the reduced price), or correct the period (below). **To void, use the
  app:** as an admin, press **Void game…** on the game's card (shown on a short basketball final's card) or
  beside the game id under the settle run's `stuckGames` on the Jobs tab of `/admin`, give a
  reason (optional; it defaults to "abandoned game") and confirm. That is
  `POST /api/admin/games/:id/void` (PLAN §11.6): one guarded UPDATE to `canceled` with
  `status_detail = 'admin void: <reason>'` and `updated_at = now`, answering with how many
  pending bets ride on the game; an already-canceled game is refused with `400 VALIDATION`.
  (`retry-settlement` is no substitute — it would regrade the same short final.) **Fallback,
  only if the app is unreachable** — the same statement by hand:

  ```bash
  npx wrangler d1 execute spicybetting --remote --command "UPDATE games SET status = 'canceled', status_detail = 'admin void: abandoned game', updated_at = unixepoch() * 1000 WHERE id = 'ncaab:<espnEventId>' AND status = 'final'"
  ```

  or, if ESPN under-reported the period and the game WAS complete, correct it so it grades
  (`period = 4` for the NBA):

  ```bash
  npx wrangler d1 execute spicybetting --remote --command "UPDATE games SET period = 2, updated_at = unixepoch() * 1000 WHERE id = 'ncaab:<espnEventId>' AND status = 'final'"
  ```

  **`updated_at` is the part that matters**: the settle job re-selects a bet past
  `MAX_SETTLE_ATTEMPTS` only when the game row's `updated_at` is newer than its last attempt
  (`RESET_DEFERRED_SQL`), and nothing bumps that column but an explicit SET — without it the bet
  stays in `stuck[]` for good. (`unixepoch() * 1000` on D1 = `1794110373000`, verified against the
  local D1 on 2026-11-08; `CAST(strftime('%s','now') AS INTEGER) * 1000` is the same.) Then the next
  settle tick finishes it; confirm with `npm run db:reconcile -- --remote`. The void branch is the
  safe default: `canceled` is terminal in the ingest upsert, so ESPN cannot flip it back. The
  period-correction branch is only reliable once ESPN itself shows the corrected period or the
  date target has left the window — until then the next refresh writes the short period back and
  the bet returns to `undecidable`. (If `wrangler d1 execute --remote` answers 7403, `npx wrangler
login` first — the token is stale.)
  A postponed game is voided the next morning on the
  MLB evidence rule (`auto-void: NCAAB postponed, …` / `auto-void: NBA postponed, …`). A college
  game first seen on its own ET day has no conference ids (ESPN drops `conferenceId` on game day) —
  expected, not a bug.

  **Before merging M13c — the 0013 write gate.** Count the rows (the query above), then compute
  `7·games + 3·lines + 6·bets + 7·legs + 7·ledger + 4·targets` — the per-row cost
  `tests/worker/migration-0013.spec.ts` measured (D1's own counter agreed with the formula within
  0.35% on a 10,078-game seed, which wrote 107,827 rows). **Under 60,000: merge on a Tuesday or
  Wednesday, right after a refresh tick. Over 60,000: stop and ask the owner** (the remedies,
  pruning old `games` or paid D1, are not the deploy's to choose). After the deploy:
  `npm run db:reconcile -- --remote` must be clean, and the D1 dashboard's rows-written for the day
  goes in the PR.

  **The first basketball day after the deploy.** `npx wrangler tail` on the next refreshes must
  show `ncaab:date:<today>` and `nba:date:<today>` fetched with no CHECK error, and a college slate
  run ALONE (it weighs big). Record **Spike S7** for every basketball target over the first weekend:
  `cpuTime` from `wrangler tail --format json` against the slate's game count in `coverage[]`.
  **If a D-I target PARKS or any `ncaab` refresh reports `exceededCpu`, flip the per-conference
  switch**: `NCAAB_TARGET_SHAPE = 'conference'` in `src/worker/ingest.ts`, a one-line reviewed PR,
  no migration (PLAN §24.8). On the first big Saturday also read `wrangler tail` for a D1 error on
  the ~430-statement college refresh (Spike S2's exit). `stats.offTheBoard` counts pulled ("OFF")
  markets — on a college slate full of 30-point favourites it is routinely non-zero, and it is not
  a parser failure.

  **The first basketball day after M13d (betting open).** Close the M13d verification gate (PLAN
  §24.17): Spike S7 shows a college slate of at least 60 games finishing `outcome: ok` with no park,
  and one final of EACH league settles end to end — find a settled `ncaab` and `nba` bet in
  `GET /api/admin/jobs` (the settle run's stats) — followed by a clean
  `npm run db:reconcile -- --remote`. On the first big Saturday also read the board payload
  (§24.14): `/api/games?league=ncaab` in the browser's network tab should be under ~300 KB raw and
  well under `BOARD_MAX_GAMES` (300); if it is not, or the GET's `cpuTime` in `wrangler tail`
  nears the refresh runs' 30 ms, the client moves to one ET day per request (`from` / `to`) — no
  contract change. If anything misbehaves, close the league with its kill-switch key above.

## Checks

```bash
npm run db:reconcile -- --remote        # SUM(ledger) vs balance for every account; exit 1 on drift
npx wrangler tail                       # live logs (cron runs, errors)
npx wrangler d1 execute spicybetting --remote --command "SELECT job, status, started_at FROM job_runs ORDER BY started_at DESC LIMIT 10"
npx wrangler d1 execute spicybetting --remote --command "SELECT remaining_credits, checked_at, cooldown_until, consecutive_failures, last_status FROM secondary_budget"   # weekly: the free tier is 500/month
```

A settle run that could not settle a bet records `status='error'` with the stats intact; the bet is
retried automatically (`settle_attempts`) and parked in `stats.stuck[]` after `MAX_SETTLE_ATTEMPTS`
(480 × the 3-minute settle cadence = 24 h).

A parlay or teaser settles `lost` as soon as ONE leg loses, without waiting for its other games
(PLAN §7.1b). The settle run counts these in `stats.earlyLost`. The legs it left open stay ungraded
until their games finish, and later runs fill them in: `stats.legsGraded` counts those, with no
money moved.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens bump PRs weekly on Monday morning ET: one grouped PR
for minor/patch npm bumps, one per major, one for the Cloudflare toolchain (`wrangler` and
`@cloudflare/*`), and one for all GitHub Actions. Each is a normal PR — CI plus an adversarial
review before merge; nothing auto-merges.

**A bump PR that fails `npm ci` with `ESTRICTALLOWSCRIPTS`** has pulled in a package with an
install-time script that `package.json`'s `allowScripts` does not name (CLAUDE.md rule 12;
`.npmrc` makes the check strict). That is the policy working, not a flake: read the package's
`postinstall`, and if it is what it says it is, `npm approve-scripts --no-allow-scripts-pin <pkg>`
on the PR branch and push. The three names already there — `esbuild`, `workerd`, `fsevents` — cover
every native binary the toolchain fetches today, so a Cloudflare-group bump should never trip it on
its own; a NEW name is the thing to look at.

Reviewing a Cloudflare-group PR means checking two constraints, both in PLAN §15: `compatibility_date`
in `wrangler.jsonc` must not be newer than the workerd bundled with `@cloudflare/vitest-plugin`
(the plugin refuses it with `ERR_RUNTIME_FAILURE` and `npm run test:worker` fails; a date later than
today's fails differently, `ERR_FUTURE_COMPATIBILITY_DATE`), and the plugin's `peerDependencies` pin
the `vitest` major. If a plugin bump widens that peer to a vitest major we currently ignore, the PR
arrives red and the fix is to lift the `vitest` ceiling in BOTH `dependabot.yml` and PLAN §15 — not
to rerun CI.

And one thing CI will never flag again, because `allowScripts` names `esbuild`, `workerd` and
`fsevents` without a version: whether the bumped version's install script is still the one-line
binary fetch it has always been. On a Cloudflare-group or minor/patch PR that moves any of those
three, run `npm view <pkg>@<new version> scripts` and compare it with the previous version's — but
know that the field is a fixed wrapper (`node install.js` for esbuild and workerd, `node-gyp rebuild`
for fsevents) that will read identically on every bump, so the real check is the referenced file:
open the new version's `install.js` on npmjs.com or unpkg and skim what it does. One that does
anything other than fetch its own binary is the review finding.

`package.json` has no `overrides` block today, and `tests/unit/docs.spec.ts`
fails if one appears without a `POOL_OVERRIDES` row (PLAN §15). The case it
exists for: a dev-only vulnerability in a package that the vitest plugin's
miniflare pins exactly and no plugin release has moved yet (the old
`vitest-pool-workers` did this for `sharp` and `undici`). The fix then is an
override SCOPED to `@cloudflare/vitest-plugin → miniflare → <pkg>` — it can only
ever touch that one path — plus a table row. When the next
`@cloudflare/vitest-plugin` bump lands, ask npm what its miniflare wants on its
own — `npm view miniflare@<version pinned by the plugin> dependencies.<pkg>` —
and once that is at or past the patched version, delete the override in the
same PR (`npm ls <pkg>` shows "overridden" while it is in effect, which is the
proxy, not the answer). A stale override would silently pin a future
requirement back to the old version, which is the reason to remove each one at
the first opportunity. You will not have to remember: the guard reads what the
plugin's miniflare wants and FAILS CI on the plugin-bump PR until the override
is deleted (and fails the reverse, if an override goes while the pin is still
vulnerable).

Security-only updates are enabled separately in the repo settings. They arrive as their own
ungrouped PRs, outside `open-pull-requests-limit`, and the `ignore` rules apply to them too: a
vulnerability fixed only in an ignored major produces no PR and stays visible only in the Security
tab, which is worth a look when the weekly PRs are reviewed.

## Uptime monitor and alerts (since M13a, PLAN §24.5 / §24.6b)

Two complementary alarms. The code is live from the M13a deploy; the monitor and the mention are
operator steps, done once, the day M13a merges.

**Expect one-time alerts on the first runs after the M13a deploy, and do not read them as a
regression.** Each job's first run reaps its own historical `running` rows (runs killed before
M13a existed) into one `job-error` issue for that job — up to three issues, `refresh`, `settle`
and `maintenance`; an existing `stats.stuck[]` or an exhausted secondary budget
opens its issue on the first settle or refresh. Read them, confirm the @mention email arrived and
that the `ops-alert` label is on the issue, and close them — that is the recipient check happening
by itself.

- **External monitor** (it catches everything dead at once: a cron outage, a broken deploy, D1
  unreachable). Create a free UptimeRobot-class HTTP monitor on
  **`https://spicybetting.wardcrazy01894.workers.dev/api/health/ingest`**, interval 5 minutes,
  alerting on any non-200 by email to the owner. It answers `200` with `ok: true`, or `503` with
  `reasons[]` saying why: `refresh-stale` (no refresh run recorded `ok` within 5 refresh ticks —
  **15 minutes** since M13b; it was 75 under M13a's 15-minute cron), `targets-parked`,
  `espn-all-failing`. The
  body also carries `lastRefreshOkAt` and `parkedTargets`. One read, nothing written. The first
  check after the M13a deploy must be 200. `/api/health` itself stays 200 and DB-free; do not point
  the monitor there.

  ```bash
  curl -s -w '\n%{http_code}\n' https://spicybetting.wardcrazy01894.workers.dev/api/health/ingest
  ```

- **In-app alerts** (detail, and a dead refresh seen by the next settle run): GitHub issues labelled
  `ops-alert`, titled `[alert] <kind>: <key>`, opened with `GITHUB_TOKEN` (OFF without it: every
  job still records the alert rows and reports `stats.alerts.enabled: false`, and nothing is
  posted). One issue per incident; comments back off 1 h → 2 → 4 → 8 → 16 → 24 h; closed after 6
  quiet hours; reopened (not duplicated) if it recurs within 24 h. Kinds: `refresh-stale`,
  `target-parked`, `job-error` (including a run the reaper found killed), `espn-status` (any ESPN
  outcome — `403` / `429` / `5xx` / `timeout` / `network` / `bad-json` — after 3 in a row on one
  target, ≈ 18 min of failing; a single 403 or 429 no longer alerts, since 2026-11-08),
  `espn-all-failing`, `settle-stuck` (one issue for every stuck bet),
  `secondary-budget-exhausted`, `d1-rows-near-cap` (rolling 24 h ≥ 60,000 rows: the instruction to
  set `REFRESH_LIVE_TICKS` to 2). At most 2 GitHub calls per job run; a GitHub
  failure is logged as `[alert]` and never fails the job.

  **The @mention is what sends the email.** `GITHUB_TOKEN` belongs to `wardcrazy01894`, the repo's
  own account, and GitHub never notifies an account of its own activity, so without a mention
  nobody is emailed. The `wrangler.jsonc` var `ALERT_MENTION_LOGIN` (not a secret) is `alancast`.
  The issue body, every throttled comment and every reopen start with `@alancast`; the closing
  comment does not. That account needs GitHub notification setting "Participating, @mentions and
  custom → Email" on. Watching the repo (Watch → Custom → Issues) also works, but only for an
  account other than the token's. Empty = no mention.

  **Recipient check, once after the M13a deploy:** force one alert and confirm the email arrives.
  Plant a firing alert row, then run any job from `/admin` → Jobs (its evaluation creates the issue
  within that run); the issue's body must begin with `@alancast` and the email must arrive. The row
  goes quiet on its own and the issue closes itself 6 hours later.

  ```bash
  npx wrangler d1 execute spicybetting --remote --command "INSERT INTO alerts (fingerprint, kind, key, state, opened_at, last_seen_at, occurrences, pending, last_detail) VALUES ('job-error:recipient-check', 'job-error', 'recipient-check', 'firing', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, 1, 1, 'M13a recipient check (OPERATIONS.md)')"
  ```

  ```bash
  npx wrangler d1 execute spicybetting --remote --command "SELECT fingerprint, state, issue_number, occurrences, pending, comments, last_seen_at FROM alerts ORDER BY last_seen_at DESC"
  ```

## Parked target (since M13a, PLAN §24.4)

A refresh target whose invocation was killed (CPU) three times in a row is **parked**: the scheduler
skips it, `GET /api/admin/jobs` shows it in the newest refresh run's `stats.parked` (and as a banner
on the Jobs page), the ingest health route answers 503 `targets-parked`, and a `target-parked` alert
opens. Every other league keeps refreshing. A target is stamped immediately before its own fetch
and both reschedules clear the stamp, so only an invocation that DIED mid-target (CPU or wall
limit, an evicted isolate) leaves `ingest_targets.incomplete_attempts` raised; an ESPN error or
timeout is an ordinary failure with its own backoff. A target with one strike already runs alone
on its next claim. The killed run's `job_runs` row turns from `running` to `error` ("no finish
recorded: killed …") on the next run of that job at least 15 minutes later.

1. `npx wrangler tail --format json` and look for `exceededCpu` on refresh invocations. That
   confirms a CPU kill rather than a crash.
2. It retries on its own once every 6 hours. A transient spike heals with no action.
3. To retry now, press **Refresh** on any game card of that slate (it un-parks the target and runs
   it). If the slate is genuinely too big, that admin request dies too (Cloudflare's 1102 page).
4. If it keeps parking: for a college-basketball date, the pre-sized fix is the per-conference
   switch (`NCAAB_TARGET_SHAPE = 'conference'`, PLAN §24.8), a one-line PR. Otherwise take PLAN §17
   R1's ladder.
5. Bets on a parked slate stay pending; nothing pays wrongly. §7.5's 7-day void is the backstop.

## Open measurements (PLAN Spikes S1 / S2)

S1 is measured (below). S2 is not blocked: it wants a deployed Worker, which exists. Until somebody
reads it, `SETTLE_CHUNK` stays at 20.

```bash
npx wrangler tail --format json    # one JSON line per invocation; it carries `cpuTime` (ms)
# in another shell, as an admin, force one ingest on a Saturday ET date target:
curl -s -X POST -b "$COOKIE" -H 'X-SBS-Client: 1' \
  https://spicybetting.wardcrazy01894.workers.dev/api/admin/jobs/refresh
```

- **S1 (CPU): MEASURED 2026-11-07.** Refresh runs used 30 ms and 34 ms (wall 2.8–3.1 s), settle
  8 ms, API GETs 1–10 ms, all `outcome: ok`, against a documented 10 ms. The real limit has unknown
  leeway, so watch for `exceededCpu` in the tail rather than for a number. **S7** (PLAN §24.18)
  repeats this for each college-basketball slate as the slates grow, from M13c.
- **S2 (D1 statement accounting)**: the same tail shows whether a `batch()` of 60 statements errors,
  and `outcome` distinguishes "exceeded limits" from an application failure.
- **S4(c)**: the January postseason check above.
