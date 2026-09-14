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

**A red Deploy run past the "Deploy the Worker" step means the new version IS live** (only the smoke
check failed). Roll back manually if the site is actually broken; the workflow does not auto-revert.

## Secrets (set once; rotate with the same command)

```bash
printf '%s' 'new-code'  | npx wrangler secret put INVITE_CODE    # shared signup code (one code for everyone)
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put IP_HASH_SALT   # rotating this resets IP throttle keys only
printf '%s' 'github_pat_…' | npx wrangler secret put GITHUB_TOKEN   # in-app bug reports → GitHub issues (optional)
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

## Schema changes

`migrations/0001_init.sql` is **FROZEN**: it was applied to the remote D1 on 2026-09-14 and D1
recorded it in the `d1_migrations` table, so `wrangler d1 migrations apply` will never replay it.
From now on **never edit 0001** — every schema change is a new numbered `migrations/000N_*.sql`,
applied with the command above. An edit to `0001` reaches nothing and leaves the repo describing a
database that does not exist. Comment-only edits are fine. (History, so the rule is not
re-derived: before the first remote deploy `0001` WAS the live schema and was revised in place;
that window is closed. Same rule in CLAUDE.md rule 9, PLAN §16.1 and the file's own header.)

Applied migrations, newest last:

| File                        | What                                                  | Applied remotely                           |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `0001_init.sql`             | the whole schema                                      | 2026-09-14                                 |
| `0002_users_deleted_at.sql` | `users.deleted_at INTEGER NULL` — account soft delete | on merge to `main`, by the Deploy workflow |
| `0003_bug_reports.sql`      | `bug_reports` table + 2 indexes — in-app bug reports  | on merge to `main`, by the Deploy workflow |

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
- Admin pages: `/admin` in the SPA (jobs, users, disable, password reset, reconcile).
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

## Bug reports

Users file bugs from `/account` → "Report a bug". Each one is a `bug_reports` row AND a GitHub
issue in this repo, labelled `bug` + `user-report`, titled `[user report] …`, with the reporter's
username, page, app version, time and browser in the body (PLAN §11.7). Five per user per hour.

- **GitHub said no** (token expired/revoked, GitHub down): the reporter saw a 503, but the row is
  kept. `/admin` → Bug reports shows it with `not filed` and the GitHub error; the description is
  printed in full so you can open the issue by hand. Fix the token (see Secrets) — nothing retries
  on its own.
- **Feature off**: unset `GITHUB_TOKEN` (`npx wrangler secret delete GITHUB_TOKEN`) and the button
  disappears on the next page load; the route returns 503 to anyone who still has the form open.
- **Spam**: it is signed-in users only and rate-limited in the INSERT itself, so the worst a
  hostile account can do is five issues an hour until you disable it (`/admin` → Users).

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
- **January (postseason):** verify a `dates=` target returns bowl / NFL playoff games (PLAN Spike S4(c)).
  If not, add the `seasontype=3` companion target described in PLAN §8.2.

## Checks

```bash
npm run db:reconcile -- --remote        # SUM(ledger) vs balance for every account; exit 1 on drift
npx wrangler tail                       # live logs (cron runs, errors)
npx wrangler d1 execute spicybetting --remote --command "SELECT job, status, started_at FROM job_runs ORDER BY started_at DESC LIMIT 10"
```

A settle run that could not settle a bet records `status='error'` with the stats intact; the bet is
retried automatically (`settle_attempts`) and parked in `stats.stuck[]` after `MAX_SETTLE_ATTEMPTS`
(96 × the 15-minute cadence = 24 h).

## Dependencies

Dependabot (`.github/dependabot.yml`) opens bump PRs weekly on Monday morning ET: one grouped PR
for minor/patch npm bumps, one per major, one for the Cloudflare toolchain (`wrangler` and
`@cloudflare/*`), and one for all GitHub Actions. Each is a normal PR — CI plus an adversarial
review before merge; nothing auto-merges.

Reviewing a Cloudflare-group PR means checking two constraints, both in PLAN §15: `compatibility_date`
in `wrangler.jsonc` must not be newer than the workerd bundled with `@cloudflare/vitest-pool-workers`
(the pool refuses it with `ERR_RUNTIME_FAILURE` and `npm run test:worker` fails; a date later than
today's fails differently, `ERR_FUTURE_COMPATIBILITY_DATE`), and the pool's `peerDependencies` pin
the `vitest` major. If a pool bump widens that peer to a vitest major we currently ignore, the PR
arrives red and the fix is to lift the `vitest` ceiling in BOTH `dependabot.yml` and PLAN §15 — not
to rerun CI.

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
