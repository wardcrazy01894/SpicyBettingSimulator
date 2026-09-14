import { defineProject } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// The real migrations are applied to Miniflare's D1 before each test file (see
// tests/worker/setup.ts). That matters more than usual here: the money
// invariants live in the DDL (triggers, CHECK, UNIQUE), so a mocked DB would not
// test them at all. See PLAN.md §4.1 and Spike S3.
//
// vitest-pool-workers 0.22 (vitest 4) exposes the pool as a Vite plugin
// (`cloudflareTest`) instead of the old `defineWorkersProject` +
// `test.poolOptions.workers`. Same options, new location.
const migrations = await readD1Migrations('./migrations');

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Fetches to this host are stubbed in tests/worker/setup.ts and
          // served from docs/samples/, so no test ever touches the network.
          ESPN_BASE_URL: 'https://espn.test',
          COOKIE_SECURE: 'false',
          INVITE_CODE: 'test-invite',
          IP_HASH_SALT: 'test-ip-salt',
          REFRESH_TARGETS_PER_RUN: '2',
          SETTLE_CHUNK: '20',
          APP_VERSION: 'test',
          // Fetches to this host are stubbed per spec file (tests/worker/bugs.spec.ts).
          GITHUB_REPO: 'wardcrazy01894/SpicyBettingSimulator',
          GITHUB_API_BASE_URL: 'https://github.test',
          GITHUB_TOKEN: 'test-github-token',
        },
      },
    }),
  ],
  test: {
    name: 'worker',
    include: ['tests/worker/**/*.spec.ts'],
    setupFiles: ['./tests/worker/setup.ts'],
  },
});
