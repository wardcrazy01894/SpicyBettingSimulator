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
printf '%s' 'github_pat_…' | npx wrangler secret put GITHUB_TOKEN   # in-app bug reports → GitHub issues (optional)
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

| File                               | What                                                                                                                                                                                                                         | Applied remotely                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `0001_init.sql`                    | the whole schema                                                                                                                                                                                                             | 2026-09-14                                                                                     |
| `0002_users_deleted_at.sql`        | `users.deleted_at INTEGER NULL` — account soft delete                                                                                                                                                                        | on merge to `main`, by the Deploy workflow                                                     |
| `0003_bug_reports.sql`             | `bug_reports` table + 2 indexes — in-app bug reports                                                                                                                                                                         | on merge to `main`, by the Deploy workflow                                                     |
| `0004_games_conference.sql`        | `games.home/away_conference_id TEXT NULL` — CFB board filter                                                                                                                                                                 | on merge to `main`, by the Deploy workflow                                                     |
| `0005_bets_teaser_tiers.sql`       | REBUILDS `bets` + `bet_legs` + `ledger` (rows copied) to widen the teaser CHECK to 3–14 pt                                                                                                                                   | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards |
| `0006_bug_reports_diagnostics.sql` | `bug_reports.diagnostics TEXT NULL` — the browser log a report attaches                                                                                                                                                      | on merge to `main`, by the Deploy workflow                                                     |
| `0007_secondary_odds.sql`          | `game_lines.{spread,total,ml}_book TEXT NULL`, `games.secondary_tried_at INTEGER NULL`, and the single-row `secondary_budget` table seeded at 500 credits (PLAN §21.3)                                                       | on merge to `main`, by the Deploy workflow                                                     |
| `0008_bet_legs_same_game.sql`      | REBUILDS `bet_legs` (rows copied; `bets` and `ledger` untouched) so `UNIQUE (bet_id, game_id)` becomes `UNIQUE (bet_id, game_id, market)`, plus the `bet_legs_bi_one_side_per_game` trigger — same-game parlays (PLAN §5.2c) | on merge to `main`, by the Deploy workflow — run `npm run db:reconcile -- --remote` afterwards |

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
- Users rename themselves under Profile on `/account` (`POST /api/auth/display-name`). The
  display name is what the leaderboard shows; the username never changes (it salts the KDF).
- **Refresh one game**: admins see a Refresh button on every game card. It pulls that game's
  whole date slate from ESPN now (`POST /api/admin/games/:id/refresh`) and shows up in the Jobs
  tab as an admin-triggered refresh run.
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

| Prefix                  | Written by                     | When                                                                                                                                             |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[api]`                 | `requestLogMiddleware`         | any request with status ≥ 400 (with the error code, e.g. `409 LINE_CHANGED`) or slower than 1 s. Format: `METHOD path status CODE user=name ms`. |
| `[api] unhandled error` | `errorHandler`                 | a 500 — the only time a stack trace is logged                                                                                                    |
| `[client-error]`        | `POST /api/bugs/client-errors` | a browser hit an uncaught error; the line is that browser's diagnostics log (last errors, API calls, routes), at most one per 30 s per user      |
| `[cron]`                | the scheduled handler          | every job run: name, status, error                                                                                                               |
| `[bugs]`                | bug filing                     | GitHub refused a report, or the row could not be marked filed                                                                                    |
| `[config]`              | `readConfig`                   | `GITHUB_TOKEN` (or `ODDS_API_KEY`) set but a var is missing — that feature stays OFF                                                             |
| `[secondary]`           | the secondary odds sweep       | `unauthorized — check ODDS_API_KEY`; a malformed 2xx (schema drift); or a sweep that threw and was contained (the run is still `ok`; PLAN §21.9) |

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
  (PLAN §9.1): `*/15 * * * *` refresh (:00 :15 :30 :45), `5-59/15 * * * *` settle (:05 :20 :35
  :50), `30 8 * * *` maintenance (08:30 UTC). Manual:
  `POST /api/admin/jobs/{refresh|settle|maintenance}` as admin.
- Per-run work is capped by two `wrangler.jsonc` vars: `REFRESH_TARGETS_PER_RUN` (2 ET-date
  targets per refresh) and `SETTLE_CHUNK` (20 bets per settle). Do not raise either before PLAN
  Spikes S1/S2 are measured — see below.
- **ESPN's edge filters on User-Agent, and the rule is opaque.** Measured 2026-09-14: no UA, an empty
  UA, `Mozilla/5.0 (compatible; …)`, a real Chrome UA, and the BARE product token
  `SpicyBettingSimulator/0.1` all get **403**; the token WITH the GitHub comment
  (`ESPN_USER_AGENT` in `src/worker/espn.ts`) gets 200 (12/12 live runs). Do not shorten or edit
  that string without re-running this probe:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -A 'SpicyBettingSimulator/0.1 (+https://github.com/wardcrazy01894/SpicyBettingSimulator)' \
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260914'   # expect 200
  ```

  If 403s reappear in `GET /api/admin/jobs` → `stats.failures[]`, re-run the probe with candidate
  strings, change the constant, `npm run deploy`. A 403 degrades gracefully (rows untouched, target
  backs off) but is only discovered by looking — check `failures[]` and `dayRowsWritten` weekly.

