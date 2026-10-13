import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-report', open: 'never' }],
  ],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
