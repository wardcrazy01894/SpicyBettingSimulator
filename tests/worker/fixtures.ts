/**
 * Fixtures for the `worker` project.
 *
 * workerd has no `node:fs`, and the project boundary in
 * `tsconfig.tests-worker.json` does not include `tests/unit/**`, so these are
 * SYNTHESISED payloads rather than the 1.5 MB captured samples. That is the
 * right trade: the "does it parse the real thing" guarantee belongs to the unit
 * project (tests/unit/espn.spec.ts, which reads docs/samples/ via fs); the
 * worker project needs small, precisely-shaped slates it can mutate — a game
 * going final with a specific score, a line moving, a game being cancelled.
 *
 * The builders emit the exact ESPN shape the parser expects, and
 * tests/unit/espn.spec.ts includes a conformance test asserting that a builder
 * output parses to the same domain object as the equivalent real event, so the
 * two fixture worlds cannot drift.
 */

export interface EventSpec {
  readonly eventId: string;
  readonly league: 'nfl' | 'ncaaf';
  readonly kickoffAt: number;
  readonly status: 'pre' | 'in' | 'post' | 'postponed' | 'canceled';
  readonly homeAbbr: string;
  readonly awayAbbr: string;
  readonly homeScore?: number;
  readonly awayScore?: number;
  readonly season?: number;
  readonly week?: number;
  /** Omit to model a game with no posted line (normal for CFB early in the week). */
  readonly odds?: {
    readonly spreadHome?: number;
    readonly spreadHomePrice?: number;
    readonly spreadAwayPrice?: number;
    readonly total?: number;
    readonly overPrice?: number;
    readonly underPrice?: number;
    readonly mlHome?: number;
    readonly mlAway?: number;
  };
}

/** Build a scoreboard payload in ESPN's shape from a list of specs. */
export function buildScoreboard(_events: readonly EventSpec[]): unknown {
  throw new Error('not implemented: M1');
}

/**
 * Install a fetch stub for `https://espn.test/**` that serves `buildScoreboard`
 * output keyed by the `dates=` query parameter. Returns a handle so a test can
 * change the slate mid-run (kick a game off, move a line, cancel a game) and
 * then re-run the refresh job.
 */
export function stubEspn(_slates: Readonly<Record<string, readonly EventSpec[]>>): {
  set(dateKey: string, events: readonly EventSpec[]): void;
  /** Number of upstream requests made, so tests can assert the request budget. */
  readonly callCount: number;
  restore(): void;
} {
  throw new Error('not implemented: M1');
}
