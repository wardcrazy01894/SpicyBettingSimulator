/**
 * The client-side diagnostics log that rides along with a bug report.
 * PLAN.md §11.7.
 *
 * A bounded ring buffer of one-line events — uncaught errors, unhandled
 * promise rejections, console.error/warn calls, every API call with its status
 * and duration, and route changes — plus a snapshot of the environment. Pure
 * and DOM-free: `install.ts` is the only thing that wires it to `window`, and
 * `tests/web/diagnostics.spec.ts` exercises everything here without one.
 *
 * Nothing in it is a secret by construction: no request bodies, no response
 * bodies, no cookies, no query strings beyond what the page path already
 * shows. It is the equivalent of a support engineer asking "what were you
 * doing and what did the console say" — and it lands in a public GitHub issue,
 * which the report form says.
 */

export type DiagnosticKind = 'error' | 'rejection' | 'console' | 'api' | 'route';

export interface DiagnosticEvent {
  readonly at: number;
  readonly kind: DiagnosticKind;
  readonly text: string;
}

/** Events kept; the oldest is dropped past this. */
export const DIAGNOSTICS_MAX_EVENTS = 60;
/** One event's text is cut here so a single stack trace cannot fill the log. */
export const DIAGNOSTICS_MAX_EVENT_CHARS = 600;
/** The user agent and page lines in the head are cut here for the same reason. */
export const DIAGNOSTICS_MAX_HEAD_FIELD_CHARS = 300;

export interface DiagnosticsEnvironment {
  readonly appVersion: string | null;
  readonly userAgent: string | null;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly language: string | null;
  readonly online: boolean | null;
  readonly page: string | null;
}

export class DiagnosticsLog {
  private readonly events: DiagnosticEvent[] = [];
  private readonly max: number;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now(), max = DIAGNOSTICS_MAX_EVENTS) {
    this.now = now;
    this.max = max;
  }

  record(kind: DiagnosticKind, text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean === '') return;
    const cut =
      clean.length > DIAGNOSTICS_MAX_EVENT_CHARS
        ? `${clean.slice(0, DIAGNOSTICS_MAX_EVENT_CHARS)}…`
        : clean;
    this.events.push({ at: this.now(), kind, text: cut });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }

  /** Newest last; a copy. */
  list(): readonly DiagnosticEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** `2026-09-14T15:30:00.000Z` → `15:30:00.000` — dates are the report's job. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

/**
 * The text block a bug report attaches. Environment first, then the events
 * oldest → newest with a UTC clock, so a reader can line it up with the
 * report's own timestamp. Bounded by `maxChars` from the OLD end: the last
 * events are the ones that matter. The result is NEVER longer than `maxChars`
 * whatever the inputs — the head's free-text fields are cut, and the whole is
 * sliced as a last resort — because a report the validator refuses for its
 * diagnostics is a report nobody can file.
 */
export function renderDiagnostics(
  env: DiagnosticsEnvironment,
  events: readonly DiagnosticEvent[],
  maxChars: number,
): string {
  const field = (value: string | null): string =>
    value === null
      ? '?'
      : value.length > DIAGNOSTICS_MAX_HEAD_FIELD_CHARS
        ? `${value.slice(0, DIAGNOSTICS_MAX_HEAD_FIELD_CHARS)}…`
        : value;
  const head = [
    `app ${field(env.appVersion)} · ${field(env.language)} · ${
      env.viewport === null
        ? 'viewport ?'
        : `${String(env.viewport.width)}×${String(env.viewport.height)}`
    } · ${env.online === null ? 'online ?' : env.online ? 'online' : 'OFFLINE'}`,
    `page ${field(env.page)}`,
    `ua ${field(env.userAgent)}`,
    '',
    events.length === 0 ? '(no events recorded)' : `${String(events.length)} events, oldest first:`,
  ].join('\n');
  const lines = events.map((e) => `${clock(e.at)} ${e.kind.padEnd(9)} ${e.text}`);
  let body = lines.join('\n');
  const budget = maxChars - head.length - 1;
  if (body.length > budget) {
    // Drop whole lines from the front until it fits, then mark the cut.
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? '';
      if (size + line.length + 1 > budget - 24) break;
      kept.unshift(line);
      size += line.length + 1;
    }
    body = [`… ${String(lines.length - kept.length)} earlier events cut`, ...kept].join('\n');
  }
  return `${head}\n${body}`.slice(0, maxChars);
}

/** One line for an error-ish value: name, message, first stack frame. */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    const frame = (value.stack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('at '));
    return `${value.name}: ${value.message}${frame === undefined ? '' : ` (${frame})`}`;
  }
  if (typeof value === 'string') return value;
  try {
    // `JSON.stringify(undefined)` is undefined despite the declared return type.
    const json: unknown = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    // fall through: circular, or a throwing getter
  }
  try {
    return String(value);
  } catch {
    // A null-prototype object with a throwing getter cannot even be stringified.
    return '[unprintable value]';
  }
}
