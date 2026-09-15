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

d('VirtualFS — optional OPFS async cache (heavy)', () => {
  it('supports async operations and shell reads without a synchronous preload', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const { VfsAdapter } = await import('../../src/shell/vfs-adapter.js');
    const { Bash } = await import('just-bash');
    const dbName = 'a6-no-preload';
    const fs = await VirtualFS.create({
      dbName,
      backend: 'opfs',
      wipe: true,
      opfsAsyncCache: false,
    });
    let peer: Awaited<ReturnType<typeof VirtualFS.create>> | undefined;
    try {
      await fs.writeFile('/work/file', 'longer content');
      await fs.writeFile('/work/file', 'short');
      await fs.symlink('/work/file', '/link');
      expect(fs.statSync('/work/file')).toBe(null);
      expect(fs.readDirSync('/work')).toBe(null);
      expect(await fs.readTextFile('/link')).toBe('short');
      const adapter = new VfsAdapter(fs);
      adapter.setRegisteredCommandsFn(() => ['cat', 'find']);
      const bash = new Bash({ fs: adapter, cwd: '/', defenseInDepth: false });
      const result = await bash.exec('cat /link; find /work -type f');
      if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('short/work/file\n');
      peer = await VirtualFS.create({ dbName, backend: 'opfs' });
      expect(peer.statSync('/work/file')).toBe(null);
      await peer.rename('/work/file', '/work/renamed');
      expect(await fs.readTextFile('/work/renamed')).toBe('short');
      let errorCode = '';
      try {
        await VirtualFS.create({ dbName, backend: 'opfs', opfsAsyncCache: true });
      } catch (error) {
        errorCode = (error as { code: string }).code;
      }
      expect(errorCode).toBe('EBUSY');
    } finally {
      await peer?.dispose();
      await fs.dispose();
    }
    const reloaded = await VirtualFS.create({ dbName, backend: 'opfs', opfsAsyncCache: true });
    try {
      expect(await reloaded.readTextFile('/work/renamed')).toBe('short');
      expect(reloaded.statSync('/work/renamed')?.size).toBe(5);
      await reloaded.rm('/work/renamed');
      expect(await reloaded.exists('/work/renamed')).toBe(false);
    } finally {
      await reloaded.dispose();
    }
  });
});
