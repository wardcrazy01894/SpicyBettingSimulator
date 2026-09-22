# 🌶️ Spicy Betting Simulator

### ▶ Play it now: **https://spicybetting.wardcrazy01894.workers.dev**

Real lines. Real odds. Fake money. A private sportsbook for a few friends who
want to find out who actually knows football, without anyone's rent riding on
it.

You sign up, get a fake **$1,000**, and bet it on this week's NFL and college
games at the prices the books are posting. Games go final, bets grade
themselves, the money moves, and a leaderboard settles the argument. There is
no top-up button, so bet like it's real.

---

## What's on the board

- **Every NFL game and every FBS college game**, pulled from ESPN's scoreboard
  with DraftKings' prices (or the top book ESPN carries when DK isn't there).
  The board refreshes on a 15-minute cycle, games nearest kickoff first; a game
  that's still days away is re-checked every few hours. The board runs through
  the Monday that closes the week: next week's college slate shows up Sunday
  morning, the NFL's on Sunday night after the late games, and both stay up
  through Monday night. When DraftKings is missing a spread, total or moneyline
  on an NFL game or a ranked college game, the board fills it from another book
  via The Odds API and says which book on that market.
- **Moneylines, spreads and totals** on each game.
- **Straight bets** on one thing, or **parlays** on 2 to 10 legs, and the legs
  can mix Saturday and Sunday.
- **Same game parlays**: a game can carry one side pick (spread or moneyline)
  and one total in the same bet, priced leg by leg like any parlay. A spread
  and a moneyline on one team are the same question twice, so that pair is
  the one thing the slip will not build.
- **Teasers** from 3 to 14 points (plus 6.5). Every leg moves your way by that
  much, and you pay for it in the price. Spreads and totals only, since a
  moneyline has no line to move. A push still reduces the bet instead of
  killing it, at every tier.
- A **Top 25 / conference filter** on the college tab, because 80 games is a
  lot of games.

## How a Saturday goes

1. **Sign up** with the invite code. First account in becomes the admin.
2. **Tap a price** on the board and it lands in your slip. There is one slip
   for both leagues, so switching tabs never loses a pick.
3. **Pick the shape**: one leg is a straight, more is a parlay, or flip to
   teaser and choose your points. Tap a game's total next to its spread and
   you have a same game parlay.
4. **Stake and place.** The server prices the bet from its own current lines.
   If a line moved while you were thinking, you get a "line changed" nudge, not
   a silent fill.
5. **Change your mind** any time before the first leg locks, one minute before
   kickoff. Edits re-price against the current lines.
6. **Watch it grade.** Settlement runs a few minutes after each refresh. Your
   account page has the full ledger, every cent of it, and the leaderboard
   ranks everyone by **equity**: balance plus whatever is still riding.
   **Tap a name on the leaderboard** to see that player's bets: what's still
   open and how each leg is going, and everything that's settled, with what it
   won or lost. Everyone's history is open to everyone; it's a friend group,
   not a bank.
7. **Something look wrong?** "Report a bug" is in the header on every page
   once you're signed in. It files an issue in
   [this repo](https://github.com/wardcrazy01894/SpicyBettingSimulator/issues)
   with your username, the page you were on, the app version, your browser and
   a log of recent errors and requests attached. The form shows you the
   diagnostics it attaches before you send. (The button only appears when the admin has set
   the `GITHUB_TOKEN` secret; it is set on the live site.)

## Under the hood

One Cloudflare Worker (Hono API, cron jobs, static assets), one D1 SQLite
database, one React SPA. It runs entirely on Cloudflare's free tier. Money is
integer cents with the invariants living in the database schema itself, so a
balance can only ever change through the ledger.

If you want the real story: [`PLAN.md`](./PLAN.md) is the architecture of
record, [`CLAUDE.md`](./CLAUDE.md) holds the conventions, and
[`docs/OPERATIONS.md`](./docs/OPERATIONS.md) is the runbook for the live site.

## Run it locally

Needs Node 24+. Everything runs against a local, in-process copy of D1, so
you don't need a Cloudflare account until you deploy your own copy.

```bash
git clone https://github.com/wardcrazy01894/SpicyBettingSimulator.git
cd SpicyBettingSimulator
npm install

npm run db:migrate:local              # apply the schema to the local D1
cp .dev.vars.example .dev.vars        # local secrets + the fixture-server override
npm run dev                           # fixture ESPN server + Worker + Vite
```

(Deploying your own copy also needs `npx wrangler d1 create spicybetting` and
its id in `wrangler.jsonc`; don't commit that change, the committed id is the
live database.)

Open <http://localhost:5173>. Vite proxies `/api` to `wrangler dev` on `:8787`,
and `ESPN_BASE_URL` points at a local fixture server replaying the captured
payloads in `docs/samples/`, so local development never touches the real ESPN
API. Sign up (you'll be admin), then trigger a refresh from the admin page to
seed the board.

## Contributing

Run the whole gate before opening a PR, and get it green:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

`npm test` includes `tests/unit/docs.spec.ts`, which fails when `PLAN.md`,
`CLAUDE.md` or this file disagrees with the code on a mechanical fact: a
constant, an error code, a route, a table, the teaser card, the migration list.
Docs ship in the same PR as the behaviour change. Every PR also gets an
adversarial review before merge; the checklist is
`.github/pull_request_template.md`.

### Icons

`public/favicon.svg` is the site icon (a gold "$" coin with a flame) and the
only file you edit. The PNG and ICO copies next to it are generated from it and
committed, so after changing the SVG run `npm run icons`. Keep the SVG free of
`<text>`: the "$" is a stroked path so the rasters don't depend on the fonts of
whichever machine regenerates them.

## Deploy

Merging to `main` deploys: the workflow applies any pending migrations and then
ships the Worker to https://spicybetting.wardcrazy01894.workers.dev. The
secrets are set once by hand:

```bash
npx wrangler secret put INVITE_CODE
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put GITHUB_TOKEN   # optional: turns on in-app bug reports
```

Everything else, from the schema-change policy to what the logs mean, is in
`docs/OPERATIONS.md`.
