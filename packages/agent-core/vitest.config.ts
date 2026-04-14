import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
    reporters: process.env.QUILIN_ENV === 'test'
      ? ['json']
      : ['default'],
  },
});
