import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runKill } from '../../src/cloud/kill.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-kill-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud kill', () => {
  it('kills the sandbox and removes the registry entry', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });

    await runKill({ substrate: sub, registryPath, query: 'task-1' });

    expect(await sub.list()).toHaveLength(0);
    expect(await reg.list()).toHaveLength(0);
  });

  it('removes the registry entry even when the sandbox is already dead', async () => {
    const sub = new FakeSubstrate();
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'gone',
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'dead',
    });

    await runKill({ substrate: sub, registryPath, query: 'task-1' });
    expect(await reg.list()).toHaveLength(0);
  });

  it('throws when the query matches no registry entry', async () => {
    await expect(
      runKill({ substrate: new FakeSubstrate(), registryPath, query: 'nope' })
    ).rejects.toThrow(/not found/i);
  });
});
