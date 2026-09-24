#!/usr/bin/env node
/**
 * Capture ESPN scoreboards for EVERY ET date an Odds API sample spans, merged
 * into one file per league. PLAN.md §21.7.
 *
 * ESPN serves one ET date per request, and each Odds API sample spans several,
 * so a single-date capture cannot feed `matchOddsApiEvents` a candidate list
 * drawn from the same days as the events. The date list is derived from the API
 * sample's own `commence_time`s — never a literal — so the two files cannot
 * drift apart silently.
 *
 *   node scripts/capture-espn-range.mjs            # both football leagues
 *   node scripts/capture-espn-range.mjs nfl        # one league
 *   node scripts/capture-espn-range.mjs mlb 20260922 [20260924 …]
 *
 * MLB has no Odds API sample (the secondary never sweeps it, PLAN.md §23.10),
 * so its dates come from argv, and each date is written to its OWN file,
 * `docs/samples/espn-mlb-scoreboard-YYYY-MM-DD.json` — the two committed MLB
 * captures (§23.2) are reproducible this way.
 *
 * The merged file keeps the FIRST response's root object and replaces `events`
 * with the concatenation of every response's `events`. Its root `season`/`week`
 * therefore describe the first date only; tests must not assert them.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

// The exact User-Agent the Worker sends (docs/OPERATIONS.md's probe). Read from
// the source so this script cannot drift from it.
const ua = /ESPN_USER_AGENT =\s*'([^']+)'/.exec(read('src/worker/espn.ts'));
if (!ua) throw new Error('ESPN_USER_AGENT not found in src/worker/espn.ts');
const USER_AGENT = ua[1];

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/**
 * ESPN `dates=` key (US Eastern calendar date) for an ISO instant. A local
 * re-implementation of src/shared/time.ts's etDateKey, because this is a plain
 * .mjs one-shot outside the TypeScript projects; both go through Intl with an
 * explicit America/New_York, so they cannot disagree.
 */
function etDateKey(iso) {
  const parts = ET.formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

const LEAGUES = {
  nfl: {
    sample: 'docs/samples/odds-api-nfl.json',
    url: (key) =>
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${key}&limit=100`,
    out: (first, last) => `docs/samples/espn-nfl-scoreboard-${first}..${last}.json`,
  },
  ncaaf: {
    sample: 'docs/samples/odds-api-ncaaf.json',
    url: (key) =>
      `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300&dates=${key}`,
    out: (first, last) => `docs/samples/espn-cfb-scoreboard-${first}..${last}.json`,
  },
};

const iso = (k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;

/** `mlb` + explicit YYYYMMDD dates from argv: one file per date, unmerged. */
async function captureMlb(keys) {
  if (keys.length === 0) throw new Error('mlb needs at least one YYYYMMDD date');
  for (const key of keys) {
    if (!/^\d{8}$/.test(key)) throw new Error(`mlb: ${key} is not YYYYMMDD`);
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${key}&limit=100`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`mlb ${key}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.events)) throw new Error(`mlb ${key}: no events[]`);
    const out = `docs/samples/espn-mlb-scoreboard-${iso(key)}.json`;
    writeFileSync(new URL(out, ROOT), JSON.stringify(body));
    console.log(`mlb ${key}: wrote ${out} (${body.events.length} events)`);
  }
}

const wanted = process.argv.slice(2);
if (wanted[0] === 'mlb') {
  await captureMlb(wanted.slice(1));
  process.exit(0);
}
for (const [league, cfg] of Object.entries(LEAGUES)) {
  if (wanted.length > 0 && !wanted.includes(league)) continue;
  const sample = JSON.parse(read(cfg.sample));
  const keys = [...new Set(sample.map((e) => etDateKey(e.commence_time)))].sort();
  console.log(`${league}: ${sample.length} events span ${keys.length} ET dates: ${keys.join(' ')}`);

  let root = null;
  const events = [];
  for (const key of keys) {
    const res = await fetch(cfg.url(key), {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`${league} ${key}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.events)) throw new Error(`${league} ${key}: no events[]`);
    console.log(`  ${key}: ${body.events.length} events`);
    root ??= body;
    events.push(...body.events);
  }
  // Named `<first ISO date>..<last day>` when the range stays inside one month
  // (`2026-09-17..28`), full ISO for the last date otherwise.
  const first = keys[0];
  const last = keys[keys.length - 1];
  const lastPart = first.slice(0, 6) === last.slice(0, 6) ? last.slice(6, 8) : iso(last);
  const out = cfg.out(iso(first), lastPart);
  writeFileSync(new URL(out, ROOT), JSON.stringify({ ...root, events }));
  console.log(`  wrote ${out} (${events.length} events)`);
}
