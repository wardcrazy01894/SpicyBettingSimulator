/**
 * Human labels for the domain enums. One table per enum, typed as a total
 * `Record<...>` so adding a member to `src/shared/types.ts` breaks the build here
 * instead of rendering a raw enum value to a user.
 */

import { formatLineTenths } from '../../shared/validate.js';
import type {
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
};

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
