import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(__dirname, '../..');
const allFloors = JSON.parse(readFileSync(resolve(repoRoot, 'coverage-thresholds.json'), 'utf-8'));
const floors = allFloors?.typescript?.webcomponents ?? {
  lines: 0,
  statements: 0,
  functions: 0,
  branches: 0,
};

export default defineConfig({
  optimizeDeps: { include: ['@pierre/trees', '@pierre/diffs'] },
  test: {
    name: 'webcomponents',
    globals: true,
    include: ['tests/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,

      instances: [{ browser: 'chromium', viewport: { width: 1280, height: 900 } }],
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.stories.ts', 'src/index.ts', 'src/register.ts', '**/*.d.ts'],
      thresholds: floors,
    },
  },
});
