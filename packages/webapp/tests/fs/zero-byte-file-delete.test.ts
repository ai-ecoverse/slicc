/**
 * Regression suite for #2157 — a zero-byte file under `/workspace` could not
 * be deleted.
 *
 * ZenFS' VFS layer only calls the backend's `write` for dirty BYTE ranges, and
 * an empty file has none: `IndexFS.createFile` put an inode in the index and
 * `WebAccessFS` never created the `FileSystemFileHandle`. `stat`/`exists` then
 * answered from the index (the file looked real) while `unlink` raised
 * `ENOENT: … unlink '<path>'` from `removeEntry`, so:
 *
 *   - `rm f`      exited 1 and the file survived,
 *   - `rm -f f`   exited 0 with no stderr (POSIX suppression) and the file
 *                 survived — a cleanup step reporting success while deleting
 *                 nothing,
 *   - `rm -rf d/` left the directory AND the empty file behind, exit 0.
 *
 * A 1-byte file in the same directory always deleted correctly, which is what
 * isolated the trigger to size 0 — every assertion below carries that control.
 *
 * Two patches to `@zenfs/dom` close it (see patches/README.md):
 *   1. `createFile` materializes the OPFS handle, so every file the index
 *      knows about also exists on the backing store.
 *   2. `remove` tolerates an already-absent OPFS entry — the index is
 *      authoritative there, so an entry it knows but OPFS does not is
 *      otherwise undeletable forever (the phantom-deletion class: files
 *      written before fix 1, and sidecar entries whose bytes are gone).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { createMutableDirectoryHandle, type MutableDirectoryHandle } from './fsa-test-helpers.js';

// Each case gets its own dbName: same-dbName instances share one resolved
// WebAccessFS (and therefore one index), so reusing a name would leak state.
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
    // The four ways of producing an empty file all land here: `: > f`,
    // `touch f`, `printf '' > f` and `writeFileSync(p, '')`.
    await fs.writeFile('/workspace/zbtest/empty.txt', '');
    await fs.writeFile('/workspace/zbtest/onebyte.txt', 'x'); // control
  });

  afterEach(async () => {
    await fs.dispose();
    vi.unstubAllGlobals();
  });

  /**
   * Names in the REAL backing store under a VFS directory — `acquireOpfsHandle`
   * roots each instance at a `<dbName>/` subdirectory of the OPFS root. Reading
   * the store directly (rather than through the VFS) is the whole point: the
   * defect was an index entry with nothing behind it.
   */
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
    // The defect was here: only `onebyte.txt` reached OPFS, so `empty.txt`
    // existed in the index and nowhere else.
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

    await fs.rm('/workspace/zbtest/onebyte.txt'); // control
    expect(await backingNames('/workspace/zbtest')).toEqual([]);
  });

  it('a recursive rm clears a directory holding both an empty and a non-empty file', async () => {
    // The partial-deletion variant: the non-empty file went, the empty one and
    // its directory stayed, and the caller saw success.
    await fs.rm('/workspace/zbtest', { recursive: true });
    expect(await fs.exists('/workspace/zbtest')).toBe(false);
    expect(await backingNames('/workspace')).toEqual([]);
  });

  it('removes an index entry whose backing file is already gone (phantom deletion)', async () => {
    // Models a file written before the `createFile` fix, or a sidecar entry
    // whose OPFS counterpart vanished: the index knows the path, the backing
    // store does not. Every `unlink` used to raise ENOENT, and because ZenFS
    // evicts the vnode only after a SUCCESSFUL unlink, the entry came back.
    opfs.removeEntry(`${dbName}/workspace/zbtest/onebyte.txt`);
    expect(await fs.exists('/workspace/zbtest/onebyte.txt')).toBe(true);
    await expect(fs.rm('/workspace/zbtest/onebyte.txt')).resolves.toBeUndefined();
    expect(await fs.exists('/workspace/zbtest/onebyte.txt')).toBe(false);
  });

  it('leaves no index entry behind when the backing store refuses the create', async () => {
    // The mirror image of the bug: `createFile` inserts the inode first, so a
    // failing `getFileHandle` (quota, permission) must not leave the index
    // claiming a file the store never got — that is the same divergence, just
    // reached from the other side. Patched on the mock's prototype because
    // ZenFS caches its own handle instances; a wrapper we hand back here would
    // never be the object it calls.
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
    // The rolled-back path is still usable — the failure left no EEXIST tombstone.
    await fs.writeFile('/workspace/zbtest/refused.txt', '');
    expect(await backingNames('/workspace/zbtest')).toContain('refused.txt');
  });

  it('a genuinely missing path still reports ENOENT', async () => {
    // The `remove` tolerance must not turn a real miss into silent success —
    // `IndexFS` is the gate, and it still rejects an unknown path.
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

    // `mv` is deliberately NOT asserted here. #2157 also reported a failing
    // `mv` on a 0-byte file, but `rename` over this backend fails for a 1-byte
    // file too — ZenFS' Async mixin mirrors each op onto an InMemory sync cache
    // that is only populated once `ready()` has run, and `renameSync` against
    // the empty cache raises "no such file or directory (Out of sync!)". That
    // is size-independent, so it is a separate defect rather than part of the
    // zero-byte asymmetry, and asserting it here would couple this suite to a
    // fix that does not belong in it.
  });
});

describe('@zenfs/dom zero-byte materialization patch (#2157)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('the patch is present in the installed dist', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(
      src.includes('PATCH(#2157)'),
      'Installed @zenfs/dom no longer materializes a file handle in ' +
        'createFile / no longer tolerates an absent OPFS entry in remove; ' +
        'patches/@zenfs+dom+*.patch is missing or failed to apply. Zero-byte ' +
        'files then become undeletable again — see patches/README.md.'
    ).toBe(true);
    expect(src).toContain('async createFile(path, options)');
  });
});
