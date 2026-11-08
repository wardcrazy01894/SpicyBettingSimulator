/**
 * The admin Jobs page's ingest banner (PLAN.md §24.4 / §24.6, M13a): the
 * PARKED targets named by the newest refresh run, and the rolling-24h ESPN
 * response tally (`dayEspnStatus`, which `recentRuns` folds into every run).
 * Pure and DOM-free; `stats` is opaque JSON, so every field is checked.
 */
import type { JobRunView } from '../../shared/api-types.js';

export interface IngestBanner {
  /** One line per parked target, e.g. `ncaaf:date:20261107 (3 incomplete attempts)`. */
  readonly parked: readonly string[];
  /** `200 × 40 · 429 × 2`, or null when there is no tally yet. */
  readonly espn: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ingestBanner(runs: readonly JobRunView[]): IngestBanner {
  const newest = runs.find((r) => r.job === 'refresh' && isRecord(r.stats));
  const stats = isRecord(newest?.stats) ? newest.stats : {};
  const parkedRaw: unknown = stats['parked'];
  const parked = Array.isArray(parkedRaw)
    ? parkedRaw.filter(isRecord).map((p) => {
        const n = typeof p['incompleteAttempts'] === 'number' ? p['incompleteAttempts'] : 0;
        return `${String(p['targetId'])} (${String(n)} incomplete attempt${n === 1 ? '' : 's'})`;
      })
    : [];
  const tallyRaw: unknown = stats['dayEspnStatus'];
  const tally = isRecord(tallyRaw)
    ? Object.entries(tallyRaw).filter((e): e is [string, number] => typeof e[1] === 'number')
    : [];
  const espn =
    tally.length === 0
      ? null
      : tally
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k} × ${String(v)}`)
          .join(' · ');
  return { parked, espn };
}
