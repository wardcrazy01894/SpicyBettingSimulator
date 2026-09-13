/**
 * The one segmented control used by the Open/Settled, NFL/NCAAF/All-time and
 * straight/parlay switches. Real `<button role="tab">`s with `aria-selected`,
 * 44px tall via `.segment` in styles.css.
 */
import type { ReactElement } from 'react';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
}): ReactElement {
  const { label, value, options, onChange } = props;
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          className="segment"
          aria-selected={option.value === value}
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
