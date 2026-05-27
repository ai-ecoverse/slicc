import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPause } from '../../src/cloud/pause.js';
import { FileRegistry } from '../../src/cloud/registry-file.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-pause-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud pause', () => {
  it('pauses the sandbox and updates registry state', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const reg = new FileRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });

    await runPause({ substrate: sub, registryPath, query: 'task-1' });

    // Check state before connecting (which would resume it)
    expect((await sub.list())[0].state).toBe('paused');
    expect((await reg.list())[0].state).toBe('paused');

    // After connecting, the sandbox is resumed
    expect((await sub.connect(h.sandboxId)).sandboxId).toBe(h.sandboxId);
    expect((await sub.list())[0].state).toBe('running');
  });

  it('throws when the query matches no registry entry', async () => {
    await expect(
      runPause({ substrate: new FakeSubstrate(), registryPath, query: 'nope' })
    ).rejects.toThrow(/not found/i);
    await expect(
      runPause({ substrate: new FakeSubstrate(), registryPath, query: 'nope' })
    ).rejects.toMatchObject({
      name: 'CloudError',
      code: 'NOT_FOUND',
    });
  });

  it('preserves trayId and lastJoinUpdatedAt across pause (resume baseline)', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const reg = new FileRegistry(registryPath);
    const before = {
      substrate: 'e2b' as const,
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/j',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running' as const,
      trayId: 'tray-original',
      lastJoinUpdatedAt: '2026-05-22T00:00:01Z',
    };
    await reg.append(before);

    await runPause({ substrate: sub, registryPath, query: 'task-1' });

    const after = (await reg.list())[0];
    expect(after.state).toBe('paused');
    expect(after.trayId).toBe('tray-original');
    expect(after.lastJoinUpdatedAt).toBe('2026-05-22T00:00:01Z');
  });
});
