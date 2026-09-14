# SpicyBettingSimulator

A fake-money sports-betting simulator for a small group of friends. Each user gets
one fake **$1,000** account balance at signup — it covers both the NFL and FBS
college football, and it never resets — and places bets against **real** lines and
**real** odds pulled from ESPN's public scoreboard feed (DraftKings prices).
Moneylines, spreads and totals; straight bets and 2–10 leg parlays, whose legs
may mix leagues; and 6 / 6.5 / 7-point teasers — **spread and total legs only**,
because a moneyline has no line to move — priced from a fixed card rather than
from the legs. The site grades bets automatically as games go final, keeps an
auditable ledger of every cent, and ranks everyone by **equity** — balance plus
whatever is riding on open bets. **No real money is ever involved** — it's a "how
would I have done" tracker, not a sportsbook.

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

## How to play

1. **Sign up** with the invite code. The first account to sign up becomes the
   admin. You get one **$1,000** balance, once, for the life of the account.
2. **Pick a game** on the board (NFL / CFB tabs). Tapping a price adds a leg to
   the bet slip — there is ONE slip and it spans both leagues, so the tabs move
   the board and never your picks.
3. **Choose a shape**: one leg is a straight bet; two or more is a parlay, or a
   teaser if you switch mode and pick 6 / 6.5 / 7 points. Teaser legs must be
   spreads or totals.
4. **Stake and place.** The server prices the bet from its own current lines —
   the client never sends a price. If a line moved since you tapped it you get a
   "the line changed" confirm rather than a silent fill.
5. **Edit or cancel** any open bet until its earliest leg locks (one minute
   before kickoff). An edit re-prices against today's lines.
6. **Watch it grade.** Scores are ingested every 15 minutes and bets settle 5
   minutes after that, automatically. `/account` has the full ledger;
   `/leaderboard` ranks everyone by equity.
7. **Something broken?** `/account` → "Report a bug" files a GitHub issue in
   this repo with your username, the page and the app version attached. (Only
   shown when the admin has set `GITHUB_TOKEN`; see `docs/OPERATIONS.md`.)

## Before you open a PR

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

`npm test` includes `tests/unit/docs.spec.ts`, which fails when `PLAN.md`,
`CLAUDE.md` or this file disagrees with the code on a mechanical fact — a
constant, an error code, a route, a table, the teaser card. Docs ship in the same
PR as the behaviour change; see `.github/pull_request_template.md`.

## Icons

`public/favicon.svg` is the site icon and the only file you edit: a gold "$"
coin with a flame, in the app's accent orange on its dark background. The PNG
and ICO copies next to it (tab icon, iOS home-screen icon, manifest icons) are
generated from it and committed, so after changing the SVG run:

```bash
npm run icons
```

Keep the SVG free of `<text>`: the "$" is a stroked path precisely so the
rasters do not depend on the fonts of whichever machine regenerates them.
`tests/unit/docs.spec.ts` checks that every icon `index.html` and the manifest
point at exists in `public/`, because the SPA fallback serves index.html for a
missing asset with a 200, so a broken link would otherwise fail silently.

## Deploy

Live at https://spicybetting.wardcrazy01894.workers.dev (Cloudflare free plan). Full runbook:
`docs/OPERATIONS.md` (secrets, schema-change policy, the ESPN User-Agent probe, checks).

```bash
npx wrangler d1 migrations apply spicybetting --remote
npx wrangler secret put INVITE_CODE
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put GITHUB_TOKEN   # optional: in-app bug reports → GitHub issues
npm run deploy
```
