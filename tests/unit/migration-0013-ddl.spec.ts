/**
 * Migration 0013's six `CREATE TABLE`s and every index and trigger it
 * recreates, compared TEXTUALLY against each one's LAST DEFINER (PLAN.md
 * §24.9) — 0009 for `games` / `game_lines` / `ingest_targets`, 0010 for
 * `bets` / `bet_legs`, 0011 for `ledger` — plus 0012's four ALTERed
 * `ingest_targets` columns. Node env, like the 0009/0010/0011 DDL specs, and
 * for the same reason: the worker pool has already applied 0013, so a
 * before/after `sqlite_master` comparison there compares 0013 with itself.
 *
 * The ONLY permitted differences: the four `CHECK (league IN (...))` lists
 * gain `'ncaab'` and `'nba'`, and `ingest_targets` carries 0012's four columns
 * inline, appended after `updated_at` in 0012's order. A reviewer diffing 0013
 * against 0009 alone would miss that `bets`, `bet_legs` and `ledger` must come
 * from 0010 / 0011 — this spec is what catches a silent revert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEAGUES } from '../../src/shared/types.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const read = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
const M0009 = read('0009_mlb_league.sql');
const M0010 = read('0010_parlay_25_legs.sql');
const M0011 = read('0011_ledger_refill_buyout.sql');
const M0012 = read('0012_ingest_guard.sql');
const OUT = read('0013_basketball_leagues.sql');

const REBUILT = ['games', 'game_lines', 'bets', 'bet_legs', 'ledger', 'ingest_targets'] as const;

/** The migration that last defined each table before 0013 (PLAN.md §24.9's table). */
const LAST_DEFINER: Readonly<Record<(typeof REBUILT)[number], string>> = {
  games: M0009,
  game_lines: M0009,
  bets: M0010,
  bet_legs: M0010,
  ledger: M0011,
  ingest_targets: M0009,
};

function norm(item: string): string {
  return item
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** The parenthesised body of `CREATE TABLE <name> (`, split at top-level commas. */
function tableItems(sql: string, name: string): string[] {
  const m = new RegExp(`CREATE TABLE ${name} \\(`).exec(sql);
  if (m === null) throw new Error(`no CREATE TABLE ${name}`);
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = m.index + m[0].length; i < sql.length; i += 1) {
    const ch = sql[i] ?? '';
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) {
        items.push(current);
        return items.map(norm).filter((s) => s.length > 0);
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  throw new Error(`unterminated CREATE TABLE ${name}`);
}

/** Every CREATE INDEX / CREATE TRIGGER statement on the given tables, normalised. */
function objects(sql: string, tables: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/CREATE INDEX [^;]+;/g)) {
    const on = /\bON (\w+)/.exec(m[0])?.[1] ?? '';
    if (tables.includes(on)) out.push(norm(m[0]));
  }
  for (const m of sql.matchAll(/CREATE TRIGGER [\s\S]+?END;/g)) {
    const on = /\bON (\w+)/.exec(m[0])?.[1] ?? '';
    if (tables.includes(on)) out.push(norm(m[0]));
  }
  return out.sort();
}

/** One table's items with every `league IN (...)` list replaced by a marker. */
function withoutLeagueList(items: readonly string[]): string[] {
  return items.map((i) => i.replace(/CHECK \(league IN \([^)]*\)\)/, 'CHECK (league IN <L>)'));
}

const leagueList = (items: readonly string[]): string | undefined =>
  items.map((i) => /CHECK \(league IN \(([^)]*)\)\)/.exec(i)?.[1]).find((x) => x !== undefined);

describe("0013's rebuilt tables match their LAST definers except the league CHECKs", () => {
  it('games, game_lines, bets, bet_legs and ledger equal their last definer but for the league list', () => {
    for (const t of ['games', 'game_lines', 'bets', 'bet_legs', 'ledger'] as const) {
      expect(withoutLeagueList(tableItems(OUT, t)), t).toEqual(
        withoutLeagueList(tableItems(LAST_DEFINER[t], t)),
      );
    }
    // game_lines and ledger have no league column: byte-for-byte equal.
    expect(tableItems(OUT, 'game_lines')).toEqual(tableItems(M0009, 'game_lines'));
    expect(tableItems(OUT, 'ledger')).toEqual(tableItems(M0011, 'ledger'));
    // The two later definers really are the ones copied: 0010's leg caps and
    // 0011's ledger kinds survive.
    expect(tableItems(OUT, 'bets')).toContain(
      'leg_count INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND 25)',
    );
    expect(tableItems(OUT, 'bets')).toContain("CHECK (bet_type <> 'teaser' OR leg_count <= 10)");
    expect(tableItems(OUT, 'ledger').join(' ')).toContain("'deposit_refill', 'bust_buyout'");
  });

  it('the four league lists are exactly LEAGUES (plus mixed on bets)', () => {
    const quoted = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');
    for (const t of ['games', 'bet_legs', 'ingest_targets'] as const) {
      expect(leagueList(tableItems(OUT, t)), t).toBe(quoted(LEAGUES));
    }
    expect(leagueList(tableItems(OUT, 'bets'))).toBe(quoted([...LEAGUES, 'mixed']));
    expect(LEAGUES).toEqual(['nfl', 'ncaaf', 'mlb', 'ncaab', 'nba']);
  });

  it("ingest_targets is 0009's plus 0012's four columns, appended in 0012's order", () => {
    const src = withoutLeagueList(tableItems(M0009, 'ingest_targets'));
    const out = withoutLeagueList(tableItems(OUT, 'ingest_targets'));
    // 0012's ALTERs, as column definitions.
    const added = [...M0012.matchAll(/ALTER TABLE ingest_targets ADD COLUMN ([^;]+);/g)].map((m) =>
      norm(m[1] ?? ''),
    );
    expect(added).toHaveLength(4);
    expect(out).toEqual([...src, ...added]);
    expect(out.slice(-4).map((i) => i.split(' ')[0])).toEqual([
      'attempt_started_at',
      'incomplete_attempts',
      'last_ok_at',
      'conference_id',
    ]);
  });

  it('every index and trigger on the six tables is recreated exactly as its last definer wrote it', () => {
    // 0009 is the last file to write games' / game_lines' / ingest_targets'
    // objects; 0010 recreated bets' and bet_legs'; 0011 the ledger's.
    const expected = [
      ...objects(M0009, ['games', 'game_lines', 'ingest_targets']),
      ...objects(M0010, ['bets', 'bet_legs']),
      ...objects(M0011, ['ledger']),
    ].sort();
    // 12 indexes + 5 ledger triggers + 1 bet_legs trigger.
    expect(expected).toHaveLength(18);
    expect(objects(OUT, REBUILT)).toEqual(expected);
  });

  it('copies back every column by name, ingest_targets with the guard columns', () => {
    expect(OUT).toMatch(
      /INSERT INTO ingest_targets \([^)]*attempt_started_at, incomplete_attempts, last_ok_at, conference_id\)/,
    );
    // Never OR IGNORE / OR REPLACE (CLAUDE.md rule 6), and no PRAGMA.
    expect(OUT).not.toMatch(/OR IGNORE|OR REPLACE|PRAGMA/i);
    // The triggers come AFTER the ledger copy-back (or every balance doubles).
    expect(OUT.indexOf('CREATE TRIGGER ledger_ai_apply')).toBeGreaterThan(
      OUT.indexOf('INSERT INTO ledger'),
    );
  });
});
