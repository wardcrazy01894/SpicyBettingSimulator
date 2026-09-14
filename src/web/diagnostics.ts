/**
 * Wires the diagnostics log (lib/diagnostics.ts, pure) to the browser:
 * uncaught errors, unhandled rejections, console.error/warn, and — from
 * api/client.ts — every API call. Installed once from main.tsx, before React
 * mounts, so a crash during boot is captured too.
 *
 * Uncaught errors are also BEACONED to the Worker (`POST /api/bugs/client-errors`)
 * so they show up in `wrangler tail` / Workers Logs even when nobody files a
 * report. Throttled to one beacon per `BEACON_MIN_INTERVAL_MS`, sent only while
 * a session is live (`setBeaconEnabled`, driven by SessionContext; the server
 * enforces it anyway), and never awaited — a failing beacon must not become a
 * second error.
 *
 * The log is CLEARED whenever the session ends (SessionContext), so on a
 * shared browser one person's activity can never ride along in the next
 * person's public issue.
 */
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../shared/constants.js';
import { DiagnosticsLog, describeThrown, renderDiagnostics } from './lib/diagnostics.js';
import type { DiagnosticsEnvironment } from './lib/diagnostics.js';

/** The one log. `api/client.ts` records into it; the bug sheet reads it. */
export const diagnostics = new DiagnosticsLog();

const BEACON_MIN_INTERVAL_MS = 30_000;
const BEACON_MAX_CHARS = 2_000;
let lastBeaconAt = 0;
let appVersion: string | null = null;
let beaconEnabled = false;

/** SessionContext flips this with the session; a beacon while anonymous is a wasted 401. */
export function setBeaconEnabled(enabled: boolean): void {
  beaconEnabled = enabled;
}

/**
 * `/api/bets/3f2a…-…` → `/api/bets/:id`: the diagnostics land in a public
 * issue, and while a uuid is not a secret it is not something a reader needs.
 */
export function redactPath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}

/** Called once /api/health answers, so the report can say which build. */
export function setAppVersion(version: string): void {
  appVersion = version;
}

export function environment(): DiagnosticsEnvironment {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    appVersion,
    userAgent: nav?.userAgent ?? null,
    viewport:
      typeof window === 'undefined'
        ? null
        : { width: window.innerWidth, height: window.innerHeight },
    language: nav?.language ?? null,
    online: nav?.onLine ?? null,
    page: typeof location === 'undefined' ? null : `${location.pathname}${location.search}`,
  };
}

/** The text block the bug report attaches. */
export function diagnosticsText(maxChars: number): string {
  return renderDiagnostics(environment(), diagnostics.list(), maxChars);
}

function beacon(): void {
  if (!beaconEnabled) return;
  const now = Date.now();
  if (now - lastBeaconAt < BEACON_MIN_INTERVAL_MS) return;
  lastBeaconAt = now;
  try {
    void fetch('/api/bugs/client-errors', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ diagnostics: diagnosticsText(BEACON_MAX_CHARS) }),
    }).catch(() => undefined);
  } catch {
    // fetch itself threw (very old browser) — there is nothing else to do.
  }
}

let installed = false;

export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Nothing in here may throw: a recorder that throws inside console.error
  // would replace the error being reported with its own.
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // swallowed by design
    }
  };

  window.addEventListener('error', (event) => {
    safely(() => {
      const where =
        event.filename === ''
          ? ''
          : ` @ ${event.filename}:${String(event.lineno)}:${String(event.colno)}`;
      diagnostics.record('error', `${describeThrown(event.error ?? event.message)}${where}`);
    });
    beacon();
  });
  window.addEventListener('unhandledrejection', (event) => {
    safely(() => {
      diagnostics.record('rejection', describeThrown(event.reason));
    });
    beacon();
  });

  // console.error / console.warn still print; they are recorded as well.
  const original = { error: console.error.bind(console), warn: console.warn.bind(console) };
  console.error = (...args: unknown[]): void => {
    safely(() => {
      diagnostics.record('console', `error: ${args.map(describeThrown).join(' ')}`);
    });
    original.error(...args);
  };
  console.warn = (...args: unknown[]): void => {
    safely(() => {
      diagnostics.record('console', `warn: ${args.map(describeThrown).join(' ')}`);
    });
    original.warn(...args);
  };

  // Route changes: the History API has no event, so patch pushState/replaceState
  // and listen for popstate. One line per navigation is what makes "what were
  // you doing" answerable.
  const recordRoute = (): void => {
    diagnostics.record('route', `${location.pathname}${location.search}`);
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const fn = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>): void => {
      fn(...args);
      recordRoute();
    };
  }
  window.addEventListener('popstate', recordRoute);
  recordRoute();
}
