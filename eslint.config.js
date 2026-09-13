// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.wrangler/**',
      '.tsbuild/**',
      'node_modules/**',
      'docs/samples/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files outside every tsconfig project (this config, the .mjs scripts)
          // are linted without type information via disableTypeChecked below.
          allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Money is exact integer/BigInt arithmetic. The actual failure mode is
  // `Math.floor(stake * decimalOdds)` — a float multiply followed by a
  // truncation — so ALL four truncation helpers are banned in the layers that
  // touch cents. src/web may use them for layout; if a genuine non-money use
  // appears here, an `eslint-disable-next-line` WITH a justification comment is
  // the escape hatch.
  {
    files: ['src/shared/**/*.ts', 'src/worker/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['round', 'floor', 'ceil', 'trunc'].map((m) => ({
          object: 'Math',
          property: m,
          message: `Math.${m} is forbidden here — money and odds use the exact BigInt helpers in src/shared/odds.ts (PLAN.md §5.3).`,
        })),
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is parsed with parseDollarsToCents, not parseFloat.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is parsed with parseDollarsToCents.' },
      ],
    },
  },

  // Pure domain layer: must not reference any platform global.
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is parsed with parseDollarsToCents.' },
        { name: 'fetch', message: 'src/shared must stay platform-free (PLAN.md §2.2).' },
        { name: 'Request', message: 'src/shared must stay platform-free (PLAN.md §2.2).' },
        { name: 'Response', message: 'src/shared must stay platform-free (PLAN.md §2.2).' },
        { name: 'document', message: 'src/shared must stay platform-free (PLAN.md §2.2).' },
        { name: 'window', message: 'src/shared must stay platform-free (PLAN.md §2.2).' },
      ],
    },
  },

  {
    files: ['src/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // Plain ESM JavaScript: no type information, and Node globals must be declared
  // explicitly (we deliberately avoid adding the `globals` package for three files).
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
);
