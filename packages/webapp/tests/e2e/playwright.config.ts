// packages/webapp/tests/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export default defineConfig({
  testDir: '.',
  webServer: {
    command: `node ${resolve(repoRoot, 'dist/cli/index.js')}`,
    port: 5780,
    reuseExistingServer: !process.env['CI'],
    env: { PORT: '5780' },
  },
  use: {
    baseURL: 'http://localhost:5780',
  },
  retries: 0,
  workers: 1,
});
