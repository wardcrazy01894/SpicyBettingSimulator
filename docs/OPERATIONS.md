# Operations runbook — SpicyBettingSimulator

Live: **https://spicybetting.wardcrazy01894.workers.dev** (Cloudflare Workers free plan, $0/month).
First deployed 2026-09-14. Everything below runs from a checkout of `main` with `wrangler` logged in
to the `alanc3939+cloudflare@gmail.com` Cloudflare account.

## Deploy

```bash
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build   # the gate
npx wrangler d1 migrations apply spicybetting --remote   # only when migrations/ changed
npm run deploy                                           # vite build + wrangler deploy
curl -s https://spicybetting.wardcrazy01894.workers.dev/api/health
```

Every merge to `main` is NOT auto-deployed; deploy is a manual step (above). Rollback = `git checkout <previous sha> && npm run deploy`.

## Secrets (set once; rotate with the same command)

```bash
printf '%s' 'new-code'  | npx wrangler secret put INVITE_CODE    # shared signup code (one code for everyone)
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put IP_HASH_SALT   # rotating this resets IP throttle keys only
```

`GET /api/health` reports `inviteRequired: true` once `INVITE_CODE` is set. The values currently in
use are in the (gitignored) `.env.deploy.local` on the deploying machine.

## Schema changes

`migrations/0001_init.sql` was applied to the remote D1 on 2026-09-14. From now on **never edit
0001** — add `migrations/0002_*.sql` and apply with the command above. (Before the first remote
deploy the file was edited in place; that window is closed.)

## Accounts

- The FIRST signup becomes admin. Signup needs the invite code.
- Admin pages: `/admin` in the SPA (jobs, users, disable, password reset, reconcile).
- Reset a password from the CLI: `node scripts/admin-hash.mjs <username> <new-password>` prints a
  `wrangler d1 execute` statement to run with `--remote`.
- Adjust a balance: `POST /api/admin/users/:id/adjust {amountCents, memo}` (ledger row; cannot overdraft).

## Data feed

- Source: ESPN's public scoreboard API (no key). Cron `*/15` refreshes, `5-59/15` settles,
  `30 8 * * *` maintenance. Manual: `POST /api/admin/jobs/{refresh|settle|maintenance}` as admin.
- **ESPN returns 403 for an empty User-Agent** (Workers send none) and for `Mozilla/5.0 (compatible; …)`
  bot strings. `ESPN_USER_AGENT` in `src/worker/espn.ts` is a plain product token and passes
  (0 failures over 12 consecutive runs at first deploy). If 403s reappear, check that constant first.
- Budget: `GET /api/admin/jobs` → newest run's `stats.dayRowsWritten` is the rolling 24 h rows-written
  total against D1's hard 100,000/day. Modelled ≈5k on a college Saturday.
- **January (postseason):** verify a `dates=` target returns bowl / NFL playoff games (PLAN Spike S4(c)).
  If not, add the `seasontype=3` companion target described in PLAN §8.2.

## Checks

```bash
node scripts/reconcile.mjs --remote     # SUM(ledger) vs balance for every account; exit 1 on drift
npx wrangler tail                       # live logs (cron runs, errors)
npx wrangler d1 execute spicybetting --remote --command "SELECT job, status, started_at FROM job_runs ORDER BY started_at DESC LIMIT 10"
```

A settle run that could not settle a bet records `status='error'` with the stats intact; the bet is
retried automatically (`settle_attempts`) and parked in `stats.stuck[]` after 24 h.
