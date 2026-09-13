/** Renders an ApiError using messageForCode, with a retry affordance. */
import type { ReactElement } from 'react';

export function ErrorBanner(_props: {
  readonly error: unknown;
  onRetry?: () => void;
}): ReactElement {
  throw new Error('not implemented: M7a');
}
