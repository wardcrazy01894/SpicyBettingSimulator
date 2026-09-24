import { describe, expect, it } from 'vitest';
import {
  effectiveAmericanPrice,
  gradeBet,
  gradeLeg,
  gradeMoneyline,
  gradeSpread,
  gradeTotal,
  projectLeg,
} from '../../src/shared/grading.js';
import type { BetPricing, GradableGame } from '../../src/shared/grading.js';
import { FULL_ACTION } from '../../src/shared/action.js';
import { AppError } from '../../src/shared/errors.js';
import {
  EVEN_MONEY_UNIT,
  americanToPrice,
  multiplyPrices,
  teasedLineTenths,
} from '../../src/shared/odds.js';
import type {
  AmericanPrice,
  BetLegSnapshot,
  BetStatus,
  GameResult,
  GameStatus,
  LegGrade,
  Price,
} from '../../src/shared/types.js';

/**
 * TDD contract for src/shared/grading.ts (PLAN.md §7.3, M2b).
 *
 * EVERY numeric payout literal below was produced by a BigInt REPL, never by
 * hand (CLAUDE.md convention 2). The canonical set, at a 1000¢ stake:
 *
 *   0 surviving -110 legs -> price      1/1        payout   1000   (= stake)
 *   1 surviving -110 leg  -> price    210/110      payout   1909
 *   2 surviving -110 legs -> price  44100/12100    payout   3644
 *   3 surviving -110 legs -> price 9261000/1331000 payout   6957
 *   -110/-110/+150        -> price 11025000/1210000 payout  9111   (PLAN §5.4)
 *   ...leg 3 pushes       -> price  44100/12100    payout   3644   (PLAN §5.4)
 *   ...all legs push      -> price      1/1        payout   1000   (PLAN §5.4)
 *
 * The expected-status oracle is transcribed from the §7.3 pseudocode rather than
 * imported from the implementation, so a bug in `grading.ts` cannot make its own
 * tests agree with it.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const BASE_LEG: BetLegSnapshot = {
  gameId: 'g1',
  league: 'nfl',
  market: 'spread',
  side: 'home',
  lineTenths: -35,
  americanPrice: -110,
  provider: 'espnbet',
  lineCapturedAt: 1_700_000_000_000,
  snapshotAt: 1_700_000_060_000,
  kickoffAtSnapshot: 1_700_003_600_000,
  homeAbbr: 'CIN',
  awayAbbr: 'TB',
};

function makeLeg(overrides: Partial<BetLegSnapshot> = {}): BetLegSnapshot {
  return { ...BASE_LEG, ...overrides };
}

/**
 * TEST-ONLY: every vector in this file is football, so every game has FULL
 * action (PLAN.md §23.6). `action` is REQUIRED on `GradableGame` and production
 * code has no default — this helper is the one place it is supplied for free.
 */
function full(result: GameResult): GradableGame {
  return { ...result, action: FULL_ACTION };
}

function final(homeScore: number | null, awayScore: number | null): GradableGame {
  return full({ status: 'final', homeScore, awayScore });
}

function notFinal(status: GameStatus): GradableGame {
  return full({ status, homeScore: null, awayScore: null });
}

/** Independent oracle: the exact rational for a set of American integers. */
function priceOf(americans: readonly AmericanPrice[]): Price {
  return multiplyPrices(americans.map(americanToPrice));
}

/**
 * A (leg, game) pair engineered to grade exactly `grade`, on its own game id so
 * a parlay's legs never collide. Moneyline home throughout: it needs no line, so
 * the truth-table sweep exercises `gradeBet`'s combination logic and nothing else.
 */
function legForGrade(
  grade: LegGrade,
  index: number,
  americanPrice: AmericanPrice = -110,
): { leg: BetLegSnapshot; game: GradableGame } {
  const leg = makeLeg({
    gameId: `g${String(index)}`,
    market: 'moneyline',
    side: 'home',
    lineTenths: null,
    americanPrice,
  });
  switch (grade) {
    case 'win':
      return { leg, game: final(27, 24) };
    case 'loss':
      return { leg, game: final(24, 27) };
    case 'push':
      return { leg, game: final(24, 24) };
    case 'void':
      return { leg, game: notFinal('canceled') };
    case 'pending':
      return { leg, game: notFinal('in_progress') };
  }
}

/** Build the `(legs, games)` arguments for a bet whose legs grade as `grades`. */
function betFor(
  grades: readonly LegGrade[],
  americanPrices?: readonly AmericanPrice[],
): { legs: BetLegSnapshot[]; games: Map<string, GradableGame> } {
  const legs: BetLegSnapshot[] = [];
  const games = new Map<string, GradableGame>();
  grades.forEach((grade, i) => {
    const { leg, game } = legForGrade(grade, i, americanPrices?.[i] ?? -110);
    legs.push(leg);
    games.set(leg.gameId, game);
  });
  return { legs, games };
}

