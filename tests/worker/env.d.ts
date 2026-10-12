/**
 * Types for the `cloudflare:test` module in the worker project.
 *
 * @cloudflare/vitest-plugin types `import { env } from 'cloudflare:test'` as the
 * GLOBAL `Cloudflare.Env` interface (the one `wrangler types` would generate),
 * so we augment that with our hand-written `Env` plus the test-only
 * `TEST_MIGRATIONS` binding injected by vitest.workers.config.ts.
 */
/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../../src/worker/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      readonly TEST_MIGRATIONS: readonly D1Migration[];
    }
  }
}

export {};
