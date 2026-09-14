import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileRegistry } from '../../src/cloud/registry-file.js';
import { CLI_START_POLL_TIMEOUT_MS, runStart } from '../../src/cloud/start.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let envFile: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-start-'));
  envFile = path.join(dir, 'secrets.env');
  await fs.writeFile(
    envFile,
    [
      'ANTHROPIC_API_KEY=sk-test',
      'ANTHROPIC_API_KEY_DOMAINS=api.anthropic.com',

      'E2B_API_KEY=e2b-secret',
      'E2B_API_KEY_DOMAINS=e2b.dev',
    ].join('\n') + '\n'
  );
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud start', () => {
  it('creates a sandbox, uploads secrets.env, polls cloud-status, registers entry', async () => {
    const substrate = new FakeSubstrate();
    const result = await runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      name: 'task-1',
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 5_000,
      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        await handle.writeFile(
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://www.sliccy.ai/join/tok',
            trayId: 't1',
            controllerUrl: 'wss://w/controller/c',
            webhookUrl: 'https://w/webhook/wb/wid',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: new Date().toISOString(),
          })
        );
      },
    });

    expect(result.joinUrl).toBe('https://www.sliccy.ai/join/tok');
    expect(result.sandboxId).toMatch(/^fake-/);
    expect(result.name).toBe('task-1');

    const sandboxes = await substrate.list();
    expect(sandboxes).toHaveLength(1);

    const handle = await substrate.connect(result.sandboxId);
    const uploaded = await handle.readFile('/slicc/secrets.env');
    expect(uploaded).toContain('ANTHROPIC_API_KEY=sk-test');

    expect(uploaded).not.toContain('E2B_API_KEY=');
    expect(uploaded).not.toContain('E2B_API_KEY_DOMAINS=');

    const reg = new FileRegistry(registryPath);
    const entries = await reg.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      substrate: 'e2b',
      sandboxId: result.sandboxId,
      name: 'task-1',
      joinUrl: 'https://www.sliccy.ai/join/tok',
      state: 'running',

      trayId: 't1',
    });
    expect(entries[0].lastJoinUpdatedAt).toBeTruthy();
    expect(typeof entries[0].lastJoinUpdatedAt).toBe('string');
  });

  it('kills the sandbox and includes stderr-tail in the error when cloud-status never appears', async () => {
    const substrate = new FakeSubstrate();
    const start = runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 200,
      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        await handle.writeFile(
          '/tmp/slicc-stderr.log',
          'Error: Failed to launch Chromium\n  cause: missing libnss3\n'
        );
      },
    });
    await expect(start).rejects.toThrow(/missing libnss3/);
    await expect(start).rejects.toMatchObject({
      name: 'CloudError',
      code: 'SANDBOX_NOT_READY',
    });
    expect(await substrate.list()).toHaveLength(0);
  });

  it('falls back gracefully when /tmp/slicc-stderr.log is absent', async () => {
    const substrate = new FakeSubstrate();
    const start = runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 200,
      pollIntervalMs: 10,
    });
    await expect(start).rejects.toThrow(/no \/tmp\/slicc-stderr\.log produced/);
    await expect(start).rejects.toMatchObject({
      name: 'CloudError',
      code: 'SANDBOX_NOT_READY',
    });
    expect(await substrate.list()).toHaveLength(0);
  });

  it('throws if env file is unreadable', async () => {
    const substrate = new FakeSubstrate();
    await expect(
      runStart({
        substrate,
        envFilePath: '/nonexistent/path/secrets.env',
        registryPath,
        sliccVersion: '3.2.2',
        workerBaseUrl: 'https://www.sliccy.ai',
        pollTimeoutMs: 100,
        pollIntervalMs: 10,
      })
    ).rejects.toThrow();
  });

  it('extracts ADOBE_IMS_TOKEN and ADOBE_IMS_TOKEN_DOMAINS into sandbox envVars', async () => {
    const adobeEnvFile = path.join(dir, 'adobe-secrets.env');
    await fs.writeFile(
      adobeEnvFile,
      [
        'ADOBE_IMS_TOKEN=ims-token-123',
        'ADOBE_IMS_TOKEN_DOMAINS=adobe.io,adobelogin.com',
        'OTHER_SECRET=do-not-include',
        'ANTHROPIC_API_KEY=sk-test',
      ].join('\n') + '\n'
    );

    const substrate = new FakeSubstrate();
    await runStart({
      substrate,
      envFilePath: adobeEnvFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 5_000,
      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        await handle.writeFile(
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://www.sliccy.ai/join/tok',
            trayId: 't1',
            controllerUrl: 'wss://w/controller/c',
            webhookUrl: 'https://w/webhook/wb/wid',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: new Date().toISOString(),
          })
        );
      },
    });

    expect(substrate.lastCreateOpts).toBeTruthy();
    expect(substrate.lastCreateOpts?.envVars).toMatchObject({
      ADOBE_IMS_TOKEN: 'ims-token-123',
      ADOBE_IMS_TOKEN_DOMAINS: 'adobe.io,adobelogin.com',
      SLICC_TRAY_WORKER_BASE_URL: 'https://www.sliccy.ai',
    });

    expect(substrate.lastCreateOpts?.envVars?.OTHER_SECRET).toBeUndefined();
  });

  it('forwards --template to the substrate and applies the default CLI poll timeout', async () => {
    const substrate = new FakeSubstrate();
    const result = await runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      template: 'slicc-test',

      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        await handle.writeFile(
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://www.sliccy.ai/join/tok',
            trayId: 't1',
            controllerUrl: 'wss://w/controller/c',
            webhookUrl: 'https://w/webhook/wb/wid',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: new Date().toISOString(),
          })
        );
      },
    });
    expect(result.joinUrl).toBe('https://www.sliccy.ai/join/tok');

    expect(substrate.lastCreateOpts?.template).toBe('slicc-test');
  });

  it('uses a generous CLI poll-timeout default for cold-boot headroom', () => {
    expect(CLI_START_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
