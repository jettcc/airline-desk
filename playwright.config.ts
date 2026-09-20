import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests-browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: { headless: true, viewport: { width: 1280, height: 900 } },
  reporter: [['list'], ['json', { outputFile: 'evals/browser/results.json' }]],
});
