import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Dedicated browser-mode config (mirrors @slicc/webcomponents) so the repo's
// default `vitest run` stays browser-free. The launcher is a real custom element
// with shadow DOM, so it needs real Chromium for computed-style + shadow
// fidelity. Coverage floors come from the repo-root single source of truth.
const repoRoot = resolve(__dirname, '../..');
const allFloors = JSON.parse(readFileSync(resolve(repoRoot, 'coverage-thresholds.json'), 'utf-8'));
const floors = allFloors?.typescript?.spoon ?? {
  lines: 0,
  statements: 0,
  functions: 0,
  branches: 0,
};

export default defineConfig({
  test: {
    name: 'spoon',
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
      exclude: ['**/*.stories.ts', 'src/index.ts', 'src/overlay-entry.ts', '**/*.d.ts'],
      thresholds: floors,
    },
  },
});
