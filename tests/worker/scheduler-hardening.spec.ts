/**
 * Scheduler hardening (M13a) and the three-minute tick (M13b) — the contracts,
 * written FIRST (PLAN.md §24.15) as `it.todo`s and discharged by the milestone
 * named in each `describe`. The rules they name are PLAN.md §24.4–§24.7; a rule
 * added there is a contract added here in the same PR.
 */
import { describe, it } from 'vitest';

describe('M13a: the poison-target guard (PLAN.md §24.4)', () => {
  it.todo('each target is stamped immediately before ITS OWN fetch, never all at claim time');
  it.todo(
    'a run killed during target 1 leaves target 2 untouched: no increment, no provisional backoff',
  );
  it.todo(
    'a target with incomplete_attempts > 0 is never packed behind another target: it runs alone',
  );
  it.todo(
    '(M13a) the reserved slot and its fall-through never claim a target with incomplete_attempts > 0',
  );
  it.todo('the success path sets last_ok_at; a target with last_ok_at NULL weighs as big');
  it.todo('the success reschedule resets incomplete_attempts to 0 and attempt_started_at to NULL');
  it.todo(
    'the failure reschedule (ESPN 5xx, timeout, bad JSON, D1 error in upsertSlate) resets them too',
  );
  it.todo('a target with incomplete_attempts >= INGEST_MAX_INCOMPLETE_ATTEMPTS is not claimed');
  it.todo(
    'a parked target is claimable for ONE probation attempt INGEST_PARKED_RETRY_MS after its last attempt',
  );
  it.todo(
    'bumpTargetForGame un-parks (incomplete_attempts = 0) and the admin run stamps attempt 1',
  );
  it.todo('stats.parked lists every parked target');
  it.todo(
    'withJobRun reaps running rows older than JOB_REAP_AFTER_MS; a slow live run past its lease is NOT reaped',
  );
  it.todo(
    'NO_LIVE_GAME and the retire rule select exactly what they did before for a NULL conference_id',
  );
});

describe('M13a: GET /api/health/ingest (PLAN.md §24.5)', () => {
  it.todo(
    '200 with ok:true when a refresh run recorded ok within HEALTH_STALE_TICKS periods and nothing is parked',
  );
  it.todo(
    '503 refresh-stale when the newest ok refresh run is older than the threshold, or there is none',
  );
  it.todo('503 targets-parked when any target is parked');
  it.todo('503 espn-all-failing when some target errored and none is ok; NULL last_status ignored');
  it.todo('a refresh run that claims zero targets records ok');
  it.todo('GET /api/health is byte-identical to before M13a');
});

describe('M13a: ESPN response-status counters (PLAN.md §24.6)', () => {
  it.todo('ProviderError.kind distinguishes http, timeout, network and bad-json');
  it.todo('stats.espnStatus counts one outcome per target in the fixed vocabulary');
  it.todo('recentRuns folds a rolling-24h dayEspnStatus, surviving a malformed stats blob');
});

describe('M13a: in-app alerts as GitHub issues (PLAN.md §24.6b)', () => {
  it.todo(
    'a new fingerprint creates ONE issue titled "[alert] <kind>: <key>" with the ops-alert label',
  );
  it.todo(
    'two occurrences within ALERT_COMMENT_INTERVAL_MS produce one comment; pending carries over',
  );
  it.todo('a failed GitHub post loses neither pending nor the comment backoff step');
  it.todo('settle-stuck is ONE fingerprint for any number of stuck bets');
  it.todo('d1-rows-near-cap is evaluated on every refresh run in M13a');
  it.todo('the comment interval doubles per comment and caps at ALERT_COMMENT_MAX_INTERVAL_MS');
  it.todo('quiet for ALERT_RESOLVE_AFTER_MS: a closing comment and the issue closed');
  it.todo('a recurrence within ALERT_REOPEN_WINDOW_MS of resolve reopens the SAME issue');
  it.todo('a recurrence after the reopen window creates a NEW issue and resets the counters');
  it.todo(
    'no GITHUB_TOKEN: no GitHub call, occurrences still recorded, stats.alerts.enabled false',
  );
  it.todo(
    'the issue body, comments and reopens begin with @ALERT_MENTION_LOGIN when configured; no mention when empty',
  );
  it.todo(
    'a SETTLE run opens refresh-stale when no refresh run recorded ok for HEALTH_STALE_TICKS periods',
  );
  it.todo('two racing evaluations of one fingerprint post once (meta.changes is the permission)');
  it.todo('a GitHub failure is logged and counted, never fails the job, and releases the claim');
  it.todo('at most ALERT_MAX_GITHUB_CALLS_PER_RUN GitHub calls per run');
});

describe('M13b: the three-minute tick (PLAN.md §24.7)', () => {
  it.todo(
    'every cadence is a tick multiple from the NOMINAL instant: a run 5 s late still claims a live slate on the next tick',
  );
  it.todo('a live slate is due again after REFRESH_LIVE_TICKS ticks, in every league');
  it.todo(
    'weight packing: NFL + MLB share a run; a CFB slate runs alone; a never-fetched target runs alone',
  );
  it.todo('weight packing stops at the first candidate that does not fit (no skipping ahead)');
  it.todo('the count cap REFRESH_TARGETS_PER_RUN bounds a run of empty slates');
  it.todo(
    'every REFRESH_DISCOVERY_EVERY_NTH_TICK-th tick claims a non-live target first, falling through when none is due',
  );
  it.todo('an admin run is always general');
  it.todo('both leases are strictly shorter than REFRESH_TICK_MS');
  it.todo('JOB_RUNS_KEPT_PER_JOB keeps a full day of refresh and settle runs');
});
