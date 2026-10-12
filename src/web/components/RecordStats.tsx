/**
 * The per-sport statistics — Record, ROI, Profit and (where the response
 * carries it) Settled — as `<div><dt/><dd/></div>` items for a `.stat-grid`.
 * One component so the account card, a player's header, and the My Bets strip
 * print the same four figures with the same help copy; the money columns stay
 * with their own pages because they are never per sport (PLAN.md §11.5).
 *
 * `scope` only changes the explanatory note: under a single sport, the one
 * thing a reader can be surprised by is a cross-sport parlay that is in
 * neither sport's figures.
 */
import type { ReactElement } from 'react';

import { PROFIT_HELP, PROFIT_HINT, ROI_HELP, ROI_HINT, formatRoi } from '../lib/labels.js';
import type { Scope } from '../lib/scope.js';
import { formatSignedCents } from '../../shared/validate.js';
import type { BettingRecord } from '../../shared/api-types.js';

export interface RecordStatsView {
  readonly record: BettingRecord;
  readonly roi: number | null;
  readonly profitCents: number;
  readonly settledCount?: number;
}

export function RecordStats(props: { readonly stats: RecordStatsView }): ReactElement {
  const s = props.stats;
  return (
    <>
      <div>
        <dt>Record</dt>
        <dd>
          {String(s.record.won)}-{String(s.record.lost)}-{String(s.record.push)}
          {s.record.void > 0 ? ` (${String(s.record.void)} void)` : ''}
        </dd>
      </div>
      <div>
        <dt>
          <abbr className="help" title={PROFIT_HELP}>
            Profit
          </abbr>
        </dt>
        <dd>
          {formatSignedCents(s.profitCents)}
          <small className="stat-hint">{PROFIT_HINT}</small>
        </dd>
      </div>
      <div>
        <dt>
          <abbr className="help" title={ROI_HELP}>
            ROI
          </abbr>
        </dt>
        <dd>
          {formatRoi(s.roi)}
          <small className="stat-hint">{ROI_HINT}</small>
        </dd>
      </div>
      {s.settledCount !== undefined && (
        <div>
          <dt>Settled</dt>
          <dd>{String(s.settledCount)}</dd>
        </div>
      )}
    </>
  );
}

/** Shown under a single sport's figures; nothing under All. */
export function ScopeNote(props: { readonly scope: Scope }): ReactElement | null {
  if (props.scope === 'all') return null;
  return (
    <p className="muted scope-note">
      A parlay that mixes sports counts under All only. The money is the whole account either way.
    </p>
  );
}
