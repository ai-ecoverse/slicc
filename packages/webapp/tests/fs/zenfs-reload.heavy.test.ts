/**
 * Heavy-gated OPFS reload integrity test.
 *
 * Asserts that the OPFS-backed VirtualFS, configured with the
 * `metadata: '/.metadata.json'` sidecar, preserves three classes of
 * metadata across a simulated reload:
 *
 *   1. symlink targets (created via `vfs.symlink()`, read via `readlink()`),
 *   2. file mode bits (notably the executable bit — what
 *      `git statusMatrix` reads off `lstat().mode`),
 *   3. the sidecar JSON itself, written to the OPFS root at
 *      `/.metadata.json` (the well-known location passed to ZenFS).
 *
 * Gating: this test is OPT-IN. It runs only when
 * `SLICC_TEST_HEAVY_OPFS=1` is set in the environment AND a live OPFS
 * is reachable (i.e. `navigator.storage.getDirectory` exists). The
 * default `npm run test -w @slicc/webapp` skips this file because
 * vitest's Node environment has no OPFS. Run it locally inside a
 * puppeteer-driven browser worker, or in a future CI lane that
 * provisions OPFS via the same driver used by Spike 1.
 */

import { describe, expect, it } from 'vitest';

const SHOULD_RUN =
  process.env['SLICC_TEST_HEAVY_OPFS'] === '1' &&
  typeof (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage
    ?.getDirectory === 'function';

const d = SHOULD_RUN ? describe : describe.skip;

d('VirtualFS — OPFS reload integrity (heavy)', () => {
  it('symlink survives a reload', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    {
      const vfs = await VirtualFS.create({
        dbName: 'a6-reload-symlink',
        backend: 'opfs',
        wipe: true,
      });
      await vfs.writeFile('/target.txt', 'hello');
      await vfs.symlink('/target.txt', '/link');
      await vfs.dispose();
    }
    {
      const vfs = await VirtualFS.create({
        dbName: 'a6-reload-symlink',
        backend: 'opfs',
      });
      const target = await vfs.readlink('/link');
      expect(target).toBe('/target.txt');
      const content = await vfs.readTextFile('/link');
      expect(content).toBe('hello');
      await vfs.dispose();
    }
  });

  it('exec filemode survives a reload', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    // `vfs.getLightningFS()` no longer exists; reach the underlying
    // ZenFS `fs.promises` directly here, since this test exercises a
    // POSIX surface (`chmod`) that VirtualFS does not re-expose. The
    // OPFS backend is now mounted at `/__opfs__/<dbName>` (per-dbName
    // subpath, see `initOpfsBackend`), so direct ZenFS calls must
    // address the prefixed path.
    const { fs: zenfs } = await import('@zenfs/core');
    const DB = 'a6-reload-filemode';
    const ROOT = `/__opfs__/${DB}`;
    {
      const vfs = await VirtualFS.create({
        dbName: DB,
        backend: 'opfs',
        wipe: true,
      });
      await vfs.writeFile('/run.sh', '#!/bin/sh\necho ok\n');
      await zenfs.promises.chmod(`${ROOT}/run.sh`, 0o100755);
      await vfs.dispose();
    }
    {
      const vfs = await VirtualFS.create({
        dbName: DB,
        backend: 'opfs',
      });
      const st = await zenfs.promises.lstat(`${ROOT}/run.sh`);
      expect(st.mode & 0o111).not.toBe(0);
      await vfs.dispose();
    }
  });

  it('metadata sidecar is written to OPFS root at /.metadata.json', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({
      dbName: 'a6-reload-sidecar',
      backend: 'opfs',
      wipe: true,
    });
    await vfs.writeFile('/seed.txt', 'x');
    await vfs.symlink('/seed.txt', '/seed-link');
    const root = await (
      navigator as unknown as {
        storage: { getDirectory: () => Promise<FileSystemDirectoryHandle> };
      }
    ).storage.getDirectory();
    const subdir = await root.getDirectoryHandle('a6-reload-sidecar');
    const sidecar = await subdir.getFileHandle('.metadata.json');
    expect(sidecar).toBeTruthy();
    const file = await sidecar.getFile();
    expect(file.size).toBeGreaterThan(0);
    await vfs.dispose();
  });
});
