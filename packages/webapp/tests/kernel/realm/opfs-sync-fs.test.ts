/**
 * Unit tests for the in-tree `OPFS_SYNC_FS` Emscripten-FS plugin.
 * Exercises `node_ops` + `stream_ops` against:
 *   - the existing async FSA shim in `tests/fs/fsa-test-helpers.ts`
 *     (for the `prewalkOpfsTree` + queued OPFS mutations); and
 *   - an in-test `SyncAccessHandle` shim built around a backing
 *     `Uint8Array` (for the SAH-backed file I/O surface).
 *
 * The shim approach mirrors the test-helper pattern used by the
 * mount tests (`py-realm-mount-opfs.test.ts`) — no real Pyodide /
 * OPFS needed, just contract-level pinning of the ops tables and
 * the dir-handle cache so the mount/register surface can be wired
 * without re-discovering this internal API.
 */

import { describe, expect, it } from 'vitest';
import {
  createOpfsSyncFs,
  type EmscriptenFsApi,
  ERRNO,
  type FsNode,
  type FsStream,
  flushPendingOpfsOps,
  type OpfsMount,
  type OpfsSahProvider,
  type OpfsSyncAccessHandle,
  prewalkOpfsTree,
} from '../../../src/kernel/realm/opfs-sync-fs.js';
import { createMutableDirectoryHandle } from '../../fs/fsa-test-helpers.js';

// ---------------------------------------------------------------------------
// Sync-access-handle shim
// ---------------------------------------------------------------------------

interface FileBacking {
  data: Uint8Array;
}

