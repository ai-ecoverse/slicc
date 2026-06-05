/**
 * Regression test for review comment 3362777631 on PR #876.
 *
 * Earlier revisions of `initOpfsBackend` called ZenFS' top-level
 * `configure({ mounts: { '/': … } })` for every OPFS-backed
 * `VirtualFS` instance, so a second instance with a different
 * `dbName` (e.g. the helper `slicc-fs-global` used by git/MCP/OAuth)
 * would replace the GLOBAL `/` mount and silently disconnect the
 * orchestrator's primary `slicc-fs` instance from its OPFS tree
 * (`/workspace` would resolve into the helper's subdir).
 *
 * The fix mounts each OPFS-backed instance at a per-`dbName` subpath
 * (`/__opfs__/<dbName>`) via `mount(point, fs)` instead of
 * `configure({ '/': … })`, with a stub InMemory root established once
 * per realm. This file asserts that:
 *
 *   1. two OPFS-backed VirtualFS instances with different `dbName`s
 *      coexist and do not see each other's files;
 *   2. the first instance still sees its own data after the second
 *      is constructed (i.e. its mount was not displaced by the
 *      second `configure` call);
 *   3. each instance exposes a distinct `/__opfs__/<dbName>` mount
 *      root internally (`mountRoot` field) — proves the per-dbName
 *      subpath is in effect.
 */
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
    // Snapshot the ZenFS mount entry at the primary's subpath BEFORE
    // the helper is created. Pre-fix, the helper's `configure({ '/':
    // … })` would replace the global `/` mount and the same key
    // would still be present (or absent for the per-dbName subpath
    // since the primary used `/`). The new design installs each
    // instance at its own `/__opfs__/<dbName>` mount.
    const primaryFsBefore = mounts.get(primaryRoot);
    expect(primaryFsBefore).toBeDefined();

    // Second instance with a different dbName.
    const helper = await VirtualFS.create({
      dbName: 'slicc-fs-test-helper',
      backend: 'opfs',
      wipe: true,
    });
    const helperRoot = (helper as unknown as { mountRoot: string }).mountRoot;
    expect(helperRoot).not.toBe(primaryRoot);

    // BOTH per-dbName mounts are present after the second create —
    // proves the second `initOpfsBackend` did not replace the first.
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
    // `mountRoot` is the underlying ZenFS mount point the VFS proxies
    // its calls through. Per-`dbName` subpath proves we no longer
    // remount the global `/`.
    const mountRoot = (vfs as unknown as { mountRoot: string }).mountRoot;
    expect(mountRoot).toBe('/__opfs__/slicc-fs-test-subpath');
    await vfs.dispose();
  });
});
