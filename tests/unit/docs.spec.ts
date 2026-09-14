/**
 * THE DOCS-DRIFT GUARD (CLAUDE.md rule 11).
 *
 * `PLAN.md` is the architecture of record, `CLAUDE.md` is the rulebook and
 * `docs/OPERATIONS.md` is the runbook somebody reads under pressure. All three
 * are only worth reading if they are true, and prose has no compiler — so the
 * mechanical half of "is this still true?" is asserted here, against the code.
 *
 * WHAT THIS CAN AND CANNOT DO, stated up front so nobody mistakes a green run
 * for a reviewed document. It checks facts that are decidable: a constant's
 * value, an error code's existence, a route literal, a table name, a trigger
 * name, a cell of the teaser card, a cron expression, a secret name, a live URL,
 * the gate command. It CANNOT tell you the
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/shared/errors.js';
import {
  BET_CUTOFF_BUFFER_MS,
  INITIAL_BANKROLL_CENTS,
  LINE_STALE_MS,
  MAX_PARLAY_LEGS,
  MAX_PAYOUT_CENTS,
  MAX_SETTLE_ATTEMPTS,
  MIN_STAKE_CENTS,
  MIN_TEASER_LEGS,
  SESSION_TTL_MS,
  TEASER_PAYOUTS,
  TEASER_POINTS_TENTHS,
  VOID_AFTER_MS,
} from '../../src/shared/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const PLAN = read('PLAN.md');
const CLAUDE = read('CLAUDE.md');
const README = read('README.md');
const OPERATIONS = read('docs/OPERATIONS.md');
const PR_TEMPLATE = read('.github/pull_request_template.md');
const SCHEMA = read('migrations/0001_init.sql');
const WRANGLER = read('wrangler.jsonc');
const ENV_TS = read('src/worker/env.ts');
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

/**
 * The text of ONE numbered rule in CLAUDE.md's "Non-negotiable conventions",
 * from `N.` to `N+1.` at the left margin.
 *
 * Scoped, not whole-file, for the same reason `section()` is: "the word FROZEN
 * appears somewhere in CLAUDE.md" stays true after rule 9 has been reverted,
 * because four other paragraphs also say it. The claim worth asserting is that
 * THE RULE says it.
 */
