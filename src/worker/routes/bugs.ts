/** /api/bugs — the in-app "Report a bug" form. PLAN.md §11.7. */

import { Hono } from 'hono';
import type { BugReportResponse } from '../../shared/api-types.js';
import { BUG_REPORT_USER_AGENT_MAX, CLIENT_ERROR_BEACON_MAX } from '../../shared/constants.js';
import { AppError } from '../../shared/errors.js';
import { validateBugReport } from '../../shared/validate.js';
import { createBugReport } from '../bugs.js';
import { requireAuth } from '../middleware.js';
import type { AppContext } from '../middleware.js';
import { readJson, validationError } from './auth.js';

export function bugsRoutes(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use('*', requireAuth());

  /**
   * 201 `{ id, issueNumber, issueUrl }`. The server supplies the reporter, the
   * time, the app version and the user agent; the client sends only what the
   * person typed plus the SPA path they were on.
   */
  app.post('/', async (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const parsed = validateBugReport(await readJson(c));
    if (!parsed.ok) throw validationError(parsed);
    const body: BugReportResponse = await createBugReport(c.env, c.var.config, {
      user,
      input: parsed.value,
      userAgent: readUserAgent(c.req.header('user-agent')),
      now: c.var.now,
    });
    return c.json(body, 201);
  });

  /**
   * The uncaught-error beacon (src/web/diagnostics.ts). Nothing is stored: the
   * text goes to the Worker log as ONE line, so a browser crash shows up in
   * `wrangler tail` / Workers Logs alongside the server's own errors even when
   * nobody files a report. Signed-in only (the router's requireAuth), bounded,
   * and the client throttles itself to one every 30 s.
   */
  app.post('/client-errors', async (c) => {
    const user = c.var.user;
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const raw = await readJson(c);
    const text =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { diagnostics?: unknown }).diagnostics === 'string'
        ? (raw as { diagnostics: string }).diagnostics.trim()
        : '';
    if (text === '')
      throw new AppError('VALIDATION', 'diagnostics is required.', { field: 'diagnostics' });
    if (text.length > CLIENT_ERROR_BEACON_MAX) {
      throw new AppError(
        'VALIDATION',
        `diagnostics must be at most ${String(CLIENT_ERROR_BEACON_MAX)} characters.`,
        {
          field: 'diagnostics',
        },
      );
    }
    // One line, newlines folded, so a log viewer shows it as one event.
    console.error('[client-error]', `user=${user.username}`, text.replace(/\s*\n\s*/g, ' | '));
    return c.body(null, 204);
  });

  return app;
}

/** Trimmed, bounded, and NULL when absent or blank. Exported for its test. */
export function readUserAgent(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  // Slice by code point, not UTF-16 unit, so a surrogate pair is never halved.
  return Array.from(trimmed).slice(0, BUG_REPORT_USER_AGENT_MAX).join('');
}
