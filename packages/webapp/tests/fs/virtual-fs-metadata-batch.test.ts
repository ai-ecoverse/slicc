/**
 * Regression: N metadata updates must not rewrite the OPFS sidecar N times.
 * Diagnosed while extracting large tarballs (@thread:thr_b83wwqmt4e).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createDirectoryHandle, createMutableDirectoryHandle } from './fsa-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('VirtualFS.updateMetadataBatch', () => {
  it('persists N mode/time updates with one sidecar write', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-sidecar';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const readSidecar = async () => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()) as {
        entries: Record<string, { mode?: number; mtimeMs?: number }>;
      };
    };
    try {
      for (let i = 0; i < 8; i++) {
        await fs.writeFile(`/f${i}`, `data-${i}`);
      }
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      const when = new Date(1_600_000_000_000);
      await fs.updateMetadataBatch(
        Array.from({ length: 8 }, (_, i) => ({
          path: `/f${i}`,
          mode: 0o600 + (i % 7),
          atime: when,
          mtime: when,
        }))
      );
      expect(flushSpy).toHaveBeenCalledTimes(1);
      const entries = (await readSidecar()).entries;
      for (let i = 0; i < 8; i++) {
        expect(entries[`/f${i}`].mode! & 0o777).toBe(0o600 + (i % 7));
        expect(entries[`/f${i}`].mtimeMs).toBe(when.getTime());
        expect(((await fs.stat(`/f${i}`)).mode ?? 0) & 0o777).toBe(0o600 + (i % 7));
      }
    } finally {
      await fs.dispose();
    }
  });

  it('skips mount members and still applies later VFS updates', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-mixed-mount';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const readSidecar = async () => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()) as {
        entries: Record<string, { mode?: number; mtimeMs?: number }>;
      };
    };
    try {
      await fs.writeFile('/local-a', 'a');
      await fs.writeFile('/local-b', 'b');
      await fs.mount(
        '/mnt',
        LocalMountBackend.fromHandle(createDirectoryHandle({ file: 'mounted' }), {
          mountId: 'metadata-batch-mount',
        })
      );
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      const when = new Date(1_700_000_000_000);
      await fs.updateMetadataBatch([
        { path: '/local-a', mode: 0o640, atime: when, mtime: when },
        { path: '/mnt/file', mode: 0o755, atime: when, mtime: when },
        { path: '/local-b', mode: 0o711, atime: when, mtime: when },
      ]);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      const entries = (await readSidecar()).entries;
      expect(entries['/local-a'].mode! & 0o777).toBe(0o640);
      expect(entries['/local-b'].mode! & 0o777).toBe(0o711);
      expect(entries['/local-a'].mtimeMs).toBe(when.getTime());
      expect(entries['/local-b'].mtimeMs).toBe(when.getTime());
      expect(((await fs.stat('/local-a')).mode ?? 0) & 0o777).toBe(0o640);
      expect(((await fs.stat('/local-b')).mode ?? 0) & 0o777).toBe(0o711);
      // Mount metadata is unsupported — lone APIs still ENOSYS.
      await expect(fs.chmod('/mnt/file', 0o700)).rejects.toMatchObject({ code: 'ENOSYS' });
      await expect(
        fs.updateMetadataBatch([{ path: '/mnt/missing', mode: 0o700 }])
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.dispose();
    }
  });

  it('chmod and utimes still persist before return (batch of one)', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-single';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const persisted = async () => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()).entries['/run'];
    };
    try {
      await fs.writeFile('/run', 'data');
      await fs.chmod('/run', 0o755);
      expect((await persisted()).mode & 0o777).toBe(0o755);
      await fs.utimes('/run', new Date(0), new Date(123456));
      expect((await persisted()).mtimeMs).toBe(123456);
    } finally {
      await fs.dispose();
    }
  });

  it('N individual chmod calls still rewrite the sidecar N times', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const fs = await VirtualFS.create({
      dbName: 'metadata-batch-contrast',
      backend: 'opfs',
      wipe: true,
    });
    try {
      for (let i = 0; i < 5; i++) await fs.writeFile(`/c${i}`, 'x');
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      for (let i = 0; i < 5; i++) await fs.chmod(`/c${i}`, 0o700);
      expect(flushSpy).toHaveBeenCalledTimes(5);
    } finally {
      await fs.dispose();
    }
  });
});
