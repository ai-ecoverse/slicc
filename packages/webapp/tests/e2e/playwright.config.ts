// packages/webapp/tests/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Fixed port for the fake OpenAI-compatible LLM webServer.
 *  Pinned so `seedLocalLlmProvider` can derive a stable baseUrl
 *  without a global setup step. */
export const FAKE_LLM_PORT = 5781;

/** Default fixture the harness loads when nothing else is wired. Points
 *  at the reference scenario consumed by `reference-scenario.test.ts`;
 *  override via `FAKE_LLM_FIXTURE` when a test needs different turns. */
const DEFAULT_FAKE_LLM_FIXTURE = resolve(
  repoRoot,
  'packages/webapp/tests/e2e/fake-llm/fixtures/reference-scenario.json'
);

export default defineConfig({
  testDir: '.',
  webServer: [
    {
      // `--cdp-port=9222` pins the proxy's outbound CDP target so the
      // agent's `playwright-cli` and the harness's `readCdpPageState`
      // both speak to the same Chrome — see `reference-scenario.test.ts`,
      // which launches Playwright Chrome with `--remote-debugging-port=9222`.
      command: `node ${resolve(repoRoot, 'dist/node-server/index.js')} --serve-only --cdp-port=9222`,
      port: 5780,
      reuseExistingServer: !process.env['CI'],
      env: { PORT: '5780' },
    },
    {
      command: `npx tsx ${resolve(repoRoot, 'packages/webapp/tests/e2e/fake-llm/start.ts')}`,
      port: FAKE_LLM_PORT,
      // Always boot a fresh fake server so the turn cursor + fixture are
      // pristine each run; reusing a previous run's process would leak
      // stale cursor state across scenarios.
      reuseExistingServer: false,
      env: {
        FAKE_LLM_PORT: String(FAKE_LLM_PORT),
        FAKE_LLM_HOST: '127.0.0.1',
        FAKE_LLM_FIXTURE: process.env['FAKE_LLM_FIXTURE'] ?? DEFAULT_FAKE_LLM_FIXTURE,
      },
    },
  ],
  use: {
    baseURL: 'http://localhost:5780',
  },
  // Single-worker by construction: the node-server CDP proxy points at one
  // Chrome on port 9222, and every CDP-binding scenario (reference-scenario,
  // preview-serve) launches Playwright Chrome with `--remote-debugging-port=9222`.
  // Running them in parallel would collide on the port and on the proxy's
  // outbound target.
  workers: 1,
  fullyParallel: true,
  timeout: 30_000,
  // Real-browser / CDP / model-staging E2E flows are non-deterministic under
  // load; retry only in CI so local runs still fail fast.
  retries: process.env['CI'] ? 2 : 0,
});
