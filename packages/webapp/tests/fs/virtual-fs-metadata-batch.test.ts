/**
 * Regression: N metadata updates must not rewrite the OPFS sidecar N times.
 * Diagnosed while extracting large tarballs (@thread:thr_b83wwqmt4e).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';
import { createDirectoryHandle, createMutableDirectoryHandle } from './fsa-test-helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it('individual chmod and utimes persist at flush, including multiple changes to one path', async () => {
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
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await fs.chmod('/run', 0o755);
      await fs.utimes('/run', new Date(0), new Date(123456));
      expect(await persisted()).toBeUndefined();
      await fs.flush();
      expect((await persisted()).mode & 0o777).toBe(0o755);
      expect((await persisted()).mtimeMs).toBe(123456);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
      await fs.dispose();
    }
  });

  it('N individual chmod/utimes calls cause one full sidecar rewrite after an idle gap', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const fs = await VirtualFS.create({
      dbName: 'metadata-batch-contrast',
      backend: 'opfs',
      wipe: true,
    });
    try {
      for (let i = 0; i < 5; i++) await fs.writeFile(`/c${i}`, 'x');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      for (let i = 0; i < 5; i++) {
        await fs.chmod(`/c${i}`, 0o700);
        await fs.utimes(`/c${i}`, new Date(0), new Date(123456));
      }
      expect(flushSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(flushSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      await flushSpy.mock.results[0].value;
      const directory = await (
        await root.handle.getDirectoryHandle('metadata-batch-contrast')
      ).getFileHandle('.metadata.json');
      const entries = JSON.parse(await (await directory.getFile()).text()).entries;
      for (let i = 0; i < 5; i++) {
        expect(entries[`/c${i}`].mode & 0o777).toBe(0o700);
        expect(entries[`/c${i}`].mtimeMs).toBe(123456);
      }
    } finally {
      vi.useRealTimers();
      await fs.dispose();
    }
  });

  it('a peer flush drains the shared dirty metadata and cancels the idle write', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-peer';
    const primary = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const peer = await VirtualFS.create({ dbName, backend: 'opfs' });
    try {
      await primary.writeFile('/file', 'x');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const flushSpy = vi.spyOn(
        peer as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      const deferredSpy = vi.spyOn(
        primary as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      await primary.chmod('/file', 0o700);
      await peer.flush();
      expect(flushSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(deferredSpy).not.toHaveBeenCalled();
      const directory = await root.handle.getDirectoryHandle(dbName);
      const sidecar = await (await directory.getFileHandle('.metadata.json')).getFile();
      expect(JSON.parse(await sidecar.text()).entries['/file'].mode & 0o777).toBe(0o700);
    } finally {
      vi.useRealTimers();
      await peer.dispose();
      await primary.dispose();
    }
  });

  it('retries a failed idle write without another metadata syscall', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-retry';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await fs.writeFile('/file', 'x');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      flushSpy.mockRejectedValueOnce(new Error('sidecar unavailable'));
      await fs.chmod('/file', 0o700);
      await vi.advanceTimersByTimeAsync(100);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(flushSpy).toHaveBeenCalledTimes(2);
      await flushSpy.mock.results[1].value;
      const directory = await root.handle.getDirectoryHandle(dbName);
      const sidecar = await (await directory.getFileHandle('.metadata.json')).getFile();
      expect(JSON.parse(await sidecar.text()).entries['/file'].mode & 0o777).toBe(0o700);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      await fs.dispose();
    }
  });

  it('forwards explicit metadata and external invalidation through the shell adapter', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-batch-adapter';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const adapter = new VfsAdapter(fs);
    try {
      const directory = await root.handle.getDirectoryHandle(dbName);
      root.setFile(`${dbName}/.metadata.consistent.json`, 'stale mark');
      await adapter.forgetSidecarConsistency();
      await expect(directory.getFileHandle('.metadata.consistent.json')).rejects.toThrow();

      await fs.writeFile('/file', 'old');
      const when = new Date(123456);
      await adapter.updateMetadataBatch([{ path: '/file', mode: 0o700, atime: when, mtime: when }]);
      const sidecar = await (await directory.getFileHandle('.metadata.json')).getFile();
      expect(JSON.parse(await sidecar.text()).entries['/file'].mode & 0o777).toBe(0o700);
      root.setFile(`${dbName}/file`, 'fresh');
      adapter.invalidatePaths(['/file']);
      expect(await adapter.readFile('/file')).toBe('fresh');
    } finally {
      await fs.dispose();
    }
  });
});
