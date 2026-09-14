/**
 * "Report a bug" is reachable from every page (the header button), so the
 * open/close state lives above the router in AppShell and any page can ask
 * for it with `useBugReport().open()`. PLAN.md §11.7.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface BugReportApi {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
}

const BugReportContext = createContext<BugReportApi | null>(null);

export function BugReportProvider(props: { readonly children: ReactNode }): ReactElement {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => {
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  const api = useMemo<BugReportApi>(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return <BugReportContext.Provider value={api}>{props.children}</BugReportContext.Provider>;
}

export function useBugReport(): BugReportApi {
  const api = useContext(BugReportContext);
  if (api === null) throw new Error('useBugReport outside BugReportProvider');
  return api;
}
