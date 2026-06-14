import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Dedicated **real-browser** integration config for the webapp shell.
 *
 * Why this exists (issue #957): the default `vitest run` projects execute in
 * Node, where just-bash's defense-in-depth box dynamic-imports `node:module`
 * and aborts any multi-statement script (`X=1; echo $X`, `$(...)` capture,
 * pipelines combined with assignments). That means the Node unit harness
 * **cannot run the multi-statement scripts the agent actually generates**, so
 * whole classes of shell bugs — UTF-8 mojibake in command substitution and
 * text/byte statement interleave among them — slipped through. These tests run
 * the genuine just-bash engine (the `browser` export the webapp ships) in
 * headless Chromium via the Playwright provider, so those scripts execute
 * exactly as they do for a user.
 *
 * Kept OUT of the root `vitest run` (the default node projects stay
 * browser-free) and run explicitly via `npm run test:integration -w
 * @slicc/webapp`. The matching `tests/integration/**` path is already excluded
 * from the root config's `webapp` project.
 */
export default defineConfig({
  test: {
    name: 'webapp-integration',
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }],
    },
  },
});
