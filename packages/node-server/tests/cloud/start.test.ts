import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runStart, filterSecretsEnv } from '../../src/cloud/start.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
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
      // E2B creds intentionally in the source file — runStart must strip them
      // before upload (G1: do not leak substrate creds into the cloud).
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
    // G1: E2B credentials must NOT be uploaded to the cloud sandbox.
    expect(uploaded).not.toContain('E2B_API_KEY=');
    expect(uploaded).not.toContain('E2B_API_KEY_DOMAINS=');

    const reg = new CloudSessionRegistry(registryPath);
    const entries = await reg.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      substrate: 'e2b',
      sandboxId: result.sandboxId,
      name: 'task-1',
      joinUrl: 'https://www.sliccy.ai/join/tok',
      state: 'running',
      // Resume baseline must be populated from the seeded cloud-status payload.
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
        // Intentionally do NOT write /tmp/slicc-join.json — force the poll to time out.
      },
    });
    await expect(start).rejects.toThrow(/missing libnss3/);
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
});

describe('filterSecretsEnv', () => {
  it('strips E2B_API_KEY with various whitespace shapes', () => {
    const input = [
      'ANTHROPIC_API_KEY=sk-test',
      'E2B_API_KEY=plain',
      '  E2B_API_KEY=leading-space',
      'E2B_API_KEY  =extra-space-before-eq',
      'E2B_API_KEY_DOMAINS=e2b.dev',
      '\tE2B_API_KEY=tab-prefixed',
    ].join('\n');
    const out = filterSecretsEnv(input);
    expect(out).toContain('ANTHROPIC_API_KEY=sk-test');
    // All four E2B_API_KEY variants must be stripped:
    expect(out).not.toContain('E2B_API_KEY=plain');
    expect(out).not.toContain('E2B_API_KEY=leading-space');
    expect(out).not.toContain('E2B_API_KEY=extra-space-before-eq');
    expect(out).not.toContain('E2B_API_KEY_DOMAINS=e2b.dev');
    expect(out).not.toContain('E2B_API_KEY=tab-prefixed');
  });

  it('preserves comments and empty lines', () => {
    const input = '# important comment\n\nANTHROPIC_API_KEY=x\nE2B_API_KEY=strip\n';
    const out = filterSecretsEnv(input);
    expect(out).toContain('# important comment');
    expect(out.split('\n').some((l) => l === '')).toBe(true);
    expect(out).toContain('ANTHROPIC_API_KEY=x');
    expect(out).not.toContain('E2B_API_KEY=strip');
  });
});
