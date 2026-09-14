/**
 * The slip sheet: Straight / Parlay / Teaser toggle, leg list, stake input, live
 * to-win. role="dialog" with focus trapping.
 *
 * On a 409 LINE_CHANGED it shows the old and new prices and offers an explicit
 * "accept and place" — it never silently re-submits with acceptLineChange.
 *
 * TEASER MODE shows each leg as "book line → teased line" and prices the whole
 * slip from `config.teaserPayouts`, which the SERVER echoes. The legs' own
 * prices are hidden there because they are not what the bet pays.
 *
 * ONE SLIP, CROSS-LEAGUE (M5b). Legs may come from either league tab, so each
 * carries an NFL / CFB badge — the tab you happen to be on no longer tells you
 * where a pick came from.
 */
import { useCallback, useRef } from 'react';
import type { ReactElement } from 'react';

import { ErrorBanner } from './ErrorBanner.js';
import { Segmented } from './Segmented.js';
import { SlipSummary } from './SlipSummary.js';
import { StakeInput } from './StakeInput.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { formatAmerican, teasedLineTenths } from '../../shared/odds.js';
import { formatCents, formatLineTenths } from '../../shared/validate.js';
import { LEAGUE_BADGE, MARKET_LABEL, teaserPointsLabel } from '../lib/labels.js';
import { useBetSlip } from '../state/bet-slip.js';
import { useConfig } from '../state/config.js';
import type { SlipLeg, SlipMode } from '../state/slip-reducer.js';
import type { LineTenths } from '../../shared/types.js';

const MODE_OPTIONS: readonly { value: SlipMode; label: string }[] = [
  { value: 'straight', label: 'Straight' },
  { value: 'parlay', label: 'Parlay' },
  { value: 'teaser', label: 'Teaser' },
];

function lineText(lineTenths: LineTenths | null, signed: boolean): string {
  return lineTenths === null ? '' : ` ${formatLineTenths(lineTenths, signed)}`;
}

/**
 * "-7.5 → -1.5" for a teasable leg, or a reason it cannot be teased.
 *
 * A moneyline leg already in the slip when the user switches to Teaser is NOT
 * silently dropped — deleting somebody's pick to make their slip valid is worse
 * than telling them — so it renders as "no line to tease" and the preview's own
 * validation error blocks the submit until they remove it.
 */
function teaseText(leg: SlipLeg, pointsTenths: number): string {
  if (leg.market === 'moneyline' || leg.lineTenths === null) return 'no line to tease';
  const signed = leg.market === 'spread';
  const teased = teasedLineTenths(leg.market, leg.side, leg.lineTenths, pointsTenths);
  return `${formatLineTenths(leg.lineTenths, signed)} → ${formatLineTenths(teased, signed)}`;
}

export function BetSlip(): ReactElement {
  const slip = useBetSlip();
  const config = useConfig();
  const dialogRef = useRef<HTMLDivElement>(null);

  // `setOpen` ONLY. The context object is re-memoised on every slip change — a
  // keystroke in the stake box produces a new `Slip` and a new preview —
  // so a `close` that depended on the whole context was a new function on every
  // keystroke, which re-armed the focus trap and threw focus back to the Close
  // button. `setOpen` is a `useState` setter and is stable for the app's life.
  const { setOpen } = slip;
  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);
  useFocusTrap(dialogRef, slip.open, close);

  if (!slip.open) return <></>;

  const editing = slip.editingBetId !== null;
  const blocked = slip.preview.error !== null || slip.submitting;
  const maxStake = slip.availableCents ?? 0;
  // Neither multi is placeable below two legs, so both are greyed until then.
  const modeOptions = MODE_OPTIONS.map((option) =>
    option.value !== 'straight' && slip.legs.length < 2 ? { ...option, disabled: true } : option,
  );
  const teasing = slip.mode === 'teaser';
  const pointsOptions = config.teaserPoints.map((tenths) => ({
    value: tenths,
    label: teaserPointsLabel(tenths),
  }));

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
          options={modeOptions}
          onChange={slip.setMode}
        />

        {teasing && (
          <>
            {/* Thirteen tiers: a native <select>, like the week picker — a
                segmented row cannot hold that many on a phone. */}
            <div className="week-picker">
              <label className="week-label" htmlFor="teaser-points">
                Teaser points
              </label>
              <select
                id="teaser-points"
                className="week-select"
                value={String(slip.teaserPointsTenths)}
                onChange={(event) => {
                  slip.setTeaserPoints(Number(event.target.value));
                }}
              >
                {pointsOptions.map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted slip-hint">
              Every line moves {teaserPointsLabel(slip.teaserPointsTenths)} your way. Spreads and
              totals only — moneylines cannot be teased.
            </p>
          </>
        )}

        {slip.legs.length === 0 ? (
          <p className="empty-hint">Tap a price on the board to add a leg.</p>
        ) : (
          <ul className="slip-legs">
            {slip.legs.map((leg) => (
              <li className="slip-leg" key={`${leg.gameId}|${leg.market}|${leg.side}`}>
                <div className="slip-leg-main">
                  {/*
                   * The slip is ONE cross-league draft (M5b), so which league a
                   * leg came from is no longer implied by the tab you are on and
                   * has to be said on the leg itself.
                   */}
                  <span className="chip chip-quiet slip-leg-league">
                    {LEAGUE_BADGE[leg.league]}
                  </span>
                  <span className="slip-leg-pick">{leg.label}</span>
                  <span className="slip-leg-market">{MARKET_LABEL[leg.market]}</span>
                </div>
                <span className="slip-leg-price">
                  {teasing
                    ? teaseText(leg, slip.teaserPointsTenths)
                    : formatAmerican(leg.americanPrice)}
                </span>
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
          <p className="slip-balance">Balance {formatCents(slip.availableCents)}</p>
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
            {slip.canAcceptLineChange ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={slip.submitting}
                onClick={() => {
                  void slip.acceptLineChange();
                }}
              >
                Accept new line &amp; place
              </button>
            ) : (
              <p className="banner-text">
                One of these markets is no longer offered — remove that leg and try again.
              </p>
            )}
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
              void slip.submit();
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
