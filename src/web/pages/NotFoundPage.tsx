import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';

export function NotFoundPage(): ReactElement {
  return (
    <section className="page">
      <h2 className="page-title">Nothing here</h2>
      <p className="muted">That page does not exist.</p>
      <Link className="btn btn-quiet" to="/">
        Back to the board
      </Link>
    </section>
  );
}
