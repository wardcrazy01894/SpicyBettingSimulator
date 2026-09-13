#!/usr/bin/env node
/**
 * Local ESPN stand-in for `npm run dev`. Serves docs/samples/*.json with the same
 * URL shape as the real API so `ESPN_BASE_URL=http://127.0.0.1:8788` exercises
 * the real HTTP path without touching the network.
 *
 * IT IS ONLY REACHED IF `.dev.vars` EXISTS. `wrangler.jsonc` defaults
 * ESPN_BASE_URL to the real https://site.api.espn.com; `.dev.vars.example` ships
 * the `http://127.0.0.1:8788` override as its first line. Copy it before
 * `npm run dev`, or local development quietly talks to production ESPN while this
 * server idles.
 *
 * Routes (query params are accepted and IGNORED, which is the point — it always
 * returns the same captured slate):
 *   /apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD
 *   /apis/site/v2/sports/football/college-football/scoreboard?groups=80&dates=YYYYMMDD
 *
 * M1 TODO: rewrite event `date` fields to be relative to today so the fixture
 * games are always "upcoming" in local dev (otherwise every fixture game is in
 * the past and nothing is bettable). Gate behind ?shift=0 to opt out.
 */

const PORT = Number(process.env.FIXTURE_PORT ?? 8788);

function main() {
  throw new Error('not implemented: M1');
}

main();
export { PORT };
