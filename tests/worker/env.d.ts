/**
 * Types for the `cloudflare:test` module in the worker project.
 *
 * vitest-pool-workers 0.22 types `import { env } from 'cloudflare:test'` as the
 * GLOBAL `Cloudflare.Env` interface (the one `wrangler types` would generate),
 * so we augment that with our hand-written `Env` plus the test-only
 * `TEST_MIGRATIONS` binding injected by vitest.workers.config.ts.
 */
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as WorkerEnv } from '../../src/worker/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      readonly TEST_MIGRATIONS: readonly D1Migration[];
    }
  }
}

export {};
