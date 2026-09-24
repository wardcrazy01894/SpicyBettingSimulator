/**
 * Human labels for the domain enums. One table per enum, typed as a total
 * `Record<...>` so adding a member to `src/shared/types.ts` breaks the build here
 * instead of rendering a raw enum value to a user.
 */

import { MIN_TEASER_LEGS } from '../../shared/constants.js';
import { formatAmerican } from '../../shared/odds.js';
import { distinctGameIds, formatLineTenths } from '../../shared/validate.js';
import type {
  BetLeague,
  BetStatus,
  BetType,
  GameStatus,
  League,
  LedgerKind,
  LegGrade,
  LineTenths,
  Market,
  Side,
} from '../../shared/types.js';

export const LEAGUE_LABEL: Readonly<Record<League, string>> = {
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  mlb: 'MLB',
};

/**
 * A BET's league, which may be `'mixed'` — a cross-league parlay or teaser
 * (M5b). Separate from `LEAGUE_LABEL` because a GAME is never mixed, and a
 * `Record<League, …>` that quietly accepted a third key would stop failing the
 * build when a real fourth league appeared.
 */
export const BET_LEAGUE_LABEL: Readonly<Record<BetLeague, string>> = {
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  mlb: 'MLB',
  // Not 'NFL + NCAAF' since M12a: that would be false for MLB + NFL. The slip's
  // `leagueSummary` names the actual leagues from the legs (PLAN.md §23.12).
  mixed: 'Mixed',
};

/**
 * The SHORT badge shown on each leg of a cross-league slip, where the label sits
 * beside a pick and has to stay out of the way. "CFB" rather than "NCAAF"
 * because it is three characters and is what the product owner calls it; the
 * long form stays for headings, where the room exists.
 */
export const LEAGUE_BADGE: Readonly<Record<League, string>> = {
  nfl: 'NFL',
  ncaaf: 'CFB',
  mlb: 'MLB',
};

export const MARKET_LABEL: Readonly<Record<Market, string>> = {
  moneyline: 'Moneyline',
  spread: 'Spread',
  total: 'Total',
};

export const SIDE_LABEL: Readonly<Record<Side, string>> = {
  home: 'Home',
  away: 'Away',
  over: 'Over',
  under: 'Under',
};

export const BET_TYPE_LABEL: Readonly<Record<BetType, string>> = {
  straight: 'Straight',
  parlay: 'Parlay',
  teaser: 'Teaser',
};

/** Whether any two legs are on one game — a same-game parlay or teaser (M11). */
export function hasSameGameLegs(legs: readonly { readonly gameId: string }[]): boolean {
  return distinctGameIds(legs).length < legs.length;
}

/**
 * The bet card's shape line: "Straight", "Parlay · 3 legs", "6.5-pt teaser ·
 * 2 legs", and "Same game parlay · 2 legs" when two legs share a game. The
 * word order is the industry's; nothing here changes how the bet is priced.
 */
export function betShapeLabel(bet: {
  readonly betType: BetType;
  readonly teaserPoints: number | null;
  readonly legs: readonly { readonly gameId: string }[];
}): string {
  if (bet.betType === 'straight') return BET_TYPE_LABEL.straight;
  // The noun is composed for its position in the sentence, never re-cased
  // from a heading label: "6-pt teaser" / "parlay" mid-sentence after "Same
  // game", or capitalised on its own.
  const noun =
    bet.teaserPoints === null ? 'parlay' : `${teaserPointsLabel(bet.teaserPoints)} teaser`;
  const shape = hasSameGameLegs(bet.legs)
    ? `Same game ${noun}`
    : bet.teaserPoints === null
      ? BET_TYPE_LABEL[bet.betType]
      : noun;
  return `${shape} · ${String(bet.legs.length)} legs`;
}

/**
 * A teaser tier in TENTHS rendered as points: 60 → "6-pt", 65 → "6.5-pt".
 *
 * Reuses `formatLineTenths`, which is the only thing in the app allowed to turn
 * tenths into a decimal string — a second implementation here is exactly how
 * "6.5" starts rendering as "6".
 */