/** PLAN §7.3, transcribed. Deliberately NOT the implementation. */
function expectedStatus(grades: readonly LegGrade[]): BetStatus {
  if (grades.includes('pending')) return 'pending';
  if (grades.includes('loss')) return 'lost';
  if (grades.includes('win')) return 'won';
  return grades.every((g) => g === 'void') ? 'void' : 'push';
}

/** REPL-verified payouts for N surviving -110 legs at a 1000¢ stake. */
const PAYOUT_1000_BY_WINS: Readonly<Record<number, number>> = {
  0: 1000,
  1: 1909,
  2: 3644,
  3: 6957,
  4: 13283,
  5: 25359,
};

const ALL_GRADES: readonly LegGrade[] = ['win', 'loss', 'push', 'void', 'pending'];

// ---------------------------------------------------------------------------
// §5.7 primitives
// ---------------------------------------------------------------------------

describe('gradeSpread', () => {
  it('home -3.5 wins when the home team wins by 4', () => {
    // CIN 28 - TB 24: margin 4, line -3.5, covers by 0.5.
    expect(gradeSpread(28, 24, -35)).toBe('win');
  });

  it('home -3.5 loses when the home team wins by 3', () => {
    // CIN 27 - TB 24: margin 3, line -3.5, short by half a point.
    expect(gradeSpread(27, 24, -35)).toBe('loss');
  });

  it('away +3.5 wins when the away team loses by 3', () => {
    // lineTenths is already from the BETTOR'S side: away +3.5 is +35.
    expect(gradeSpread(24, 27, 35)).toBe('win');
  });

  it('away +3.5 loses when the away team loses by 4', () => {
    expect(gradeSpread(24, 28, 35)).toBe('loss');
  });

  it('home -3 PUSHES on an exact 3-point win (integer tenths, exact === 0)', () => {
    expect(gradeSpread(27, 24, -30)).toBe('push');
  });

  it('away +3 PUSHES on an exact 3-point loss', () => {
    expect(gradeSpread(24, 27, 30)).toBe('push');
  });

  it('PK (line 0) pushes on a tie', () => {
    expect(gradeSpread(24, 24, 0)).toBe('push');
  });

  it('PK (line 0) is a plain win/loss otherwise', () => {
    expect(gradeSpread(24, 21, 0)).toBe('win');
    expect(gradeSpread(21, 24, 0)).toBe('loss');
  });

  it('a losing favourite still loses even with the points', () => {
    // CIN 24 - TB 27 laying 3.5: losing outright is never a cover.
    expect(gradeSpread(24, 27, -35)).toBe('loss');
  });

  it('a big underdog wins with the points despite losing the game', () => {
    expect(gradeSpread(24, 27, 105)).toBe('win');
  });

  it('works for a 30.5-point CFB spread', () => {
    expect(gradeSpread(56, 21, -305)).toBe('win'); // margin 35 > 30.5
    expect(gradeSpread(52, 24, -305)).toBe('loss'); // margin 28 < 30.5
    expect(gradeSpread(21, 56, 305)).toBe('loss'); // the other side of the same game
    expect(gradeSpread(24, 52, 305)).toBe('win');
  });

  it('pushes on a whole-number CFB spread hit exactly', () => {
    expect(gradeSpread(55, 24, -310)).toBe('push'); // margin 31 === 31.0
  });

  it('0-0 with a 0 line pushes', () => {
    expect(gradeSpread(0, 0, 0)).toBe('push');
  });
});

describe('gradeTotal', () => {
  it('over 50.5 wins at 28-24 (52)', () => {
    expect(gradeTotal(28, 24, 505, 'over')).toBe('win');
  });

  it('over 50.5 wins at 27-24 (51)', () => {
    expect(gradeTotal(27, 24, 505, 'over')).toBe('win');
  });

  it('over 50.5 loses at 27-23 (50)', () => {
    expect(gradeTotal(27, 23, 505, 'over')).toBe('loss');
  });

  it('under 50.5 wins at 24-24 (48)', () => {
    expect(gradeTotal(24, 24, 505, 'under')).toBe('win');
  });

  it('under 50.5 loses at 28-24 (52)', () => {
    expect(gradeTotal(28, 24, 505, 'under')).toBe('loss');
  });

  it('over 48 PUSHES at 24-24', () => {
    expect(gradeTotal(24, 24, 480, 'over')).toBe('push');
  });

  it('under 48 PUSHES at 24-24', () => {
    expect(gradeTotal(24, 24, 480, 'under')).toBe('push');
  });

  it('a 50.0 line pushes on an exact 50-point game', () => {
    expect(gradeTotal(27, 23, 500, 'over')).toBe('push');
    expect(gradeTotal(27, 23, 500, 'under')).toBe('push');
  });

  it('0-0 under a 30.5 CFB total is a win for the under', () => {
    expect(gradeTotal(0, 0, 305, 'under')).toBe('win');
    expect(gradeTotal(0, 0, 305, 'over')).toBe('loss');
  });

  it('is symmetric: over and under never agree unless it is a push', () => {
    for (const [home, away, line] of [
      [28, 24, 505],
      [24, 24, 505],
      [0, 0, 305],
      [55, 52, 1075],
    ] as const) {
      const over = gradeTotal(home, away, line, 'over');
      const under = gradeTotal(home, away, line, 'under');
      if (over === 'push') {
        expect(under).toBe('push');
      } else {
        expect(under).not.toBe(over);
      }
    }
  });
});

