// @ts-check
// ESLint flat config (ESM) — ESLint 10 supports flat config only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist',
      '**/dist/**',
      'release',
      '**/release/**',
      'coverage',
      'node_modules',
      '.claude',
      '**/.claude/**',
      'internal/src/ui/public/game-auth.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // Browser JS in the static UI — plain JS with browser globals (no TS parser).
  // Disable no-undef because browser globals (document, fetch, alert, EventSource…)
  // are not in the Node environment that ESLint otherwise assumes.
  // The glob is relative to the config file's base path (internal/).
  {
    files: ['**/src/ui/public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        EventSource: 'readonly',
        console: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'script',
      },
    },
  },
  {
    files: ['desktop/**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        require: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'commonjs',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
