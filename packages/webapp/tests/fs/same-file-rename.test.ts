/**
 * Same-inode rename on a hostfs-like mount must be a POSIX no-op (#3107).
 *
 * The fake backend folds lookup by case + NFC so `Slicc.md` / `SLICC.md` and
 * NFD / NFC share one inode, matching APFS via hostfs. VirtualFS must not
 * call backend.rename (which would rewrite the catalog name) and must not
 * copy+write dest (O_TRUNC of the only copy).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from '../../src/fs/mount/backend.js';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

let dbCounter = 0;

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

class CaseFoldHostfs implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///fake-kb';
  readonly mountId = 'fake-kb';
  readonly renameCalls: Array<[string, string]> = [];
  readonly writeCalls: string[] = [];
  private nextIno = 100;
  private readonly files = new Map<
    string,
    { storedName: string; bytes: Uint8Array; ino: number }
  >();

  put(name: string, body: string): void {
    const key = fold(name);
    const existing = this.files.get(key);
    const bytes = new TextEncoder().encode(body);
    if (existing) {
      existing.bytes = bytes;
      return;
    }
    this.files.set(key, { storedName: name, bytes, ino: this.nextIno++ });
  }

  private lookup(path: string) {
    return this.files.get(fold(path.replace(/^\/+/, '')));
  }

  async readDir(): Promise<MountDirEntry[]> {
    return [...this.files.values()].map((e) => ({
      name: e.storedName,
      kind: 'file' as const,
      size: e.bytes.byteLength,
      ino: e.ino,
    }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.lookup(path);
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return entry.bytes.slice();
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.writeCalls.push(path);
    const key = fold(path.replace(/^\/+/, ''));
    const existing = this.files.get(key);
    if (existing) {
      existing.bytes = body.slice();
      return;
    }
    this.files.set(key, {
      storedName: path.replace(/^\/+/, ''),
      bytes: body.slice(),
      ino: this.nextIno++,
    });
  }

  async stat(path: string): Promise<MountStat> {
    const entry = this.lookup(path);
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return { kind: 'file', size: entry.bytes.byteLength, mtime: 1, ino: entry.ino };
  }

  async mkdir(): Promise<void> {}

  async remove(path: string): Promise<void> {
    this.files.delete(fold(path.replace(/^\/+/, '')));
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    this.renameCalls.push([fromPath, toPath]);
    const src = this.lookup(fromPath);
    if (!src) throw new FsError('ENOENT', 'no such file', fromPath);
    const dest = this.lookup(toPath);
    if (dest && dest.ino === src.ino) return;
    this.files.delete(fold(fromPath.replace(/^\/+/, '')));
    src.storedName = toPath.replace(/^\/+/, '');
    this.files.set(fold(src.storedName), src);
  }

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'fake-kb' };
  }

  async close(): Promise<void> {}

  getHostPath(): string {
    return '/fake-kb';
  }
}

describe('same-inode rename on a case-/NFC-insensitive mount (#3107)', () => {
  let vfs: VirtualFS;
  let backend: CaseFoldHostfs;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `same-file-rename-${dbCounter++}`,
      wipe: true,
    });
    backend = new CaseFoldHostfs();
    await vfs.mkdir('/mnt/kb', { recursive: true });
    await vfs.mount('/mnt/kb', backend);
  });

  it('case-only rename is a no-op: bytes survive, readdir name unchanged', async () => {
    backend.put('Slicc.md', 'hello-case');
    await vfs.rename('/mnt/kb/Slicc.md', '/mnt/kb/SLICC.md');
    expect(backend.renameCalls).toEqual([]);
    expect(backend.writeCalls).toEqual([]);
    const names = (await vfs.readDir('/mnt/kb')).map((e) => e.name);
    expect(names).toEqual(['Slicc.md']);
    expect(await vfs.readTextFile('/mnt/kb/Slicc.md')).toBe('hello-case');
    expect(await vfs.readTextFile('/mnt/kb/SLICC.md')).toBe('hello-case');
  });

  it('NFD→NFC rename is a no-op: bytes survive, readdir name unchanged', async () => {
    const nfd = `Groeger-Familie${'o\u0308'}.md`;
    const nfc = `Groeger-Familie${'\u00f6'}.md`;
    backend.put(nfd, 'hello-nfc');
    await vfs.rename(`/mnt/kb/${nfd}`, `/mnt/kb/${nfc}`);
    expect(backend.renameCalls).toEqual([]);
    const names = (await vfs.readDir('/mnt/kb')).map((e) => e.name);
    expect(names).toEqual([nfd]);
    expect(await vfs.readTextFile(`/mnt/kb/${nfd}`)).toBe('hello-nfc');
  });

  it('copyFile of a case-equal dest does not O_TRUNC the only copy', async () => {
    backend.put('Slicc.md', 'keep-me');
    await vfs.copyFile('/mnt/kb/Slicc.md', '/mnt/kb/SLICC.md');
    expect(backend.writeCalls).toEqual([]);
    expect(await vfs.readTextFile('/mnt/kb/Slicc.md')).toBe('keep-me');
  });

  it('distinct names still rename', async () => {
    backend.put('from.txt', 'moved');
    await vfs.rename('/mnt/kb/from.txt', '/mnt/kb/to.txt');
    expect(backend.renameCalls).toEqual([['from.txt', 'to.txt']]);
    const names = (await vfs.readDir('/mnt/kb')).map((e) => e.name);
    expect(names).toEqual(['to.txt']);
    expect(await vfs.readTextFile('/mnt/kb/to.txt')).toBe('moved');
  });
});