describe('gradeMoneyline', () => {
  it('higher score wins', () => {
    expect(gradeMoneyline(27, 24)).toBe('win');
  });

  it('lower score loses', () => {
    expect(gradeMoneyline(24, 27)).toBe('loss');
  });

  it('equal scores PUSH (NFL games can tie)', () => {
    expect(gradeMoneyline(24, 24)).toBe('push');
  });

  it('a 0-0 final PUSHES — it is a tie, not a loss', () => {
    expect(gradeMoneyline(0, 0)).toBe('push');
  });

  it('winning 1-0 is still a win', () => {
    expect(gradeMoneyline(1, 0)).toBe('win');
    expect(gradeMoneyline(0, 1)).toBe('loss');
  });
});

// ---------------------------------------------------------------------------
// gradeLeg: status gate, score sanity, market dispatch
// ---------------------------------------------------------------------------

describe('gradeLeg', () => {
  it("game 'canceled' -> 'void' regardless of score", () => {
    const leg = makeLeg({ market: 'spread', side: 'home', lineTenths: -35 });
    // A canceled game that nevertheless carries a score it would have LOST on.
    expect(gradeLeg(leg, full({ status: 'canceled', homeScore: 10, awayScore: 45 }))).toBe('void');
    expect(gradeLeg(leg, notFinal('canceled'))).toBe('void');
  });

  it("game 'postponed' -> 'pending' (it may still be played)", () => {
    expect(gradeLeg(makeLeg(), notFinal('postponed'))).toBe('pending');
  });

  it("game 'in_progress' -> 'pending'", () => {
    expect(gradeLeg(makeLeg(), full({ status: 'in_progress', homeScore: 28, awayScore: 0 }))).toBe(
      'pending',
    );
  });

  it("game 'scheduled' -> 'pending'", () => {
    expect(gradeLeg(makeLeg(), notFinal('scheduled'))).toBe('pending');
  });

  it("game 'unknown' -> 'pending' (never guess)", () => {
    expect(gradeLeg(makeLeg(), full({ status: 'unknown', homeScore: 28, awayScore: 24 }))).toBe(
      'pending',
    );
  });

  it("final with a null score -> 'pending' and does not throw", () => {
    expect(() => gradeLeg(makeLeg(), final(null, 24))).not.toThrow();
    expect(gradeLeg(makeLeg(), final(null, 24))).toBe('pending');
    expect(gradeLeg(makeLeg(), final(28, null))).toBe('pending');
    expect(gradeLeg(makeLeg(), final(null, null))).toBe('pending');
  });

  it("final with a non-integer score -> 'pending'", () => {
    expect(gradeLeg(makeLeg(), final(24.5, 24))).toBe('pending');
    expect(gradeLeg(makeLeg(), final(24, Number.NaN))).toBe('pending');
    expect(gradeLeg(makeLeg(), final(24, Number.POSITIVE_INFINITY))).toBe('pending');
  });

  it("final with a negative score -> 'pending' (garbage, never graded)", () => {
    expect(gradeLeg(makeLeg(), final(-3, 24))).toBe('pending');
    expect(gradeLeg(makeLeg(), final(24, -1))).toBe('pending');
  });

  it('a 0-0 final IS gradeable — 0 is a real score, not a missing one', () => {
    const ml = makeLeg({ market: 'moneyline', side: 'home', lineTenths: null });
    expect(gradeLeg(ml, final(0, 0))).toBe('push');
    const under = makeLeg({ market: 'total', side: 'under', lineTenths: 305 });
    expect(gradeLeg(under, final(0, 0))).toBe('win');
  });

  it('dispatches a spread leg to the bettor’s own side', () => {
    const home = makeLeg({ market: 'spread', side: 'home', lineTenths: -35 });
    const away = makeLeg({ market: 'spread', side: 'away', lineTenths: 35 });
    expect(gradeLeg(home, final(28, 24))).toBe('win');
    expect(gradeLeg(away, final(28, 24))).toBe('loss');
    expect(gradeLeg(home, final(27, 24))).toBe('loss');
    expect(gradeLeg(away, final(27, 24))).toBe('win');
  });

  it('dispatches a total leg to over/under', () => {
    const over = makeLeg({ market: 'total', side: 'over', lineTenths: 505 });
    const under = makeLeg({ market: 'total', side: 'under', lineTenths: 505 });
    expect(gradeLeg(over, final(28, 24))).toBe('win');
    expect(gradeLeg(under, final(28, 24))).toBe('loss');
  });

  it('dispatches a moneyline leg to the bettor’s own side', () => {
    const home = makeLeg({ market: 'moneyline', side: 'home', lineTenths: null });
    const away = makeLeg({ market: 'moneyline', side: 'away', lineTenths: null });
    expect(gradeLeg(home, final(27, 24))).toBe('win');
    expect(gradeLeg(away, final(27, 24))).toBe('loss');
    expect(gradeLeg(home, final(24, 24))).toBe('push');
    expect(gradeLeg(away, final(24, 24))).toBe('push');
  });

  it("a spread/total leg with a null or non-integer line -> 'pending' (never guess)", () => {
    expect(
      gradeLeg(makeLeg({ market: 'spread', side: 'home', lineTenths: null }), final(28, 24)),
    ).toBe('pending');
    expect(
      gradeLeg(makeLeg({ market: 'total', side: 'over', lineTenths: null }), final(28, 24)),
    ).toBe('pending');
    expect(
      gradeLeg(makeLeg({ market: 'spread', side: 'home', lineTenths: -3.5 }), final(28, 24)),
    ).toBe('pending');
  });

  it("an impossible market/side pairing -> 'pending', it never throws mid-run", () => {
    expect(
      gradeLeg(makeLeg({ market: 'spread', side: 'over', lineTenths: -35 }), final(28, 24)),
    ).toBe('pending');
    expect(
      gradeLeg(makeLeg({ market: 'total', side: 'home', lineTenths: 505 }), final(28, 24)),
    ).toBe('pending');
    expect(
      gradeLeg(makeLeg({ market: 'moneyline', side: 'under', lineTenths: null }), final(28, 24)),
    ).toBe('pending');
  });

  it('reads the line from the SNAPSHOT, never from anything on the game', () => {
    // The game object literally cannot carry a line — GradableGame has status,
    // two scores and an action — no line. This pins the contract of PLAN §14.3 at the type level and in
    // behaviour: same game, two snapshots, two different grades.
    const game = final(28, 24);
    expect(gradeLeg(makeLeg({ lineTenths: -35 }), game)).toBe('win');
    expect(gradeLeg(makeLeg({ lineTenths: -65 }), game)).toBe('loss');
  });
});

