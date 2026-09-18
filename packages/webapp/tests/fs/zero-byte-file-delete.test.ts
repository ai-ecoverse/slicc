import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { createMutableDirectoryHandle, type MutableDirectoryHandle } from './fsa-test-helpers.js';

let dbCounter = 0;

describe('zero-byte files on the OPFS backend (#2157)', () => {
  let opfs: MutableDirectoryHandle;
  let dbName: string;
  let fs: VirtualFS;

  beforeEach(async () => {
    opfs = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => opfs.handle },
    });
    dbName = `zero-byte-delete-${dbCounter++}`;
    fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    await fs.mkdir('/workspace/zbtest', { recursive: true });

    await fs.writeFile('/workspace/zbtest/empty.txt', '');
    await fs.writeFile('/workspace/zbtest/onebyte.txt', 'x');
  });

  afterEach(async () => {
    await fs.dispose();
    vi.unstubAllGlobals();
  });

  async function backingNames(vfsDir: string): Promise<string[]> {
    let dir = await opfs.handle.getDirectoryHandle(dbName);
    for (const segment of vfsDir.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment);
    }
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    return names.sort();
  }

  it('materializes a 0-byte file on the backing store, like a 1-byte one', async () => {
    expect(await backingNames('/workspace/zbtest')).toEqual(['empty.txt', 'onebyte.txt']);
    expect(await fs.stat('/workspace/zbtest/empty.txt')).toMatchObject({
      type: 'file',
      size: 0,
    });
  });

  it('rm removes a 0-byte file without a spurious ENOENT', async () => {
    await expect(fs.rm('/workspace/zbtest/empty.txt')).resolves.toBeUndefined();
    expect(await fs.exists('/workspace/zbtest/empty.txt')).toBe(false);
    expect(await backingNames('/workspace/zbtest')).toEqual(['onebyte.txt']);

    await fs.rm('/workspace/zbtest/onebyte.txt');
    expect(await backingNames('/workspace/zbtest')).toEqual([]);
  });

  it('a recursive rm clears a directory holding both an empty and a non-empty file', async () => {
    await fs.rm('/workspace/zbtest', { recursive: true });
    expect(await fs.exists('/workspace/zbtest')).toBe(false);
    expect(await backingNames('/workspace')).toEqual([]);
  });

  it('removes an index entry whose backing file is already gone (phantom deletion)', async () => {
    opfs.removeEntry(`${dbName}/workspace/zbtest/onebyte.txt`);
    expect(await fs.exists('/workspace/zbtest/onebyte.txt')).toBe(true);
    await expect(fs.rm('/workspace/zbtest/onebyte.txt')).resolves.toBeUndefined();
    expect(await fs.exists('/workspace/zbtest/onebyte.txt')).toBe(false);
  });

  it('leaves no index entry behind when the backing store refuses the create', async () => {
    const proto = Object.getPrototypeOf(await opfs.handle.getDirectoryHandle(dbName)) as {
      getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
    };
    const original = proto.getFileHandle;
    proto.getFileHandle = async function refusing(name, opts) {
      if (name === 'refused.txt') throw new DOMException('quota exceeded', 'QuotaExceededError');
      return original.call(this, name, opts);
    };
    try {
      await expect(fs.writeFile('/workspace/zbtest/refused.txt', '')).rejects.toThrow();
      expect(await fs.exists('/workspace/zbtest/refused.txt')).toBe(false);
      expect(await backingNames('/workspace/zbtest')).toEqual(['empty.txt', 'onebyte.txt']);
    } finally {
      proto.getFileHandle = original;
    }

    await fs.writeFile('/workspace/zbtest/refused.txt', '');
    expect(await backingNames('/workspace/zbtest')).toContain('refused.txt');
  });

  it('a genuinely missing path still reports ENOENT', async () => {
    await expect(fs.rm('/workspace/zbtest/never-existed.txt')).rejects.toThrow(/ENOENT/);
  });

  describe('through the shell', () => {
    let shell: AlmostBashShellHeadless;

    beforeEach(() => {
      shell = new AlmostBashShellHeadless({ fs });
    });

    it.each([
      ['rm', 'rm /workspace/zbtest/empty.txt'],
      ['rm -f', 'rm -f /workspace/zbtest/empty.txt'],
    ])('%s deletes a 0-byte file and exits 0', async (_label, command) => {
      const result = await shell.executeCommand(command);
      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await fs.exists('/workspace/zbtest/empty.txt')).toBe(false);
    });

    it('rm -rf removes a directory containing a 0-byte file', async () => {
      const result = await shell.executeCommand('rm -rf /workspace/zbtest');
      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await fs.exists('/workspace/zbtest')).toBe(false);
    });
  });
});

describe('@zenfs/dom zero-byte materialization protections (#2157)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('uses upstream _create while retaining the missing-entry removal patch', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(src).toContain('async _create(path, inode)');
    expect(src).not.toContain('async createFile(path, options)');
    expect(
      src.includes('PATCH(#2157)'),
      'Installed @zenfs/dom no longer tolerates an absent OPFS entry in remove; ' +
        'patches/@zenfs+dom+*.patch is missing or failed to apply. Phantom ' +
        'files then become undeletable again — see patches/README.md.'
    ).toBe(true);
  });
});
