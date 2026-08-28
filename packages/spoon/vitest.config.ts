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
      exclude: [
        '**/*.stories.ts',
        // The tunnel loader entry is the one file left out: its single
        // statement boots the loader against the ambient frame at import time,
        // which a test realm must not do. Everything it calls
        // (`tunnel/tunnel-runtime.ts`) is covered — including a full boot into
        // a disposable iframe — and the other IIFE entry (`overlay-entry.ts`,
        // the `window.__SLICC_ELECTRON_OVERLAY__` contract) is covered outright.
        'src/tunnel/tunnel-loader-entry.ts',
        '**/*.d.ts',
      ],
      thresholds: floors,
    },
  },
});
