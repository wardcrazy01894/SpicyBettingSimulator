import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
  },
});
