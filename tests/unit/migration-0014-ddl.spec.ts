/**
 * Migration 0014's `CREATE TABLE bet_legs` and every index and trigger it
 * recreates, compared TEXTUALLY against 0013 — the file that last defined
 * them (PLAN.md §16.2). Node env, like migration-0011-ddl.spec.ts, and for the
 * same reason: the worker pool has already applied 0014, so a before/after
 * `sqlite_master` comparison there compares 0014 with itself.
 *
 * The ONLY permitted differences: `UNIQUE (bet_id, game_id, market)` gains
 * `side`, and the `bet_legs_bi_middle_teaser_only` trigger is new (teaser
 * middles, PLAN.md §5.2d).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const read = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
const SRC = read('0013_basketball_leagues.sql');
const OUT = read('0014_bet_legs_teaser_middle.sql');

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

/** Every CREATE INDEX / CREATE TRIGGER statement on `bet_legs`, normalised. */
function objects(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/CREATE INDEX [^;]+;/g)) {
    if (/\bON bet_legs\b/.test(m[0])) out.push(norm(m[0]));
  }
  for (const m of sql.matchAll(/CREATE TRIGGER [\s\S]+?END;/g)) {
    if (/\bON bet_legs\b/.test(m[0].split('\n')[0] ?? '')) out.push(norm(m[0]));
  }
  return out.sort();
}

describe("0014's bet_legs matches 0013 except the UNIQUE and the new trigger", () => {
  it('bet_legs differs by exactly the widened UNIQUE, in the same position', () => {
    const src = tableItems(SRC, 'bet_legs');
    const out = tableItems(OUT, 'bet_legs');
    expect(src.filter((i) => !out.includes(i))).toEqual(['UNIQUE (bet_id, game_id, market)']);
    expect(out.filter((i) => !src.includes(i))).toEqual(['UNIQUE (bet_id, game_id, market, side)']);
    expect(out.length).toBe(src.length);
    expect(out.indexOf('UNIQUE (bet_id, game_id, market, side)')).toBe(
      src.indexOf('UNIQUE (bet_id, game_id, market)'),
    );
  });

  it('copies every column back, in the order 0013 does', () => {
    const copyBack = (sql: string): string =>
      norm(/INSERT INTO bet_legs \([\s\S]+?FROM bet_legs_copy;/.exec(sql)?.[0] ?? '');
    expect(copyBack(OUT)).not.toBe('');
    expect(copyBack(OUT)).toBe(copyBack(SRC));
  });

  it('touches no other table', () => {
    expect([...OUT.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1])).toEqual([
      'bet_legs_copy',
      'bet_legs',
    ]);
    expect([...OUT.matchAll(/DROP TABLE (\w+)/g)].map((m) => m[1])).toEqual([
      'bet_legs',
      'bet_legs_copy',
    ]);
  });

  it('recreates every index and trigger 0013 wrote on bet_legs, and adds exactly one trigger', () => {
    const src = objects(SRC);
    const out = objects(OUT);
    expect(src.length).toBe(3); // 2 indexes + bet_legs_bi_one_side_per_game
    expect(out.filter((o) => !o.includes('bet_legs_bi_middle_teaser_only'))).toEqual(src);
    expect(out.length).toBe(src.length + 1);
  });

  it('the copy-back precedes both triggers', () => {
    const copyBack = OUT.indexOf('INSERT INTO bet_legs');
    expect(copyBack).toBeGreaterThan(0);
    expect(OUT.indexOf('CREATE TRIGGER')).toBeGreaterThan(copyBack);
  });
});
