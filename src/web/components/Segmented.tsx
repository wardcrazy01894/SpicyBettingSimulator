/**
 * The one segmented control used by the Open/Settled, NFL/NCAAF/All-time and
 * straight/parlay switches. 44px tall via `.segment` in styles.css.
 *
 * PLAIN buttons with `aria-pressed`, deliberately NOT `role="tab"`. A tablist
 * owes assistive tech a `tabpanel` for each tab and roving `tabindex` /
 * arrow-key movement between them; none of these three switches has a panel to
 * point at (they filter the page around them), and implementing a half tablist
 * is worse than not claiming the role. `aria-pressed` toggle buttons describe
 * exactly what these are.
 */
import type { ReactElement } from 'react';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** e.g. "Parlay" below two legs — offered, but not selectable yet. */
  readonly disabled?: boolean;
}

export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
}): ReactElement {
  const { label, value, options, onChange } = props;
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment"
          aria-pressed={option.value === value}
          disabled={option.disabled ?? false}
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
