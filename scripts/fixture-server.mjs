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
 * Routes:
 *   /apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD
 *   /apis/site/v2/sports/football/college-football/scoreboard?groups=80&dates=YYYYMMDD
 *
 * Query handling: `dates=` is honoured by filtering events to that US-Eastern
 * calendar day (same bucketing as real ESPN, verified 2026-09-13); `groups=` and
 * everything else is ignored.
 *
 * Time shifting: the captured samples are from the week of 2026-09-12, so out of
 * the box every fixture game is in the past and nothing is bettable. By default
 * every event `date` is shifted forward by a whole number of weeks so the slate
 * lands in the CURRENT week, and started/final games are rewound to
 * STATUS_SCHEDULED with a fresh DraftKings-shaped line so they are bettable.
 * `?shift=0` serves the raw capture (useful for parser debugging).
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.FIXTURE_PORT ?? 8788);
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, '..', 'docs', 'samples');

const FILES = {
  nfl: 'espn-nfl-scoreboard.json',
  'college-football': 'espn-cfb-scoreboard.json',
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** All sample kickoffs fall in this week; used to compute the shift. */
const SAMPLE_ANCHOR_MS = Date.parse('2026-09-10T00:00:00Z');

function loadSample(league) {
  return JSON.parse(readFileSync(join(SAMPLES, FILES[league]), 'utf8'));
}

/** Whole weeks needed to move the sample week into the week containing `now`. */
function weeksToShift(now) {
  const diff = now - SAMPLE_ANCHOR_MS;
  return diff <= 0 ? 0 : Math.floor(diff / WEEK_MS);
}

/** YYYYMMDD of an instant in America/New_York (ESPN's `dates=` bucket). */
function etDateKey(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** A synthetic DraftKings-shaped odds block for games we rewind to scheduled. */
function syntheticOdds(competition) {
  const home = competition.competitors.find((c) => c.homeAway === 'home');
  const away = competition.competitors.find((c) => c.homeAway === 'away');
  return {
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    details: `${home.team.abbreviation} -3.5`,
    overUnder: 44.5,
    spread: -3.5,
    awayTeamOdds: { favorite: false, underdog: true, team: away.team },
    homeTeamOdds: { favorite: true, underdog: false, team: home.team },
    moneyline: {
      home: { close: { odds: '-180' }, open: { odds: '-180' } },
      away: { close: { odds: '+150' }, open: { odds: '+150' } },
    },
    pointSpread: {
      home: { close: { line: '-3.5', odds: '-110' }, open: { line: '-3.5', odds: '-110' } },
      away: { close: { line: '+3.5', odds: '-110' }, open: { line: '+3.5', odds: '-110' } },
    },
    total: {
      over: { close: { line: 'o44.5', odds: '-110' }, open: { line: 'o44.5', odds: '-110' } },
      under: { close: { line: 'u44.5', odds: '-110' }, open: { line: 'u44.5', odds: '-110' } },
    },
  };
}

function shiftPayload(payload, weeks) {
  if (weeks === 0) return payload;
  const out = structuredClone(payload);
  for (const event of out.events ?? []) {
    const shifted = Date.parse(event.date) + weeks * WEEK_MS;
    const iso = new Date(shifted).toISOString().replace(/\.\d{3}Z$/, 'Z');
    event.date = iso;
    for (const comp of event.competitions ?? []) {
      comp.date = iso;
      comp.startDate = iso;
      const st = comp.status?.type?.name;
      if (st && st !== 'STATUS_SCHEDULED') {
        comp.status = {
          clock: 0,
          displayClock: '0:00',
          period: 0,
          type: {
            id: '1',
            name: 'STATUS_SCHEDULED',
            state: 'pre',
            completed: false,
            description: 'Scheduled',
            detail: 'Scheduled',
            shortDetail: 'Scheduled',
          },
        };
        for (const c of comp.competitors ?? []) c.score = '0';
        comp.odds = [syntheticOdds(comp)];
      }
    }
  }
  return out;
}

function filterByDate(payload, dateKey) {
  if (!dateKey) return payload;
  const out = { ...payload };
  out.events = (payload.events ?? []).filter((e) => etDateKey(Date.parse(e.date)) === dateKey);
  return out;
}

function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const m = /^\/apis\/site\/v2\/sports\/football\/(nfl|college-football)\/scoreboard$/.exec(
    url.pathname,
  );
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture-server: unknown path', path: url.pathname }));
    return;
  }
  const league = m[1];
  const shiftParam = url.searchParams.get('shift');
  const weeks = shiftParam === '0' ? 0 : weeksToShift(Date.now());
  const dateKey = url.searchParams.get('dates');
  let body;
  try {
    body = filterByDate(shiftPayload(loadSample(league), weeks), dateKey);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
  console.log(
    `[fixtures] ${league} dates=${dateKey ?? '-'} shift=${weeks}w -> ${body.events.length} events (${json.length} bytes)`,
  );
}

function main() {
  const server = createServer(handle);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[fixtures] ESPN fixture server on http://127.0.0.1:${PORT}`);
    console.log(`[fixtures] shifting sample week forward by ${weeksToShift(Date.now())} week(s)`);
  });
}

main();
export { PORT };
