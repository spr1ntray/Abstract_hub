import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['internal/tests/**/*.test.ts'],
    // Low scrypt N for test speed: 2^12 (~4096 iterations) vs production 2^18.
    // crypto.ts reads this env at module load time — vitest sets it before imports.
    env: {
      GIGABOT_SCRYPT_N: '4096',
    },
    coverage: {
      provider: 'v8',
      include: ['internal/src/**/*.ts'],
      exclude: ['internal/src/cli.ts', 'internal/src/**/cli.ts', 'internal/src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
