/**
 * A STRUCTURAL guard on the focus trap's dependencies.
 *
 * The bug: the stake input lost focus after a single keystroke. `useFocusTrap`
 * arms itself by focusing the dialog's first focusable child and disarms by
 * restoring focus to whatever opened the sheet, so re-running its effect is
 * visible — it yanks the caret out of the box. The effect listed `onClose` in
 * its dependency array, `BetSlip` built `onClose` with `useCallback(…, [slip])`,
 * and the slip context is re-memoised on every keystroke (SET_STAKE returns a
 * new `LeagueSlip`; `computePreview` returns a fresh object). One keystroke, one
 * re-arm, focus gone. `tests/web/slip-edit-flow.spec.ts` proves that churn is
 * real; this file proves it can no longer reach the trap.
 *
 * Asserted against the SOURCE because the mechanism is a React effect over real
 * DOM focus, and this project has no DOM environment (`vitest.web.config.ts` is
 * node, and jsdom is deliberately not a dependency). A source assertion is
 * narrow, but it fails loudly the moment someone puts a slip-derived value back
 * in either dependency list — which is exactly the regression.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/web/${relative}`, import.meta.url)), 'utf8');
}

/** The dependency lists of every `useEffect`/`useCallback` in a file, in order. */
function hookDeps(code: string, hook: 'useEffect' | 'useCallback'): readonly string[] {
  const deps: string[] = [];
  const pattern = new RegExp(`${hook}\\(`, 'g');
  for (const match of code.matchAll(pattern)) {
    // Walk forward from the call's open paren to its matching close paren.
    let depth = 0;
    let end = -1;
    for (let i = match.index + match[0].length - 1; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const call = code.slice(match.index, end);
    const list = /,\s*\[([^\]]*)\]\s*,?\s*$/.exec(call);
    if (list !== null) deps.push(list[1]?.replace(/\s+/g, ' ').trim() ?? '');
  }
  return deps;
}

describe('useFocusTrap dependencies', () => {
  const code = source('hooks/useFocusTrap.ts');

  it('arms on the ref and `active` ONLY', () => {
    // The first useEffect keeps `onClose` fresh in a ref and is intentionally
    // dependency-free (it runs every render); the second is the trap itself.
    const deps = hookDeps(code, 'useEffect');
    expect(deps).toContain('ref, active');
  });

  it('never lists `onClose` as a dependency', () => {
    for (const list of hookDeps(code, 'useEffect')) {
      expect(list.split(',').map((d) => d.trim())).not.toContain('onClose');
    }
  });

  it('reads the close handler through a ref, so a fresh one is picked up anyway', () => {
    expect(code).toMatch(/onCloseRef\.current\(\)/);
    expect(code).toMatch(/onCloseRef\.current = onClose/);
  });
});

describe("BetSlip's close handler", () => {
  const code = source('components/BetSlip.tsx');

  it('depends on the STABLE setter, never on the whole slip context', () => {
    const deps = hookDeps(code, 'useCallback');
    expect(deps).toContain('setOpen');
    expect(deps).not.toContain('slip');
  });

  it('destructures `setOpen` rather than closing over `slip`', () => {
    expect(code).toMatch(/const \{ setOpen \} = slip;/);
  });
});
