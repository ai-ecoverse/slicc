import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Dedicated browser-mode config so the repo's default `vitest run` (all node
// projects) stays browser-free. Functional tests for the web components run in
// real Chromium via the Playwright provider — the project's explicit choice for
// true custom-element + shadow-DOM + computed-style fidelity (jsdom can't paint
// or lay out). Coverage floors come from the repo-root single-source-of-truth.
const repoRoot = resolve(__dirname, '../..');
const allFloors = JSON.parse(readFileSync(resolve(repoRoot, 'coverage-thresholds.json'), 'utf-8'));
const floors = allFloors?.typescript?.webcomponents ?? {
  lines: 0,
  statements: 0,
  functions: 0,
  branches: 0,
};

export default defineConfig({
  test: {
    name: 'webcomponents',
    globals: true,
    include: ['tests/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      // Desktop viewport: this is a desktop-first prototype lift, so computed-style
      // tests assert the wide-layout design values. Components carry their own
      // narrow / extension-sidebar media queries (≤560px); those are exercised by
      // tests that opt in explicitly (a matchMedia gate + the showcase Mobile story),
      // not by an incidentally-small default window.
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