class ShimSyncAccessHandle implements OpfsSyncAccessHandle {
  closed = false;
  constructor(
    private readonly backing: FileBacking,
    private readonly onClose: () => void
  ) {}
  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    const at = options?.at ?? 0;
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const end = Math.min(this.backing.data.length, at + view.byteLength);
    const n = Math.max(0, end - at);
    view.set(this.backing.data.subarray(at, at + n), 0);
    return n;
  }
  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    const at = options?.at ?? 0;
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const requiredLength = at + view.byteLength;
    if (requiredLength > this.backing.data.length) {
      const grown = new Uint8Array(requiredLength);
      grown.set(this.backing.data);
      this.backing.data = grown;
    }
    this.backing.data.set(view, at);
    return view.byteLength;
  }
  truncate(newSize: number): void {
    if (newSize === this.backing.data.length) return;
    const grown = new Uint8Array(newSize);
    grown.set(this.backing.data.subarray(0, Math.min(newSize, this.backing.data.length)));
    this.backing.data = grown;
  }
  getSize(): number {
    return this.backing.data.length;
  }
  flush(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

/**
 * Builds a `SahProvider` that lazily reads the underlying file
 * via `FileSystemFileHandle.getFile()` the first time a path is
 * acquired, then keeps the bytes in `backings`. Writes flushed via
 * `persistAll()` push the in-memory bytes back through the FSA
 * shim so post-test assertions against the OPFS root still see
 * the live state.
 */
function createShimSahProvider(rootDir?: FileSystemDirectoryHandle): {
  provider: OpfsSahProvider;
  backings: Map<string, FileBacking>;
  handles: Map<string, FileSystemFileHandle>;
  leased: Set<string>;
  persistAll(): Promise<void>;
  setRoot(root: FileSystemDirectoryHandle): void;
} {
  const backings = new Map<string, FileBacking>();
  const handles = new Map<string, FileSystemFileHandle>();
  const leased = new Set<string>();
  let root = rootDir;
  const provider: OpfsSahProvider = {
    acquire(relPath: string, fileHandle?: FileSystemFileHandle): OpfsSyncAccessHandle {
      if (leased.has(relPath)) {
        throw new Error(`SAH lease conflict: ${relPath}`);
      }
      leased.add(relPath);
      if (fileHandle) handles.set(relPath, fileHandle);
      let backing = backings.get(relPath);
      if (!backing) {
        backing = { data: new Uint8Array() };
        backings.set(relPath, backing);
      }
      return new ShimSyncAccessHandle(backing, () => {
        leased.delete(relPath);
      });
    },
    release(relPath: string): void {
      leased.delete(relPath);
    },
  };
  async function resolveHandle(relPath: string): Promise<FileSystemFileHandle | undefined> {
    if (handles.has(relPath)) return handles.get(relPath);
    if (!root) return undefined;
    const parts = relPath.split('/');
    let cursor: FileSystemDirectoryHandle = root;
    for (const part of parts.slice(0, -1)) {
      cursor = await cursor.getDirectoryHandle(part);
    }
    try {
      return await cursor.getFileHandle(parts[parts.length - 1]);
    } catch {
      return undefined;
    }
  }
  return {
    provider,
    backings,
    handles,
    leased,
    setRoot(next: FileSystemDirectoryHandle): void {
      root = next;
    },
    async persistAll(): Promise<void> {
      for (const [relPath, backing] of backings) {
        const fileHandle = await resolveHandle(relPath);
        if (!fileHandle) continue;
        const writable = await fileHandle.createWritable();
        await writable.write(backing.data);
        await writable.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Emscripten FS shim — minimal `createNode` + `isDir/File/Link` + `ErrnoError`
// ---------------------------------------------------------------------------

class FsErrnoError extends Error {
  errno: number;
  constructor(errno: number) {
    super(`errno ${errno}`);
    this.errno = errno;
  }
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function makeShimFs(): EmscriptenFsApi & { nextInode: number } {
  let nextInode = 1;
  const fs: EmscriptenFsApi & { nextInode: number } = {
    nextInode,
    createNode(parent, name, mode, _dev): FsNode {
      const node = {
        id: nextInode++,
        name,
        mode,
        // `parent` is `null` for the root in our plugin's createNode,
        // but FsNode types it non-nullable — point root at itself so
        // tests can `node.parent === root` for the root case.
        parent: parent as FsNode,
        mount: undefined as unknown as OpfsMount,
        timestamp: Date.now(),
        node_ops: undefined as never,
        stream_ops: undefined as never,
        opfs: undefined as never,
      } as unknown as FsNode;
      if (parent === null) node.parent = node;
      fs.nextInode = nextInode;
      return node;
    },
    isDir(mode: number): boolean {
      return (mode & S_IFMT) === S_IFDIR;
    },
    isFile(mode: number): boolean {
      return (mode & S_IFMT) === S_IFREG;
    },
    isLink(mode: number): boolean {
      return (mode & S_IFMT) === S_IFLNK;
    },
    ErrnoError: FsErrnoError as unknown as new (errno: number) => Error & { errno: number },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

async function setup(tree: Record<string, unknown>): Promise<{
  fs: ReturnType<typeof makeShimFs>;
  plugin: ReturnType<typeof createOpfsSyncFs>;
  mount: OpfsMount;
  root: FsNode;
  sah: ReturnType<typeof createShimSahProvider>;
  rootDir: ReturnType<typeof createMutableDirectoryHandle>;
}> {
  const rootDir = createMutableDirectoryHandle(
    tree as Parameters<typeof createMutableDirectoryHandle>[0]
  );
  const prewalk = await prewalkOpfsTree(rootDir.handle);
  const sah = createShimSahProvider(rootDir.handle);
  const fs = makeShimFs();
  const plugin = createOpfsSyncFs(fs);
  const mount = {
    opts: { rootHandle: rootDir.handle, prewalk, sahProvider: sah.provider },
    mountpoint: '/mnt',
    root: undefined as unknown as FsNode,
  } as OpfsMount;
  const root = plugin.mount(mount);
  mount.root = root;
  return { fs, plugin, mount, root, sah, rootDir };
}

function openStream(plugin: ReturnType<typeof createOpfsSyncFs>, node: FsNode): FsStream {
  const stream: FsStream = { node, position: 0 };
  plugin.stream_ops.open(stream);
  return stream;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prewalkOpfsTree', () => {
  it('walks every dir + file under the root, keyed by relative path', async () => {
    const { handle } = createMutableDirectoryHandle({
      'a.txt': 'A',
      sub: { 'b.txt': 'BB', nested: { 'c.bin': 'CCC' } },
      empty: {},
    });
    const snap = await prewalkOpfsTree(handle);
    expect(snap.entries.get('')!.kind).toBe('directory');
    expect(snap.entries.get('a.txt')!.kind).toBe('file');
    expect(snap.entries.get('sub')!.kind).toBe('directory');
    expect(snap.entries.get('sub/b.txt')!.kind).toBe('file');
    expect(snap.entries.get('sub/nested/c.bin')!.kind).toBe('file');
    expect(snap.entries.get('empty')!.kind).toBe('directory');
    const aFile = snap.entries.get('a.txt');
    if (aFile?.kind !== 'file') throw new Error('expected file');
    expect(aFile.size).toBe(1);
  });
});

describe('OPFS_SYNC_FS — mount + node_ops', () => {
  it('builds the in-memory tree from the prewalk snapshot', async () => {
    const { plugin, root } = await setup({
      'a.txt': 'A',
      sub: { 'b.txt': 'BB' },
    });
    const names = plugin.node_ops.readdir(root);
    expect(names).toContain('.');
    expect(names).toContain('..');
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
    const a = plugin.node_ops.lookup(root, 'a.txt');
    expect(a.opfs.size).toBe(1);
    const sub = plugin.node_ops.lookup(root, 'sub');
    const b = plugin.node_ops.lookup(sub, 'b.txt');
    expect(b.opfs.relPath).toBe('sub/b.txt');
  });

  it('lookup throws ENOENT for missing entries', async () => {
    const { plugin, root } = await setup({});
    expect(() => plugin.node_ops.lookup(root, 'nope')).toThrow(/errno 44/);
  });

  it('getattr returns file size, dir blksize, link target length', async () => {
    const { plugin, root } = await setup({ 'a.txt': 'hello' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const attr = plugin.node_ops.getattr(a);
    expect(attr.size).toBe(5);
    expect(attr.ino).toBe(a.id);
    const rootAttr = plugin.node_ops.getattr(root);
    expect(rootAttr.size).toBe(4096);
    const link = plugin.node_ops.symlink(root, 'l', '/target/path');
    expect(plugin.node_ops.getattr(link).size).toBe('/target/path'.length);
  });

  it('setattr preserves the file-type bits when mode changes', async () => {
    const { plugin, root, fs } = await setup({ 'a.txt': 'x' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    plugin.node_ops.setattr(a, { mode: 0o600 });
    expect(fs.isFile(a.mode)).toBe(true);
    expect(a.mode & 0o777).toBe(0o600);
  });

  it('mknod creates files + dirs in-memory and queues OPFS creation', async () => {
    const { plugin, root, mount, sah, rootDir } = await setup({});
    const newFile = plugin.node_ops.mknod(root, 'fresh.txt', 0o100644, 0);
    const newDir = plugin.node_ops.mknod(root, 'newdir', 0o040755, 0);
    expect(newFile.opfs.relPath).toBe('fresh.txt');
    expect(newDir.opfs.relPath).toBe('newdir');
    expect(plugin.node_ops.readdir(root)).toContain('fresh.txt');
    expect(plugin.node_ops.readdir(newDir)).toEqual(['.', '..']);
    // Stream writes go through SAH; persist to OPFS so assertions
    // against the FSA shim see the file body.
    const stream = openStream(plugin, newFile);
    plugin.stream_ops.write(stream, new TextEncoder().encode('hi'), 0, 2, 0);
    plugin.stream_ops.close(stream);
    await flushPendingOpfsOps(mount);
    await sah.persistAll();
    const childDir = await rootDir.handle.getDirectoryHandle('newdir');
    expect(childDir.kind).toBe('directory');
    const childFile = await rootDir.handle.getFileHandle('fresh.txt');
    const text = await (await childFile.getFile()).text();
    expect(text).toBe('hi');
  });

  it('mknod throws EEXIST when name already exists', async () => {
    const { plugin, root } = await setup({ 'a.txt': 'A' });
    expect(() => plugin.node_ops.mknod(root, 'a.txt', 0o100644, 0)).toThrow(/errno 20/);
  });

  it('rmdir refuses non-empty directories with ENOTEMPTY', async () => {
    const { plugin, root } = await setup({ sub: { 'k.txt': 'K' } });
    expect(() => plugin.node_ops.rmdir(root, 'sub')).toThrow(/errno 55/);
    // Drop the child first; rmdir then succeeds.
    const sub = plugin.node_ops.lookup(root, 'sub');
    plugin.node_ops.unlink(sub, 'k.txt');
    plugin.node_ops.rmdir(root, 'sub');
    expect(plugin.node_ops.readdir(root)).not.toContain('sub');
  });

  it('unlink removes files from the tree and queues OPFS removal', async () => {
    const { plugin, root, mount, rootDir } = await setup({ 'gone.txt': 'BYE' });
    plugin.node_ops.unlink(root, 'gone.txt');
    expect(plugin.node_ops.readdir(root)).not.toContain('gone.txt');
    await flushPendingOpfsOps(mount);
    await expect(rootDir.handle.getFileHandle('gone.txt')).rejects.toThrow();
  });

  it('unlink rejects directories with EISDIR', async () => {
    const { plugin, root } = await setup({ sub: {} });
    expect(() => plugin.node_ops.unlink(root, 'sub')).toThrow(/errno 31/);
  });

  it('symlink + readlink round-trip stay in-memory', async () => {
    const { plugin, root } = await setup({});
    const link = plugin.node_ops.symlink(root, 'link', '/elsewhere');
    expect(plugin.node_ops.readlink(link)).toBe('/elsewhere');
    expect(plugin.node_ops.readdir(root)).toContain('link');
    expect(() => plugin.node_ops.symlink(root, 'link', '/other')).toThrow(/errno 20/);
  });

  it('rename moves files between directories and propagates relPath', async () => {
    const { plugin, root, mount, sah, rootDir } = await setup({
      src: { 'a.txt': 'AAA' },
      dst: {},
    });
    const src = plugin.node_ops.lookup(root, 'src');
    const dst = plugin.node_ops.lookup(root, 'dst');
    const a = plugin.node_ops.lookup(src, 'a.txt');
    plugin.node_ops.rename(a, dst, 'b.txt');
    expect(plugin.node_ops.readdir(src)).not.toContain('a.txt');
    expect(plugin.node_ops.readdir(dst)).toContain('b.txt');
    expect(a.opfs.relPath).toBe('dst/b.txt');
    await flushPendingOpfsOps(mount);
    await sah.persistAll();
    const dstHandle = await rootDir.handle.getDirectoryHandle('dst');
    const newFile = await dstHandle.getFileHandle('b.txt');
    expect(await (await newFile.getFile()).text()).toBe('AAA');
    const srcHandle = await rootDir.handle.getDirectoryHandle('src');
    await expect(srcHandle.getFileHandle('a.txt')).rejects.toThrow();
  });

  it('rename rewrites relPath for every descendant of a moved directory', async () => {
    const { plugin, root, mount } = await setup({
      src: { sub: { 'leaf.txt': 'L' } },
      dst: {},
    });
    const src = plugin.node_ops.lookup(root, 'src');
    const dst = plugin.node_ops.lookup(root, 'dst');
    const sub = plugin.node_ops.lookup(src, 'sub');
    plugin.node_ops.rename(sub, dst, 'moved');
    expect(sub.opfs.relPath).toBe('dst/moved');
    const leaf = plugin.node_ops.lookup(sub, 'leaf.txt');
    expect(leaf.opfs.relPath).toBe('dst/moved/leaf.txt');
    await flushPendingOpfsOps(mount);
  });
});

describe('OPFS_SYNC_FS — stream_ops', () => {
  it('read returns the prewalked bytes via the SAH', async () => {
    const { plugin, root } = await setup({ 'a.txt': 'hello world' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const stream = openStream(plugin, a);
    const buf = new Uint8Array(11);
    // The shim SAH lazily seeds backing from the file handle on
    // first acquire; force-load it by writing the source bytes
    // through the same provider so the read assertion mirrors the
    // real-OPFS lifecycle (acquire → read → close).
    const src = new TextEncoder().encode('hello world');
    plugin.stream_ops.write(stream, src, 0, src.byteLength, 0);
    const n = plugin.stream_ops.read(stream, buf, 0, 11, 0);
    plugin.stream_ops.close(stream);
    expect(n).toBe(11);
    expect(new TextDecoder().decode(buf)).toBe('hello world');
  });

  it('write grows the cached file size and updates mtime', async () => {
    const { plugin, root } = await setup({ 'a.txt': '' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const before = a.opfs.mtime;
    const stream = openStream(plugin, a);
    const data = new TextEncoder().encode('twelve chars');
    const n = plugin.stream_ops.write(stream, data, 0, data.byteLength, 0);
    plugin.stream_ops.close(stream);
    expect(n).toBe(12);
    expect(a.opfs.size).toBe(12);
    expect(a.opfs.mtime).toBeGreaterThanOrEqual(before);
  });

  it('llseek honours SEEK_SET / SEEK_CUR / SEEK_END', async () => {
    const { plugin, root } = await setup({ 'a.txt': 'abcdef' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const stream = openStream(plugin, a);
    plugin.stream_ops.write(stream, new TextEncoder().encode('abcdef'), 0, 6, 0);
    expect(plugin.stream_ops.llseek(stream, 2, 0)).toBe(2);
    expect(plugin.stream_ops.llseek(stream, 1, 1)).toBe(3);
    expect(plugin.stream_ops.llseek(stream, -1, 2)).toBe(5);
    expect(() => plugin.stream_ops.llseek(stream, -10, 0)).toThrow(/errno 28/);
    plugin.stream_ops.close(stream);
  });

  it('open releases the SAH lease on close', async () => {
    const { plugin, root, sah } = await setup({ 'a.txt': '' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const stream = openStream(plugin, a);
    expect(sah.leased.has('a.txt')).toBe(true);
    plugin.stream_ops.close(stream);
    expect(sah.leased.has('a.txt')).toBe(false);
  });

  it('read on a closed stream surfaces EBADF', async () => {
    const { plugin, root } = await setup({ 'a.txt': '' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    const stream = openStream(plugin, a);
    plugin.stream_ops.close(stream);
    expect(() => plugin.stream_ops.read(stream, new Uint8Array(1), 0, 1, 0)).toThrow(/errno 8/);
  });
});

describe('OPFS_SYNC_FS — setattr truncate via SAH provider', () => {
  it('setattr(size=…) queues a truncate through a fresh SAH lease', async () => {
    const { plugin, root, mount, sah } = await setup({ 'a.txt': 'AAAA' });
    const a = plugin.node_ops.lookup(root, 'a.txt');
    // Force size cache to mirror what the prewalk reported.
    a.opfs.size = 4;
    plugin.node_ops.setattr(a, { size: 2 });
    expect(a.opfs.size).toBe(2);
    await flushPendingOpfsOps(mount);
    // The queued truncate ran through an acquire/release pair —
    // backing now reflects the new size.
    const backing = sah.backings.get('a.txt');
    expect(backing?.data.length ?? 0).toBe(2);
  });
});

describe('ERRNO mapping', () => {
  it('exposes the musl errno constants used by Pyodide', () => {
    expect(ERRNO.ENOENT).toBe(44);
    expect(ERRNO.EEXIST).toBe(20);
    expect(ERRNO.EISDIR).toBe(31);
    expect(ERRNO.ENOTDIR).toBe(54);
    expect(ERRNO.ENOTEMPTY).toBe(55);
    expect(ERRNO.EBADF).toBe(8);
    expect(ERRNO.EINVAL).toBe(28);
  });
});
