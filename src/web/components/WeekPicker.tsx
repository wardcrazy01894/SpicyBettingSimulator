/**
 * Week selector for the board.
 *
 * INTERPRETATION (PLAN.md §11.3 / §12.1): there is no "list the weeks" route, so
 * the dropdown is built from the weeks actually present in the slate the server
 * returned, unioned with whatever week is selected. The ◀ / ▶ buttons step by
 * one and are clamped at week 1 on the low side only — the API is the authority
 * on how many weeks a season has, and an out-of-range week simply comes back
 * empty, which is a legible outcome rather than a guess baked into the client.
 */
import type { ReactElement } from 'react';

export function WeekPicker(props: {
  readonly week: number | null;
  readonly season: number | null;
  readonly weeks: readonly number[];
  readonly onChange: (week: number | null) => void;
}): ReactElement {
  const { week, season, weeks, onChange } = props;

  return (
    <div className="week-picker">
      <button
        type="button"
        className="btn btn-quiet"
        aria-label="Previous week"
        disabled={week === null || week <= 1}
        onClick={() => {
          if (week !== null) onChange(week - 1);
        }}
      >
        ◀
      </button>

      <label className="week-label" htmlFor="week-select">
        {season === null ? 'Week' : `${String(season)} · Week`}
      </label>
      <select
        id="week-select"
        className="week-select"
        value={week === null ? '' : String(week)}
        onChange={(event) => {
          onChange(event.target.value === '' ? null : Number(event.target.value));
        }}
      >
        <option value="">Current</option>
        {weeks.map((candidate) => (
          <option key={candidate} value={String(candidate)}>
            {String(candidate)}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="btn btn-quiet"
        aria-label="Next week"
        disabled={week === null}
        onClick={() => {
          if (week !== null) onChange(week + 1);
        }}
      >
        ▶
      </button>
    </div>
  );
}
