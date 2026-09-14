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
```

`GET /api/health` reports `inviteRequired: true` once `INVITE_CODE` is set. The values currently in
use are in the (gitignored) `.env.deploy.local` on the deploying machine.

## Schema changes

`migrations/0001_init.sql` is **FROZEN**: it was applied to the remote D1 on 2026-09-14 and D1
recorded it in the `d1_migrations` table, so `wrangler d1 migrations apply` will never replay it.
From now on **never edit 0001** — every schema change is a new numbered `migrations/000N_*.sql`,
applied with the command above. An edit to `0001` reaches nothing and leaves the repo describing a
database that does not exist. Comment-only edits are fine. (History, so the rule is not
re-derived: before the first remote deploy `0001` WAS the live schema and was revised in place;
that window is closed. Same rule in CLAUDE.md rule 9, PLAN §16.1 and the file's own header.)

## Accounts

- The FIRST signup becomes admin. Signup needs the invite code.
- Admin pages: `/admin` in the SPA (jobs, users, disable, password reset, reconcile).
- Reset a password from the CLI: `node scripts/admin-hash.mjs <username> <new-password>` prints a
  `wrangler d1 execute` statement to run with `--remote`.
- Adjust a balance: `POST /api/admin/users/:id/adjust {amountCents, memo}` (ledger row; cannot overdraft).

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

## Open measurements (PLAN Spikes S1 / S2)

Neither is blocked any more — they wanted a deployed Worker and now have one. Until somebody runs
them, `REFRESH_TARGETS_PER_RUN` stays at 2 and `SETTLE_CHUNK` at 20.

```bash
npx wrangler tail --format json    # one JSON line per invocation; it carries `cpuTime` (ms)
# in another shell, as an admin, force one ingest on a Saturday ET date target:
curl -s -X POST -b "$COOKIE" -H 'x-csrf: 1' \
  https://spicybetting.wardcrazy01894.workers.dev/api/admin/jobs/refresh
```

- **S1 (CPU)**: read `cpuTime` off that invocation's tailed line; the free-tier limit is 10 ms. Take
  several Saturday runs for a p95, not one sample. `GET /api/admin/jobs` gives the matching
  `stats.rowsWritten` so CPU and rows are read together.
- **S2 (D1 statement accounting)**: the same tail shows whether a `batch()` of 60 statements errors,
  and `outcome` distinguishes "exceeded limits" from an application failure.
- **S4(c)**: the January postseason check above.
