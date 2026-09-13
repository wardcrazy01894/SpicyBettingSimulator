#!/usr/bin/env node
/**
 * Money audit. For every bankroll, checks
 *   SUM(ledger.amount_cents) === bankrolls.balance_cents
 * and exits non-zero if any row drifts. Read-only — it NEVER repairs anything,
 * because a drift means a bug that needs a human.
 *
 *   node scripts/reconcile.mjs [--local|--remote]
 *
 * Wraps `wrangler d1 execute --json`.
 */

function main() {
  throw new Error('not implemented: M8');
}

main();
