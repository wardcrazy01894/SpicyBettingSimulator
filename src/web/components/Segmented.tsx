/**
 * The one segmented control used by the Open/Settled, All/NFL/NCAAF,
 * Straight/Parlay/Teaser and 6/6.5/7-point switches. 44px tall via `.segment`
 * in styles.css.
 *
 * `T` allows a NUMBER as well as a string so the teaser tier (60/65/70 tenths)
 * can be its own value rather than a stringified one that every call site has to
 * parse back — a parse is exactly where "6.5 points" becomes "6 points".
 *
 * PLAIN buttons with `aria-pressed`, deliberately NOT `role="tab"`. A tablist
 * owes assistive tech a `tabpanel` for each tab and roving `tabindex` /
 * arrow-key movement between them; none of these three switches has a panel to
 * point at (they filter the page around them), and implementing a half tablist
 * is worse than not claiming the role. `aria-pressed` toggle buttons describe
 * exactly what these are.
 */
import type { ReactElement } from 'react';

export interface SegmentedOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /** e.g. "Parlay" below two legs — offered, but not selectable yet. */
  readonly disabled?: boolean;
}

export function Segmented<T extends string | number>(props: {
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
