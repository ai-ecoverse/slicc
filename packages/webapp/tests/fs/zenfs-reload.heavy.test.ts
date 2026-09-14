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
