import type { ReactElement } from 'react';

export function Spinner(props: { readonly label?: string }): ReactElement {
  const label = props.label ?? 'Loading';
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner-dot" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
    </div>
  );
}
