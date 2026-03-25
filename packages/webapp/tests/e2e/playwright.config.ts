// packages/webapp/tests/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export default defineConfig({
  testDir: '.',
  webServer: {
    command: `node ${resolve(repoRoot, 'dist/node-server/index.js')} --serve-only`,
    port: 5780,
    reuseExistingServer: !process.env['CI'],
    env: { PORT: '5780' },
  },
  use: {
    baseURL: 'http://localhost:5780',
  },
  fullyParallel: true,
  timeout: 30_000,
  retries: 0,
});