describe('projectLeg', () => {
  it('agrees with gradeLeg on every status and market', () => {
    const legs = [
      makeLeg({ market: 'spread', side: 'home', lineTenths: -35 }),
      makeLeg({ market: 'spread', side: 'away', lineTenths: 35 }),
      makeLeg({ market: 'total', side: 'over', lineTenths: 505 }),
      makeLeg({ market: 'total', side: 'under', lineTenths: 505 }),
      makeLeg({ market: 'moneyline', side: 'home', lineTenths: null }),
      makeLeg({ market: 'moneyline', side: 'away', lineTenths: null }),
    ];
    const games: GradableGame[] = [
      final(28, 24),
      final(24, 24),
      final(24, 28),
      final(null, null),
      notFinal('scheduled'),
      notFinal('in_progress'),
      notFinal('postponed'),
      notFinal('unknown'),
      notFinal('canceled'),
    ];
    for (const leg of legs) {
      for (const game of games) {
        expect(projectLeg(leg, game)).toBe(gradeLeg(leg, game));
      }
    }
  });

  it('projects a live in-progress game as pending, not as the current leader', () => {
    const leg = makeLeg({ market: 'moneyline', side: 'home', lineTenths: null });
    expect(projectLeg(leg, full({ status: 'in_progress', homeScore: 35, awayScore: 0 }))).toBe(
      'pending',
    );
  });
});

// ---------------------------------------------------------------------------
// gradeBet
// ---------------------------------------------------------------------------

describe('gradeBet — straights (the 1-leg case of the same function)', () => {
  it('straight win pays floor(stake * price)', () => {
    const { legs, games } = betFor(['win']);
    const outcome = gradeBet(2500, legs, games);
    expect(outcome.status).toBe('won');
    // 2500¢ at -110: floor(2500 * 210 / 110) = 4772 (PLAN §5.4, REPL-verified).
    expect(outcome.payoutCents).toBe(4772);
    expect(outcome.effectivePrice).toEqual(priceOf([-110]));
    expect(outcome.legs).toEqual([{ legIndex: 0, grade: 'win', price: americanToPrice(-110) }]);
  });

  it('straight win at a plus price pays the §5.4 vector', () => {
    const { legs, games } = betFor(['win'], [164]);
    // 5000¢ at +164: floor(5000 * 264 / 100) = 13200 (PLAN §5.4).
    expect(gradeBet(5000, legs, games).payoutCents).toBe(13200);
  });

  it('straight loss pays 0 and keeps the PLACEMENT price (§7.4)', () => {
    const { legs, games } = betFor(['loss']);
    const outcome = gradeBet(2500, legs, games);
    expect(outcome.status).toBe('lost');
    expect(outcome.payoutCents).toBe(0);
    expect(outcome.effectivePrice).toEqual(priceOf([-110]));
    expect(effectiveAmericanPrice(outcome)).toBe(-110);
  });

  it('straight push returns the stake exactly, at even money', () => {
    const { legs, games } = betFor(['push']);
    const outcome = gradeBet(2500, legs, games);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(2500);
    expect(outcome.effectivePrice).toEqual(EVEN_MONEY_UNIT);
    expect(outcome.legs).toEqual([{ legIndex: 0, grade: 'push', price: americanToPrice(-110) }]);
    expect(effectiveAmericanPrice(outcome)).toBe(100);
  });

  it('straight on a canceled game VOIDS and returns the stake', () => {
    const { legs, games } = betFor(['void']);
    const outcome = gradeBet(2500, legs, games);
    expect(outcome.status).toBe('void');
    expect(outcome.payoutCents).toBe(2500);
    expect(outcome.effectivePrice).toEqual(EVEN_MONEY_UNIT);
    expect(effectiveAmericanPrice(outcome)).toBe(100);
  });

  it('straight on an unfinished game stays pending and writes nothing', () => {
    const { legs, games } = betFor(['pending']);
    const outcome = gradeBet(2500, legs, games);
    expect(outcome.status).toBe('pending');
    expect(outcome.payoutCents).toBe(0);
    expect(outcome.legs).toEqual([]);
    expect(outcome.effectivePrice).toEqual(EVEN_MONEY_UNIT);
  });
});