- Budget: `GET /api/admin/jobs` → newest run's `stats.dayRowsWritten` is the rolling 24 h rows-written
  total against D1's hard 100,000/day. Modelled ≈5k on a college Saturday.
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
  header), `budgetSkipped`, and one entry per league saying `retry` / `resweep` / `forced` with the
  cost and what it filled, or `skipped: no-gap | throttled | budget | cooldown | no-budget-row`.
  Guards you should never see tripped: a sweep is refused below a reserve of 25 credits, at most
  once per 2 h per league, and not at all during the 1–8 h cooldown a 429 or 5xx sets. A FREE probe
  (`GET /v4/sports`, 0 credits) re-reads the balance daily while the reserve blocks and right after
  a failed sweep, so the monthly reset is noticed without any date arithmetic and an outage costs
  ~0 credits. If `remaining` sits under 25 for days: the month is spent; nothing is broken and the
  board is primary-only until the 1st. If `last_status` in `secondary_budget` reads `unauthorized`:
  the key was revoked — `wrangler secret put ODDS_API_KEY` again. A ranked game whose two feeds
  disagree on home/away (neutral sites) is refused on purpose and named under `swapped`.
- **January (postseason):** verify a `dates=` target returns bowl / NFL playoff games (PLAN Spike S4(c)).
  If not, add the `seasontype=3` companion target described in PLAN §8.2.

## Checks

```bash
npm run db:reconcile -- --remote        # SUM(ledger) vs balance for every account; exit 1 on drift
npx wrangler tail                       # live logs (cron runs, errors)
npx wrangler d1 execute spicybetting --remote --command "SELECT job, status, started_at FROM job_runs ORDER BY started_at DESC LIMIT 10"
npx wrangler d1 execute spicybetting --remote --command "SELECT remaining_credits, checked_at, cooldown_until, consecutive_failures, last_status FROM secondary_budget"   # weekly: the free tier is 500/month
```

A settle run that could not settle a bet records `status='error'` with the stats intact; the bet is
retried automatically (`settle_attempts`) and parked in `stats.stuck[]` after `MAX_SETTLE_ATTEMPTS`
(96 × the 15-minute cadence = 24 h).

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
in `wrangler.jsonc` must not be newer than the workerd bundled with `@cloudflare/vitest-pool-workers`
(the pool refuses it with `ERR_RUNTIME_FAILURE` and `npm run test:worker` fails; a date later than
today's fails differently, `ERR_FUTURE_COMPATIBILITY_DATE`), and the pool's `peerDependencies` pin
the `vitest` major. If a pool bump widens that peer to a vitest major we currently ignore, the PR
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

`package.json` carries one `overrides` entry, scoped to
`@cloudflare/vitest-pool-workers → miniflare → sharp: 0.35.4`, to patch a
dev-only vulnerability in a package that pool's miniflare pins exactly (PLAN §15).
It can only ever touch that one path. When a `@cloudflare/vitest-pool-workers`
bump lands, ask npm what the pool's miniflare wants on its own —
`npm view miniflare@<version pinned by the pool> dependencies.sharp` — and once
that is ≥ 0.35.4, delete the override in the same PR (`npm ls sharp` shows
"overridden" while it is in effect, which is the proxy, not the answer). If a
future miniflare ever wants sharp 0.36+, the override would silently pin it
back to 0.35.4 — another reason to remove it at the first opportunity. You will
not have to remember: `tests/unit/docs.spec.ts` reads what the pool's miniflare
wants and FAILS CI on the pool-bump PR until the override is deleted (and fails
the reverse, if the override goes while the pin is still vulnerable).

Security-only updates are enabled separately in the repo settings. They arrive as their own
ungrouped PRs, outside `open-pull-requests-limit`, and the `ignore` rules apply to them too: a
vulnerability fixed only in an ignored major produces no PR and stays visible only in the Security
tab, which is worth a look when the weekly PRs are reviewed.

## Open measurements (PLAN Spikes S1 / S2)

Neither is blocked any more — they wanted a deployed Worker and now have one. Until somebody runs
them, `REFRESH_TARGETS_PER_RUN` stays at 2 and `SETTLE_CHUNK` at 20.

```bash
npx wrangler tail --format json    # one JSON line per invocation; it carries `cpuTime` (ms)
# in another shell, as an admin, force one ingest on a Saturday ET date target:
curl -s -X POST -b "$COOKIE" -H 'X-SBS-Client: 1' \
  https://spicybetting.wardcrazy01894.workers.dev/api/admin/jobs/refresh
```

- **S1 (CPU)**: read `cpuTime` off that invocation's tailed line; the free-tier limit is 10 ms. Take
  several Saturday runs for a p95, not one sample. `GET /api/admin/jobs` gives the matching
  `stats.rowsWritten` so CPU and rows are read together.
- **S2 (D1 statement accounting)**: the same tail shows whether a `batch()` of 60 statements errors,
  and `outcome` distinguishes "exceeded limits" from an application failure.
- **S4(c)**: the January postseason check above.
