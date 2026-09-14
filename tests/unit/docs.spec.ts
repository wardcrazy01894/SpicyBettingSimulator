/**
 * THE DOCS-DRIFT GUARD (CLAUDE.md rule 11).
 *
 * `PLAN.md` is the architecture of record and `CLAUDE.md` is the rulebook. Both
 * are only worth reading if they are true, and prose has no compiler — so the
 * mechanical half of "is this still true?" is asserted here, against the code.
 *
 * WHAT THIS CAN AND CANNOT DO, stated up front so nobody mistakes a green run
 * for a reviewed document. It checks facts that are decidable: a constant's
 * value, an error code's existence, a route literal, a table name, a cell of the
 * teaser card, a cron expression, the gate command. It CANNOT tell you the
 * reasoning is wrong, the design changed, or a paragraph now describes something
 * nobody does. That is still the reviewer's job. What it catches is the drift
 * that actually happens in practice: a number edited in one place, a code added
 * to the enum and nowhere else, a route renamed, a table dropped.
 *
 * Every failure message says WHAT is stale and WHERE, because a docs test that
 * reports `expected true to be false` is a docs test people delete.
 *
 * Runs in the `unit` project (node env) so it can use `node:fs`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/shared/errors.js';
import {
  BET_CUTOFF_BUFFER_MS,
  INITIAL_BANKROLL_CENTS,
  LINE_STALE_MS,
  MAX_PAYOUT_CENTS,
  MAX_SETTLE_ATTEMPTS,
  MIN_STAKE_CENTS,
  SESSION_TTL_MS,
  TEASER_PAYOUTS,
} from '../../src/shared/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const PLAN = read('PLAN.md');
const CLAUDE = read('CLAUDE.md');
const README = read('README.md');
const SCHEMA = read('migrations/0001_init.sql');
const WRANGLER = read('wrangler.jsonc');
const PACKAGE = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/**
 * The text of ONE `##`/`###` section of a markdown file, by its number.
 *
 * Section-scoped rather than whole-file on purpose: "the code `BET_LOCKED`
 * appears somewhere in a 3,000-line document" is a much weaker claim than "it
 * appears in the API surface chapter", and the weaker claim is the one that
 * silently stops being useful.
 */
