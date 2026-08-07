import { defineConfig } from '@playwright/test';

/**
 * Portal Playwright — shell smoke + responsive validation over the
 * PRODUCTION build (docs/29 §15: 1440/1024/390 representative classes).
 * Screenshots/evidence land in ../artifacts/portal-w2-1/ via e2e/support.ts.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4318',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4318',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
