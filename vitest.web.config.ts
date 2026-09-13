import { defineProject } from 'vitest/config';

// `web` -> the SPA's PURE helpers (grouping, formatting, the slip reducer).
// environment is 'node', not jsdom: jsdom is not a dependency and these helpers
// are deliberately DOM-free, which is what keeps them testable at all.
export default defineProject({
  test: {
    name: 'web',
    environment: 'node',
    include: ['tests/web/**/*.spec.ts'],
  },
});
