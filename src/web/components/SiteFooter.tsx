/** The studio credit: the last line of every page, small and dim. */
import type { ReactElement } from 'react';

export function SiteFooter(): ReactElement {
  return (
    <footer className="site-footer">
      <a className="studio-credit" href="https://spicyals.com" target="_blank" rel="noopener">
        A Spicy Al Software Solution
      </a>
    </footer>
  );
}
