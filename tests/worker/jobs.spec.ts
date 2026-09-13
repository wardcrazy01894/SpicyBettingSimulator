import { describe, it } from 'vitest';

/** TDD contract for M4 (leases) — PLAN.md §9.2. */

describe('leases', () => {
  it.todo('a second concurrent run cannot acquire the lease and exits as skipped');
  it.todo('an EXPIRED lease is reclaimed by the next run');
  it.todo('release sets lease_until to 0 so the next run starts immediately');
  it.todo('a crashed run (no release) is unblocked once the TTL passes');
});

describe('job_runs', () => {
  it.todo('records status ok with stats on success');
  it.todo('records status error with the message, and does NOT rethrow');
  it.todo('records status skipped when the lease is held');
});

describe('cron dispatch', () => {
  it.todo('"*/15 * * * *" -> refresh');
  it.todo('"5-59/15 * * * *" -> settle');
  it.todo('"30 8 * * *" -> maintenance');
  it.todo('an unknown cron expression is a no-op, not a crash');
});

describe('admin trigger', () => {
  it.todo('POST /api/admin/jobs/refresh runs the same function with trigger=admin');
  it.todo('returns 409 JOB_LOCKED when the lease is held');
  it.todo('is 404 for a non-admin user');
});
