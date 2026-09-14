import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolvePort(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

export const FAKE_LLM_PORT = resolvePort('SLICC_E2E_FAKE_LLM_PORT', 5781);

export const WRANGLER_PORT = resolvePort('SLICC_E2E_WRANGLER_PORT', 8787);
export const BRIDGE_PORT = resolvePort('SLICC_E2E_BRIDGE_PORT', 5710);
export const CDP_PORT = resolvePort('SLICC_E2E_CDP_PORT', 9222);

export const WRANGLER_SUPERVISOR_PORT = resolvePort(
  'SLICC_E2E_WRANGLER_SUPERVISOR_PORT',
  WRANGLER_PORT + 1
);

export const WRANGLER_LOG_DIR = resolve(repoRoot, '.wrangler/e2e-logs');

export const E2E_BRIDGE_TOKEN = 'e2e-fixed-bridge-token';

export const LEADER_ORIGIN = `http://localhost:${WRANGLER_PORT}`;

export const WRANGLER_SUPERVISOR_ORIGIN = `http://127.0.0.1:${WRANGLER_SUPERVISOR_PORT}`;

export const BRIDGE_WS_URL = `ws://localhost:${BRIDGE_PORT}/cdp`;

const FIXTURES_DIR = resolve(repoRoot, 'packages/webapp/tests/e2e/fake-llm/fixtures');
const DEFAULT_FAKE_LLM_FIXTURE = resolve(FIXTURES_DIR, 'reference-scenario.json');

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
      command: `npx tsx ${resolve(repoRoot, 'packages/webapp/tests/e2e/cdp-browser.ts')}`,
      port: CDP_PORT,
      reuseExistingServer: !process.env['CI'],
      env: {
        SLICC_E2E_CDP_PORT: String(CDP_PORT),
      },
    },
    {
      command: `npx tsx ${resolve(repoRoot, 'packages/webapp/tests/e2e/wrangler-server.ts')} -- dev --local --env staging --config ${resolve(repoRoot, 'packages/cloudflare-worker/wrangler.jsonc')} --port ${WRANGLER_PORT} --ip 127.0.0.1`,
      env: {
        X_LOCAL_OBSERVABILITY: 'false',
        SLICC_E2E_WRANGLER_PORT: String(WRANGLER_PORT),
        SLICC_E2E_WRANGLER_SUPERVISOR_PORT: String(WRANGLER_SUPERVISOR_PORT),

        WRANGLER_LOG_PATH: WRANGLER_LOG_DIR,
      },

      url: `${LEADER_ORIGIN}/status`,
      reuseExistingServer: !process.env['CI'],

      timeout: 120_000,

      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
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

    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  reporter: process.env['CI'] ? [['html', { open: 'never' }], ['list']] : [['list']],

  workers: 1,
  fullyParallel: true,
  timeout: 30_000,

  retries: process.env['CI'] ? 2 : 0,
});
