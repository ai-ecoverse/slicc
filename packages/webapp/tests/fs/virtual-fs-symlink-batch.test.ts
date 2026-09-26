/**
 * Regression: N symlink creates must not rewrite the OPFS sidecar N times.
 * Sibling of #3507 (tar metadata batch); diagnosed for mamba extract (#3518).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createDirectoryHandle, createMutableDirectoryHandle } from './fsa-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('VirtualFS.symlinkBatch', () => {
  it('persists N symlink creates with one sidecar write', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'symlink-batch-sidecar';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const readSidecar = async () => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()) as {
        entries: Record<string, { type?: string; target?: string }>;
      };
    };
    try {
      for (let i = 0; i < 8; i++) {
        await fs.writeFile(`/t${i}`, `data-${i}`);
      }
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      await fs.symlinkBatch(
        Array.from({ length: 8 }, (_, i) => ({
          target: `/t${i}`,
          path: `/l${i}`,
        }))
      );
      expect(flushSpy).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 8; i++) {
        expect(await fs.readlink(`/l${i}`)).toBe(`/t${i}`);
        expect((await fs.lstat(`/l${i}`)).type).toBe('symlink');
      }
      const entries = (await readSidecar()).entries;
      for (let i = 0; i < 8; i++) {
        expect(entries[`/l${i}`]).toBeDefined();
      }
    } finally {
      await fs.dispose();
    }
  });

  it('symlink still persists before return (batch of one)', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'symlink-batch-single';
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const persisted = async () => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()).entries['/link'];
    };
    try {
      await fs.writeFile('/target', 'data');
      await fs.symlink('/target', '/link');
      expect(await persisted()).toBeDefined();
      expect(await fs.readlink('/link')).toBe('/target');
    } finally {
      await fs.dispose();
    }
  });

  it('N individual symlink calls still rewrite the sidecar N times', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const fs = await VirtualFS.create({
      dbName: 'symlink-batch-contrast',
      backend: 'opfs',
      wipe: true,
    });
    try {
      for (let i = 0; i < 5; i++) await fs.writeFile(`/c${i}`, 'x');
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      for (let i = 0; i < 5; i++) await fs.symlink(`/c${i}`, `/s${i}`);
      expect(flushSpy).toHaveBeenCalledTimes(5);
    } finally {
      await fs.dispose();
    }
  });

  it('refuses mount link paths before creating later members', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const fs = await VirtualFS.create({
      dbName: 'symlink-batch-mount-refuse',
      backend: 'opfs',
      wipe: true,
    });
    try {
      await fs.writeFile('/local', 'a');
      await fs.mount(
        '/mnt',
        LocalMountBackend.fromHandle(createDirectoryHandle({ file: 'mounted' }), {
          mountId: 'symlink-batch-mount',
        })
      );
      const flushSpy = vi.spyOn(
        fs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );
      await expect(
        fs.symlinkBatch([
          { target: '/local', path: '/ok-link' },
          { target: '/local', path: '/mnt/bad-link' },
        ])
      ).rejects.toMatchObject({ code: 'EINVAL' });
      expect(flushSpy).not.toHaveBeenCalled();
      expect(await fs.exists('/ok-link')).toBe(false);
    } finally {
      await fs.dispose();
    }
  });
});
