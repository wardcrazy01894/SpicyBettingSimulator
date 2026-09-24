/**
 * Migration 0009's six `CREATE TABLE`s, compared TEXTUALLY against the DDL
 * they replace (PLAN.md §23.3). Node env, reading the migration files with fs
 * like docs.spec.ts does.
 *
 * WHY THIS IS A UNIT TEST. tests/worker/migration-0009.spec.ts re-runs 0009 on
 * a pool that has ALREADY applied it, so for TABLES its before/after
 * `sqlite_master.sql` comparison compares 0009 with itself and proves nothing
 * (its trigger and index checks are against source SQL and do prove
 * something). A rebuild that silently dropped a CHECK, a DEFAULT or a
 * REFERENCES while widening the league CHECK would pass there. Here each
 * rebuilt table is compared with the most recent definition of that table in
 * 0001–0008 — its last `CREATE TABLE <name> (` plus every later
 * `ALTER TABLE <name> ADD COLUMN` appended in file order, which is SQLite's
 * physical column order — and the ONLY permitted difference is `'mlb'` added
 * to the `league` CHECK of games, bets, bet_legs and ingest_targets.
 *
 * Sources that result: games / game_lines / ingest_targets from 0001 (+0004's
 * and 0007's ADD COLUMNs); bets and ledger from 0005 (which rebuilt them; its
 * ledger is 0001's verbatim); bet_legs from 0008.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const read = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');

const REBUILT = ['games', 'game_lines', 'bets', 'bet_legs', 'ledger', 'ingest_targets'] as const;
const WIDENED = new Set(['games', 'bets', 'bet_legs', 'ingest_targets']);

/** Collapse whitespace so formatting never counts as a difference. */
function norm(item: string): string {
  return item
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** The parenthesised body of `CREATE TABLE <name> (`, split at top-level commas. */
function tableItems(sql: string, name: string): string[] | null {
  const head = new RegExp(`CREATE TABLE ${name} \\(`, 'g');
  let last: RegExpExecArray | null = null;
  for (const m of sql.matchAll(head)) last = m;
  if (last === null) return null;
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = last.index + last[0].length; i < sql.length; i += 1) {
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

const isConstraint = (item: string): boolean =>
  /^(UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY|CONSTRAINT)\b/.test(item);

interface Shape {
  readonly columns: string[];
  readonly constraints: string[];
  readonly source: string;
}

function split(items: readonly string[], source: string): Shape {
  return {
    columns: items.filter((i) => !isConstraint(i)),
    constraints: items.filter(isConstraint),
    source,
  };
}

/** The table as 0001–0008 leave it. */
function before(name: string): Shape {
  let shape: Shape | null = null;
  for (const file of FILES) {
    if (file >= '0009') break;
    const sql = read(file);
    const created = tableItems(sql, name);
    if (created !== null) shape = split(created, file);
    const alter = new RegExp(`ALTER TABLE ${name} ADD COLUMN ([^;]+);`, 'g');
    for (const m of sql.matchAll(alter)) {
      if (shape === null) throw new Error(`${file} alters ${name} before it exists`);
      shape = { ...shape, columns: [...shape.columns, norm(m[1] ?? '')] };
    }
  }
  if (shape === null) throw new Error(`no source for ${name}`);
  return shape;
}

function after(name: string): Shape {
  const file = FILES.find((f) => f.startsWith('0009'));
  if (file === undefined) throw new Error('0009 is missing');
  const items = tableItems(read(file), name);
  if (items === null) throw new Error(`0009 does not create ${name}`);
  return split(items, file);
}

/** Undo exactly the one permitted change, so everything else must match. */
const unwiden = (item: string): string => item.replace("'ncaaf', 'mlb'", "'ncaaf'");

describe("0009's rebuilt tables match their sources except the league CHECK", () => {
  it('each table resolves to the expected source file', () => {
    expect(Object.fromEntries(REBUILT.map((t) => [t, before(t).source]))).toEqual({
      games: '0001_init.sql',
      game_lines: '0001_init.sql',
      bets: '0005_bets_teaser_tiers.sql',
      bet_legs: '0008_bet_legs_same_game.sql',
      ledger: '0005_bets_teaser_tiers.sql',
      ingest_targets: '0001_init.sql',
    });
  });

  for (const table of REBUILT) {
    it(`${table}: same columns in the same physical order, same table constraints`, () => {
      const src = before(table);
      const out = after(table);
      expect(src.columns.length).toBeGreaterThan(5);
      // Physical order matters: 0009 copies rows with explicit column lists,
      // but a `SELECT *` anywhere downstream would read by position.
      expect(out.columns.map((c) => c.split(' ')[0])).toEqual(
        src.columns.map((c) => c.split(' ')[0]),
      );
      expect(out.constraints).toEqual(src.constraints);

      const changed = out.columns.filter((c, i) => c !== src.columns[i]);
      if (WIDENED.has(table)) {
        // Exactly one line differs — the league CHECK — and only by 'mlb'.
        expect(changed).toHaveLength(1);
        expect(changed[0]).toMatch(/^league TEXT NOT NULL CHECK \(league IN \(/);
        expect(changed[0]).toContain("'mlb'");
        expect(out.columns.map(unwiden)).toEqual(src.columns);
      } else {
        expect(changed).toEqual([]);
      }
    });
  }

  it('the four widened CHECKs are exactly the four league lines, nothing else anywhere', () => {
    const diffs = REBUILT.flatMap((t) => {
      const src = before(t);
      return after(t)
        .columns.filter((c, i) => c !== src.columns[i])
        .map((c) => `${t}: ${c}`);
    });
    expect(diffs).toEqual([
      "games: league TEXT NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb'))",
      "bets: league TEXT NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb', 'mixed'))",
      "bet_legs: league TEXT NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb'))",
      "ingest_targets: league TEXT NOT NULL CHECK (league IN ('nfl', 'ncaaf', 'mlb'))",
    ]);
  });
});
