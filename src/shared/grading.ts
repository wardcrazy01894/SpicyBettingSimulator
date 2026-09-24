/**
 * Bet grading. PLAN.md §7.3.
 *
 * Pure: takes an immutable leg snapshot plus the game's score/status and returns
 * an outcome. It NEVER sees a live line — that is the whole point of the snapshot
 * (PLAN.md §14.3). `GradableGame` carries status, two scores and the game's
 * `action` verdict (§23.6) — no line — so there is no line for this module to
 * read even by accident.
 *
 * All comparisons are integer arithmetic in TENTHS of a point, so a half-point
 * push is an exact `=== 0`, not an epsilon compare. All MONEY leaves through
 * `payoutCents()` from `odds.ts`, which is BigInt end to end; nothing here
 * multiplies or divides a cent.
 *
 * ── The three readings of §7 this file commits to ────────────────────────────
 *
 * 1. **A losing leg does NOT short-circuit a pending one.** §7.3 orders the
 *    checks `pending` first, `loss` second, and the order is load-bearing: a
 *    parlay with one lost leg and one in-progress leg grades `pending`, not
 *    `lost`. That agrees with §7.1, whose selection query only picks up a bet
 *    when EVERY leg's game is already `final` or `canceled` — so in production
 *    this combination is only reachable when a "final" game's score is garbage,
 *    and the right answer there is to wait for ESPN to republish rather than to
 *    settle on data we distrust. It also keeps the invariant that a graded bet
 *    always writes a result for every leg. (Nothing is lost commercially: a dead
 *    parlay pays 0 whenever it does settle.)
 *
 * 2. **A `final` game with a null / non-integer / negative score is `pending`,
 *    not `loss` and not `void`.** §7.3 says "log + skip; never guess". §7.1
 *    calls this out explicitly as the head-of-line case: the bet increments
 *    `settle_attempts`, writes no money, and after 24 h of that lands in
 *    `job_runs.stats.stuck[]` for a human. Voiding would hand back a stake we
 *    might owe as a payout; grading it a loss would confiscate one.
 *
 * 3. **A straight push returns `status: 'push'`, `payoutCents: stake` and
 *    `effectivePrice: EVEN_MONEY_UNIT` (1/1).** The caller writes
 *    `american_price = 100` as a LITERAL (§7.4) — `priceToAmerican(1/1)` throws
 *    by design, because even money has no American form (§5.5). Use
 *    `effectiveAmericanPrice()` below and that trap is handled for you.
 */

import { totalDecided } from './action.js';
import type { GameAction } from './action.js';
import { MIN_TEASER_LEGS } from './constants.js';
import { AppError } from './errors.js';
import {
  EVEN_MONEY_UNIT,
  PUSH_AMERICAN_PRICE,
  americanToPrice,
  payoutCents,
  priceFromLegs,
  priceToAmerican,
  teaserPrice,
} from './odds.js';
import type {
  AmericanPrice,
  BetLegSnapshot,
  BetStatus,
  Cents,
  GameResult,
  LegGrade,
  LegResult,
  Price,
} from './types.js';

/**
 * A game as grading sees it: status and score (`GameResult`, frozen in
 * `types.ts`) plus the GAME-level verdict on which markets have action
 * (`action.ts`, PLAN.md §23.6). `action` is REQUIRED — an optional field
 * defaulting to `FULL_ACTION` would fail OPEN: a call site that forgot it would
 * grade (and pay) an MLB Final/7's run line. Required, a missed site is a
 * compile error. Football callers pass `gameAction(league, …)`, which is
 * `FULL_ACTION` for every football game.
 *
 * Still no line: the line is the snapshot's (PLAN.md §14.3, rule 7).
 */
export interface GradableGame extends GameResult {
  readonly action: GameAction;
}

/**
 * A leg of a SETTLED bet. `grade` is a `LegResult`, never `'pending'`: a pending
 * bet returns `legs: []`, so M6 can bind `grade` straight into
 * `bet_legs.result` (whose CHECK forbids 'pending') without a cast.
 */
