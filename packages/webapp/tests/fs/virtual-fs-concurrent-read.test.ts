/**
 * Regression for #2034: concurrent `readFile` calls against the OPFS-backed
 * VirtualFS must return each path's own bytes.
 *
 * ZenFS keys its vnode cache by `ino`, and every vnode owns a sparse data
 * cache. Two paths that share an ino while both are open share one vnode —
 * and therefore one data cache — so the second reader is served the first
 * file's bytes. Sequential reads never collide because the vnode is evicted
 * on the last `unref`, which is why the original report saw byte-correct
 * sequential fetches and a collapsed parallel module-graph fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

function installOpfsStub(handle: FileSystemDirectoryHandle): void {
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => handle },
  });
}

interface IndexLike {
  get(path: string): { ino: number; data: number } | undefined;
}

describe('VirtualFS — concurrent reads (#2034)', () => {
  beforeEach(() => {
    installOpfsStub(createMutableDirectoryHandle({}).handle);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parallel reads of distinct files return distinct content', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({
      dbName: 'concurrent-read-a',
      backend: 'opfs',
      wipe: true,
    });
    const names = Array.from({ length: 8 }, (_, i) => `/workspace/dist/chunk-${i}.js`);
    for (const n of names) await vfs.writeFile(n, `export const id = '${n}';\n`);

    const results = await Promise.all(names.map((n) => vfs.readFile(n, { encoding: 'utf-8' })));
    expect(results).toEqual(names.map((n) => `export const id = '${n}';\n`));
    await vfs.dispose();
  });

  it('parallel reads stay distinct even when two index entries collide on ino', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({
      dbName: 'concurrent-read-b',
      backend: 'opfs',
      wipe: true,
    });
    await vfs.writeFile('/workspace/index.js', 'INDEX'.repeat(10));
    await vfs.writeFile('/workspace/chunk-a.js', 'CHUNK-A'.repeat(10));

    // Forge the collision a poisoned sidecar used to produce in the field
    // (#2146): make chunk-a carry index.js's ino.
    const index = (vfs as unknown as { opfsBackendFs: { index: IndexLike } }).opfsBackendFs.index;
    const a = index.get('/workspace/index.js');
    const b = index.get('/workspace/chunk-a.js');
    if (!a || !b) throw new Error('index entries missing');
    b.ino = a.ino;

    const [idx, chunk] = await Promise.all([
      vfs.readFile('/workspace/index.js', { encoding: 'utf-8' }),
      vfs.readFile('/workspace/chunk-a.js', { encoding: 'utf-8' }),
    ]);
    expect(idx).toBe('INDEX'.repeat(10));
    expect(chunk).toBe('CHUNK-A'.repeat(10));
    await vfs.dispose();
  });
});
