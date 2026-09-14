import { describe, expect, it } from 'vitest';
import { FsError } from '../../../src/fs/types.js';
import {
  deleteInstalledPlugin,
  PLUGINS_STORE_PATH,
  readPluginsFile,
  setInstalledPlugin,
} from '../../../src/shell/plugins/store.js';
import type { InstalledPluginEntry } from '../../../src/shell/plugins/types.js';

const SAMPLE: InstalledPluginEntry = {
  root: '/workspace/.plugins/sources/reports-plugin',
  version: '1.2.0',
  installedAt: '2026-05-20T00:00:00.000Z',
};

function faultingPluginsFs(code: 'ENOENT' | 'EIO' | 'EACCES') {
  const writes: string[] = [];
  return {
    writes,
    fs: {
      async readFile(): Promise<string> {
        throw new FsError(code, `${code} reading plugins registry`, PLUGINS_STORE_PATH);
      },
      async writeFile(_path: string, content: string | Uint8Array): Promise<void> {
        writes.push(typeof content === 'string' ? content : 'binary');
      },
      async mkdir(): Promise<void> {},
    },
  };
}

describe('plugins store read-modify-write faults', () => {
  it('readPluginsFile treats ENOENT as empty and does not write', async () => {
    const { fs, writes } = faultingPluginsFs('ENOENT');
    await expect(readPluginsFile(fs)).resolves.toEqual({ version: 1, plugins: {} });
    expect(writes).toEqual([]);
  });

  it('readPluginsFile treats invalid JSON as empty', async () => {
    const writes: string[] = [];
    const fs = {
      async readFile(): Promise<string> {
        return 'not json at all';
      },
      async writeFile(_path: string, content: string | Uint8Array): Promise<void> {
        writes.push(typeof content === 'string' ? content : 'binary');
      },
      async mkdir(): Promise<void> {},
    };
    await expect(readPluginsFile(fs)).resolves.toEqual({ version: 1, plugins: {} });
    expect(writes).toEqual([]);
  });

  it('setInstalledPlugin from ENOENT writes the new entry onto an empty registry', async () => {
    const { fs, writes } = faultingPluginsFs('ENOENT');
    await setInstalledPlugin('reports-plugin', SAMPLE, fs);
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]) as {
      plugins: Record<string, InstalledPluginEntry>;
    };
    expect(payload.plugins['reports-plugin'].root).toBe(SAMPLE.root);
  });

  it('setInstalledPlugin propagates a non-ENOENT FsError and does not truncate the registry', async () => {
    const { fs, writes } = faultingPluginsFs('EIO');
    await expect(setInstalledPlugin('reports-plugin', SAMPLE, fs)).rejects.toThrow(
      'EIO reading plugins registry'
    );
    expect(writes).toEqual([]);
  });

  it('deleteInstalledPlugin propagates a non-ENOENT FsError and does not truncate the registry', async () => {
    const { fs, writes } = faultingPluginsFs('EACCES');
    await expect(deleteInstalledPlugin('reports-plugin', fs)).rejects.toThrow(
      'EACCES reading plugins registry'
    );
    expect(writes).toEqual([]);
  });
});
