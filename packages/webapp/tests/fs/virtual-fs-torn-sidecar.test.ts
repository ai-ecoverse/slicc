import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle, type MutableDirectoryHandle } from './fsa-test-helpers.js';

const SIDECAR = '.metadata.json';

let opfs: MutableDirectoryHandle;

function installOpfsStub(handle: FileSystemDirectoryHandle): void {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async (): Promise<FileSystemDirectoryHandle> => handle,
    },
  });
}

async function sidecarHandle(dbName: string, create = false): Promise<FileSystemFileHandle> {
  const dir = await opfs.handle.getDirectoryHandle(dbName);
  return dir.getFileHandle(SIDECAR, { create });
}

async function readSidecar(dbName: string): Promise<string> {
  return (await (await sidecarHandle(dbName)).getFile()).text();
}

async function writeSidecar(dbName: string, text: string): Promise<void> {
  const writable = await (await sidecarHandle(dbName, true)).createWritable();
  await writable.write(text);
  await writable.close();
}

function failSidecarReads(
  budget: number,
  errName = 'NotReadableError'
): { attempts: () => number } {
  let attempts = 0;
  const wrapDir = (dir: FileSystemDirectoryHandle): FileSystemDirectoryHandle =>
    ({
      ...dir,
      kind: 'directory',
      name: dir.name,
      getDirectoryHandle: (...a: Parameters<FileSystemDirectoryHandle['getDirectoryHandle']>) =>
        dir.getDirectoryHandle(...a),
      removeEntry: (...a: Parameters<FileSystemDirectoryHandle['removeEntry']>) =>
        dir.removeEntry(...a),
      keys: () => dir.keys(),
      values: () => dir.values(),
      entries: () => dir.entries(),
      async getFileHandle(
        name: string,
        opts?: FileSystemGetFileOptions
      ): Promise<FileSystemFileHandle> {
        const real = await dir.getFileHandle(name, opts);
        if (name !== SIDECAR) return real;
        return {
          ...real,
          kind: 'file',
          name: real.name,
          createWritable: (...a: Parameters<FileSystemFileHandle['createWritable']>) =>
            real.createWritable(...a),
          async getFile(): Promise<File> {
            attempts += 1;
            if (attempts <= budget) throw new DOMException('snapshot invalidated', errName);
            return real.getFile();
          },
        } as unknown as FileSystemFileHandle;
      },
    }) as unknown as FileSystemDirectoryHandle;

  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async (): Promise<FileSystemDirectoryHandle> =>
        ({
          ...opfs.handle,
          kind: 'directory',
          name: opfs.handle.name,
          getFileHandle: (...a: Parameters<FileSystemDirectoryHandle['getFileHandle']>) =>
            opfs.handle.getFileHandle(...a),
          removeEntry: (...a: Parameters<FileSystemDirectoryHandle['removeEntry']>) =>
            opfs.handle.removeEntry(...a),
          async getDirectoryHandle(
            name: string,
            opts?: FileSystemGetDirectoryOptions
          ): Promise<FileSystemDirectoryHandle> {
            return wrapDir(await opfs.handle.getDirectoryHandle(name, opts));
          },
        }) as unknown as FileSystemDirectoryHandle,
    },
  });
  return { attempts: () => attempts };
}

describe('VirtualFS — unparseable OPFS metadata sidecar is reseeded, not honored', () => {
  beforeEach(() => {
    opfs = createMutableDirectoryHandle({});
    installOpfsStub(opfs.handle);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts after a torn write and keeps the file content that was already on disk', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-torn-sidecar';

    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.writeFile('/survivor.txt', 'still here');
    await first.dispose();

    const intact = await readSidecar(DB);
    expect(intact.length).toBeGreaterThan(47);
    await writeSidecar(DB, intact.slice(0, 47));

    const second = await VirtualFS.create({ dbName: DB, backend: 'opfs' });
    expect(await second.readTextFile('/survivor.txt')).toBe('still here');

    const reseeded: unknown = JSON.parse(await readSidecar(DB));
    expect((reseeded as { entries?: unknown }).entries).toBeTypeOf('object');
    await second.dispose();
  });

  it('reseeds an empty sidecar file', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-empty-sidecar';
    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.dispose();
    await writeSidecar(DB, '');

    const second = await VirtualFS.create({ dbName: DB, backend: 'opfs' });
    await second.writeFile('/after.txt', 'ok');
    expect(await second.readTextFile('/after.txt')).toBe('ok');
    await second.dispose();
  });

  it('retries an invalidated snapshot instead of reseeding over intact metadata', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-invalidated-snapshot';
    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.writeFile('/kept.txt', 'kept');
    await first.dispose();
    const before = await readSidecar(DB);

    const reads = failSidecarReads(1);
    const second = await VirtualFS.create({ dbName: DB, backend: 'opfs' });

    expect(reads.attempts()).toBeGreaterThanOrEqual(2);
    expect(await readSidecar(DB)).toBe(before);
    await second.dispose();
  });

  it('propagates a persistent read failure rather than reseeding on unknown bytes', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-unreadable-sidecar';
    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.writeFile('/kept.txt', 'kept');
    await first.dispose();
    const before = await readSidecar(DB);

    failSidecarReads(Number.POSITIVE_INFINITY);
    await expect(VirtualFS.create({ dbName: DB, backend: 'opfs' })).rejects.toThrow();

    installOpfsStub(opfs.handle);
    expect(await readSidecar(DB)).toBe(before);
    const third = await VirtualFS.create({ dbName: DB, backend: 'opfs' });
    expect(await third.readTextFile('/kept.txt')).toBe('kept');
    await third.dispose();
  });

  it('propagates a non-NotReadableError read failure without retrying', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-denied-sidecar';
    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.dispose();

    const reads = failSidecarReads(Number.POSITIVE_INFINITY, 'NotAllowedError');
    await expect(VirtualFS.create({ dbName: DB, backend: 'opfs' })).rejects.toThrow();
    expect(reads.attempts()).toBe(1);
  });

  it('leaves a parseable sidecar untouched so persisted metadata survives', async () => {
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const DB = 'slicc-fs-intact-sidecar';
    const first = await VirtualFS.create({ dbName: DB, backend: 'opfs', wipe: true });
    await first.writeFile('/kept.txt', 'kept');
    await first.dispose();

    const before = await readSidecar(DB);
    const second = await VirtualFS.create({ dbName: DB, backend: 'opfs' });
    expect(await readSidecar(DB)).toBe(before);
    await second.dispose();
  });
});
