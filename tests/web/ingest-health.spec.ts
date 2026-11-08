import { describe, expect, it } from 'vitest';
import type { JobRunView } from '../../src/shared/api-types.js';
import { ingestBanner } from '../../src/web/lib/ingest-health.js';

function run(over: Partial<JobRunView>): JobRunView {
  return {
    id: 'r',
    job: 'refresh',
    trigger: 'cron',
    startedAt: 0,
    finishedAt: 0,
    status: 'ok',
    stats: {},
    error: null,
    ...over,
  };
}

describe('ingestBanner (the Jobs page parked banner + ESPN tally, PLAN.md §24.4 / §24.6)', () => {
  it('reads the parked list off the NEWEST refresh run only', () => {
    const banner = ingestBanner([
      run({ id: 's', job: 'settle', stats: { parked: [{ targetId: 'ignored' }] } }),
      run({
        id: 'new',
        stats: {
          parked: [{ targetId: 'ncaaf:date:20261107', incompleteAttempts: 3, attemptStartedAt: 1 }],
          dayEspnStatus: { '200': 40, '429': 2 },
        },
      }),
      run({ id: 'old', stats: { parked: [{ targetId: 'older', incompleteAttempts: 9 }] } }),
    ]);
    expect(banner.parked).toEqual(['ncaaf:date:20261107 (3 incomplete attempts)']);
    expect(banner.espn).toBe('200 × 40 · 429 × 2');
  });

  it('is empty when nothing is parked and there is no tally; survives junk stats', () => {
    expect(ingestBanner([])).toEqual({ parked: [], espn: null });
    expect(ingestBanner([run({ stats: { parked: 'nope', dayEspnStatus: [1, 2] } })])).toEqual({
      parked: [],
      espn: null,
    });
    expect(ingestBanner([run({ stats: null })])).toEqual({ parked: [], espn: null });
  });
});
