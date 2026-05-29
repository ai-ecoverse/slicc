import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileRegistry } from '../../src/cloud/registry-file.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-reg-'));
  file = path.join(dir, 'cloud-sessions.json');
});

describe('FileRegistry', () => {
  it('returns an empty list when the file is missing', async () => {
    const reg = new FileRegistry(file);
    expect(await reg.list()).toEqual([]);
  });

  it('appends, lists, and removes entries with stable ordering', async () => {
    const reg = new FileRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'a',
      name: 'one',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/aa',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'b',
      name: 'two',
      createdAt: '2026-05-22T00:01:00Z',
      joinUrl: 'https://w/join/bb',
      lastSeen: '2026-05-22T00:01:00Z',
      state: 'running',
    });

    expect((await reg.list()).map((s) => s.sandboxId)).toEqual(['a', 'b']);

    await reg.remove('a');
    expect((await reg.list()).map((s) => s.sandboxId)).toEqual(['b']);
  });

  it('update merges fields by sandboxId', async () => {
    const reg = new FileRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'a',
      name: 'one',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    await reg.update('a', { joinUrl: 'https://w/join/new', state: 'paused' });
    const entry = (await reg.list()).find((s) => s.sandboxId === 'a');
    expect(entry?.joinUrl).toBe('https://w/join/new');
    expect(entry?.state).toBe('paused');
  });

  it('update throws when sandboxId is not found', async () => {
    const reg = new FileRegistry(file);
    await expect(reg.update('missing-id', { state: 'paused' })).rejects.toThrow(
      /entry not found: missing-id/
    );
  });

  it('remove is a no-op when sandboxId is not found', async () => {
    const reg = new FileRegistry(file);
    await expect(reg.remove('missing-id')).resolves.toBeUndefined();
  });

  it('findByNameOrId resolves both name and sandboxId', async () => {
    const reg = new FileRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'sb-abc',
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/x',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    expect((await reg.findByNameOrId('task-1'))?.sandboxId).toBe('sb-abc');
    expect((await reg.findByNameOrId('sb-abc'))?.sandboxId).toBe('sb-abc');
    expect(await reg.findByNameOrId('nope')).toBeNull();
  });
});