export interface GradedLeg {
  readonly legIndex: number;
  readonly grade: LegResult;
  /**
   * Derived from the leg's snapshot `americanPrice` via `americanToPrice()`.
   * Nothing persists a rational; see PLAN.md §5.2.
   *
   * MEANINGLESS FOR A TEASER LEG, which stores the placeholder +100: a teaser is
   * priced once, at the bet level, from `TEASER_PAYOUTS`. Nothing in the teaser
   * path reads this field; it is still populated so `GradedLeg` has one shape.
   */
  readonly price: Price;
}

/**
 * How a bet's price is derived from its legs. Passed in by the caller because it
 * is a property of the BET ROW (`bets.bet_type` / `bets.teaser_points_tenths`),
 * not of the leg snapshots — the legs of a teaser and of a parlay are
 * indistinguishable once the teased line is stored, which is deliberate: it is
 * what lets `gradeLeg` stay completely unaware that teasers exist.
 */
export type BetPricing =
  { readonly kind: 'parlay' } | { readonly kind: 'teaser'; readonly pointsTenths: number };

/** The default: straights and parlays alike are the product of their legs. */
export const PARLAY_PRICING: BetPricing = Object.freeze({ kind: 'parlay' as const });

export interface BetOutcome {
  /** `pending` means NOTHING is written — not even partial leg results. */
  readonly status: BetStatus;
  /** Total return in cents (stake + profit). 0 for a loss, stake for push/void. */
  readonly payoutCents: Cents;
  /** Per-leg results, only meaningful when `status !== 'pending'`. */
  readonly legs: readonly GradedLeg[];
  /**
   * The effective price after pushed/voided legs are removed, i.e. what the bet
   * was actually PAID at. Per status (for a TEASER, read "the card's row for the
   * surviving leg count" wherever this says "the product of the surviving legs"):
   *   `won`     the product of the surviving (winning) legs only.
   *   `lost`    the full PLACEMENT price — §7.4: "a lost bet keeps its placement
   *             price: there are no surviving legs to re-price from, and the
   *             price it was offered is the honest thing to display."
   *   `push` /
   *   `void`    `EVEN_MONEY_UNIT` (1/1). The stake comes back; see note 3 above.
   *   `pending` `EVEN_MONEY_UNIT`, and meaningless — nothing is written.
   */
  readonly effectivePrice: Price;
  /**
   * Only on a `pending` outcome: which leg blocked settlement and why, in the
   * form M6 writes to `bets.settle_error` (§7.1). Absent on settled outcomes.
   */
  readonly pendingReason?: string;
}

/**
 * A score we are willing to grade on. `null` (never parsed), a fraction, `NaN`,
 * `Infinity` and a negative are all ungradeable garbage — §7.3's "never guess".
 * `0` is NOT garbage: a 0-0 final is a real, gradeable result.
 */
function isGradeableScore(score: number | null): score is number {
  return score !== null && Number.isSafeInteger(score) && score >= 0;
}

/** A line we are willing to grade on. `null` is legal only for a moneyline. */
function isGradeableLine(lineTenths: number | null): lineTenths is number {
  return lineTenths !== null && Number.isSafeInteger(lineTenths);
}

/**
 * Grade a single leg. The order is PLAN.md §7.3 / §23.6's, and is load-bearing:
 *   canceled game                              -> 'void'
 *   status !== 'final'                         -> 'pending'
 *   action.kind === 'undecidable'              -> 'pending'  (never guess)
 *   action.markets[market] === 'no-action'     -> 'void'     (no score needed)
 *   a score is null / not a finite integer     -> 'pending'  (log and skip; never guess)
 *   'no-action-unless-decided' && !decided     -> 'void'     (totals only)
 *   otherwise                                  -> win/loss/push per market
 *
 * League-unaware: it never reads `leg.league`. Which markets of a finished
 * game have action is decided by `action.ts` and handed in on the game.
 *
 * A malformed leg (spread/total with no line, or a market/side pairing that
 * cannot exist) also grades `pending`. It deliberately does NOT throw: a throw
 * inside the settle job would abort the whole chunk, whereas `pending` costs one
 * UPDATE and routes the bet to the `stuck[]` report (§7.1).
 */
