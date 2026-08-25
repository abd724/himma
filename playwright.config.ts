/**
 * RI-1 — production-like browser E2E over the REAL stack: the Expo web
 * preview (docs/12: web is the review surface; native validation is the
 * separate RI-6 gate) against the real local backend + PostgreSQL.
 *
 * `npm run e2e` boots both servers itself; reuseExistingServer makes local
 * iteration cheap. Phone-first viewport (390×844) per docs/08.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:8081',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The idempotent dev seed guarantees real catalogue truth (and
      // rebuilt search documents) before the server accepts the journeys.
      command: 'npm run dev:seed && npm run dev:server',
      cwd: './backend',
      url: 'http://127.0.0.1:3101/internal/health',
      reuseExistingServer: true,
      timeout: 60_000,
      env: { PORT: '3101' },
    },
    {
      command: 'npx expo start --web --port 8081',
      url: 'http://localhost:8081',
      reuseExistingServer: true,
      timeout: 180_000,
      env: { CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3101' },
    },
  ],
});
