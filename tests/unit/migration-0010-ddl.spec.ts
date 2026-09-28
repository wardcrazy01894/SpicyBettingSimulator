/**
 * Migration 0010's three `CREATE TABLE`s (bets, bet_legs, ledger) and every
 * index and trigger it recreates, compared TEXTUALLY against 0009 — the file
 * that last defined all of them (PLAN.md §16.2). Node env, like
 * migration-0009-ddl.spec.ts, and for the same reason: the worker pool has
 * already applied 0010, so a before/after `sqlite_master` comparison there
 * compares 0010 with itself.
 *
 * The ONLY permitted differences: `bets.leg_count`'s CHECK goes from
 * `BETWEEN 1 AND 10` to `BETWEEN 1 AND 25` (MAX_PARLAY_LEGS), and `bets`
 * gains one table constraint holding a teaser to MAX_TEASER_LEGS (10), which
 * the old column CHECK used to cover for free.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_PARLAY_LEGS, MAX_TEASER_LEGS } from '../../src/shared/constants.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const read = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
const SRC = read('0009_mlb_league.sql');
const OUT = read('0010_parlay_25_legs.sql');

const REBUILT = ['bets', 'bet_legs', 'ledger'] as const;

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

describe("0010's rebuilt tables match 0009 except the leg-count CHECKs", () => {
  it('the new caps are the constants', () => {
    expect(MAX_PARLAY_LEGS).toBe(25);
    expect(MAX_TEASER_LEGS).toBe(10);
  });

  it('bet_legs and ledger are byte-for-byte 0009 (modulo whitespace)', () => {
    expect(tableItems(OUT, 'bet_legs')).toEqual(tableItems(SRC, 'bet_legs'));
    expect(tableItems(OUT, 'ledger')).toEqual(tableItems(SRC, 'ledger'));
  });

  it('bets differs by exactly the leg_count CHECK and one added teaser constraint', () => {
    const src = tableItems(SRC, 'bets');
    const out = tableItems(OUT, 'bets');
    const removed = src.filter((i) => !out.includes(i));
    const added = out.filter((i) => !src.includes(i));
    expect(removed).toEqual(['leg_count INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND 10)']);
    expect(added).toEqual([
      `leg_count INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND ${String(MAX_PARLAY_LEGS)})`,
      `CHECK (bet_type <> 'teaser' OR leg_count <= ${String(MAX_TEASER_LEGS)})`,
    ]);
    // Physical column order is unchanged: the new line sits where the old one did.
    const name = (i: string): string => i.split(' ')[0] ?? '';
    const isColumn = (i: string): boolean => !/^(UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY)\b/.test(i);
    expect(out.filter(isColumn).map(name)).toEqual(src.filter(isColumn).map(name));
  });

  it('every index and trigger on the three tables is recreated exactly as 0009 wrote it', () => {
    const src = objects(SRC, REBUILT);
    expect(src.length).toBe(14); // 8 indexes + 5 ledger triggers + 1 bet_legs trigger
    expect(objects(OUT, REBUILT)).toEqual(src);
  });
});
