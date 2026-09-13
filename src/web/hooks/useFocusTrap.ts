/**
 * Focus trapping for the bet-slip sheet (PLAN.md §12.4).
 *
 * On open: remember what had focus, move focus into the dialog. While open: Tab
 * and Shift+Tab cycle within it, Escape closes. On close: restore focus to the
 * element that opened it, so a keyboard user is not dumped at the top of the
 * document.
 */

import { useEffect } from 'react';
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
        onClose();
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
  }, [ref, active, onClose]);
}
