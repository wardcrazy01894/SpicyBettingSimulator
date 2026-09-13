import { defineConfig } from 'vitest/config';

// Three projects:
//   unit   -> pure logic in src/shared (node env, fast)
//   worker -> Worker + real D1 via @cloudflare/vitest-pool-workers
//   web    -> pure UI helpers in src/web/lib and the slip reducer (node env)
export default defineConfig({
  test: {
    projects: ['vitest.unit.config.ts', 'vitest.workers.config.ts', 'vitest.web.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
