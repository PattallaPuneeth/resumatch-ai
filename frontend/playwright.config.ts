import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests against the running stack (`docker compose up`). They cover the
 * paths that unit tests with mocked APIs cannot: real cookies through the Next.js proxy, the
 * real analysis payload, and live status updates from the workers.
 *
 *   cd frontend && npm run test:e2e            # stack on http://localhost:3000
 *   E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /layout\.spec\.ts/ },
  ],
});
