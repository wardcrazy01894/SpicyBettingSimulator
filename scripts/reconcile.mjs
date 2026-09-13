#!/usr/bin/env node
/**
 * Money audit. For every bankroll, checks
 *   SUM(ledger.amount_cents) === bankrolls.balance_cents
 * and exits non-zero if any row drifts. Read-only — it NEVER repairs anything,
 * because a drift means a bug that needs a human.
 *
 *   node scripts/reconcile.mjs [--local|--remote]
 *   npm run db:reconcile -- --remote
 *
 * Wraps `wrangler d1 execute --json`. Same query as `reconcileBankrolls()` in
 * src/worker/db.ts, so the CLI and POST /api/admin/reconcile cannot disagree.
 */

import { spawnSync } from 'node:child_process';

const DB_NAME = 'spicybetting';

const SQL = `SELECT b.id AS bankroll_id,
                    b.balance_cents AS balance_cents,
                    COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE bankroll_id = b.id), 0)
                      AS ledger_sum_cents
               FROM bankrolls b
              ORDER BY b.id`;

/** `--local` (default) or `--remote`; anything else is a usage error. */
function targetFlag(argv) {
  const flags = argv.filter((a) => a === '--local' || a === '--remote');
  if (flags.length > 1) throw new Error('pass at most one of --local / --remote');
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--local' && a !== '--remote');
  if (unknown.length > 0) throw new Error(`unknown option(s): ${unknown.join(' ')}`);
  return flags[0] ?? '--local';
}

/**
 * `wrangler d1 execute --json` prints a JSON array of result envelopes, but it
 * also prints human banner lines on some versions, so the payload is located by
 * scanning for the first `[` rather than by parsing the whole stream.
 */
function runQuery(flag) {
  const args = ['d1', 'execute', DB_NAME, flag, '--json', '--command', SQL];
  const proc = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`wrangler exited ${proc.status}\n${proc.stderr ?? ''}`);
  }
  const out = proc.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`could not find JSON in wrangler output:\n${out}`);
  const parsed = JSON.parse(out.slice(start));
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const env of envelopes) {
    if (Array.isArray(env?.results)) rows.push(...env.results);
  }
  return rows;
}

function main() {
  const flag = targetFlag(process.argv.slice(2));
  const rows = runQuery(flag);
  const drift = rows.filter((r) => Number(r.balance_cents) !== Number(r.ledger_sum_cents));

  console.log(`reconcile ${flag}: checked ${rows.length} bankroll(s)`);
  if (drift.length === 0) {
    console.log('OK — SUM(ledger.amount_cents) === balance_cents for every bankroll.');
    return;
  }
  console.error(`DRIFT on ${drift.length} bankroll(s):`);
  for (const row of drift) {
    console.error(
      `  ${row.bankroll_id}: balance_cents=${row.balance_cents} ledger_sum=${row.ledger_sum_cents} ` +
        `delta=${Number(row.balance_cents) - Number(row.ledger_sum_cents)}`,
    );
  }
  console.error('This is a BUG, not something to repair by hand. Do not edit balances.');
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`reconcile failed: ${err?.message ?? String(err)}`);
  process.exitCode = 2;
}