export function teaserPointsLabel(pointsTenths: number): string {
  return `${formatLineTenths(pointsTenths, false)}-pt`;
}

/**
 * The tier dropdown's entry: "6-pt · -120". The price is the card's cell for
 * the slip's CURRENT leg count; a slip below the teaser minimum (not yet
 * placeable) previews the smallest row rather than nothing. Any cell the
 * server's card does not have — an unknown tier, or more legs than it prices —
 * falls back to the bare points label: the card is the truth, and the label
 * must never invent a number (no upper clamp, on purpose).
 */
export function teaserTierOptionLabel(
  pointsTenths: number,
  legCount: number,
  card: Readonly<Record<number, Readonly<Record<number, number>>>>,
): string {
  const legs = Math.max(legCount, MIN_TEASER_LEGS);
  const price = card[pointsTenths]?.[legs];
  const points = teaserPointsLabel(pointsTenths);
  return price === undefined ? points : `${points} · ${formatAmerican(price)}`;
}

export const BET_STATUS_LABEL: Readonly<Record<BetStatus, string>> = {
  pending: 'Open',
  won: 'Won',
  lost: 'Lost',
  push: 'Push',
  void: 'Void',
  cancelled: 'Cancelled',
};

export const LEG_GRADE_LABEL: Readonly<Record<LegGrade, string>> = {
  win: 'Win',
  loss: 'Loss',
  push: 'Push',
  void: 'Void',
  pending: 'Live',
};

export const GAME_STATUS_LABEL: Readonly<Record<GameStatus, string>> = {
  scheduled: 'Scheduled',
  in_progress: 'Live',
  final: 'Final',
  postponed: 'Postponed',
  canceled: 'Canceled',
  unknown: 'Unknown',
};

export const LEDGER_KIND_LABEL: Readonly<Record<LedgerKind, string>> = {
  deposit_initial: 'Opening bankroll',
  bet_stake: 'Bet placed',
  bet_payout: 'Bet payout',
  bet_refund: 'Bet refunded',
  admin_adjust: 'Admin adjustment',
};

/** CSS modifier suffix for win/loss/push colouring. */
export const GRADE_TONE: Readonly<Record<LegGrade, string>> = {
  win: 'win',
  loss: 'loss',
  push: 'push',
  void: 'push',
  pending: 'pending',
};

export const STATUS_TONE: Readonly<Record<BetStatus, string>> = {
  pending: 'pending',
  won: 'win',
  lost: 'loss',
  push: 'push',
  void: 'push',
  cancelled: 'pending',
};

/**
 * The short pick label for one market/side, e.g. "MIA -3.5", "o 47.5", "NE ML".
 * `formatLineTenths` (shared) is the only thing allowed to render a line.
 */
export function pickLabel(
  market: Market,
  side: Side,
  lineTenths: LineTenths | null,
  homeAbbr: string,
  awayAbbr: string,
): string {
  const team = side === 'home' ? homeAbbr : awayAbbr;
  if (market === 'moneyline') return `${team} ML`;
  if (market === 'spread') {
    return lineTenths === null ? `${team} spread` : `${team} ${formatLineTenths(lineTenths, true)}`;
  }
  const ou = side === 'over' ? 'O' : 'U';
  return lineTenths === null ? `${ou} total` : `${ou} ${formatLineTenths(lineTenths, false)}`;
}

/** "Q3 · 4:12" from a game's period + clock, or the server's status detail. */
export function gameClockLabel(
  status: GameStatus,
  statusDetail: string | null,
  period: number | null,
  displayClock: string | null,
): string {
  if (status === 'in_progress' && period !== null && displayClock !== null) {
    return `Q${String(period)} · ${displayClock}`;
  }
  return statusDetail ?? GAME_STATUS_LABEL[status];
}

/** ROI as a signed percentage, or "—" when there is no settled action. */
export function formatRoi(roi: number | null): string {
  if (roi === null) return '—';
  const pct = roi * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
