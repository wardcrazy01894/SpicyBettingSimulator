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
 *   /apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD   (PLAN.md §23.4)
 *   /v4/sports                                          The Odds API's FREE probe
 *   /v4/sports/americanfootball_{nfl|ncaaf}/odds        The Odds API's odds (PLAN.md §21)
 *
 * The Odds API routes serve docs/samples/odds-api-*.json with the real credit
 * headers (`x-requests-remaining` etc.), honour `commenceTimeFrom/To`, and shift
 * `commence_time` into the current week by the same rule and from the SAME
 * anchor as the ESPN events, which are the same-date captures of the same games
 * — so the sweep finds matches locally. Any `apiKey` is accepted; nothing is
 * spent.
 *
 * Query handling: `dates=` is honoured by filtering events to that US-Eastern
 * calendar day (same bucketing as real ESPN, verified 2026-09-13); `groups=` and
 * everything else is ignored.
 *
 * Time shifting: the captured samples start on 2026-09-17, so out of
 * the box every fixture game is in the past and nothing is bettable. By default
 * every event `date` is shifted forward by a whole number of weeks so the slate
 * lands in the CURRENT week, and started/final games are rewound to
 * STATUS_SCHEDULED with a fresh DraftKings-shaped line so they are bettable.
 * `?shift=0` serves the raw capture (useful for parser debugging).
 *
 * MLB is shifted by whole DAYS, not weeks: its board is today only (§23.5), so
 * the one committed slate (docs/samples/espn-mlb-scoreboard-2026-09-24.json)
 * is moved onto the CURRENT ET date, and its in-progress games are rewound to
 * scheduled with a synthetic run line (±1.5), total and moneyline.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.FIXTURE_PORT ?? 8788);
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, '..', 'docs', 'samples');

// The SAME-DATE captures (PLAN.md §21.7): every ET date the Odds API samples
// span, so the two local feeds describe the same games and the secondary sweep
// finds matches in `npm run dev`. The original week samples stay committed for
// the parser's unit tests.
const FILES = {
  nfl: 'espn-nfl-scoreboard-2026-09-17..28.json',
  'college-football': 'espn-cfb-scoreboard-2026-09-17..26.json',
  mlb: 'espn-mlb-scoreboard-2026-09-24.json',
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** The MLB capture's ET date, as a UTC calendar date for whole-day arithmetic. */
const MLB_SAMPLE_DATE_UTC = Date.UTC(2026, 8, 24);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The captures start on this date (Thu 2026-09-17); used to compute the shift. */
const SAMPLE_ANCHOR_MS = Date.parse('2026-09-17T00:00:00Z');
/** Same anchor as the ESPN captures — that is the point of the same-date files. */
const ODDS_ANCHOR_MS = SAMPLE_ANCHOR_MS;
const ODDS_FILES = {
  americanfootball_nfl: 'odds-api-nfl.json',
  americanfootball_ncaaf: 'odds-api-ncaaf.json',
};
/** Same anchor as the ESPN captures — that is the point of the same-date files. */
const ODDS_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-requests-used': '3',
  'x-requests-remaining': '497',
};

function loadSample(league) {
  return JSON.parse(readFileSync(join(SAMPLES, FILES[league]), 'utf8'));
}

/**
 * Whole ET calendar days from the MLB capture's date to today's ET date. Counted
 * on date KEYS, not on elapsed milliseconds, so it lands on today's date even
 * across a DST change (a first pitch may drift by an hour; the date does not).
 */
function daysToShiftMlb(now) {
  const key = etDateKey(now);
  const today = Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
  );
  return Math.max(0, Math.round((today - MLB_SAMPLE_DATE_UTC) / DAY_MS));
}

/** Whole weeks needed to move the sample week into the week containing `now`. */
function weeksToShift(now, anchor = SAMPLE_ANCHOR_MS) {
  const diff = now - anchor;
  return diff <= 0 ? 0 : Math.floor(diff / WEEK_MS);
}

