/** inputMode="decimal", quick chips ($5/$25/$100/Max), parseDollarsToCents. */
import type { ReactElement } from 'react';

export interface StakeInputProps {
  readonly stakeCents: number;
  readonly maxCents: number;
  onChange(cents: number): void;
}

export function StakeInput(_props: StakeInputProps): ReactElement {
  throw new Error('not implemented: M7b');
}