function section(markdown: string, number: string): string {
  const lines = markdown.split('\n');
  const depth = number.includes('.') ? 3 : 2;
  const open = new RegExp(`^#{${String(depth)}} ${number.replace('.', '\\.')}[. ]`);
  const start = lines.findIndex((line) => open.test(line));
  if (start < 0) throw new Error(`PLAN.md has no §${number} heading — did a chapter get renamed?`);
  // A `##` section runs to the next `##`; a `###` runs to the next heading of
  // either depth.
  const closer = depth === 2 ? /^## / : /^#{2,3} /;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => closer.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Every top-level chapter from `## N.` onward, so §11 means §11.1–§11.6 too. */
function chapter(number: string): string {
  return section(PLAN, number);
}

// ---------------------------------------------------------------------------
// 1. Error codes  <->  PLAN §11
// ---------------------------------------------------------------------------

describe('ERROR_CODES vs PLAN.md §11', () => {
  const api = chapter('11');

  it('documents every code in the enum', () => {
    const undocumented = ERROR_CODES.filter((code) => !api.includes(code));
    expect(
      undocumented,
      `PLAN.md §11 never mentions ${String(undocumented.length)} error code(s) that ` +
        `src/shared/errors.ts exports: ${undocumented.join(', ')}. ` +
        `Add each to §11's vocabulary table with its status and what raises it.`,
    ).toEqual([]);
  });

  /**
   * SCREAMING_SNAKE-in-backticks is also how §11 writes constants, env vars and
   * the enum's own name, so those have to be excluded before the leftovers can
   * be called phantom codes. Kept as an explicit list rather than a clever
   * regex: when this test fires, the reader needs to be able to tell instantly
   * whether the token is a real code or a new non-code that belongs here.
   */
  const NOT_A_CODE = new Set([
    'ERROR_CODES',
    'ERROR_STATUS',
    'INVITE_CODE',
    'IP_HASH_SALT',
    'ESPN_BASE_URL',
    'COOKIE_SECURE',
    'SETTLE_CHUNK',
    'APP_VERSION',
    'KDF_VERSION',
    'CLIENT_KDF',
    'REFRESH_TARGETS_PER_RUN',
  ]);
  /** Suffixes that make a token a quantity, never a wire code. */
  const QUANTITY = /_(CENTS|MS|TENTHS|LEGS|BYTES|ITERATIONS|ATTEMPTS|GAMES|GROUP)$/;

  it('invents no code the enum does not have', () => {
    const known = new Set<string>(ERROR_CODES);
    const phantom = [
      ...new Set(
        [...api.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)]
          .map((m) => m[1] ?? '')
          .filter((token) => !NOT_A_CODE.has(token))
          .filter((token) => !QUANTITY.test(token))
          .filter((token) => !token.startsWith('MAX_') && !token.startsWith('MIN_')),
      ),
    ].filter((token) => !known.has(token));
    expect(
      phantom,
      `PLAN.md §11 names ${String(phantom.length)} error code(s) that do not exist in ` +
        `src/shared/errors.ts: ${phantom.join(', ')}. Either add them to ERROR_CODES, ` +
        `stop documenting them — a code in the docs that no client can ever receive is worse ` +
        `than none — or, if it is not a code at all, add it to this test's NOT_A_CODE list.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Constants  <->  PLAN §3.1's constants-of-record table
// ---------------------------------------------------------------------------

describe('constants.ts vs PLAN.md §3.1', () => {
  /** `| `NAME` | `VALUE` | …` — the table's own shape. */
  const quoted = new Map<string, string>(
    [...PLAN.matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*`([0-9_]+)`\s*\|/gm)].map((m) => [
      m[1] ?? '',
      (m[2] ?? '').replaceAll('_', ''),
    ]),
  );

  const expected: Readonly<Record<string, number>> = {
    INITIAL_BANKROLL_CENTS,
    MIN_STAKE_CENTS,
    MAX_PAYOUT_CENTS,
    BET_CUTOFF_BUFFER_MS,
    LINE_STALE_MS,
    SESSION_TTL_MS,
    MAX_SETTLE_ATTEMPTS,
  };

  for (const [name, value] of Object.entries(expected)) {
    it(`PLAN quotes ${name} as ${String(value)}`, () => {
      const written = quoted.get(name);
      expect(
        written,
        `PLAN.md §3.1's constants-of-record table has no row for \`${name}\`. ` +
          `Add one as: | \`${name}\` | \`${String(value)}\` | … |`,
      ).toBeDefined();
      expect(
        Number(written),
        `PLAN.md §3.1 says ${name} = ${String(written)}, but src/shared/constants.ts ` +
          `says ${String(value)}. One of them changed without the other.`,
      ).toBe(value);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. TEASER_PAYOUTS  <->  PLAN §5.8's card
// ---------------------------------------------------------------------------

describe('TEASER_PAYOUTS vs PLAN.md §5.8', () => {
  /**
   * §5.8 renders the card as `| legs | 6 pt | 6.5 pt | 7 pt |` with signed
   * American values (`−120` uses a UNICODE minus, `+150` a plus). Parsed back to
   * integers and compared cell for cell — a card that is right in the code and
   * wrong in the plan is how somebody hand-prices a teaser at the wrong tier.
   */
  const rows = new Map<number, readonly number[]>(
    [...section(PLAN, '5.8').matchAll(/^\|\s*(\d{1,2})\s*\|([^\n]*)\|\s*$/gm)]
      .map(([, legs, rest]): [number, readonly number[]] => [
        Number(legs),
        (rest ?? '')
          .split('|')
          .map((cell) => cell.trim())
          .filter((cell) => cell !== '')
          .map((cell) => Number(cell.replace('−', '-').replace('+', ''))),
      ])
      .filter(([legs, cells]) => legs >= 2 && legs <= 10 && cells.length === 3),
  );

  it('renders all nine leg counts', () => {
    expect(
      [...rows.keys()].sort((a, b) => a - b),
      `PLAN.md §5.8's teaser card should have one row per leg count 2..10. ` +
        `Parsed: ${JSON.stringify([...rows.keys()])}.`,
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('matches constants.ts cell for cell', () => {
    const mismatches: string[] = [];
    // Column order in the table is 6 pt, 6.5 pt, 7 pt == tenths 60, 65, 70.
    const tiers = [60, 65, 70] as const;
    for (const [legs, cells] of rows) {
      tiers.forEach((tier, column) => {
        const code = TEASER_PAYOUTS[tier][legs as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10];
        const doc = cells[column];
        if (doc !== code) {
          mismatches.push(
            `${String(legs)} legs @ ${String(tier / 10)}pt: PLAN says ${String(doc)}, ` +
              `TEASER_PAYOUTS says ${String(code)}`,
          );
        }
      });
    }
    expect(
      mismatches,
      `PLAN.md §5.8's teaser card disagrees with TEASER_PAYOUTS:\n  ${mismatches.join('\n  ')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Cron expressions  <->  PLAN §9.1
// ---------------------------------------------------------------------------

describe('wrangler.jsonc crons vs PLAN.md §9.1', () => {
  const crons = [...WRANGLER.matchAll(/"((?:[\d*,/-]+\s+){4}[\d*,/-]+)"/g)].map((m) => m[1] ?? '');

  it('finds the three cron expressions in wrangler.jsonc', () => {
    expect(
      crons.length,
      `Expected 3 cron expressions in wrangler.jsonc, parsed ${String(crons.length)}: ` +
        `${JSON.stringify(crons)}. CLAUDE.md's platform table says we use exactly 3 — ` +
        `a fourth needs the per-Worker cap re-checked first.`,
    ).toBe(3);
  });

  it('documents each one in §9.1', () => {
    const triggers = section(PLAN, '9.1');
    const missing = crons.filter((cron) => !triggers.includes(cron));
    expect(
      missing,
      `PLAN.md §9.1 does not list cron expression(s) ${JSON.stringify(missing)} from ` +
        `wrangler.jsonc. §9.1 is where an operator looks to find out what runs when.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Routes  <->  PLAN §11
// ---------------------------------------------------------------------------

describe('src/worker/routes/* vs PLAN.md §11', () => {
  /**
   * Where each router file is mounted, from `src/worker/index.ts`'s route table.
   * Read from the file rather than hard-coded, so adding a router without a
   * `app.route(...)` line — or moving one — surfaces here too.
   */
  const index = read('src/worker/index.ts');
  const mounts = new Map<string, string>(
    [...index.matchAll(/app\.route\('([^']+)',\s*(\w+)Routes\(\)\)/g)].map((m) => [
      m[2] ?? '',
      m[1] ?? '',
    ]),
  );

  const files = ['meta', 'auth', 'games', 'bets', 'bankroll', 'leaderboard', 'admin'] as const;

  it('every router file has exactly one mount in index.ts', () => {
    const unmounted = files.filter((name) => !mounts.has(name));
    expect(
      unmounted,
      `src/worker/index.ts has no app.route(...) line for: ${unmounted.join(', ')}. ` +
        `PLAN.md §16 makes that table one line per track precisely so it cannot be forgotten.`,
    ).toEqual([]);
  });

  it('documents every route path in §11', () => {
    const api = chapter('11');
    const undocumented: string[] = [];

    for (const name of files) {
      const prefix = mounts.get(name) ?? '';
      const source = read(`src/worker/routes/${name}.ts`);
      for (const match of source.matchAll(/app\.(get|post|put|delete)\('([^']*)'/g)) {
        const method = (match[1] ?? '').toUpperCase();
        const path = match[2] ?? '';
        if (path === '*') continue; // middleware mount, not a route
        const full = path === '/' ? prefix : `${prefix}${path}`;
        if (!api.includes(full)) undocumented.push(`${method} ${full}  (routes/${name}.ts)`);
      }
    }

    expect(
      undocumented,
      `PLAN.md §11 never mentions ${String(undocumented.length)} live route(s):\n  ` +
        `${undocumented.join('\n  ')}\n` +
        `An undocumented endpoint is one nobody reviews and nobody knows to test.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Tables  <->  PLAN §3
// ---------------------------------------------------------------------------

describe('migrations/0001_init.sql vs PLAN.md §3', () => {
  const tables = [...SCHEMA.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1] ?? '');

  it('names every table in §3', () => {
    const dataModel = chapter('3');
    const missing = tables.filter((table) => !dataModel.includes(table));
    expect(
      missing,
      `PLAN.md §3 (Data model) never names table(s): ${missing.join(', ')}. ` +
        `§3.2 is supposed to explain the WHY of every table in 0001_init.sql.`,
    ).toEqual([]);
  });

  it('found the schema at all', () => {
    expect(
      tables.length,
      'Parsed zero CREATE TABLE statements out of migrations/0001_init.sql — this test ' +
        'would silently pass forever. Check the regex against the file.',
    ).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// 7. The pre-PR gate  <->  package.json
// ---------------------------------------------------------------------------

describe('the pre-PR gate', () => {
  /** The one-line `npm run … && …` command CLAUDE.md tells you to run. */
  const gate = /npm run typecheck(?: && npm run [\w:]+| && npm test)+/.exec(CLAUDE)?.[0] ?? '';

  it('is present in CLAUDE.md', () => {
    expect(
      gate,
      'CLAUDE.md no longer contains a `npm run typecheck && …` pre-PR gate command.',
    ).not.toBe('');
  });

  it('names only scripts package.json actually defines', () => {
    const scripts = gate
      .split('&&')
      .map((part) => part.trim().replace(/^npm (run )?/, ''))
      .filter((name) => name !== '');
    const undefined_ = scripts.filter((name) => PACKAGE.scripts[name] === undefined);
    expect(
      undefined_,
      `CLAUDE.md's pre-PR gate runs script(s) package.json does not define: ` +
        `${undefined_.join(', ')}. The gate has to be copy-pasteable or nobody runs it.`,
    ).toEqual([]);
  });

  it('is the same command in README.md', () => {
    expect(
      README.includes(gate),
      `README.md's "Before you open a PR" command differs from CLAUDE.md's gate.\n` +
        `  CLAUDE.md: ${gate}\n` +
        `Two gates means one of them is the real one and nobody knows which.`,
    ).toBe(true);
  });

  it('is what CI runs', () => {
    const ci = read('.github/workflows/ci.yml');
    const missing = gate
      .split('&&')
      .map((part) => part.trim())
      .filter((cmd) => !ci.includes(cmd));
    expect(
      missing,
      `.github/workflows/ci.yml does not run: ${missing.join(', ')}. ` +
        `A gate CI does not enforce is a suggestion.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Banned stale phrases
// ---------------------------------------------------------------------------

describe('stale phrases', () => {
  /**
   * Things that were TRUE before M5b and are now false. Each of them, left
   * standing in the prose, sends a reader looking for code that no longer
   * exists — the specific failure this whole file is about.
   */
  const BANNED = [
    'per-league bankroll',
    'season rollover',
    'ensureBankroll prelude',
    'MIXED_LEAGUE_PARLAY is thrown',
  ] as const;

  /**
   * A mention is EXEMPT when its PARAGRAPH is explicitly talking about the past
   * (or about this very rule). History is worth keeping — "this used to be
   * per-league bankrolls, and here is why it isn't" is exactly the note that
   * stops somebody re-proposing it — so the rule is "no unqualified mention",
   * not "never say the words".
   *
   * The unit is the paragraph, not the line, because a history note routinely
   * wraps: the marker can easily sit two lines above the phrase it qualifies.
   * The cost is that a long paragraph containing "replaced" for some unrelated
   * reason can shelter a genuinely stale sentence. That is the right trade — a
   * guard that cries wolf on honest history gets deleted, and this one has to
   * survive to be worth anything.
   */
  const HISTORY =
    /\b(history|superseded|used to|no longer|deprecated|never thrown|replaces?|replaced|deleted|removed|abandoned|stale phrases?|banned)\b/i;
  /** …or a mention that is itself a negation: "No per-league bankrolls". */
  const NEGATED = /\b(no|not|never|nothing|without)\s+$/i;

  const docs: readonly (readonly [string, string])[] = [
    ['PLAN.md', PLAN],
    ['CLAUDE.md', CLAUDE],
    ['README.md', README],
  ];

  for (const [name, text] of docs) {
    it(`${name} states no superseded fact as current`, () => {
      const offences: string[] = [];
      const lines = text.split('\n');

      // Paragraph boundaries, as line indices, so a failure can still name the
      // exact line while the exemption is judged over the whole block.
      let blockStart = 0;
      for (let i = 0; i <= lines.length; i += 1) {
        const atEnd = i === lines.length;
        if (!atEnd && (lines[i] ?? '').trim() !== '') continue;
        const block = lines.slice(blockStart, i);
        const exempt = HISTORY.test(block.join('\n'));
        if (!exempt) {
          block.forEach((line, offset) => {
            for (const phrase of BANNED) {
              const at = line.toLowerCase().indexOf(phrase.toLowerCase());
              if (at < 0) continue;
              if (NEGATED.test(line.slice(0, at))) continue;
              offences.push(
                `${name}:${String(blockStart + offset + 1)}  "${phrase}"  in: ${line.trim()}`,
              );
            }
          });
        }
        blockStart = i + 1;
      }
      expect(
        offences,
        `These lines state a pre-M5b fact as if it were still true:\n  ` +
          `${offences.join('\n  ')}\n` +
          `Either delete them, or mark them as history (say "used to", "no longer", ` +
          `"replaces", "deprecated", or negate them outright).`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. Cross-cutting claims the docs make about each other
// ---------------------------------------------------------------------------

describe('claims the docs make about the repo', () => {
  it('CLAUDE.md carries rule 11 (docs ship with the change)', () => {
    expect(
      /^11\. \*\*Docs are part of the change/m.test(CLAUDE),
      'CLAUDE.md lost rule 11. It is the rule this entire test file enforces; without it ' +
        'the failures below have no documented remedy.',
    ).toBe(true);
  });

  it('the PR template exists and CLAUDE.md points at it', () => {
    const template = read('.github/pull_request_template.md');
    expect(template.length, '.github/pull_request_template.md is empty.').toBeGreaterThan(100);
    expect(
      CLAUDE.includes('.github/pull_request_template.md'),
      'CLAUDE.md does not mention .github/pull_request_template.md, so nothing tells a ' +
        'contributor the checklist exists.',
    ).toBe(true);
  });

  it('the migration freeze story is told the same way in all three places', () => {
    // CLAUDE.md rule 9, PLAN.md §16.1 and the SQL header must agree that 0001 is
    // still editable. When M8 deploys, all three flip together.
    const claims = [
      ['CLAUDE.md', /editable until M8'?s first remote deploy/i.test(CLAUDE)],
      ['PLAN.md', /edited IN PLACE|EDITABLE UNTIL/i.test(PLAN)],
      ['migrations/0001_init.sql', /EDITABLE UNTIL THE FIRST REMOTE DEPLOY/i.test(SCHEMA)],
    ] as const;
    const disagreeing = claims.filter(([, ok]) => !ok).map(([where]) => where);
    expect(
      disagreeing,
      `The "0001 is editable until M8" rule is missing from: ${disagreeing.join(', ')}. ` +
        `All three say it, and all three must flip together the day it is deployed.`,
    ).toEqual([]);
  });
});
