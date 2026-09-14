import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_MAX_EVENTS,
  DIAGNOSTICS_MAX_EVENT_CHARS,
  DIAGNOSTICS_MAX_HEAD_FIELD_CHARS,
  DiagnosticsLog,
  describeThrown,
  renderDiagnostics,
} from '../../src/web/lib/diagnostics.js';
import type { DiagnosticsEnvironment } from '../../src/web/lib/diagnostics.js';

const ENV: DiagnosticsEnvironment = {
  appVersion: '0.1.0',
  userAgent: 'Mozilla/5.0 (test)',
  viewport: { width: 390, height: 844 },
  language: 'en-US',
  online: true,
  page: '/bets',
};

function logAt(times: number[]): DiagnosticsLog {
  let i = 0;
  return new DiagnosticsLog(() => times[i++] ?? times[times.length - 1] ?? 0);
}

describe('DiagnosticsLog', () => {
  it('keeps events newest-last and drops the oldest past the cap', () => {
    const log = new DiagnosticsLog(() => 1, 3);
    for (const n of [1, 2, 3, 4, 5]) log.record('api', `call ${String(n)}`);
    expect(log.list().map((e) => e.text)).toEqual(['call 3', 'call 4', 'call 5']);
  });

  it('collapses whitespace, ignores blanks, and cuts an oversized event', () => {
    const log = new DiagnosticsLog(() => 1);
    log.record('console', '   ');
    log.record('error', 'Error:\n  at a\n   at b');
    log.record('error', 'x'.repeat(DIAGNOSTICS_MAX_EVENT_CHARS + 50));
    const [a, b] = log.list();
    expect(log.list()).toHaveLength(2);
    expect(a?.text).toBe('Error: at a at b');
    expect(b?.text.length).toBe(DIAGNOSTICS_MAX_EVENT_CHARS + 1);
    expect(b?.text.endsWith('…')).toBe(true);
  });

  it('default cap is DIAGNOSTICS_MAX_EVENTS', () => {
    const log = new DiagnosticsLog(() => 1);
    for (let n = 0; n < DIAGNOSTICS_MAX_EVENTS + 10; n += 1) log.record('route', `/p${String(n)}`);
    expect(log.list()).toHaveLength(DIAGNOSTICS_MAX_EVENTS);
  });
});

describe('renderDiagnostics', () => {
  it('prints the environment, then events oldest first with a UTC clock', () => {
    const log = logAt([Date.UTC(2026, 8, 14, 15, 30, 0, 250), Date.UTC(2026, 8, 14, 15, 30, 1, 0)]);
    log.record('route', '/');
    log.record('api', 'POST /api/bets 409 LINE_CHANGED 120ms');
    const text = renderDiagnostics(ENV, log.list(), 8000);
    expect(text).toContain('app 0.1.0 · en-US · 390×844 · online');
    expect(text).toContain('page /bets');
    expect(text).toContain('ua Mozilla/5.0 (test)');
    expect(text).toContain('2 events, oldest first:');
    expect(text).toContain('15:30:00.250 route     /');
    expect(text).toContain('15:30:01.000 api       POST /api/bets 409 LINE_CHANGED 120ms');
  });

  it('says so when nothing was recorded, and renders unknowns as ?', () => {
    const text = renderDiagnostics(
      {
        appVersion: null,
        userAgent: null,
        viewport: null,
        language: null,
        online: null,
        page: null,
      },
      [],
      8000,
    );
    expect(text).toContain('app ? · ? · viewport ? · online ?');
    expect(text).toContain('(no events recorded)');
  });

  it('cuts from the OLD end to fit maxChars and says how many were dropped', () => {
    const log = new DiagnosticsLog(() => 0);
    for (let n = 0; n < 40; n += 1)
      log.record('api', `GET /api/games 200 ${String(n).padStart(3, '0')}ms`);
    const text = renderDiagnostics(ENV, log.list(), 700);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toMatch(/… \d+ earlier events cut/);
    // The newest event is always kept.
    expect(text).toContain('GET /api/games 200 039ms');
    expect(text).not.toContain('GET /api/games 200 000ms');
  });

  it('never exceeds maxChars, whatever the head contains', () => {
    const log = new DiagnosticsLog(() => 0);
    for (let n = 0; n < 5; n += 1) log.record('api', `GET /api/games 200 ${String(n)}ms`);
    const huge = { ...ENV, userAgent: 'U'.repeat(9000), page: `/games?${'q=1&'.repeat(500)}` };
    for (const max of [8000, 2000, 400, 120]) {
      const text = renderDiagnostics(huge, log.list(), max);
      expect(text.length, `max ${String(max)}`).toBeLessThanOrEqual(max);
    }
    // The head fields are cut at DIAGNOSTICS_MAX_HEAD_FIELD_CHARS, not dropped.
    const text = renderDiagnostics(huge, log.list(), 8000);
    expect(text).toContain(`ua ${'U'.repeat(DIAGNOSTICS_MAX_HEAD_FIELD_CHARS)}…`);
    expect(text).toContain('GET /api/games 200 4ms');
  });

  it('marks offline', () => {
    expect(renderDiagnostics({ ...ENV, online: false }, [], 8000)).toContain('OFFLINE');
  });
});

describe('describeThrown', () => {
  it('names an Error with its message and first stack frame', () => {
    const err = new TypeError('bad');
    err.stack = 'TypeError: bad\n    at doThing (app.js:10:5)\n    at other (app.js:20:1)';
    expect(describeThrown(err)).toBe('TypeError: bad (at doThing (app.js:10:5))');
  });

  it('never throws, even for a value that cannot be stringified', () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'x', {
      enumerable: true,
      get: () => {
        throw new Error('getter');
      },
    });
    expect(describeThrown(hostile)).toBe('[unprintable value]');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeThrown(circular)).toBe('[object Object]');
  });

  it('clear() empties the log', () => {
    const log = new DiagnosticsLog(() => 1);
    log.record('route', '/admin');
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it('passes strings through and JSON-encodes the rest', () => {
    expect(describeThrown('plain')).toBe('plain');
    expect(describeThrown({ code: 7 })).toBe('{"code":7}');
    expect(describeThrown(undefined)).toBe('undefined');
  });
});

describe('redactPath', () => {
  it('collapses uuid path segments to :id and leaves everything else', async () => {
    const { redactPath } = await import('../../src/web/diagnostics.js');
    expect(redactPath('/api/bets/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')).toBe('/api/bets/:id');
    expect(redactPath('/api/admin/users/3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B/adjust')).toBe(
      '/api/admin/users/:id/adjust',
    );
    expect(redactPath('/api/games')).toBe('/api/games');
  });
});
