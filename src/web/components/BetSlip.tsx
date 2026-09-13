/**
 * The slip sheet: straight/parlay toggle, leg list, stake input, live to-win.
 * role="dialog" with focus trapping.
 *
 * On a 409 LINE_CHANGED it shows the old and new prices and offers an explicit
 * "accept and place" — it never silently re-submits with acceptLineChange.
 */
import { useCallback, useRef } from 'react';
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import { Segmented } from './Segmented.js';
import { SlipSummary } from './SlipSummary.js';
import { StakeInput } from './StakeInput.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { formatAmerican } from '../../shared/odds.js';
import { formatCents, formatLineTenths } from '../../shared/validate.js';
import { MARKET_LABEL } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';
import type { SlipMode } from '../state/slip-reducer.js';
import type { LineTenths } from '../../shared/types.js';

const MODE_OPTIONS: readonly { value: SlipMode; label: string }[] = [
  { value: 'straight', label: 'Straight' },
  { value: 'parlay', label: 'Parlay' },
];

function lineText(lineTenths: LineTenths | null, signed: boolean): string {
  return lineTenths === null ? '' : ` ${formatLineTenths(lineTenths, signed)}`;
}

export function BetSlip(): ReactElement {
  const slip = useBetSlip();
  const config = useConfig();
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    slip.setOpen(false);
  }, [slip]);
  useFocusTrap(dialogRef, slip.open, close);

  if (!slip.open) return <></>;

  const editing = slip.editingBetId !== null;
  const blocked = slip.preview.error !== null || slip.submitting;
  const maxStake = slip.availableCents ?? 0;

  return (
    <div className="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit bet' : 'Bet slip'}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">{editing ? 'Edit bet' : 'Bet slip'}</h2>
          <button type="button" className="btn btn-quiet" onClick={close}>
            Close
          </button>
        </header>

        <Segmented
          label="Bet type"
          value={slip.mode}
          options={MODE_OPTIONS}
          onChange={slip.setMode}
        />

        {slip.legs.length === 0 ? (
          <p className="empty-hint">Tap a price on the board to add a leg.</p>
        ) : (
          <ul className="slip-legs">
            {slip.legs.map((leg) => (
              <li className="slip-leg" key={`${leg.gameId}|${leg.market}|${leg.side}`}>
                <div className="slip-leg-main">
                  <span className="slip-leg-pick">{leg.label}</span>
                  <span className="slip-leg-market">{MARKET_LABEL[leg.market]}</span>
                </div>
                <span className="slip-leg-price">{formatAmerican(leg.americanPrice)}</span>
                <button
                  type="button"
                  className="btn btn-quiet"
                  aria-label={`Remove ${leg.label}`}
                  onClick={() => {
                    slip.removeLeg(leg.gameId, leg.market, leg.side);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <StakeInput
          stakeCents={slip.stakeCents}
          maxCents={maxStake}
          minCents={config.minStakeCents}
          onChange={slip.setStakeCents}
        />

        <SlipSummary preview={slip.preview} stakeCents={slip.stakeCents} />

        {slip.availableCents !== null && (
          <p className="slip-balance">Bankroll {formatCents(slip.availableCents)}</p>
        )}

        {slip.lineChange !== null && (
          <div className="banner banner-warn" role="alert">
            <p className="banner-text">The line moved while you were building this bet:</p>
            <ul className="line-change-list">
              {slip.lineChange.legs.map((leg) => (
                <li key={`${leg.gameId}|${leg.market}|${leg.side}`}>
                  <span className="line-change-market">{MARKET_LABEL[leg.market]}</span>{' '}
                  <span className="line-change-old">
                    {formatAmerican(leg.expected.americanPrice)}
                    {lineText(leg.expected.lineTenths, leg.market === 'spread')}
                  </span>{' '}
                  →{' '}
                  <span className="line-change-new">
                    {leg.current === null
                      ? 'no longer offered'
                      : `${formatAmerican(leg.current.americanPrice)}${lineText(leg.current.lineTenths, leg.market === 'spread')}`}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-primary"
              disabled={slip.submitting}
              onClick={() => {
                void slip.submit(true);
              }}
            >
              Accept new line &amp; place
            </button>
          </div>
        )}

        {slip.lastError !== null && slip.lineChange === null && (
          <ErrorBanner error={slip.lastError} />
        )}

        {slip.preview.error !== null && slip.legs.length > 0 && (
          <p className="slip-problem">{slip.preview.error}</p>
        )}

        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={editing ? slip.cancelEdit : slip.clear}
          >
            {editing ? 'Cancel edit' : 'Clear'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocked}
            onClick={() => {
              void slip.submit(false);
            }}
          >
            {slip.submitting
              ? 'Placing…'
              : editing
                ? `Update — ${formatCents(slip.stakeCents)}`
                : `Place bet — ${formatCents(slip.stakeCents)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
