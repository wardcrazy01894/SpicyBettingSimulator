/**
 * The college boards' Top 25 / conference dropdown (CFB, and college
 * basketball since M13d — PLAN.md §24.14). It takes the league's spec, so
 * each board lists its own conferences. A native <select>, like the week
 * picker: a dozen options is past what a segmented row can hold on a phone,
 * and the native control gets the platform's picker for free.
 */
import type { ReactElement } from 'react';

import { boardFilterOptions, isBoardFilter } from '../lib/board-filter.js';
import type { BoardFilter, BoardFilterSpec } from '../lib/board-filter.js';

export function BoardFilterSelect(props: {
  readonly spec: BoardFilterSpec;
  readonly filter: BoardFilter;
  readonly onChange: (filter: BoardFilter) => void;
}): ReactElement {
  const { spec, filter, onChange } = props;
  return (
    <div className="week-picker">
      <label className="week-label" htmlFor="board-filter">
        Show
      </label>
      <select
        id="board-filter"
        className="week-select"
        value={filter}
        onChange={(event) => {
          const next = event.target.value;
          if (isBoardFilter(next)) onChange(next);
        }}
      >
        {boardFilterOptions(spec).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
