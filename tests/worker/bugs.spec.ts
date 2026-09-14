/**
 * POST /api/bugs and GET /api/admin/bugs against the real D1 and a stubbed
 * GitHub (`https://github.test/**`, bound as GITHUB_API_BASE_URL in
 * vitest.workers.config.ts). PLAN.md §11.7.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminBugReportsResponse,
  BugReportResponse,
  HealthResponse,
} from '../../src/shared/api-types.js';
import { BUG_ISSUE_LABELS, BUG_ISSUE_TITLE_PREFIX } from '../../src/shared/bugs.js';
import { BUG_REPORTS_PER_WINDOW, BUG_REPORT_WINDOW_MS } from '../../src/shared/constants.js';
import type { ApiErrorBody } from '../../src/shared/errors.js';
import { GITHUB_USER_AGENT } from '../../src/worker/bugs.js';
import { readConfig } from '../../src/worker/env.js';
import type { Env } from '../../src/worker/env.js';
import { buildApp } from '../../src/worker/index.js';

const INVITE = 'test-invite';
const GOOD = { title: 'Slip will not close', description: 'Tapped Close and it stayed open.' };

let userSeq = 0;
async function register(admin = false): Promise<{ cookie: string; id: string; name: string }> {
  userSeq += 1;
  const username = `bug${String(userSeq)}`;
  const res = await buildApp().request(
    'https://example.com/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SBS-Client': '1' },
      body: JSON.stringify({ username, dk: 'a'.repeat(64), inviteCode: INVITE }),
    },
    env,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const { user } = await res.json<{ user: { id: string } }>();
  if (admin)
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?1').bind(user.id).run();
  return {
    cookie: /sbs_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '',
    id: user.id,
    name: username,
  };
}

function post(
  body: unknown,
  cookie?: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    buildApp().request(
      'https://example.com/api/bugs',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-SBS-Client': '1',
          ...(cookie === undefined ? {} : { cookie }),
          ...extra,
        },
        body: JSON.stringify(body),
      },
      env,
    ),
  );
}

function get(path: string, cookie?: string): Promise<Response> {
  return Promise.resolve(
    buildApp().request(
      `https://example.com${path}`,
      cookie === undefined ? undefined : { headers: { cookie } },
      env,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * GitHub stub
 * ------------------------------------------------------------------ */

interface GitHubCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: { title: string; body: string; labels: string[] };
}

interface GitHubStub {
  readonly calls: GitHubCall[];
  respond: (call: GitHubCall) => Response | Promise<Response>;
  restore(): void;
}

