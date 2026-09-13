import { defineConfig } from 'vitest/config';

// Two projects:
//   unit   -> pure logic in src/shared (node env, fast)
//   worker -> Worker + real D1 via @cloudflare/vitest-pool-workers
export default defineConfig({
  test: {
    projects: ['vitest.unit.config.ts', 'vitest.workers.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
