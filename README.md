# SpicyBettingSimulator

A fake-money sports-betting simulator for a small group of friends. Every season,
for the NFL and FBS college football, each user gets a fake **$1,000** bankroll and
places bets against **real** lines and **real** odds pulled from ESPN's public
scoreboard feed (DraftKings prices). Straight bets and 2–10 leg parlays on
moneylines, spreads and totals. The site grades bets automatically as games go
final, keeps an auditable ledger of every cent, and ranks everyone on a
leaderboard. **No real money is ever involved** — it's a "how would I have done"
tracker, not a sportsbook.

It runs entirely on the Cloudflare free tier: one Worker (Hono API + Cron
Triggers + static assets) with a D1 SQLite database, and a React/TypeScript SPA.

See [`PLAN.md`](./PLAN.md) for the architecture and [`CLAUDE.md`](./CLAUDE.md) for
conventions.

## Local setup

Requires Node 24+ and a Cloudflare account (free).

```bash
git clone git@github-wardcrazy:wardcrazy01894/SpicyBettingSimulator.git
cd SpicyBettingSimulator
npm install

# 1. create the local D1 database and paste the id into wrangler.jsonc
npx wrangler d1 create spicybetting

# 2. apply the schema locally
npm run db:migrate:local

# 3. local secrets AND the fixture-server override (required — without this,
#    local dev talks to the real ESPN API)
cp .dev.vars.example .dev.vars

# 4. run everything: fixture ESPN server + Worker + Vite
npm run dev
```

Then open <http://localhost:5173>. The Vite dev server proxies `/api` to
`wrangler dev` on `:8787`, and `ESPN_BASE_URL` points at a local fixture server
that replays the captured payloads in `docs/samples/`, so local development
never hits the real ESPN API.

To seed some games, sign up (first user becomes admin) and hit
`POST /api/admin/jobs/refresh` from the admin page.

## Before you open a PR

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

## Deploy

```bash
npx wrangler d1 migrations apply spicybetting --remote
npx wrangler secret put INVITE_CODE
npx wrangler secret put IP_HASH_SALT
npm run deploy
```
