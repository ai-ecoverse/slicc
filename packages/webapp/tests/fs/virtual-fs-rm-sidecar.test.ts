import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * `rm` used to re-serialize the whole `/.metadata.json` sidecar per call:
 * `rm -rf` of a 7,000-file package (an `ipk` upgrade, a reinstall) took
 * 16 minutes in the browser. It now coalesces like chmod/utimes.
 */
describe('OPFS rm and the metadata sidecar', () => {
  async function opfs(dbName: string) {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const directory = await root.handle.getDirectoryHandle(dbName);
    const entries = async (): Promise<Record<string, unknown>> => {
      const file = await (await directory.getFileHandle('.metadata.json')).getFile();
      return JSON.parse(await file.text()).entries;
    };
    return { fs, entries };
  }

  it('does not rewrite the sidecar per rm; the coalesced flush drops the entries', async () => {
    const { fs, entries } = await opfs('rm-sidecar-coalesced');
    try {
      for (let i = 0; i < 20; i++) await fs.writeFile(`/pkg/f${i}`, 'x');
      await fs.flush();
      expect(Object.keys(await entries())).toContain('/pkg/f0');
      for (let i = 0; i < 20; i++) await fs.rm(`/pkg/f${i}`);
      // Not yet written back: no sidecar round trip per unlink.
      expect(Object.keys(await entries())).toContain('/pkg/f0');
      await fs.flush();
      const after = Object.keys(await entries());
      expect(after.filter((p) => p.startsWith('/pkg/f'))).toEqual([]);
      expect(await fs.exists('/pkg/f0')).toBe(false);
    } finally {
      await fs.dispose();
    }
  });

  it('a recursive rm is persisted by the deferred flush without an explicit one', async () => {
    const { fs, entries } = await opfs('rm-sidecar-deferred');
    try {
      for (let i = 0; i < 5; i++) await fs.writeFile(`/tree/sub/f${i}`, 'x');
      await fs.flush();
      await fs.rm('/tree', { recursive: true });
      await vi.waitFor(async () => {
        const after = Object.keys(await entries());
        expect(after.filter((p) => p.startsWith('/tree'))).toEqual([]);
      });
    } finally {
      await fs.dispose();
    }
  });
});
