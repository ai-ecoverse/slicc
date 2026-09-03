/**
 * node-server half of the shared CapabilityBroker REST contract (#2276 slice B).
 *
 * Replays `packages/shared-ts/fixtures/capability-rest-contract.json` against
 * a live Express app carrying the real secret / sign-and-forward / sudo
 * routes. The Swift server replays the SAME file in
 * `packages/swift-server/Tests/CapabilityRestContractTests.swift`, and the
 * browser adapter is pinned to it in
 * `packages/webapp/tests/work-unit/capability-rest-adapter.test.ts` — so the
 * two privileged servers and the one browser client cannot drift apart
 * silently.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSecretRoutes } from '../../src/routes/secrets.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { OauthSecretStore } from '../../src/secrets/oauth-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';
import { registerSudoApproveEndpoint } from '../../src/sudo/endpoint.js';

const here = dirname(fileURLToPath(import.meta.url));

interface ContractCase {
  name: string;
  operation: string;
  method: string;
  path: string;
  body?: unknown;
  expect: {
    status: number;
    bodyKind?: 'array' | 'object';
    itemFields?: string[];
    bodyFields?: Record<string, unknown>;
  };
}

interface Contract {
  version: number;
  operations: Array<{ operation: string; method: string; path: string }>;
  serverCases: ContractCase[];
}

const contract = JSON.parse(
  readFileSync(
    join(here, '..', '..', '..', 'shared-ts', 'fixtures', 'capability-rest-contract.json'),
    'utf8'
  )
) as Contract;

let tmpDir: string;

interface Harness {
  base: string;
  close(): Promise<void>;
}

async function start(): Promise<Harness> {
  tmpDir = join(tmpdir(), `slicc-capability-contract-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, 'secrets.env');
  writeFileSync(
    file,
    ['GITHUB_TOKEN=ghp_realtoken123456789abcdef', 'GITHUB_TOKEN_DOMAINS=api.github.com'].join('\n'),
    { mode: 0o600 }
  );
  const secretStore = new EnvSecretStore(file);
  const oauthStore = new OauthSecretStore();
  const secretProxy = new SecretProxyManager(secretStore, 'contract-session', oauthStore);
  await secretProxy.reload();

  const app = express();
  registerSecretRoutes(app, { secretStore, secretProxy, oauthStore, devMode: false });
  // A backend that would throw if it were ever reached: every contract case
  // for this route is a rejected payload, so a real prompt must never fire.
  registerSudoApproveEndpoint(app, {
    backend: {
      name: 'contract-guard',
      prompt: () => {
        throw new Error('the contract suite must never raise a real approval prompt');
      },
    },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Concrete path for a case, with the fixture's placeholders resolved. */
function resolvePath(path: string): string {
  return path.replace('{{unknownSecret}}', `NO_SUCH_SECRET_${randomUUID().slice(0, 8)}`);
}

describe('CapabilityBroker REST contract — node-server', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await start();
  });
  afterEach(async () => {
    await h.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a route for every contract operation', async () => {
    for (const op of contract.operations) {
      // Two exclusions, both covered by `serverCases` instead:
      //   - `/api/fetch-proxy` is mounted by index.ts (it needs the whole
      //     proxy pipeline), not by the route modules this harness composes.
      //   - `DELETE /api/secrets/{name}` legitimately 404s for a name that
      //     does not exist, so "404" cannot distinguish it from a missing
      //     route here; the `{{unknownSecret}}` case asserts a JSON handler
      //     body, which a missing route would not produce.
      if (op.path.startsWith('/api/fetch-proxy') || op.path.includes('{name}')) continue;
      const res = await fetch(`${h.base}${op.path}`, {
        method: op.method === '*' ? 'GET' : op.method,
        headers: { 'Content-Type': 'application/json' },
        ...(op.method === 'POST' ? { body: '{}' } : {}),
      });
      expect({ path: op.path, notFound: res.status === 404 }).toEqual({
        path: op.path,
        notFound: false,
      });
    }
  });

  for (const testCase of contract.serverCases) {
    it(testCase.name, async () => {
      const init: RequestInit = {
        method: testCase.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (testCase.body !== undefined) init.body = JSON.stringify(testCase.body);
      const res = await fetch(`${h.base}${resolvePath(testCase.path)}`, init);
      expect(res.status).toBe(testCase.expect.status);

      const body = (await res.json()) as unknown;
      if (testCase.expect.bodyKind === 'array') {
        expect(Array.isArray(body)).toBe(true);
        for (const field of testCase.expect.itemFields ?? []) {
          for (const item of body as Array<Record<string, unknown>>) {
            expect(item).toHaveProperty(field);
          }
        }
      }
      if (testCase.expect.bodyKind === 'object') {
        expect(Array.isArray(body)).toBe(false);
        expect(typeof body).toBe('object');
      }
      for (const [field, value] of Object.entries(testCase.expect.bodyFields ?? {})) {
        expect(body).toHaveProperty(field, value);
      }
    });
  }
});
