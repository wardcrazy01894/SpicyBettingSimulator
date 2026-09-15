/**
 * A real `role="tablist"` — the WAI-ARIA Tabs pattern with automatic activation:
 * each tab names its panel via `aria-controls`, only the active tab is in the tab
 * order (roving `tabindex`), and Left/Right/Home/End move focus AND selection.
 *
 * This is the counterpart to `<Segmented>`, which deliberately does NOT claim the
 * tab role because its switches filter the page around them rather than pick a
 * panel. Use this one when there is a panel to point at, `<Segmented>` otherwise.
 *
 * The caller renders ONE `<TabPanel>` per tab, so every `aria-controls` resolves,
 * and passes `hidden` for the inactive ones:
 *
 *   <Tabs id="admin" label="Admin sections" tabs={TABS} value={tab} onChange={setTab} />
 *   {TABS.map((t) => (
 *     <TabPanel key={t.id} id="admin" tab={t.id} label={t.label} hidden={t.id !== tab}>…</TabPanel>
 *   ))}
 *
 * The panel is `tabindex="0"` (the APG fallback): a panel can be empty — "No
 * bug reports yet." is two paragraphs — and without it Tab from the tablist
 * would skip the whole panel and land in the bet slip.
 *
 * Each panel also gets a visually-hidden `<h3>` naming it, because a tab label
 * is a region name, not a heading, and heading navigation was how the old
 * one-long-scroll page was traversed.
 */
import { useRef } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

import { nextTabIndex } from '../lib/tabs.js';

export interface TabOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

function tabId(group: string, tab: string): string {
  return `${group}-tab-${tab}`;
}

function panelId(group: string, tab: string): string {
  return `${group}-panel-${tab}`;
}

export function Tabs<T extends string>(props: {
  /** Prefix for the element ids that tie each tab to its panel. */
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly TabOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  const { id, label, tabs, value, onChange } = props;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Leave browser/OS chords alone (Cmd+Left is "back" in Safari).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = tabs.findIndex((tab) => tab.id === value);
    const next = nextTabIndex(event.key, current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    onChange(target.id);
    buttons.current[next]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId(id, tab.id)}
            className="tab"
            aria-selected={selected}
            aria-controls={panelId(id, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(tab.id);
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel(props: {
  readonly id: string;
  readonly tab: string;
  /** The tab's label, repeated as the panel's hidden heading. */
  readonly label: string;
  readonly hidden: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { id, tab, label, hidden, children } = props;
  return (
    <div
      className="tabpanel"
      role="tabpanel"
      id={panelId(id, tab)}
      aria-labelledby={tabId(id, tab)}
      hidden={hidden}
      tabIndex={0}
    >
      <h3 className="sr-only">{label}</h3>
      {children}
    </div>
  );
}
