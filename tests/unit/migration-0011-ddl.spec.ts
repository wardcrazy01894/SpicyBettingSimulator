/**
 * Migration 0011's `CREATE TABLE ledger` and every index and trigger it
 * recreates, compared TEXTUALLY against 0010 — the file that last defined
 * them (PLAN.md §16.2). Node env, like migration-0010-ddl.spec.ts, and for the
 * same reason: the worker pool has already applied 0011, so a before/after
 * `sqlite_master` comparison there compares 0011 with itself.
 *
 * The ONLY permitted difference: `ledger.kind`'s CHECK gains
 * `'deposit_refill'` and `'bust_buyout'` (PLAN.md §4.5).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const read = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
const SRC = read('0010_parlay_25_legs.sql');
const OUT = read('0011_ledger_refill_buyout.sql');

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

describe("0011's ledger matches 0010 except the kind CHECK", () => {
  it('ledger differs by exactly the widened kind CHECK, in the same column position', () => {
    const src = tableItems(SRC, 'ledger');
    const out = tableItems(OUT, 'ledger');
    const removed = src.filter((i) => !out.includes(i));
    const added = out.filter((i) => !src.includes(i));
    expect(removed).toEqual([
      "kind TEXT NOT NULL CHECK (kind IN ('deposit_initial', 'bet_stake', 'bet_payout', 'bet_refund', 'admin_adjust'))",
    ]);
    expect(added).toEqual([
      "kind TEXT NOT NULL CHECK (kind IN ('deposit_initial', 'bet_stake', 'bet_payout', 'bet_refund', 'admin_adjust', 'deposit_refill', 'bust_buyout'))",
    ]);
    const name = (i: string): string => i.split(' ')[0] ?? '';
    expect(out.map(name)).toEqual(src.map(name));
  });

  it('touches no other table', () => {
    expect([...OUT.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1])).toEqual([
      'ledger_copy',
      'ledger',
    ]);
    expect([...OUT.matchAll(/DROP TABLE (\w+)/g)].map((m) => m[1])).toEqual([
      'ledger',
      'ledger_copy',
    ]);
  });

  it('every index and trigger on ledger is recreated exactly as 0010 wrote it', () => {
    const src = objects(SRC, ['ledger']);
    expect(src.length).toBe(8); // 3 indexes + 5 triggers
    expect(objects(OUT, ['ledger'])).toEqual(src);
  });

  it('the copy-back precedes every trigger (ledger_ai_apply must not see the copy)', () => {
    const copyBack = OUT.indexOf('INSERT INTO ledger');
    const firstTrigger = OUT.indexOf('CREATE TRIGGER');
    expect(copyBack).toBeGreaterThan(0);
    expect(firstTrigger).toBeGreaterThan(copyBack);
  });
});