export function gradeLeg(leg: BetLegSnapshot, game: GradableGame): LegGrade {
  if (game.status === 'canceled') return 'void';
  if (game.status !== 'final') return 'pending';

  const { action } = game;
  if (action.kind === 'undecidable') return 'pending';
  const marketAction = action.markets[leg.market];
  if (marketAction === 'no-action') return 'void';

  const { homeScore, awayScore } = game;
  if (!isGradeableScore(homeScore) || !isGradeableScore(awayScore)) return 'pending';

  if (marketAction === 'no-action-unless-decided') {
    // Totals only (a line is required to be decided at all). A malformed leg
    // falls through to the per-market switch, which grades it 'pending'.
    if (leg.market === 'total' && isGradeableLine(leg.lineTenths)) {
      if (!totalDecided(homeScore, awayScore, leg.lineTenths)) return 'void';
    } else if (leg.market !== 'total') {
      // Never produced by action.ts; a side market cannot be "decided" early.
      return 'void';
    }
  }

  switch (leg.market) {
    case 'moneyline':
      if (leg.side === 'home') return gradeMoneyline(homeScore, awayScore);
      if (leg.side === 'away') return gradeMoneyline(awayScore, homeScore);
      return 'pending';
    case 'spread': {
      const { lineTenths } = leg;
      if (!isGradeableLine(lineTenths)) return 'pending';
      if (leg.side === 'home') return gradeSpread(homeScore, awayScore, lineTenths);
      if (leg.side === 'away') return gradeSpread(awayScore, homeScore, lineTenths);
      return 'pending';
    }
    case 'total': {
      const { lineTenths, side } = leg;
      if (!isGradeableLine(lineTenths)) return 'pending';
      if (side === 'over' || side === 'under')
        return gradeTotal(homeScore, awayScore, lineTenths, side);
      return 'pending';
    }
  }
}

/**
 * Spread: `(sideScore*10 + lineTenths) - oppScore*10`, sign decides.
 *
 * `lineTenths` is ALREADY from the bettor's side (see `BetLegSnapshot`): a home
 * −3.5 leg carries −35, the away +3.5 side of the same game carries +35. So
 * there is no sign flip here — the caller passes its own score first and the
 * opponent's second, and the line adds to the bettor's side. Half-point lines
 * are exactly representable in tenths, so `=== 0` is a real, reachable compare
 * (PLAN §5.7) and no epsilon appears anywhere.
 */
export function gradeSpread(
  sideScore: number,
  oppScore: number,
  lineTenths: number,
): 'win' | 'loss' | 'push' {
  const margin10 = sideScore * 10 + lineTenths - oppScore * 10;
  if (margin10 > 0) return 'win';
  if (margin10 < 0) return 'loss';
  return 'push';
}

/** Total: `(home + away) * 10` vs `lineTenths`, direction decided by the side. */
export function gradeTotal(
  homeScore: number,
  awayScore: number,
  lineTenths: number,
  side: 'over' | 'under',
): 'win' | 'loss' | 'push' {
  const sum10 = (homeScore + awayScore) * 10;
  if (sum10 === lineTenths) return 'push';
  const wentOver = sum10 > lineTenths;
  if (side === 'over') return wentOver ? 'win' : 'loss';
  return wentOver ? 'loss' : 'win';
}

/** Moneyline: higher score wins, equal is a push (NFL games can tie, 0-0 included). */
export function gradeMoneyline(sideScore: number, oppScore: number): 'win' | 'loss' | 'push' {
  if (sideScore > oppScore) return 'win';
  if (sideScore < oppScore) return 'loss';
  return 'push';
}

/** The single shared "nothing happened" outcome. No writes. */
function pendingOutcome(pendingReason: string): BetOutcome {
  return {
    status: 'pending',
    payoutCents: 0,
    legs: [],
    effectivePrice: EVEN_MONEY_UNIT,
    pendingReason,
  };
}

/** Why a leg is not yet decidable, for `settle_error`. */
function pendingReasonFor(
  legIndex: number,
  leg: BetLegSnapshot,
  game: GradableGame | undefined,
): string {
  if (game === undefined) return `leg ${String(legIndex)}: game ${leg.gameId} not found`;
  if (game.status !== 'final')
    return `leg ${String(legIndex)}: game ${leg.gameId} is ${game.status}`;
  if (game.action.kind === 'undecidable') {
    return `leg ${String(legIndex)}: game ${leg.gameId} is undecidable: ${game.action.reason}`;
  }
  if (!isGradeableScore(game.homeScore) || !isGradeableScore(game.awayScore)) {
    return `leg ${String(legIndex)}: game ${leg.gameId} is final but its score is unusable`;
  }
  return `leg ${String(legIndex)}: malformed leg (${leg.market}/${leg.side}, line ${String(leg.lineTenths)})`;
}

