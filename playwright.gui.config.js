import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/gui',
  outputDir: './gui-test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
