import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runList } from '../../src/cloud/list.js';
import { FileRegistry } from '../../src/cloud/registry-file.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-list-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud list', () => {
  it('returns an empty list when no sessions registered', async () => {
    const result = await runList({
      substrate: new FakeSubstrate(),
      registryPath,
    });
    expect(result).toEqual([]);
  });

  it('enriches each registry entry with live state from the substrate', async () => {
    const sub = new FakeSubstrate();
    const handleA = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const handleB = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-2',
    });
    await handleB.pause();

    const reg = new FileRegistry(registryPath);
    for (const h of [handleA, handleB]) {
      await reg.append({
        substrate: 'e2b',
        sandboxId: h.sandboxId,
        name: (await h.getInfo()).metadata.name as string | undefined,
        createdAt: new Date().toISOString(),
        joinUrl: `https://w/join/${h.sandboxId}`,
        lastSeen: new Date().toISOString(),
        state: 'running', // stale; live state should override
      });
    }

    const result = await runList({ substrate: sub, registryPath });
    const a = result.find((s) => s.sandboxId === handleA.sandboxId);
    const b = result.find((s) => s.sandboxId === handleB.sandboxId);
    expect(a?.state).toBe('running');
    expect(b?.state).toBe('paused');
  });

  it('marks an entry as dead when the substrate no longer knows about it', async () => {
    const sub = new FakeSubstrate();
    const reg = new FileRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'stale-id',
      name: 'gone',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/join/g',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });
    const result = await runList({ substrate: sub, registryPath });
    expect(result[0].state).toBe('dead');
  });
});