function claudeRule(number: string): string {
  const lines = CLAUDE.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${number}. `));
  if (start < 0) {
    throw new Error(`CLAUDE.md has no rule ${number} — did the conventions get renumbered?`);
  }
  const next = new RegExp(`^${String(Number(number) + 1)}\\. `);
  // Inclusive of the `N.` line itself — that is where the rule's own claim sits.
  const rest = lines.slice(start);
  const end = rest.findIndex((line, i) => i > 0 && (next.test(line) || line.startsWith('---')));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The one `- [ ]` checklist item of the PR template that mentions `needle`. */
function templateItemAbout(needle: string): string {
  const items = PR_TEMPLATE.split(/^- \[ \] /m).filter((item) => item.includes(needle));
  if (items.length !== 1) {
    throw new Error(
      `.github/pull_request_template.md has ${String(items.length)} checklist items ` +
        `mentioning "${needle}"; expected exactly 1.`,
    );
  }
  return items[0] ?? '';
}

// ---------------------------------------------------------------------------
// The live route table, read once and shared by several suites below.
// ---------------------------------------------------------------------------

/**
 * `src/worker/index.ts` with every comment line removed.
 *
 * Load-bearing: the file's header JSDoc reproduces the whole route table as an
 * EXAMPLE, in the same `app.route('/api/x', xRoutes())` syntax. Matching the raw
 * file therefore finds every mount twice, and deleting a real `app.route(...)`
 * line leaves the commented copy behind — so this test would keep passing and
 * only `tsc` would notice. Stripping comments is what makes a deleted mount fail
 * HERE, which is where the docs claim lives.
 */
const WORKER_INDEX_CODE = read('src/worker/index.ts')
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
  })
  .join('\n');

/** Router name (`bets`) -> mounted prefix (`/api/bets`), from the route table. */
const MOUNTS = new Map<string, string>(
  [...WORKER_INDEX_CODE.matchAll(/app\.route\('([^']+)',\s*(\w+)Routes\(\)\)/g)].map((m) => [
    m[2] ?? '',
    m[1] ?? '',
  ]),
);

/**
 * Every file in `src/worker/routes/`, listed from disk rather than hard-coded.
 * A hard-coded list silently stops covering a router the day somebody adds one,
 * which is exactly when the coverage was needed.
 */
const ROUTE_FILES: readonly string[] = readdirSync(join(ROOT, 'src', 'worker', 'routes'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

interface LiveRoute {
  readonly method: string;
  /** Full path including the mounted prefix, e.g. `/api/admin/jobs/:job`. */
  readonly path: string;
  readonly file: string;
}

const LIVE_ROUTES: readonly LiveRoute[] = ROUTE_FILES.flatMap((name) => {
  const prefix = MOUNTS.get(name) ?? '';
  const source = read(`src/worker/routes/${name}.ts`);
  return [...source.matchAll(/app\.(get|post|put|delete)\('([^']*)'/g)]
    .map((match) => ({ method: (match[1] ?? '').toUpperCase(), raw: match[2] ?? '' }))
    .filter(({ raw }) => raw !== '*') // middleware mount, not a route
    .map(({ method, raw }) => ({
      method,
      path: raw === '/' ? prefix : `${prefix}${raw}`,
      file: name,
    }));
});

/** Does `path` match a live route, treating `:param` as a wildcard segment? */
function isLiveRoute(path: string): boolean {
  const wanted = path.split('/');
  return LIVE_ROUTES.some(({ path: pattern }) => {
    const segments = pattern.split('/');
    if (segments.length !== wanted.length) return false;
    return segments.every((seg, i) => seg.startsWith(':') || seg === wanted[i]);
  });
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
    // §11.7 bug reports: two vars, a secret and a limit.
    'GITHUB_REPO',
    'GITHUB_API_BASE_URL',
    'GITHUB_TOKEN',
    'BUG_REPORTS_PER_WINDOW',
    'BUG_REPORT_USER_AGENT_MAX',
    'BUG_REPORT_DIAGNOSTICS_MAX',
    'CLIENT_ERROR_BEACON_MAX',
    'SLOW_REQUEST_MS',
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
    VOID_AFTER_MS,
    MAX_PARLAY_LEGS,
    MIN_TEASER_LEGS,
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

  /**
   * The teaser tiers are a LIST, not a scalar, so they cannot live in the
   * `| NAME | VALUE |` table the loop above parses. Asserted separately rather
   * than left undocumented: getting 6.5 points wrong by a factor of ten (65 vs
   * 6.5) is the exact mistake the tenths convention exists to prevent.
   */
  it('PLAN spells out TEASER_POINTS_TENTHS', () => {
    const rendered = `TEASER_POINTS_TENTHS = [${TEASER_POINTS_TENTHS.join(', ')}]`;
    expect(
      PLAN.includes(rendered),
      `PLAN.md §3.1 does not say \`${rendered}\`, which is what ` +
        `src/shared/constants.ts exports. The tiers are TENTHS of a point ` +
        `(6 / 6.5 / 7 pt); a doc that writes them as points is how a 6.5-point ` +
        `teaser gets priced as a 65-point one.`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b. wrangler.jsonc `vars`  <->  PLAN §9.1
// ---------------------------------------------------------------------------

describe('wrangler.jsonc vars vs PLAN.md §9.1', () => {
  /** `"NAME": "123",` out of the `vars` block. */
  const vars = new Map<string, string>(
    [...WRANGLER.matchAll(/"([A-Z][A-Z0-9_]+)":\s*"(\d+)"/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
  const triggers = section(PLAN, '9.1');

  for (const name of ['REFRESH_TARGETS_PER_RUN', 'SETTLE_CHUNK'] as const) {
    it(`§9.1 quotes ${name} as wrangler.jsonc sets it`, () => {
      const configured = vars.get(name);
      expect(
        configured,
        `wrangler.jsonc has no numeric \`vars.${name}\`. Both Spike S1 and Spike S2 ` +
          `are gated on these two knobs; losing one loses the gate.`,
      ).toBeDefined();
      const written = new RegExp(`\`${name}\`\\s*\\|\\s*\`(\\d+)\``).exec(triggers)?.[1];
      expect(
        written,
        `PLAN.md §9.1 has no row for \`${name}\`. Add it to the tuning-vars table as: ` +
          `| \`${name}\` | \`${String(configured)}\` | … |`,
      ).toBeDefined();
      expect(
        written,
        `PLAN.md §9.1 says ${name} = ${String(written)}, but wrangler.jsonc deploys ` +
          `${String(configured)}. The Worker runs the second one.`,
      ).toBe(configured);
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
  const card = section(PLAN, '5.8');
  /** The header row `| legs | 3 pt | 4 pt | … |` names the tiers, in TENTHS. */
  const headerTiers = (/^\|\s*legs\s*\|([^\n]*)\|\s*$/m.exec(card)?.[1] ?? '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')
    .map((cell) => Number(cell.replace(/\s*pt$/, '')) * 10);
  const rows = new Map<number, readonly number[]>(
    [...card.matchAll(/^\|\s*(\d{1,2})\s*\|([^\n]*)\|\s*$/gm)]
      .map(([, legs, rest]): [number, readonly number[]] => [
        Number(legs),
        (rest ?? '')
          .split('|')
          .map((cell) => cell.trim())
          .filter((cell) => cell !== '')
          .map((cell) => Number(cell.replace('−', '-').replace('+', ''))),
      ])
      .filter(([legs, cells]) => legs >= 2 && legs <= 10 && cells.length === headerTiers.length),
  );

  it('the header names exactly TEASER_POINTS_TENTHS, in order', () => {
    expect(headerTiers).toEqual([...TEASER_POINTS_TENTHS]);
  });

  it('renders all nine leg counts', () => {
    expect(
      [...rows.keys()].sort((a, b) => a - b),
      `PLAN.md §5.8's teaser card should have one row per leg count 2..10. ` +
        `Parsed: ${JSON.stringify([...rows.keys()])}.`,
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('matches constants.ts cell for cell', () => {
    const mismatches: string[] = [];
    // Column order in the table is the header's, which the test above pins to
    // TEASER_POINTS_TENTHS.
    for (const [legs, cells] of rows) {
      TEASER_POINTS_TENTHS.forEach((tier, column) => {
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

  it('documents each one in docs/OPERATIONS.md', () => {
    const missing = crons.filter((cron) => !OPERATIONS.includes(cron));
    expect(
      missing,
      `docs/OPERATIONS.md does not list cron expression(s) ${JSON.stringify(missing)} from ` +
        `wrangler.jsonc. The runbook is what somebody reads at 2am to answer "should ` +
        `something have run by now?" — a schedule it does not know about is one nobody ` +
        `notices has stopped.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Routes  <->  PLAN §11
// ---------------------------------------------------------------------------

describe('src/worker/routes/* vs PLAN.md §11', () => {
  it('found some routers on disk at all', () => {
    expect(
      ROUTE_FILES.length,
      'readdirSync found no .ts files in src/worker/routes — this suite would pass ' +
        'vacuously forever. Check the path.',
    ).toBeGreaterThan(3);
  });

  it('every router file has exactly one mount in index.ts', () => {
    const unmounted = ROUTE_FILES.filter((name) => !MOUNTS.has(name));
    expect(
      unmounted,
      `src/worker/index.ts has no app.route(...) line for: ${unmounted.join(', ')}. ` +
        `(Comment lines are stripped before matching, so the route table reproduced in ` +
        `that file's header JSDoc does NOT count as a mount.) ` +
        `PLAN.md §16 makes that table one line per track precisely so it cannot be forgotten.`,
    ).toEqual([]);
  });

  it('mounts nothing that is not a file in src/worker/routes', () => {
    const orphans = [...MOUNTS.keys()].filter((name) => !ROUTE_FILES.includes(name));
    expect(
      orphans,
      `src/worker/index.ts mounts ${orphans.join(', ')}, for which there is no ` +
        `src/worker/routes/<name>.ts. Either the file moved or the mount is stale.`,
    ).toEqual([]);
  });

  it('documents every route path in §11', () => {
    const api = chapter('11');
    const undocumented = LIVE_ROUTES.filter(({ path }) => !api.includes(path)).map(
      ({ method, path, file }) => `${method} ${path}  (routes/${file}.ts)`,
    );

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

  /**
   * The triggers ARE the money invariants (CLAUDE.md rule 6): the ledger is the
   * only writer of `balance_cents`, the overdraft guard is unsuppressable, the
   * ledger is append-only. A trigger that exists in the schema and in nobody's
   * documentation is one a reader will eventually "clean up", and the `CHECK`
   * left behind does not catch what it caught (§4.2 spells out why).
   *
   * By NAME rather than by count: a count is a number that goes stale silently
   * and tells you nothing about which one is missing.
   */
  const triggers = [...SCHEMA.matchAll(/^CREATE TRIGGER (\w+)/gm)].map((m) => m[1] ?? '');

  it('names every trigger in PLAN §4', () => {
    const money = chapter('4');
    const missing = triggers.filter((name) => !money.includes(name));
    expect(
      missing,
      `PLAN.md §4 (Money, ledger and invariants) never names trigger(s): ` +
        `${missing.join(', ')}. §4.1 lists the invariant and §4.2 shows the DDL — an ` +
        `undocumented trigger is one somebody deletes as dead weight.`,
    ).toEqual([]);
  });

  it('found the triggers at all', () => {
    expect(
      triggers.length,
      'Parsed zero CREATE TRIGGER statements out of migrations/0001_init.sql. The money ' +
        'invariants live in those triggers; a regex that matches none of them makes this ' +
        'suite pass vacuously.',
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
    // Pre-deploy migration policy. `0001_init.sql` has been applied to the live
    // remote D1 and recorded in `d1_migrations`; it is frozen, and a document
    // still saying otherwise is an instruction to break production.
    'editable until',
    'edit 0001 in place',
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
    ['docs/OPERATIONS.md', OPERATIONS],
    ['.github/pull_request_template.md', PR_TEMPLATE],
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
  /**
   * Site icons. The assets binding serves index.html with a 200 for ANY unknown
   * path (`not_found_handling: single-page-application`), so a `<link>` to an
   * icon that is not in public/ fails silently: the browser downloads HTML as an
   * image and no request ever 404s. This is the only place it can be caught.
   *
   * Attributes are pulled out of each `<link>` INDEPENDENTLY, and the set of
   * hrefs is asserted exactly, so neither reordering `rel`/`href` nor dropping a
   * link can slip past.
   */
  const ICON_RELS = new Set(['icon', 'apple-touch-icon', 'manifest']);
  const EXPECTED_ICON_LINKS = [
    '/favicon.ico',
    '/favicon.svg',
    '/apple-touch-icon.png',
    '/site.webmanifest',
  ].sort();

  function iconLinks(html: string): string[] {
    return [...html.matchAll(/<link\b[^>]*>/g)]
      .map((tag) => ({
        rel: /\brel="([^"]*)"/.exec(tag[0])?.[1] ?? '',
        href: /\bhref="([^"]*)"/.exec(tag[0])?.[1] ?? '',
      }))
      .filter(({ rel }) => ICON_RELS.has(rel))
      .map(({ href }) => href);
  }

  it('index.html links exactly the expected icons, and each exists in public/', () => {
    const hrefs = iconLinks(read('index.html')).sort();
    expect(hrefs).toEqual(EXPECTED_ICON_LINKS);
    for (const ref of hrefs) {
      expect(
        existsSync(join(ROOT, 'public', ref.slice(1))),
        `${ref} is linked from index.html but public/${ref.slice(1)} does not exist`,
      ).toBe(true);
    }
  });

  it('every icon site.webmanifest lists exists in public/', () => {
    const manifest = JSON.parse(read('public/site.webmanifest')) as {
      icons?: readonly { src: string }[];
    };
    const srcs = (manifest.icons ?? []).map((icon) => icon.src);
    expect(srcs.length, 'site.webmanifest lists no icons').toBeGreaterThan(0);
    for (const ref of srcs) {
      expect(ref.startsWith('/'), `${ref} must be site-root-relative`).toBe(true);
      expect(
        existsSync(join(ROOT, 'public', ref.slice(1))),
        `${ref} is listed in site.webmanifest but public/${ref.slice(1)} does not exist`,
      ).toBe(true);
    }
  });

  /**
   * The rasters are generated by `npm run icons` and committed. Nothing can
   * prove they match the SVG without sharp, but the PNG header (IHDR: width and
   * height as big-endian u32 at bytes 16 and 20) proves each is the size its
   * NAME and its `<link>`/manifest entry claim — which catches the "regenerated
   * at the wrong size" class of drift for free.
   */
  it.each([
    ['public/favicon-32.png', 32],
    ['public/favicon-192.png', 192],
    ['public/favicon-512.png', 512],
    ['public/apple-touch-icon.png', 180],
  ])('%s is a %ipx square PNG', (relative, size) => {
    const bytes = readFileSync(join(ROOT, relative));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  });

  /**
   * The dependency ceilings live in two places by necessity — PLAN §15's
   * "Why not latest" table says WHY, `.github/dependabot.yml`'s `ignore` list
   * makes Dependabot stop proposing them — and the PLAN sentence under the
   * table promises they name the same packages. This is that promise, in BOTH
   * directions, against the TABLE (not the whole chapter, which mentions
   * `wrangler` and `vite` in passing and would let an undocumented ignore in).
   */
  it('dependabot.yml ignores exactly the packages PLAN §15 pins, and vice versa', () => {
    const dependabot = read('.github/dependabot.yml');
    const ignored = [...dependabot.matchAll(/^\s+- dependency-name: '?([^'\n]+?)'?$/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(ignored.length, 'dependabot.yml has no ignore entries').toBeGreaterThan(0);

    const m15 = section(PLAN, '15');
    const tableStart = m15.indexOf('| Package');
    expect(tableStart, 'PLAN §15 lost its "Why not latest" table').toBeGreaterThan(-1);
    const table = m15.slice(tableStart).split('\n\n')[0] ?? '';
    const pinned = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1] ?? '');
    expect(pinned.length).toBeGreaterThan(0);

    expect(
      [...ignored].sort(),
      'dependabot.yml `ignore` and the packages in PLAN §15\'s "Why not latest" table differ. ' +
        'Every ignore needs a table row saying why, and every row needs an ignore so Dependabot ' +
        'stops proposing the bump the table says we cannot take.',
    ).toEqual([...pinned].sort());
  });

  /**
   * The runbook's "Applied migrations" table is the operator's record of what
   * the live database has. A migration file nobody added to it is exactly the
   * one somebody will be surprised by at 2am.
   */
  it('every file in migrations/ is in the docs/OPERATIONS.md migrations table', () => {
    const files = readdirSync(join(ROOT, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(
        OPERATIONS.includes(`\`${file}\``),
        `migrations/${file} is not in docs/OPERATIONS.md's "Applied migrations" table.`,
      ).toBe(true);
    }
  });

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

  /**
   * THE MIGRATION FREEZE.
   *
   * `migrations/0001_init.sql` was applied to the live remote D1 on 2026-09-14
   * and D1 recorded it in `d1_migrations`, so `wrangler d1 migrations apply`
   * will never replay it. An edit to `0001` therefore reaches nothing: the repo
   * and production diverge silently and permanently.
   *
   * This assertion used to say the OPPOSITE — it pinned "0001 is editable until
   * M8" into all three documents, which turned the drift guard into a guard
   * AGAINST correcting them. It is inverted deliberately. A docs test can only
   * ever pin the state of the world it was written in; when the world moves, the
   * test moves with it, and the thing that must never happen is a test that
   * fails when somebody tells the truth.
   */
  it('says 0001 is FROZEN in all four places', () => {
    const FROZEN = /\bFROZEN\b/;
    /** …and says what to do instead: a new numbered migration. */
    const NUMBERED = /new\s+numbered\s+(?:`?(?:migrations\/)?000N|migration)/i;

    const claims = [
      ['CLAUDE.md rule 9', claudeRule('9')],
      ['.github/pull_request_template.md', templateItemAbout('0001_init.sql')],
      ['PLAN.md §16.1', section(PLAN, '16.1')],
      ['migrations/0001_init.sql header', SCHEMA.slice(0, 2000)],
    ] as const;

    const notFrozen = claims.filter(([, text]) => !FROZEN.test(text)).map(([where]) => where);
    expect(
      notFrozen,
      `These do not say \`migrations/0001_init.sql\` is FROZEN: ${notFrozen.join(', ')}. ` +
        `It is applied to the live D1 and recorded in d1_migrations; a document that ` +
        `invites an edit to it is a document that invites silent prod drift.`,
    ).toEqual([]);

    const noRemedy = claims.filter(([, text]) => !NUMBERED.test(text)).map(([where]) => where);
    expect(
      noRemedy,
      `These say 0001 is frozen but never say what to do INSTEAD: ${noRemedy.join(', ')}. ` +
        `Each must name the remedy — a new numbered migrations/000N_*.sql — or a ` +
        `contributor with a schema change has nowhere to put it.`,
    ).toEqual([]);
  });

  /**
   * The phrases themselves are banned by the stale-phrase suite above (which
   * exempts history-marked paragraphs). This asserts the OTHER half: that
   * `0001`'s own header carries a history marker, so the paragraph explaining
   * the closed pre-deploy window is allowed to exist without either lying or
   * being deleted.
   */
  it('0001_init.sql marks the closed pre-deploy window as history', () => {
    const header = SCHEMA.slice(0, 2000);
    expect(
      /\b(history|no longer|used to|closed|superseded)\b/i.test(header),
      `migrations/0001_init.sql's header explains a rule that is no longer in force ` +
        `without marking it as history. Say so explicitly, or the next reader takes the ` +
        `old rule as current.`,
    ).toBe(true);
  });

  /**
   * MF5: README said "Live at …" while CLAUDE.md said "nothing is deployed yet".
   * The prose contradiction is a judgement call this file cannot make — but the
   * URL is mechanical, and a URL that differs by a character between documents
   * is the same bug in a form the test CAN catch.
   */
  it('spells the live URL identically everywhere it appears', () => {
    // Built fresh per use: a /g regex carries `lastIndex` between calls, and a
    // stateful matcher inside a `.filter()` reports different answers for the
    // same input depending on iteration order.
    const origins = (text: string): string[] =>
      [...text.matchAll(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi)].map((m) => m[0]);

    const where: readonly (readonly [string, string])[] = [
      ['README.md', README],
      ['docs/OPERATIONS.md', OPERATIONS],
      ['CLAUDE.md', CLAUDE],
      ['PLAN.md §15', section(PLAN, '15')],
    ];

    const silent = where.filter(([, text]) => origins(text).length === 0).map(([name]) => name);
    expect(
      silent,
      `No *.workers.dev URL in: ${silent.join(', ')}. The app IS deployed; a document ` +
        `that does not say where is one a reader concludes it is not.`,
    ).toEqual([]);

    const distinct = new Set(where.flatMap(([, text]) => origins(text)));
    expect(
      [...distinct],
      `The live URL is written ${String(distinct.size)} different ways across README, ` +
        `docs/OPERATIONS.md, CLAUDE.md and PLAN §15: ${[...distinct].join(' | ')}. ` +
        `Exactly one of them can be right.`,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. docs/OPERATIONS.md  <->  the things an operator actually types
// ---------------------------------------------------------------------------

/**
 * The runbook is the document read under pressure, by somebody who is not
 * reading the code. Every command in it is a promise that the flag, the route
 * and the secret name still exist. These are the cheap halves of that promise.
 */
describe('docs/OPERATIONS.md vs the code', () => {
  it('names only routes the Worker actually serves', () => {
    // `/api/...` up to whitespace or markdown punctuation; `{a|b|c}` is the
    // runbook's shorthand for one path parameter, so it collapses to a segment.
    const cited = [
      ...new Set(
        [...OPERATIONS.matchAll(/\/api\/[A-Za-z0-9:_{}|/-]*[A-Za-z0-9}]/g)].map((m) =>
          m[0].replace(/\{[^}]*\}/g, ':param'),
        ),
      ),
    ];
    const dead = cited.filter((path) => !isLiveRoute(path));
    expect(
      dead,
      `docs/OPERATIONS.md tells an operator to call ${String(dead.length)} route(s) that ` +
        `src/worker/routes/* does not serve:\n  ${dead.join('\n  ')}\n` +
        `A runbook command that 404s is worse than no runbook.`,
    ).toEqual([]);
    expect(
      cited.length,
      'Parsed no /api/... routes out of docs/OPERATIONS.md — the regex stopped matching ' +
        'and this assertion is now vacuous.',
    ).toBeGreaterThan(2);
  });

  it('names every secret src/worker/env.ts declares', () => {
    // Optional `readonly NAME?: string;` entries are the `wrangler secret put`
    // ones; the required entries are `vars` and live in wrangler.jsonc.
    const secrets = [...ENV_TS.matchAll(/readonly ([A-Z][A-Z0-9_]+)\?: string;/g)].map(
      (m) => m[1] ?? '',
    );
    expect(
      secrets.length,
      'Parsed no optional secrets out of src/worker/env.ts; check the regex.',
    ).toBeGreaterThan(1);
    const missing = secrets.filter((name) => !OPERATIONS.includes(name));
    expect(
      missing,
      `docs/OPERATIONS.md never mentions secret(s) ${missing.join(', ')}, which ` +
        `src/worker/env.ts reads. A secret nobody knows to set is an outage on the next ` +
        `fresh deploy — and "Secrets (set once; rotate with the same command)" is the ` +
        `only place that list exists.`,
    ).toEqual([]);
  });

  it('runs only npm scripts package.json defines', () => {
    const scripts = [...new Set([...OPERATIONS.matchAll(/npm run ([\w:]+)/g)].map((m) => m[1]))];
    const undefined_ = scripts.filter((name) => PACKAGE.scripts[name ?? ''] === undefined);
    expect(
      undefined_,
      `docs/OPERATIONS.md runs npm script(s) package.json does not define: ` +
        `${undefined_.join(', ')}.`,
    ).toEqual([]);
  });

  it('uses --remote where it targets production', () => {
    expect(
      OPERATIONS.includes(PACKAGE.scripts['db:migrate:remote'] ?? ' '),
      `docs/OPERATIONS.md's migration command is not \`${String(PACKAGE.scripts['db:migrate:remote'])}\` ` +
        `(package.json's db:migrate:remote). Two spellings of the deploy-time schema ` +
        `command is how one of them ends up without --remote.`,
    ).toBe(true);
    expect(
      /npm run db:reconcile\s+--\s+--remote/.test(OPERATIONS),
      'docs/OPERATIONS.md must reconcile with `npm run db:reconcile -- --remote`. ' +
        'Without the `--` npm swallows the flag and the script silently checks the LOCAL ' +
        'database, reporting "no drift" about the wrong D1.',
    ).toBe(true);
    expect(
      read('scripts/reconcile.mjs').includes("'--remote'"),
      "scripts/reconcile.mjs no longer recognises '--remote', which docs/OPERATIONS.md " +
        'tells the operator to pass.',
    ).toBe(true);
  });
});