describe('gradeBet — the §7.3 truth table, exhaustively', () => {
  /** All 25 two-leg grade combinations. */
  for (const a of ALL_GRADES) {
    for (const b of ALL_GRADES) {
      it(`[${a}, ${b}] -> ${expectedStatus([a, b])}`, () => {
        const grades: LegGrade[] = [a, b];
        const { legs, games } = betFor(grades);
        const outcome = gradeBet(1000, legs, games);
        const status = expectedStatus(grades);
        expect(outcome.status).toBe(status);

        const wins = grades.filter((g) => g === 'win').length;
        if (status === 'pending' || status === 'lost') {
          expect(outcome.payoutCents).toBe(0);
        } else {
          expect(outcome.payoutCents).toBe(PAYOUT_1000_BY_WINS[wins]);
        }

        // A pending bet writes NOTHING — not even partial leg results (§7.1).
        expect(outcome.legs).toEqual(
          status === 'pending'
            ? []
            : grades.map((grade, legIndex) => ({
                legIndex,
                grade,
                price: americanToPrice(-110),
              })),
        );
      });
    }
  }

  /** All 125 three-leg grade combinations. */
  for (const a of ALL_GRADES) {
    for (const b of ALL_GRADES) {
      for (const c of ALL_GRADES) {
        it(`[${a}, ${b}, ${c}] -> ${expectedStatus([a, b, c])}`, () => {
          const grades: LegGrade[] = [a, b, c];
          const { legs, games } = betFor(grades);
          const outcome = gradeBet(1000, legs, games);
          const status = expectedStatus(grades);
          expect(outcome.status).toBe(status);
          const wins = grades.filter((g) => g === 'win').length;
          expect(outcome.payoutCents).toBe(
            status === 'pending' || status === 'lost' ? 0 : PAYOUT_1000_BY_WINS[wins],
          );
        });
      }
    }
  }

  it('all 3125 five-leg combinations match the §7.3 oracle (accumulated, asserted once)', () => {
    const failures: string[] = [];
    for (const a of ALL_GRADES)
      for (const b of ALL_GRADES)
        for (const c of ALL_GRADES)
          for (const d of ALL_GRADES)
            for (const e of ALL_GRADES) {
              const grades: LegGrade[] = [a, b, c, d, e];
              const { legs, games } = betFor(grades);
              const outcome = gradeBet(1000, legs, games);
              const status = expectedStatus(grades);
              const wins = grades.filter((g) => g === 'win').length;
              const payout =
                status === 'pending' || status === 'lost' ? 0 : PAYOUT_1000_BY_WINS[wins];
              if (outcome.status !== status || outcome.payoutCents !== payout) {
                failures.push(
                  `${grades.join(',')} -> ${outcome.status}/${String(outcome.payoutCents)}`,
                );
              }
            }
    expect(failures).toEqual([]);
  });

  it('a pending outcome names the blocking leg and never throws, even for an impossible price', () => {
    const { legs, games } = betFor(['win', 'pending']);
    const bad = legs.map((l, i) => (i === 0 ? { ...l, americanPrice: 0 } : l));
    const outcome = gradeBet(1000, bad, games);
    expect(outcome.status).toBe('pending');
    expect(outcome.legs).toEqual([]);
    expect(outcome.pendingReason).toMatch(/^leg 1: game .* is (scheduled|in_progress)/);
    // A settled outcome carries no reason.
    const settled = gradeBet(1000, legs, betFor(['win', 'win']).games);
    expect(settled.pendingReason).toBeUndefined();
  });

  it('pendingReason names the FIRST pending leg and each blocking cause', () => {
    const multi = betFor(['pending', 'win', 'pending']);
    expect(gradeBet(1000, multi.legs, multi.games).pendingReason).toMatch(/^leg 0: /);

    const missing = betFor(['win', 'win']);
    const games = new Map(missing.games);
    const g1 = missing.legs[1]?.gameId ?? '';
    games.delete(g1);
    expect(gradeBet(1000, missing.legs, games).pendingReason).toBe(`leg 1: game ${g1} not found`);

    const unusable = betFor(['win']);
    const g0 = unusable.legs[0]?.gameId ?? '';
    const broken = new Map(unusable.games);
    broken.set(g0, full({ status: 'final', homeScore: null, awayScore: 24 }));
    expect(gradeBet(1000, unusable.legs, broken).pendingReason).toBe(
      `leg 0: game ${g0} is final but its score is unusable`,
    );

    const malformed = betFor(['win']);
    const badLeg = { ...malformed.legs[0]!, side: 'over' as const };
    expect(gradeBet(1000, [badLeg], malformed.games).pendingReason).toBe(
      `leg 0: malformed leg (${badLeg.market}/over, line ${String(badLeg.lineTenths)})`,
    );
  });

  it('a loss with pending legs is PENDING, not lost — pending is checked first', () => {
    // PLAN §7.3 orders the checks `pending` THEN `loss`, and §7.1 never even
    // selects a bet whose games are not all final/canceled. So an already-dead
    // parlay waits for its last game rather than settling early.
    const { legs, games } = betFor(['loss', 'pending']);
    expect(gradeBet(1000, legs, games).status).toBe('pending');
  });

  it('parlay with a loss AND pushes LOSES (loss is evaluated before push removal)', () => {
    const { legs, games } = betFor(['loss', 'push', 'push', 'push', 'push']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('lost');
    expect(outcome.payoutCents).toBe(0);
  });

  it('parlay with a loss AND wins LOSES', () => {
    const { legs, games } = betFor(['win', 'win', 'loss']);
    expect(gradeBet(1000, legs, games).status).toBe('lost');
  });

  it('parlay with a loss AND voids LOSES', () => {
    const { legs, games } = betFor(['loss', 'void']);
    expect(gradeBet(1000, legs, games).status).toBe('lost');
  });

  it('mixed push + void with no winners -> push (void only when ALL legs voided)', () => {
    const { legs, games } = betFor(['push', 'void']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(1000);
  });

  it('parlay where every leg pushes returns the stake and status push', () => {
    const { legs, games } = betFor(['push', 'push', 'push']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(1000);
    expect(outcome.effectivePrice).toEqual(EVEN_MONEY_UNIT);
  });

  it('parlay where every leg voids returns the stake and status void', () => {
    const { legs, games } = betFor(['void', 'void', 'void']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('void');
    expect(outcome.payoutCents).toBe(1000);
    expect(outcome.effectivePrice).toEqual(EVEN_MONEY_UNIT);
  });

  it('parlay with ANY pending leg stays pending and returns no leg results', () => {
    const { legs, games } = betFor(['win', 'win', 'pending']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('pending');
    expect(outcome.payoutCents).toBe(0);
    expect(outcome.legs).toEqual([]);
  });

  it('a leg whose game is missing from the map is pending, never a guess', () => {
    const { legs } = betFor(['win', 'win']);
    const games = new Map<string, GradableGame>([[legs[0]!.gameId, final(27, 24)]]);
    expect(gradeBet(1000, legs, games).status).toBe('pending');
  });
});

describe('gradeBet — the PLAN §5.4 push re-pricing example', () => {
  const PRICES: readonly AmericanPrice[] = [-110, -110, 150];

  it('all three legs win: 1000¢ -> 9111¢ at +811', () => {
    const { legs, games } = betFor(['win', 'win', 'win'], PRICES);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('won');
    expect(outcome.payoutCents).toBe(9111);
    expect(outcome.effectivePrice).toEqual(priceOf(PRICES));
    expect(outcome.effectivePrice).toEqual({ num: 11_025_000n, den: 1_210_000n });
    expect(effectiveAmericanPrice(outcome)).toBe(811);
  });

  it('leg 3 pushes: re-prices to the two surviving legs -> 3644¢ at +264', () => {
    const { legs, games } = betFor(['win', 'win', 'push'], PRICES);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('won');
    expect(outcome.payoutCents).toBe(3644);
    expect(outcome.effectivePrice).toEqual({ num: 44_100n, den: 12_100n });
    expect(effectiveAmericanPrice(outcome)).toBe(264);
  });

  it('every leg pushes: stake back at even money, and 100 is a LITERAL', () => {
    const { legs, games } = betFor(['push', 'push', 'push'], PRICES);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(1000);
    expect(outcome.effectivePrice).toEqual({ num: 1n, den: 1n });
    // priceToAmerican(1/1) THROWS — even money has no American form (§5.5), so
    // the settlement path must not route a push through it.
    expect(effectiveAmericanPrice(outcome)).toBe(100);
  });

  it('re-pricing never raises the payout (§7.4 corollary): 9111 >= 3644 >= 1000', () => {
    const three = betFor(['win', 'win', 'win'], PRICES);
    const two = betFor(['win', 'win', 'push'], PRICES);
    const none = betFor(['push', 'push', 'push'], PRICES);
    const payouts = [
      gradeBet(1000, three.legs, three.games).payoutCents,
      gradeBet(1000, two.legs, two.games).payoutCents,
      gradeBet(1000, none.legs, none.games).payoutCents,
    ];
    expect(payouts).toEqual([9111, 3644, 1000]);
    expect(payouts[0]).toBeGreaterThanOrEqual(payouts[1]!);
    expect(payouts[1]).toBeGreaterThanOrEqual(payouts[2]!);
  });

  it('effectivePrice excludes pushed and voided legs', () => {
    // 4 legs, all -110: one wins, one pushes, one voids, one wins.
    const { legs, games } = betFor(['win', 'push', 'void', 'win']);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('won');
    expect(outcome.effectivePrice).toEqual(priceOf([-110, -110]));
    expect(outcome.payoutCents).toBe(3644);
    expect(outcome.legs.map((l) => l.grade)).toEqual(['win', 'push', 'void', 'win']);
  });

  it('a void leg is dropped exactly like a push (dead-heat style re-pricing)', () => {
    const { legs, games } = betFor(['win', 'void'], PRICES);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.status).toBe('won');
    expect(outcome.effectivePrice).toEqual(priceOf([-110]));
    expect(outcome.payoutCents).toBe(1909);
  });
});

describe('gradeBet — leg bookkeeping and invariants', () => {
  it('reports legIndex in the caller’s order and the snapshot price per leg', () => {
    const { legs, games } = betFor(['win', 'push', 'win'], [-110, 150, 164]);
    const outcome = gradeBet(1000, legs, games);
    expect(outcome.legs).toEqual([
      { legIndex: 0, grade: 'win', price: americanToPrice(-110) },
      { legIndex: 1, grade: 'push', price: americanToPrice(150) },
      { legIndex: 2, grade: 'win', price: americanToPrice(164) },
    ]);
  });

  it('a 10-leg parlay grades and prices exactly (no float, no 2^53 loss)', () => {
    const grades: LegGrade[] = Array.from({ length: 10 }, () => 'win');
    const prices: AmericanPrice[] = Array.from({ length: 10 }, () => -110);
    const { legs, games } = betFor(grades, prices);
    const outcome = gradeBet(100_000, legs, games);
    expect(outcome.status).toBe('won');
    // PLAN §5.4: the 10-leg -110 row, 100000¢ -> 64308161¢.
    expect(outcome.payoutCents).toBe(64_308_161);
    expect(outcome.effectivePrice).toEqual(priceOf(prices));
  });

  it('propagates PAYOUT_LIMIT_EXCEEDED rather than clamping (§5.2b)', () => {
    const grades: LegGrade[] = Array.from({ length: 10 }, () => 'win');
    const prices: AmericanPrice[] = Array.from({ length: 10 }, () => 2000);
    const { legs, games } = betFor(grades, prices);
    // REPL: 100000¢ * (2100/100)^10 = 1667988097820100000¢, far past the cap.
    expect(() => gradeBet(100_000, legs, games)).toThrow(AppError);
    const thrown = (() => {
      try {
        gradeBet(100_000, legs, games);
        return null;
      } catch (err: unknown) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('PAYOUT_LIMIT_EXCEEDED');
  });

  it('rejects a bet with no legs — that is corruption, not a push', () => {
    expect(() => gradeBet(1000, [], new Map())).toThrow(AppError);
  });

  it('rejects a negative stake even on a push', () => {
    const { legs, games } = betFor(['push']);
    expect(() => gradeBet(-1, legs, games)).toThrow(AppError);
  });

  it('never mutates the legs it is given', () => {
    const { legs, games } = betFor(['win', 'push']);
    const before = structuredClone(legs);
    gradeBet(1000, legs, games);
    expect(legs).toEqual(before);
  });
});

describe('effectiveAmericanPrice', () => {
  it('is 100 for push and void without ever calling priceToAmerican', () => {
    for (const grades of [['push'], ['void'], ['push', 'void']] as LegGrade[][]) {
      const { legs, games } = betFor(grades);
      expect(effectiveAmericanPrice(gradeBet(1000, legs, games))).toBe(100);
    }
  });

  it('is the surviving-leg price for a win', () => {
    const { legs, games } = betFor(['win', 'push'], [-110, 150]);
    expect(effectiveAmericanPrice(gradeBet(1000, legs, games))).toBe(-110);
  });

  it('is the full placement price for a loss', () => {
    const { legs, games } = betFor(['win', 'win', 'loss'], [-110, -110, 150]);
    expect(effectiveAmericanPrice(gradeBet(1000, legs, games))).toBe(811);
  });

  it('throws for a pending bet — nothing is written, so nothing is priced', () => {
    const { legs, games } = betFor(['pending']);
    expect(() => effectiveAmericanPrice(gradeBet(1000, legs, games))).toThrow(AppError);
  });
});

// ---------------------------------------------------------------------------
// Teasers (M5b). PLAN.md §5.8 and §7.
//
// EVERY payout literal below came out of a BigInt REPL, and the three headline
// ones are the spec's own worked examples at a 1000¢ stake, 6-point tier:
//     3 legs, all win          -> +150  -> 2500
//     ...one leg pushes        -> -120  -> 1833   (reduced to the 2-leg row)
//     ...two legs push         -> 1/1   -> 1000   (no action: fewer than 2 left)
// ---------------------------------------------------------------------------

describe('gradeBet — teasers', () => {
  const SIX: BetPricing = { kind: 'teaser', pointsTenths: 60 };

  it('pays the card price for the surviving leg count when every leg wins', () => {
    const { legs, games } = betFor(['win', 'win', 'win']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('won');
    expect(outcome.payoutCents).toBe(2500);
    expect(effectiveAmericanPrice(outcome)).toBe(150);
    // The legs' own prices are IGNORED: three -110 legs as a parlay pay 6957.
    expect(gradeBet(1000, legs, games).payoutCents).toBe(6957);
  });

  it('a pushed leg reduces the bet to the next-lower row of the same tier', () => {
    const { legs, games } = betFor(['win', 'win', 'push']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('won');
    expect(outcome.payoutCents).toBe(1833);
    expect(effectiveAmericanPrice(outcome)).toBe(-120);
  });

  it('reducing below two survivors is NO ACTION — the stake comes back', () => {
    const { legs, games } = betFor(['win', 'push', 'push']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(1000);
    expect(effectiveAmericanPrice(outcome)).toBe(100);
    // The same shape as a PARLAY would be a 1-leg win at -110, paying 1909.
    expect(gradeBet(1000, legs, games).status).toBe('won');
    expect(gradeBet(1000, legs, games).payoutCents).toBe(1909);
  });

  it('a 2-leg teaser with one push is no action, never a priced single', () => {
    const { legs, games } = betFor(['win', 'push']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('push');
    expect(outcome.payoutCents).toBe(1000);
  });

  it('a voided leg (canceled game) reduces exactly like a push', () => {
    const four = betFor(['win', 'win', 'win', 'void']);
    expect(gradeBet(1000, four.legs, four.games, SIX).payoutCents).toBe(2500); // 3-leg row
    const two = betFor(['win', 'void']);
    expect(gradeBet(1000, two.legs, two.games, SIX).status).toBe('push');
  });

  it('every leg voided is `void`, not `push` — the distinction survives teasing', () => {
    const { legs, games } = betFor(['void', 'void']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('void');
    expect(outcome.payoutCents).toBe(1000);
  });

  it('any loss loses the whole teaser, however many legs pushed', () => {
    const { legs, games } = betFor(['loss', 'push', 'push', 'win']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('lost');
    expect(outcome.payoutCents).toBe(0);
    // A lost bet keeps its PLACEMENT price: the 4-leg row, not the 2-leg one.
    expect(effectiveAmericanPrice(outcome)).toBe(260);
  });

  it('a pending leg still beats everything, exactly as for a parlay', () => {
    const { legs, games } = betFor(['win', 'pending']);
    const outcome = gradeBet(1000, legs, games, SIX);
    expect(outcome.status).toBe('pending');
    expect(outcome.payoutCents).toBe(0);
    expect(outcome.legs).toEqual([]);
  });

  it('grades the TEASED line out of the snapshot, knowing nothing about teasers', () => {
    // Home -7.5 teased to -1.5 at 6 points. A 27-24 home win (margin 3) LOSES on
    // the book line and WINS on the teased one; only the snapshot is consulted.
    const book = makeLeg({ gameId: 'gt', lineTenths: -75 });
    const teased = makeLeg({
      gameId: 'gt',
      lineTenths: teasedLineTenths('spread', 'home', -75, 60),
    });
    const games = new Map([['gt', final(27, 24)]]);
    expect(gradeLeg(book, final(27, 24))).toBe('loss');
    expect(gradeLeg(teased, final(27, 24))).toBe('win');
    // Two teased legs so it is a legal teaser shape.
    const second = makeLeg({ gameId: 'gt2', lineTenths: 95, side: 'away' });
    games.set('gt2', final(10, 20));
    expect(gradeBet(1000, [teased, second], games, SIX).status).toBe('won');
  });

  it('all three tiers price from their own row', () => {
    const { legs, games } = betFor(['win', 'win', 'win']);
    // REPL-verified at a 1000c stake: 6pt +150 -> 2500, 6.5pt +135 -> 2350,
    // 7pt +120 -> 2200.
    expect(gradeBet(1000, legs, games, { kind: 'teaser', pointsTenths: 60 }).payoutCents).toBe(
      2500,
    );
    expect(gradeBet(1000, legs, games, { kind: 'teaser', pointsTenths: 65 }).payoutCents).toBe(
      2350,
    );
    expect(gradeBet(1000, legs, games, { kind: 'teaser', pointsTenths: 70 }).payoutCents).toBe(
      2200,
    );
  });

  it('rejects a tier that is not on the card rather than guessing one', () => {
    const { legs, games } = betFor(['win', 'win']);
    expect(() => gradeBet(1000, legs, games, { kind: 'teaser', pointsTenths: 6 })).toThrow(
      AppError,
    );
  });

  it('omitting `pricing` is exactly the parlay behaviour (default argument)', () => {
    const { legs, games } = betFor(['win', 'win']);
    expect(gradeBet(1000, legs, games)).toEqual(gradeBet(1000, legs, games, { kind: 'parlay' }));
  });
});