/**
 * Grade a whole bet (a straight is the 1-leg case; there is no separate path).
 *
 * `legs` MUST be in `leg_index` order — §7.2's query is
 * `ORDER BY l.bet_id, l.leg_index` — because `GradedLeg.legIndex` is the array
 * position and is what the per-leg UPDATE in §7.4 binds.
 *
 * `games` is keyed by `gameId`. A leg whose game is absent grades `pending`:
 * a missing row is exactly as unknowable as an unfinished one.
 *
 * M6 OBLIGATION — leg-count guard: §7.2's query is an INNER JOIN on `games`,
 * so a leg whose game row is missing silently vanishes from `legs`, and this
 * function would happily grade (and PAY) a 3-leg parlay as a 2-leg one.
 * Settlement must assert `legs.length === bets.leg_count` before calling here
 * and defer the bet otherwise.
 *
 * Never throws for a pending bet: grades are decided BEFORE any price is
 * derived, so a leg the DB CHECK would never allow (|price| < 100) cannot abort
 * a settle chunk while its game is still in progress.
 *
 * Order matters and is tested:
 *   1. ANY leg still 'pending'  -> the bet stays pending, nothing is written.
 *   2. ANY leg 'loss'           -> 'lost', payout 0. A loss beats every push.
 *   3. Too few surviving 'win' legs -> 'void' if all legs voided, else 'push';
 *                                  payout = stake. The threshold is 1 for a
 *                                  parlay and MIN_TEASER_LEGS (2) for a teaser.
 *   4. Otherwise                -> 'won', payout = floor(stake * survivorPrice).
 *
 * ── TEASERS (`pricing.kind === 'teaser'`, PLAN.md §5.8/§7) ───────────────────
 * The grades themselves are identical — `gradeLeg` reads the TEASED line out of
 * the snapshot and has no idea a tease happened. Only the PRICE differs, and
 * only in three places:
 *   * a loss keeps the placement price, which is `TEASER_PAYOUTS[pts][legCount]`
 *     rather than a product;
 *   * pushed/voided legs reduce the bet to the card's row for the SURVIVING leg
 *     count — a 4-leg 6-point teaser with one push pays as a 3-leg one;
 *   * a reduction below two survivors is NO ACTION: there is no such thing as a
 *     one-team teaser, so the stake comes back at even money. That is the
 *     dominant industry rule (Bovada, covers.com, FanDuel-derived sources), and
 *     it is why step 3's threshold is a parameter instead of a hard `=== 0`.
 *
 * @param pricing Defaults to `PARLAY_PRICING`, so every existing caller and the
 *   entire straight/parlay contract are unchanged by teasers existing.
 * @throws AppError('VALIDATION') for a bet with no legs, a negative /
 *   non-integer stake (the latter from `payoutCents`), or a teaser tier that is
 *   not on the card (from `teaserPrice`).
 * @throws AppError('PAYOUT_LIMIT_EXCEEDED') if the payout would breach the cap.
 *   §7.4 proves this is unreachable for a legally placed parlay — dropping
 *   pushed legs strictly shrinks the product — and the teaser card's largest
 *   payout at the full bankroll is 2,600,000¢ against a 100,000,000¢ cap
 *   (verified). It is left to propagate rather than be clamped, which would
 *   silently underpay.
 */
