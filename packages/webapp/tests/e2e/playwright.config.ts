// packages/webapp/tests/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Fixed port for the fake OpenAI-compatible LLM webServer.
 *  Pinned so `seedLocalLlmProvider` can derive a stable baseUrl
 *  without a global setup step. */
export const FAKE_LLM_PORT = 5781;

/**
 * Standalone-topology ports. node-server no longer serves the UI (the static
 * UI serving was removed), so the harness mirrors production "Standalone": the
 * webapp is served by `wrangler dev` from `dist/ui` on {@link WRANGLER_PORT}
 * (the leader origin / `baseURL`) and dials back to the node-server thin-bridge
 * on {@link BRIDGE_PORT} for CDP + cross-origin `/api`. The CDP proxy's outbound
 * target stays {@link CDP_PORT}, matching the `--remote-debugging-port` the
 * CDP-binding scenarios launch Playwright Chrome with.
 */
export const WRANGLER_PORT = 8787;
export const BRIDGE_PORT = 5710;
export const CDP_PORT = 9222;

/**
 * Fixed per-process bridge token shared between node-server (`SLICC_BRIDGE_TOKEN`
 * env) and the webapp boot URL (`?bridgeToken=`, appended by `gotoLeader`). A
 * static value is fine for a loopback-only E2E harness — the token's threat
 * model is "remote allowlisted origin (sliccy.ai) with a hostile script", which
 * does not exist locally. node-server gates the `/cdp` upgrade + cross-origin
 * `/api` on it, and the origin allowlist is widened to the wrangler origin via
 * `BRIDGE_DEV_ALLOWED_ORIGINS`.
 */
export const E2E_BRIDGE_TOKEN = 'e2e-fixed-bridge-token';

/** Leader (UI) origin served by wrangler — the Playwright `baseURL`. */
export const LEADER_ORIGIN = `http://localhost:${WRANGLER_PORT}`;

/** Local node-server thin-bridge `/cdp` WebSocket URL the leader dials. */
export const BRIDGE_WS_URL = `ws://localhost:${BRIDGE_PORT}/cdp`;

/** Default fixture the harness loads when nothing else is wired. Points
 *  at the reference scenario consumed by `reference-scenario.test.ts`;
 *  override via `FAKE_LLM_FIXTURE` when a test needs different turns.
 *
 *  Short-name form: `FAKE_LLM_FIXTURE=transcript-export` expands to
 *  `packages/webapp/tests/e2e/fake-llm/fixtures/transcript-export.json`
 *  so callers do not need to type the full path. */
const FIXTURES_DIR = resolve(repoRoot, 'packages/webapp/tests/e2e/fake-llm/fixtures');
const DEFAULT_FAKE_LLM_FIXTURE = resolve(FIXTURES_DIR, 'reference-scenario.json');

/** Resolve FAKE_LLM_FIXTURE to an absolute path.
 *  A bare name (no path separators, no .json) is looked up in FIXTURES_DIR. */
function resolveFixturePath(value: string): string {
  if (value.includes('/') || value.includes('\\') || value.endsWith('.json')) {
    return resolve(repoRoot, value);
  }
  return resolve(FIXTURES_DIR, `${value}.json`);
}

export default defineConfig({
  testDir: '.',
  webServer: [
    {
      // wrangler serves `dist/ui` (the leader/UI origin) with SPA fallback,
      // exactly as the production worker does. The webapp must be built
      // (`npm run build -w @slicc/webapp` → `dist/ui/index.html`) first; the
      // CI `webapp` job builds it before the E2E step.
      command: `npx wrangler dev --config ${resolve(repoRoot, 'packages/cloudflare-worker/wrangler.jsonc')} --port ${WRANGLER_PORT} --ip 127.0.0.1`,
      port: WRANGLER_PORT,
      reuseExistingServer: !process.env['CI'],
      // wrangler's first cold start (workerd bring-up) can exceed Playwright's
      // 60s default in CI.
      timeout: 120_000,
    },
    {
      // Thin /cdp bridge + `/api` surface only — no UI. `--cdp-port=9222` pins
      // the proxy's outbound CDP target so the agent's `playwright-cli` and the
      // harness's `readCdpPageState` both speak to the same Chrome (see
      // `reference-scenario.test.ts`, which launches Playwright Chrome with
      // `--remote-debugging-port=9222`). `SLICC_BRIDGE_TOKEN` arms the `/cdp`
      // upgrade gate + cross-origin `/api` token check; `BRIDGE_DEV_ALLOWED_ORIGINS`
      // allowlists the wrangler leader origin so its cross-origin requests pass.
      command: `node ${resolve(repoRoot, 'dist/node-server/index.js')} --serve-only --cdp-port=${CDP_PORT}`,
      port: BRIDGE_PORT,
      reuseExistingServer: !process.env['CI'],
      env: {
        PORT: String(BRIDGE_PORT),
        SLICC_BRIDGE_TOKEN: E2E_BRIDGE_TOKEN,
        BRIDGE_DEV_ALLOWED_ORIGINS: `http://localhost:${WRANGLER_PORT},http://127.0.0.1:${WRANGLER_PORT}`,
      },
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
        FAKE_LLM_FIXTURE: process.env['FAKE_LLM_FIXTURE']
          ? resolveFixturePath(process.env['FAKE_LLM_FIXTURE'])
          : DEFAULT_FAKE_LLM_FIXTURE,
      },
    },
  ],
  use: {
    baseURL: LEADER_ORIGIN,
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