let issueSeq = 100;
function stubGitHub(): GitHubStub {
  const original = globalThis.fetch;
  const calls: GitHubCall[] = [];
  const stub: GitHubStub = {
    calls,
    respond: () => {
      issueSeq += 1;
      return new Response(
        JSON.stringify({
          number: issueSeq,
          html_url: `https://github.com/wardcrazy01894/SpicyBettingSimulator/issues/${String(issueSeq)}`,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    },
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://github.test/')) return original(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: GitHubCall = {
      url,
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as GitHubCall['body'],
    };
    calls.push(call);
    return stub.respond(call);
  };
  return stub;
}

let github: GitHubStub;
beforeEach(() => {
  github = stubGitHub();
});
afterEach(() => {
  github.restore();
});

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

describe('GET /api/health', () => {
  it('reports bugReportsEnabled: true when GITHUB_TOKEN is bound', async () => {
    const body = await (await get('/api/health')).json<HealthResponse>();
    expect(body.bugReportsEnabled).toBe(true);
  });
});

/**
 * `env` from cloudflare:workers is not spreadable (its bindings are not own
 * enumerable properties), so a config variant is built key by key. Optional
 * secrets are only set when a value is given, which is what
 * `exactOptionalPropertyTypes` wants and what a real Workers env looks like.
 */
function envWith(overrides: {
  readonly GITHUB_TOKEN?: string | undefined;
  readonly GITHUB_REPO?: string;
}): Env {
  const token = 'GITHUB_TOKEN' in overrides ? overrides.GITHUB_TOKEN : env.GITHUB_TOKEN;
  return {
    DB: env.DB,
    ASSETS: env.ASSETS,
    ESPN_BASE_URL: env.ESPN_BASE_URL,
    COOKIE_SECURE: env.COOKIE_SECURE,
    REFRESH_TARGETS_PER_RUN: env.REFRESH_TARGETS_PER_RUN,
    SETTLE_CHUNK: env.SETTLE_CHUNK,
    APP_VERSION: env.APP_VERSION,
    GITHUB_REPO: overrides.GITHUB_REPO ?? env.GITHUB_REPO,
    GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL,
    ...(env.INVITE_CODE === undefined ? {} : { INVITE_CODE: env.INVITE_CODE }),
    ...(env.IP_HASH_SALT === undefined ? {} : { IP_HASH_SALT: env.IP_HASH_SALT }),
    ...(token === undefined ? {} : { GITHUB_TOKEN: token }),
  };
}

describe('readConfig', () => {
  it('turns the feature off when GITHUB_TOKEN is unset or blank', () => {
    expect(readConfig(envWith({ GITHUB_TOKEN: undefined })).github).toBeNull();
    expect(readConfig(envWith({ GITHUB_TOKEN: '   ' })).github).toBeNull();
  });

  it('reads the repo, base URL and token when set', () => {
    expect(readConfig(envWith({})).github).toEqual({
      repo: 'wardcrazy01894/SpicyBettingSimulator',
      apiBaseUrl: 'https://github.test',
      token: 'test-github-token',
    });
  });

  it('refuses a GITHUB_REPO that is not owner/name', () => {
    expect(() => readConfig(envWith({ GITHUB_REPO: 'not a repo' }))).toThrow(/GITHUB_REPO/);
    expect(() => readConfig(envWith({ GITHUB_REPO: 'a/b/c' }))).toThrow(/GITHUB_REPO/);
    expect(() => readConfig(envWith({ GITHUB_REPO: '../x' }))).toThrow(/GITHUB_REPO/);
  });
});

describe('POST /api/bugs', () => {
  it('401s an anonymous caller and makes no GitHub call', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(401);
    expect(github.calls).toHaveLength(0);
  });

  it('400 VALIDATION with the field name, and writes nothing', async () => {
    const me = await register();
    const res = await post({ ...GOOD, title: 'ab' }, me.cookie);
    expect(res.status).toBe(400);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details).toEqual({ field: 'title' });
    expect(github.calls).toHaveLength(0);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ?1')
      .bind(me.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('files the issue with the server-supplied context and records the row', async () => {
    const me = await register();
    const res = await post({ ...GOOD, page: '/bets' }, me.cookie, {
      'user-agent': 'Mozilla/5.0 (test)',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await res.json<BugReportResponse>();
    expect(body.issueNumber).toBeGreaterThan(100);
    expect(body.issueUrl).toBe(
      `https://github.com/wardcrazy01894/SpicyBettingSimulator/issues/${String(body.issueNumber)}`,
    );

    // Exactly one upstream call, to the configured repo, with the token and
    // the headers GitHub requires.
    expect(github.calls).toHaveLength(1);
    const call = github.calls[0];
    if (call === undefined) throw new Error('unreachable');
    expect(call.url).toBe('https://github.test/repos/wardcrazy01894/SpicyBettingSimulator/issues');
    expect(call.headers['authorization']).toBe('Bearer test-github-token');
    expect(call.headers['user-agent']).toBe(GITHUB_USER_AGENT);
    expect(call.headers['accept']).toBe('application/vnd.github+json');
    expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call.body.title).toBe(`${BUG_ISSUE_TITLE_PREFIX}${GOOD.title}`);
    expect(call.body.labels).toEqual([...BUG_ISSUE_LABELS]);
    expect(call.body.body).toContain(GOOD.description);
    expect(call.body.body).toContain(`| Reported by | \`${me.name}\` |`);
    expect(call.body.body).toContain('| Page | `/bets` |');
    expect(call.body.body).toContain('| App version | `test` |');
    expect(call.body.body).toContain('| User agent | Mozilla/5.0 (test) |');

    const row = await env.DB.prepare('SELECT * FROM bug_reports WHERE id = ?1')
      .bind(body.id)
      .first();
    expect(row).toMatchObject({
      user_id: me.id,
      title: GOOD.title,
      description: GOOD.description,
      page: '/bets',
      user_agent: 'Mozilla/5.0 (test)',
      app_version: 'test',
      issue_number: body.issueNumber,
      issue_url: body.issueUrl,
      error: null,
    });
    expect(typeof row?.['created_at']).toBe('number');
  });

  it('never trusts a client-supplied reporter, version or time', async () => {
    const me = await register();
    const res = await post(
      { ...GOOD, username: 'admin', appVersion: '9.9.9', createdAt: 1, userId: 'x' },
      me.cookie,
    );
    expect(res.status).toBe(201);
    const call = github.calls[0];
    expect(call?.body.body).toContain(`| Reported by | \`${me.name}\` |`);
    expect(call?.body.body).toContain('| App version | `test` |');
    expect(call?.body.body).not.toContain('9.9.9');
  });

  it('keeps the row and 503s UPSTREAM_UNAVAILABLE when GitHub refuses', async () => {
    const me = await register();
    github.respond = () => new Response('{"message":"Bad credentials"}', { status: 401 });
    const res = await post(GOOD, me.cookie);
    expect(res.status).toBe(503);
    const body = await res.json<ApiErrorBody>();
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    const reportId = body.error.details?.['reportId'];
    expect(typeof reportId).toBe('string');

    const row = await env.DB.prepare(
      'SELECT issue_number, issue_url, error FROM bug_reports WHERE id = ?1',
    )
      .bind(reportId)
      .first<{ issue_number: number | null; issue_url: string | null; error: string | null }>();
    expect(row).toEqual({ issue_number: null, issue_url: null, error: 'GitHub responded 401' });
  });

  it('treats a thrown fetch (network, timeout) the same way', async () => {
    const me = await register();
    github.respond = () => {
      throw new TypeError('fetch failed');
    };
    const res = await post(GOOD, me.cookie);
    expect(res.status).toBe(503);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ?1 AND error = 'fetch failed'",
    )
      .bind(me.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('treats a 2xx without an issue number as a failure, not a success', async () => {
    const me = await register();
    github.respond = () => new Response('{}', { status: 201 });
    const res = await post(GOOD, me.cookie);
    expect(res.status).toBe(503);
  });

  it(`429 RATE_LIMITED on report ${String(BUG_REPORTS_PER_WINDOW + 1)} in an hour, with no GitHub call`, async () => {
    const me = await register();
    for (let i = 0; i < BUG_REPORTS_PER_WINDOW; i += 1) {
      const res = await post({ ...GOOD, title: `${GOOD.title} ${String(i)}` }, me.cookie);
      expect(res.status, await res.clone().text()).toBe(201);
    }
    expect(github.calls).toHaveLength(BUG_REPORTS_PER_WINDOW);

    const blocked = await post(GOOD, me.cookie);
    expect(blocked.status).toBe(429);
    const body = await blocked.json<ApiErrorBody>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details).toEqual({
      limit: BUG_REPORTS_PER_WINDOW,
      windowMs: BUG_REPORT_WINDOW_MS,
    });
    expect(github.calls).toHaveLength(BUG_REPORTS_PER_WINDOW);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ?1')
      .bind(me.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(BUG_REPORTS_PER_WINDOW);
  });

  it('counts failed filings against the limit too (they are still rows)', async () => {
    const me = await register();
    github.respond = () => new Response('', { status: 500 });
    for (let i = 0; i < BUG_REPORTS_PER_WINDOW; i += 1) {
      expect((await post(GOOD, me.cookie)).status).toBe(503);
    }
    expect((await post(GOOD, me.cookie)).status).toBe(429);
  });

  it('the window is per user and slides: an old report does not count', async () => {
    const me = await register();
    const other = await register();
    // Backdate BUG_REPORTS_PER_WINDOW rows for `me` to just outside the window.
    const old = Date.now() - BUG_REPORT_WINDOW_MS - 1;
    for (let i = 0; i < BUG_REPORTS_PER_WINDOW; i += 1) {
      await env.DB.prepare(
        `INSERT INTO bug_reports (id, user_id, title, description, app_version, created_at)
         VALUES (?1, ?2, 'old', 'old report text', 'test', ?3)`,
      )
        .bind(`old-${me.id}-${String(i)}`, me.id, old)
        .run();
    }
    expect((await post(GOOD, me.cookie)).status).toBe(201);
    expect((await post(GOOD, other.cookie)).status).toBe(201);
  });
});

describe('GET /api/admin/bugs', () => {
  it('is 401 anonymous and 404 (invisible) for a non-admin', async () => {
    expect((await get('/api/admin/bugs')).status).toBe(401);
    const me = await register();
    expect((await get('/api/admin/bugs', me.cookie)).status).toBe(404);
  });

  it('lists reports newest first, including the ones GitHub refused', async () => {
    const admin = await register(true);
    const reporter = await register();
    const ok = await (
      await post({ ...GOOD, title: 'first ok' }, reporter.cookie)
    ).json<BugReportResponse>();
    github.respond = () => new Response('', { status: 502 });
    const failed = await (
      await post({ ...GOOD, title: 'then failed' }, reporter.cookie)
    ).json<ApiErrorBody>();

    const res = await get('/api/admin/bugs', admin.cookie);
    expect(res.status).toBe(200);
    const body = await res.json<AdminBugReportsResponse>();
    const mine = body.reports.filter((r) => r.userId === reporter.id);
    expect(mine.map((r) => r.title)).toEqual(['then failed', 'first ok']);
    expect(mine[0]).toMatchObject({
      id: failed.error.details?.['reportId'],
      username: reporter.name,
      issueNumber: null,
      issueUrl: null,
      error: 'GitHub responded 502',
      appVersion: 'test',
    });
    expect(mine[1]).toMatchObject({
      id: ok.id,
      issueNumber: ok.issueNumber,
      issueUrl: ok.issueUrl,
      error: null,
      description: GOOD.description,
    });
  });
});
