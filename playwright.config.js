import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3417', headless: true, ...(process.env.HARNESS_TEST_BROWSER ? { channel: process.env.HARNESS_TEST_BROWSER } : {}), screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node test/fixtures/web-server.js', url: 'http://127.0.0.1:3417/api/health', reuseExistingServer: false, timeout: 20000 },
});
