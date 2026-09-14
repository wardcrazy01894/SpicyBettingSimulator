/** /api/bugs — the in-app "Report a bug" form. PLAN.md §11.7. */

import { Hono } from 'hono';
import type { BugReportResponse } from '../../shared/api-types.js';
import { BUG_REPORT_USER_AGENT_MAX } from '../../shared/constants.js';
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

  return app;
}

/** Trimmed, bounded, and NULL when absent or blank. */
function readUserAgent(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  // Slice by code point, not UTF-16 unit, so a surrogate pair is never halved.
  return [...trimmed].slice(0, BUG_REPORT_USER_AGENT_MAX).join('');
}
