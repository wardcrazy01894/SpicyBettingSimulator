/**
 * /api/admin/* — job triggers, job history, user management, reconcile.
 *
 * Non-admins get 404 (not 403) from `requireAdmin`, so the surface is invisible.
 *
 * OWNERSHIP (PLAN.md §16): M4 owns this router's skeleton; each milestone adds
 * its OWN delimited block and touches nobody else's. M3 landed the skeleton
 * early (M3 and M4 run in parallel and M3's user routes had nothing to attach
 * to) together with the `/users` block below and one placeholder per remaining
 * group. M4 replaces its placeholder in place; M5b appends `/balances`; nothing
 * else here moves.
 */

import { Hono } from 'hono';
import type {
  AdminUsersResponse,
  JobRunResponse,
  JobRunsResponse,
  ReconcileResponse,
} from '../../shared/api-types.js';
import { JOB_NAMES, MAX_PAYOUT_CENTS } from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import { validateDerivedKeyHex } from '../../shared/validate.js';
import { deleteUser, listUsers, setDisabled, setPassword } from '../auth.js';
import { listBugReports } from '../bugs.js';
import { bumpTargetForGame } from '../ingest.js';
import { reconcileBankrolls } from '../db.js';
import { retrySettlement } from '../settle.js';
import { adminAdjust } from '../bankroll.js';
import { isOverdraftError } from '../db.js';
import { recentRuns, runJob } from '../jobs.js';
import type { JobName } from '../jobs.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readJson, validationError } from './auth.js';

/** PLAN.md §11.6: `GET /api/admin/jobs` shows the last 50 runs. */
const ADMIN_JOB_HISTORY = 50;

