import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

interface OpfsRootHandle {
  handle: FileSystemDirectoryHandle;
}

function installOpfsStub(root: OpfsRootHandle): void {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async (): Promise<FileSystemDirectoryHandle> => root.handle,
    },
  });
}

describe('VirtualFS — OPFS multi-instance coexistence (PR #876 P1)', () => {
  beforeEach(() => {
    const opfs = createMutableDirectoryHandle({});
    installOpfsStub(opfs);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creating a second OPFS instance does not displace the first instance mount', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const { mounts } = await import('@zenfs/core');
    const primary = await VirtualFS.create({
      dbName: 'slicc-fs-test-primary',
      backend: 'opfs',
      wipe: true,
    });
    const primaryRoot = (primary as unknown as { mountRoot: string }).mountRoot;

    const primaryFsBefore = mounts.get(primaryRoot);
    expect(primaryFsBefore).toBeDefined();

    const helper = await VirtualFS.create({
      dbName: 'slicc-fs-test-helper',
      backend: 'opfs',
      wipe: true,
    });
    const helperRoot = (helper as unknown as { mountRoot: string }).mountRoot;
    expect(helperRoot).not.toBe(primaryRoot);

    const primaryFsAfter = mounts.get(primaryRoot);
    const helperFs = mounts.get(helperRoot);
    expect(primaryFsAfter).toBe(primaryFsBefore);
    expect(helperFs).toBeDefined();
    expect(helperFs).not.toBe(primaryFsAfter);

    await primary.dispose();
    await helper.dispose();
  });

  it('each OPFS-backed instance mounts under a per-dbName subpath', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({
      dbName: 'slicc-fs-test-subpath',
      backend: 'opfs',
      wipe: true,
    });

    const mountRoot = (vfs as unknown as { mountRoot: string }).mountRoot;
    expect(mountRoot).toBe('/__opfs__/slicc-fs-test-subpath');
    await vfs.dispose();
  });
});
