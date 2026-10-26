import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      JWT_SECRET: 'test-fake-jwt-secret-for-vitest-runs-only-32chars',
      INTERNAL_API_TOKEN: 'test-fake-internal-api-token-vitest-32chars',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
