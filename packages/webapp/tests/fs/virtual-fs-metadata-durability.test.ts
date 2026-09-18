import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('OPFS metadata durability', () => {
  it('persists each metadata change before any explicit flush or dispose', async () => {
    const root = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
    const dbName = 'metadata-immediate-durability';
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
});