function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export function adminRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  // Anonymous callers get 401 like every other private route; a signed-in
  // NON-admin gets 404, so the admin surface is invisible to them (PLAN §11.6).
  app.use('*', requireAuth(), requireAdmin());

  // --- users (M3) ---------------------------------------------------------
  app.get('/users', async (c) => {
    const body: AdminUsersResponse = { users: await listUsers(c.env) };
    return c.json(body, 200);
  });

  app.post('/users/:id/password', async (c) => {
    const raw = await readJson(c);
    const dk = validateDerivedKeyHex(isRecord(raw) ? raw['dk'] : undefined);
    if (!dk.ok) throw validationError(dk);
    // The admin never sees a password: they run scripts/admin-hash.mjs (or the
    // admin UI runs the browser KDF) and send the derived key. PLAN.md §10.6.
    await setPassword(c.env, c.req.param('id'), dk.value, c.var.now);
    return c.body(null, 204);
  });

  app.post('/users/:id/disabled', async (c) => {
    const raw = await readJson(c);
    const disabled = isRecord(raw) ? raw['disabled'] : undefined;
    if (typeof disabled !== 'boolean') {
      throw new AppError('VALIDATION', 'disabled must be a boolean', { field: 'disabled' });
    }
    const targetId = c.req.param('id');
    if (disabled && c.var.user?.id === targetId) {
      throw new AppError('VALIDATION', 'You cannot disable your own account.', {
        field: 'disabled',
      });
    }
    await setDisabled(c.env, targetId, disabled, c.var.now);
    return c.body(null, 204);
  });

  /**
   * `DELETE /api/admin/users/:id` — SOFT delete. 204 either way.
   *
   * The account is disabled, stamped `deleted_at`, renamed to
   * `deleted_<12 hex of its id>` (which frees the old username for whoever wants
   * it next), given the display name 'Deleted user', and has every session row
   * removed — all in ONE batch, with the guards as WHERE clauses (`auth.ts`
   * `deleteUser`). It cannot log in afterwards and it is off the leaderboard.
   *
   * SETTLED BETS AND THE LEDGER STAY. They have to: the ledger is append-only by
   * DDL (`ledger_bd_block`) and `bankrolls`/`ledger` are `ON DELETE RESTRICT`, so
   * a hard delete would mean destroying the money history that
   * `POST /api/admin/reconcile` is built to check. Nothing here writes a ledger
   * row or a balance.
   *
   * Refusals: 400 for yourself (below) and for the last enabled admin, 404 for an
   * unknown id, 409 ACCOUNT_HAS_PENDING_BETS while the account holds open bets —
   * that stake is already out of its balance and its payout would be credited to
   * an account nobody can reach, so the operator cancels or settles first.
   * Deleting an already-deleted account is a 204 no-op, not an error.
   */
  app.delete('/users/:id', async (c) => {
    const targetId = c.req.param('id');
    // Same shape as the self-disable guard above, and for the same reason: an
    // admin who deletes themselves has no way back in.
    if (c.var.user?.id === targetId) {
      throw new AppError('VALIDATION', 'You cannot delete your own account.', { field: 'id' });
    }
    await deleteUser(c.env, targetId, c.var.now);
    return c.body(null, 204);
  });
  // --- end users (M3) -----------------------------------------------------

  // --- balances (M5b) -----------------------------------------------------
  /**
   * `POST /api/admin/users/:id/adjust {amountCents, memo}` — credit or debit a
   * user's main balance. Either sign.
   *
   * The overdraft rule is NOT re-implemented here: a debit larger than the
   * balance is refused by `ledger_bi_sufficient_funds`, which rolls the batch
   * back, and that abort is mapped to `409 INSUFFICIENT_FUNDS` below. Checking
   * the balance first and then writing would be the read-then-write CLAUDE.md
   * rule 5 forbids, and would be racy besides.
   */
  app.post('/users/:id/adjust', async (c) => {
    const raw = await readJson(c);
    const amountCents = isRecord(raw) ? raw['amountCents'] : undefined;
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)) {
      throw new AppError('VALIDATION', 'amountCents must be an integer number of cents', {
        field: 'amountCents',
      });
    }
    if (amountCents === 0) {
      throw new AppError('VALIDATION', 'amountCents must not be zero', { field: 'amountCents' });
    }
    if (Math.abs(amountCents) > MAX_PAYOUT_CENTS) {
      throw new AppError('VALIDATION', 'amountCents is out of range', { field: 'amountCents' });
    }
    const rawMemo = isRecord(raw) ? raw['memo'] : undefined;
    if (rawMemo !== undefined && rawMemo !== null && typeof rawMemo !== 'string') {
      throw new AppError('VALIDATION', 'memo must be a string', { field: 'memo' });
    }
    try {
      await adminAdjust(
        c.env,
        c.req.param('id'),
        amountCents,
        typeof rawMemo === 'string' && rawMemo !== '' ? rawMemo : null,
        c.var.now,
      );
    } catch (err) {
      if (isOverdraftError(err)) {
        throw new AppError('INSUFFICIENT_FUNDS', 'That would overdraw the balance.');
      }
      throw err;
    }
    return c.body(null, 204);
  });
  // --- end balances (M5b) -------------------------------------------------

  // --- jobs (M4) ----------------------------------------------------------
  // Runs the IDENTICAL function the cron handler runs, with trigger='admin' and
  // the same lease, so "kick it manually" cannot diverge from "it ran on time"
  // (PLAN.md §9.3). Inline, not `ctx.waitUntil`: waitUntil grants wall time, not
  // CPU, so it would not help if S1 came back bad — `refreshTargetsPerRun`
  // drops an admin run to one target instead.
  // A job whose BODY threw still returns 200 with `run.status === 'error'` and
  // the message in `run.error` — deliberately, and documented in PLAN.md §9.3.
  // The HTTP status answers "did the trigger work", which it did: the lease was
  // taken, the run was recorded, and the failure is now visible in
  // GET /api/admin/jobs exactly as a failed CRON run would be. Mapping it to 500
  // would throw away the run id and the stats — which, for `settle`, ARE the
  // answer: `SettleRunError` carries the full per-bet stats and `withJobRun`
  // records them alongside the message (PLAN.md §7.4 / §9.2). The only non-200
  // here is 409 JOB_LOCKED (the lease is held).
  app.post('/jobs/:job', async (c) => {
    const name = c.req.param('job');
    if (!isJobName(name)) {
      throw new AppError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`);
    }
    const run = await runJob(c.env, name, 'admin', c.var.now);
    if (run.status === 'skipped') {
      // The lease is held — by the cron, or by another admin hitting the button.
      throw new AppError('JOB_LOCKED', `The ${name} job is already running.`, { job: name });
    }
    const body: JobRunResponse = { run };
    return c.json(body, 200);
  });

  // PLAN.md §9.3: refresh ONE game — really its date slate, the unit of an ESPN
  // request — by making its target the most due thing and running one admin
  // refresh. Same lease, same 409, same run record as the Run refresh button.
  app.post('/games/:id/refresh', async (c) => {
    const gameId = c.req.param('id');
    const bumped = await bumpTargetForGame(c.env, gameId, c.var.now);
    if (bumped === null) throw new AppError('GAME_NOT_FOUND', `No game ${gameId}.`, { gameId });
    if (bumped === 'retired') {
      throw new AppError(
        'VALIDATION',
        'Every game on that date has been final for more than two days; there is nothing left to pull.',
        { gameId },
      );
    }
    // The same refresh lease and the same secondary sweep as the cron, with
    // THIS game's retry backoff waived and nothing else (PLAN.md §21.2).
    const run = await runJob(c.env, 'refresh', 'admin', c.var.now, {
      forceSecondaryGameId: gameId,
    });
    if (run.status === 'skipped') {
      throw new AppError('JOB_LOCKED', 'The refresh job is already running.', { job: 'refresh' });
    }
    const body: JobRunResponse = { run };
    return c.json(body, 200);
  });

  // `recentRuns` folds a rolling-24h `dayRowsWritten` into every run's `stats`
  // (PLAN.md §8.6) — that is the number to check against D1's hard-enforced
  // 100k-rows/day cap. `c.var.now` so the window agrees with the rest of the
  // request.
  app.get('/jobs', async (c) => {
    const body: JobRunsResponse = {
      runs: await recentRuns(c.env, ADMIN_JOB_HISTORY, c.var.now),
    };
    return c.json(body, 200);
  });
  // --- end jobs (M4) ------------------------------------------------------

  // --- bets (M6) ----------------------------------------------------------
  // PLAN.md §7.1's MANUAL way out of the 96-attempt park, for the case where the
  // `games` row itself needed fixing and `resetDeferredBets` therefore cannot
  // see a change. It zeroes the counter and the error and NOTHING else: no
  // status, no payout, no ledger row. The bet is simply eligible for selection
  // again on the next settle run.
  app.post('/bets/:id/retry-settlement', async (c) => {
    const betId = c.req.param('id');
    const outcome = await retrySettlement(c.env, betId);
    if (outcome === 'not-found') {
      throw new AppError('BET_NOT_FOUND', `No bet ${betId}.`, { betId });
    }
    if (outcome === 'not-pending') {
      throw new AppError('BET_NOT_PENDING', 'Only a pending bet can be re-queued.', { betId });
    }
    return c.body(null, 204);
  });
  // --- end bets (M6) ------------------------------------------------------

  // --- reconcile (M8) -----------------------------------------------------
  // READ-ONLY on purpose (PLAN.md §11.6): a drift between `balance_cents` and
  // `SUM(ledger)` means a bug, and auto-repairing it would erase the evidence.
  // POST rather than GET because it is an operator ACTION with a cost, and the
  // CSRF header requirement applies to it like every other state-changing call.
  app.post('/reconcile', async (c) => {
    const { checked, drift } = await reconcileBankrolls(c.env);
    if (drift.length > 0) console.error('[admin] bankroll drift detected', drift);
    const body: ReconcileResponse = { checked, drift };
    return c.json(body, 200);
  });
  // --- end reconcile (M8) -------------------------------------------------

  // --- bug reports (§11.7) ------------------------------------------------
  // Every row, including the ones GitHub refused (`issueNumber: null`, `error`
  // set) — those are the reason the list exists, since the reporter only ever
  // saw a 503 for them.
  app.get('/bugs', async (c) => {
    return c.json(await listBugReports(c.env), 200);
  });
  // --- end bug reports (§11.7) --------------------------------------------

  return app;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
