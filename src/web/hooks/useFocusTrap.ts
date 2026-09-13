/**
 * Focus trapping for the bet-slip sheet (PLAN.md §12.4).
 *
 * On open: remember what had focus, move focus into the dialog. While open: Tab
 * and Shift+Tab cycle within it, Escape closes. On close: restore focus to the
 * element that opened it, so a keyboard user is not dumped at the top of the
 * document.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  // `onClose` is read through a ref so it is NOT an effect dependency.
  //
  // This is the whole reason the trap is correct. Arming it moves focus to the
  // first focusable child and disarming it restores focus to whatever opened
  // the sheet, so a re-run is VISIBLE: it yanks the caret out of the stake box.
  // With `onClose` in the dependency array, every render that produced a new
  // handler re-armed the trap — and the slip context is re-memoised on every
  // keystroke (SET_STAKE returns a new LeagueSlip, `computePreview` a new
  // object), so a single keystroke stole focus and typing "12.50" was
  // impossible. Deps are now only the things that genuinely change what the
  // trap is trapping.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (container === null) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = (): HTMLElement[] =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    (focusables()[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [ref, active]);
}