/** The Odds API body for one sport key, shifted and bounded like the real API. */
function oddsBody(sportKey, url) {
  const raw = JSON.parse(readFileSync(join(SAMPLES, ODDS_FILES[sportKey]), 'utf8'));
  const weeks =
    url.searchParams.get('shift') === '0' ? 0 : weeksToShift(Date.now(), ODDS_ANCHOR_MS);
  const from = Date.parse(url.searchParams.get('commenceTimeFrom') ?? '') || -Infinity;
  const to = Date.parse(url.searchParams.get('commenceTimeTo') ?? '') || Infinity;
  const out = [];
  for (const event of raw) {
    const at = Date.parse(event.commence_time) + weeks * WEEK_MS;
    if (at < from || at > to) continue;
    out.push({ ...event, commence_time: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  return { body: out, weeks };
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

/**
 * The MLB rewind line: DraftKings' run line is always ±1.5 (§23.2), so home
 * -1.5 / away +1.5, a whole-number-ish total and a moneyline.
 */
function syntheticMlbOdds(competition) {
  const home = competition.competitors.find((c) => c.homeAway === 'home');
  const away = competition.competitors.find((c) => c.homeAway === 'away');
  return {
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    details: `${home.team.abbreviation} -140`,
    overUnder: 8.5,
    spread: -1.5,
    awayTeamOdds: { favorite: false, underdog: true, team: away.team },
    homeTeamOdds: { favorite: true, underdog: false, team: home.team },
    moneyline: {
      home: { close: { odds: '-140' }, open: { odds: '-140' } },
      away: { close: { odds: '+120' }, open: { odds: '+120' } },
    },
    pointSpread: {
      displayName: 'Runline',
      home: { close: { line: '-1.5', odds: '+135' }, open: { line: '-1.5', odds: '+135' } },
      away: { close: { line: '+1.5', odds: '-160' }, open: { line: '+1.5', odds: '-160' } },
    },
    total: {
      over: { close: { line: 'o8.5', odds: '-110' }, open: { line: 'o8.5', odds: '-110' } },
      under: { close: { line: 'u8.5', odds: '-110' }, open: { line: 'u8.5', odds: '-110' } },
    },
  };
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

function shiftPayload(payload, weeks, shiftMs = weeks * WEEK_MS, oddsFor = syntheticOdds) {
  if (weeks === 0) return payload;
  const out = structuredClone(payload);
  for (const event of out.events ?? []) {
    const shifted = Date.parse(event.date) + shiftMs;
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
        for (const c of comp.competitors ?? []) {
          c.score = '0';
          delete c.winner;
          delete c.linescores;
        }
        comp.odds = [oddsFor(comp)];
        // Real ESPN keeps event.status and competitions[0].status in lock-step;
        // a parser that reads the event-level one must see the rewind too.
        event.status = comp.status;
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

  // The Odds API (PLAN.md §21): the free probe and the per-sport odds.
  if (url.pathname === '/v4/sports') {
    res.writeHead(200, { ...ODDS_HEADERS, 'x-requests-last': '0' });
    res.end(JSON.stringify(Object.keys(ODDS_FILES).map((key) => ({ key, active: true }))));
    console.log('[fixtures] odds-api probe -> 0 credits');
    return;
  }
  const o = /^\/v4\/sports\/([a-z_]+)\/odds$/.exec(url.pathname);
  if (o) {
    if (!(o[1] in ODDS_FILES)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `fixture-server: unknown sport ${o[1]}` }));
      return;
    }
    const { body, weeks } = oddsBody(o[1], url);
    res.writeHead(200, { ...ODDS_HEADERS, 'x-requests-last': '3' });
    res.end(JSON.stringify(body));
    console.log(`[fixtures] odds-api ${o[1]} shift=${weeks}w -> ${body.length} events`);
    return;
  }

  const m = /^\/apis\/site\/v2\/sports\/football\/(nfl|college-football)\/scoreboard$/.exec(
    url.pathname,
  );
  if (!m && url.pathname === '/apis/site/v2/sports/baseball/mlb/scoreboard') {
    serveMlb(url, res);
    return;
  }
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture-server: unknown path', path: url.pathname }));
    return;
  }
  const league = m[1];
  const shiftParam = url.searchParams.get('shift');
  const weeks = shiftParam === '0' ? 0 : weeksToShift(Date.now());
  const dateKey = url.searchParams.get('dates');
  if (dateKey && !/^\d{8}$/.test(dateKey)) {
    console.warn(`[fixtures] dates=${dateKey} is not a single YYYYMMDD; returning 0 events`);
  }
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

/** MLB: the 09-24 capture moved onto today's ET date (whole days), then filtered. */
function serveMlb(url, res) {
  const days = url.searchParams.get('shift') === '0' ? 0 : daysToShiftMlb(Date.now());
  const dateKey = url.searchParams.get('dates');
  let body;
  try {
    body = filterByDate(
      shiftPayload(loadSample('mlb'), days, days * DAY_MS, syntheticMlbOdds),
      dateKey,
    );
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
  console.log(
    `[fixtures] mlb dates=${dateKey ?? '-'} shift=${days}d -> ${body.events.length} events (${json.length} bytes)`,
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