export function gradeBet(
  stakeCents: Cents,
  legs: readonly BetLegSnapshot[],
  games: ReadonlyMap<string, GradableGame>,
  pricing: BetPricing = PARLAY_PRICING,
): BetOutcome {
  if (legs.length === 0) {
    throw new AppError('VALIDATION', 'A bet must have at least one leg to grade.');
  }

  const grades: LegGrade[] = legs.map((leg) => {
    const game = games.get(leg.gameId);
    return game === undefined ? 'pending' : gradeLeg(leg, game);
  });

  // 1. Pending beats everything, INCLUDING a loss. See note 1 in the header.
  //    Decided before any price derivation so this path can never throw.
  for (const [legIndex, leg] of legs.entries()) {
    if (grades[legIndex] === 'pending') {
      return pendingOutcome(pendingReasonFor(legIndex, leg, games.get(leg.gameId)));
    }
  }

  const graded: GradedLeg[] = legs.map((leg, legIndex) => ({
    legIndex,
    // Narrowed: no 'pending' survives the check above.
    grade: grades[legIndex] as LegResult,
    price: americanToPrice(leg.americanPrice),
  }));

  // 2. A losing leg beats every push, and is evaluated BEFORE push removal.
  if (graded.some((l) => l.grade === 'loss')) {
    return {
      status: 'lost',
      payoutCents: 0,
      legs: graded,
      // §7.4: a lost bet keeps the price it was offered at.
      effectivePrice: priceForSurvivors(pricing, legs, legs.length),
    };
  }

  // 3. Too few survivors: the stake comes back at even money. `void` only when
  //    EVERY leg voided, so one push among voids still reads as a push (§7.3).
  //    A parlay survives on one leg; a teaser needs two (§5.8's no-action rule).
  const survivors = legs.filter((_leg, i) => graded[i]?.grade === 'win');
  const minSurvivors = pricing.kind === 'teaser' ? MIN_TEASER_LEGS : 1;
  if (survivors.length < minSurvivors) {
    const status: BetStatus = graded.every((l) => l.grade === 'void') ? 'void' : 'push';
    return {
      status,
      // Through the BigInt helper, not `stakeCents` raw: floor(stake * 1/1) is
      // the stake, and this way a bad stake is rejected on a push too.
      payoutCents: payoutCents(stakeCents, EVEN_MONEY_UNIT),
      legs: graded,
      effectivePrice: EVEN_MONEY_UNIT,
    };
  }

  // 4. Re-price: the surviving legs' product (§7.4), or the teaser card's row
  //    for however many legs survived.
  const effectivePrice = priceForSurvivors(pricing, survivors, survivors.length);
  return {
    status: 'won',
    payoutCents: payoutCents(stakeCents, effectivePrice),
    legs: graded,
    effectivePrice,
  };
}

/**
 * The price a set of surviving legs is paid at.
 *
 * A parlay multiplies the legs' own snapshot prices; a teaser ignores them
 * entirely and reads one cell of the card. `count` is passed separately from
 * `survivors` so the `lost` branch can ask for the FULL leg count's price (the
 * one the bet was offered at) while handing over the full leg array.
 */
function priceForSurvivors(
  pricing: BetPricing,
  survivors: readonly BetLegSnapshot[],
  count: number,
): Price {
  if (pricing.kind === 'teaser') {
    return americanToPrice(teaserPrice(pricing.pointsTenths, count));
  }
  return priceFromLegs(survivors.map((leg) => leg.americanPrice));
}

/**
 * The value §7.4 binds as `:effectiveAmerican` in the settlement UPDATE.
 *
 * This exists so no caller has to remember that `priceToAmerican(1/1)` THROWS:
 * even money has no American equivalent (§5.5), and a push/void outcome's
 * effective price is exactly 1/1. Those two statuses return the literal 100.
 *
 * A TEASER needs nothing special here. Every value on the card round-trips
 * exactly through `americanToPrice` → `priceToAmerican` (verified, 27/27 cells),
 * so a won or lost teaser renders the same integer the card holds, and a reduced
 * teaser renders its reduced row.
 *
 * @throws AppError('VALIDATION') for a `pending` (or otherwise unsettled) bet —
 *   nothing is written, so there is nothing to price.
 */
export function effectiveAmericanPrice(outcome: BetOutcome): AmericanPrice {
  switch (outcome.status) {
    case 'push':
    case 'void':
      return PUSH_AMERICAN_PRICE;
    case 'won':
    case 'lost':
      return priceToAmerican(outcome.effectivePrice);
    default:
      throw new AppError(
        'VALIDATION',
        `A ${outcome.status} bet has no effective price; only a settled bet does.`,
      );
  }
}

/**
 * The live, unpersisted projection shown next to an OPEN bet's legs in the UI.
 * Identical logic to `gradeLeg` but callers must not write the result. An
 * in-progress game therefore projects as `pending`, never as whoever is ahead.
 */
export function projectLeg(leg: BetLegSnapshot, game: GradableGame): LegGrade {
  return gradeLeg(leg, game);
}
