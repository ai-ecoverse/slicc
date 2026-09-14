export const ERRNO = {
  EBADF: 8,
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ENOENT: 44,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  EPERM: 63,
} as const;

export interface EmscriptenFsApi {
  createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  ErrnoError: new (errno: number) => Error & { errno: number };
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const O_TRUNC = 0o1000;

const DEFAULT_DIR_MODE = S_IFDIR | 0o755;
const DEFAULT_FILE_MODE = S_IFREG | 0o644;
const DEFAULT_LINK_MODE = S_IFLNK | 0o777;

export interface OpfsSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OpfsSahProvider {
  acquire(relPath: string, fileHandle?: FileSystemFileHandle): OpfsSyncAccessHandle;
  release(relPath: string): void;
}

export interface OpfsPrewalkFileEntry {
  kind: 'file';
  fileHandle: FileSystemFileHandle;
  size: number;
  mtime: number;
}

export interface OpfsPrewalkDirEntry {
  kind: 'directory';
  dirHandle: FileSystemDirectoryHandle;
}

export type OpfsPrewalkEntry = OpfsPrewalkFileEntry | OpfsPrewalkDirEntry;

export interface OpfsPrewalkSnapshot {
  entries: Map<string, OpfsPrewalkEntry>;
}

export async function prewalkOpfsTree(
  rootHandle: FileSystemDirectoryHandle
): Promise<OpfsPrewalkSnapshot> {
  const entries = new Map<string, OpfsPrewalkEntry>();
  entries.set('', { kind: 'directory', dirHandle: rootHandle });

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    const iter = dir as unknown as AsyncIterable<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    >;
    for await (const [name, child] of iter) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if ((child as { kind: string }).kind === 'directory') {
        entries.set(path, { kind: 'directory', dirHandle: child as FileSystemDirectoryHandle });
        await walk(child as FileSystemDirectoryHandle, path);
      } else {
        const fileHandle = child as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        entries.set(path, {
          kind: 'file',
          fileHandle,
          size: file.size,
          mtime: file.lastModified,
        });
      }
    }
  }

  await walk(rootHandle, '');
  return { entries };
}

interface OpfsNodeExtras {
  relPath: string;
  size: number;
  mtime: number;
  linkTarget?: string;
  children?: Map<string, FsNode>;
  fileHandle?: FileSystemFileHandle;
  dirHandle?: FileSystemDirectoryHandle;
}

export interface FsNode {
  id: number;
  name: string;
  mode: number;
  parent: FsNode;
  mount: OpfsMount;
  timestamp: number;
  node_ops: NodeOps;
  stream_ops: StreamOps;
  contents?: unknown;

  opfs: OpfsNodeExtras;
}

export interface FsStream {
  node: FsNode;
  position: number;
  flags?: number;

  sah?: OpfsSyncAccessHandle;
}

export interface NodeOps {
  getattr(node: FsNode): NodeAttr;
  setattr(node: FsNode, attr: Partial<NodeAttr>): void;
  lookup(parent: FsNode, name: string): FsNode;
  mknod(parent: FsNode, name: string, mode: number, dev: number): FsNode;
  rename(oldNode: FsNode, newDir: FsNode, newName: string): void;
  unlink(parent: FsNode, name: string): void;
  rmdir(parent: FsNode, name: string): void;
  readdir(node: FsNode): string[];
  symlink(parent: FsNode, newName: string, oldPath: string): FsNode;
  readlink(node: FsNode): string;
}

export interface StreamOps {
  open(stream: FsStream): void;
  close(stream: FsStream): void;
  read(
    stream: FsStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number;
  write(
    stream: FsStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number;
  llseek(stream: FsStream, offset: number, whence: number): number;
}

export interface NodeAttr {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  blksize: number;
  blocks: number;
}

export interface OpfsMount {
  opts: OpfsMountOpts;
  mountpoint: string;
  root: FsNode;
}

export interface OpfsMountOpts {
  rootHandle: FileSystemDirectoryHandle;
  prewalk: OpfsPrewalkSnapshot;
  sahProvider: OpfsSahProvider;
  flush?: () => Promise<void>;
}

export interface OpfsSyncFsPlugin {
  mount(mount: OpfsMount): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;
  node_ops: NodeOps;
  stream_ops: StreamOps;
}

export interface OpfsSyncFilesystems {
  OPFS_SYNC_FS?: OpfsSyncFsPlugin;
}

function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function buildNodeOps(Fs: EmscriptenFsApi, plugin: OpfsSyncFsPlugin): NodeOps {
  return {
    getattr(node: FsNode): NodeAttr {
      const isDir = Fs.isDir(node.mode);
      const isLink = Fs.isLink(node.mode);
      const size = isLink ? (node.opfs.linkTarget?.length ?? 0) : isDir ? 4096 : node.opfs.size;
      const t = new Date(node.opfs.mtime || node.timestamp);
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: t,
        mtime: t,
        ctime: t,
        blksize: 4096,
        blocks: Math.ceil(size / 4096),
      };
    },

    setattr(node: FsNode, attr: Partial<NodeAttr>): void {
      if (attr.mode !== undefined) {
        node.mode = (node.mode & S_IFMT) | (attr.mode & ~S_IFMT);
      }
      if (attr.size !== undefined && Fs.isFile(node.mode)) {
        const newSize = attr.size;
        node.opfs.size = newSize;
        const sizeAtEnqueue = newSize;
        enqueueOpfsOp(node.mount, async () => {
          if (node.opfs.size > sizeAtEnqueue) return;
          const fileHandle = await ensureFileHandle(node);
          const sah = node.mount.opts.sahProvider.acquire(node.opfs.relPath, fileHandle);
          try {
            sah.truncate(newSize);
            sah.flush();
          } finally {
            sah.close();
            node.mount.opts.sahProvider.release(node.opfs.relPath);
          }
        });
      }
      if (attr.mtime !== undefined) {
        const ts = attr.mtime.getTime();
        node.opfs.mtime = ts;
        node.timestamp = ts;
      }
    },

    lookup(parent: FsNode, name: string): FsNode {
      const child = parent.opfs.children?.get(name);
      if (!child) throw new Fs.ErrnoError(ERRNO.ENOENT);
      return child;
    },

    mknod(parent: FsNode, name: string, mode: number, dev: number): FsNode {
      if (parent.opfs.children?.has(name)) {
        throw new Fs.ErrnoError(ERRNO.EEXIST);
      }
      const node = plugin.createNode(parent, name, mode, dev);
      parent.opfs.children?.set(name, node);
      if (Fs.isDir(mode)) {
        enqueueOpfsOp(parent.mount, async () => {
          const parentDir = await ensureDirHandle(parent);
          const newDir = await parentDir.getDirectoryHandle(name, { create: true });
          node.opfs.dirHandle = newDir;
        });
      } else if (Fs.isFile(mode)) {
        enqueueOpfsOp(parent.mount, async () => {
          const parentDir = await ensureDirHandle(parent);
          const newFile = await parentDir.getFileHandle(name, { create: true });
          node.opfs.fileHandle = newFile;
        });
      }
      return node;
    },

    rename(oldNode: FsNode, newDir: FsNode, newName: string): void {
      const oldParent = oldNode.parent;
      const oldName = oldNode.name;
      if (oldName === newName && oldParent === newDir) return;
      if (newDir.opfs.children?.has(newName)) {
        throw new Fs.ErrnoError(ERRNO.EEXIST);
      }
      oldParent.opfs.children?.delete(oldName);
      newDir.opfs.children?.set(newName, oldNode);
      oldNode.name = newName;
      oldNode.parent = newDir;
      renameSubtreeRelPaths(oldNode, joinRel(newDir.opfs.relPath, newName));
      if (Fs.isFile(oldNode.mode)) {
        enqueueOpfsOp(oldNode.mount, () =>
          opfsRenameFile(oldNode, oldParent, oldName, newDir, newName)
        );
      } else if (Fs.isDir(oldNode.mode)) {
        enqueueOpfsOp(oldNode.mount, () =>
          opfsRenameDir(oldNode, oldParent, oldName, newDir, newName)
        );
      }
    },

    unlink(parent: FsNode, name: string): void {
      const child = parent.opfs.children?.get(name);
      if (!child) throw new Fs.ErrnoError(ERRNO.ENOENT);
      if (Fs.isDir(child.mode)) throw new Fs.ErrnoError(ERRNO.EISDIR);
      parent.opfs.children?.delete(name);
      if (Fs.isFile(child.mode)) {
        enqueueOpfsOp(parent.mount, async () => {
          try {
            parent.mount.opts.sahProvider.release(child.opfs.relPath);
          } catch {}
          const parentDir = await ensureDirHandle(parent);
          await parentDir.removeEntry(name);
        });
      }
    },

    rmdir(parent: FsNode, name: string): void {
      const child = parent.opfs.children?.get(name);
      if (!child) throw new Fs.ErrnoError(ERRNO.ENOENT);
      if (!Fs.isDir(child.mode)) throw new Fs.ErrnoError(ERRNO.ENOTDIR);
      if ((child.opfs.children?.size ?? 0) > 0) {
        throw new Fs.ErrnoError(ERRNO.ENOTEMPTY);
      }
      parent.opfs.children?.delete(name);
      enqueueOpfsOp(parent.mount, async () => {
        const parentDir = await ensureDirHandle(parent);
        await parentDir.removeEntry(name);
      });
    },

    readdir(node: FsNode): string[] {
      if (!Fs.isDir(node.mode)) throw new Fs.ErrnoError(ERRNO.ENOTDIR);
      const names = ['.', '..'];
      for (const childName of node.opfs.children?.keys() ?? []) {
        names.push(childName);
      }
      return names;
    },

    symlink(parent: FsNode, newName: string, oldPath: string): FsNode {
      if (parent.opfs.children?.has(newName)) {
        throw new Fs.ErrnoError(ERRNO.EEXIST);
      }
      const node = plugin.createNode(parent, newName, DEFAULT_LINK_MODE, 0);
      node.opfs.linkTarget = oldPath;
      parent.opfs.children?.set(newName, node);
      return node;
    },

    readlink(node: FsNode): string {
      if (!Fs.isLink(node.mode)) throw new Fs.ErrnoError(ERRNO.EINVAL);
      return node.opfs.linkTarget ?? '';
    },
  };
}

function buildStreamOps(Fs: EmscriptenFsApi): StreamOps {
  return {
    open(stream: FsStream): void {
      const node = stream.node;
      if (Fs.isDir(node.mode)) return;
      if (!Fs.isFile(node.mode)) return;
      const sah = node.mount.opts.sahProvider.acquire(node.opfs.relPath, node.opfs.fileHandle);
      stream.sah = sah;
      if (stream.flags !== undefined && stream.flags & O_TRUNC) {
        sah.truncate(0);
        node.opfs.size = 0;
      } else {
        node.opfs.size = sah.getSize();
      }
    },

    close(stream: FsStream): void {
      const sah = stream.sah;
      if (!sah) return;
      try {
        sah.flush();
      } finally {
        sah.close();
        stream.node.mount.opts.sahProvider.release(stream.node.opfs.relPath);
        stream.sah = undefined;
      }
    },

    read(
      stream: FsStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ): number {
      const sah = stream.sah;
      if (!sah) throw new Fs.ErrnoError(ERRNO.EBADF);
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      return sah.read(view, { at: position });
    },

    write(
      stream: FsStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ): number {
      const sah = stream.sah;
      if (!sah) throw new Fs.ErrnoError(ERRNO.EBADF);
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      const written = sah.write(view, { at: position });
      const newSize = Math.max(stream.node.opfs.size, position + written);
      stream.node.opfs.size = newSize;
      stream.node.opfs.mtime = Date.now();
      stream.node.timestamp = stream.node.opfs.mtime;
      return written;
    },

    llseek(stream: FsStream, offset: number, whence: number): number {
      let position = offset;
      if (whence === 1) position = stream.position + offset;
      else if (whence === 2) {
        const sah = stream.sah;
        const size = sah ? sah.getSize() : stream.node.opfs.size;
        position = size + offset;
      }
      if (position < 0) throw new Fs.ErrnoError(ERRNO.EINVAL);
      stream.position = position;
      return position;
    },
  };
}

function materializePrewalk(
  Fs: EmscriptenFsApi,
  plugin: OpfsSyncFsPlugin,
  root: FsNode,
  prewalk: OpfsPrewalkSnapshot
): void {
  for (const [relPath, entry] of prewalk.entries) {
    if (relPath === '') continue;
    const parts = relPath.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const childName = parts[i];
      const existing = parent.opfs.children?.get(childName);
      if (!existing) throw new Fs.ErrnoError(ERRNO.EIO);
      parent = existing;
    }
    const name = parts[parts.length - 1];
    if (entry.kind === 'directory') {
      const node = plugin.createNode(parent, name, DEFAULT_DIR_MODE, 0);
      node.opfs.dirHandle = entry.dirHandle;
      node.opfs.children = new Map();
      parent.opfs.children?.set(name, node);
    } else {
      const node = plugin.createNode(parent, name, DEFAULT_FILE_MODE, 0);
      node.opfs.fileHandle = entry.fileHandle;
      node.opfs.size = entry.size;
      node.opfs.mtime = entry.mtime;
      node.timestamp = entry.mtime;
      parent.opfs.children?.set(name, node);
    }
  }
}

export function createOpfsSyncFs(Fs: EmscriptenFsApi): OpfsSyncFsPlugin {
  const plugin: OpfsSyncFsPlugin = {
    mount(mount: OpfsMount): FsNode {
      const { prewalk } = mount.opts;
      const rootEntry = prewalk.entries.get('');
      if (rootEntry?.kind !== 'directory') {
        throw new Fs.ErrnoError(ERRNO.EINVAL);
      }
      const root = plugin.createNode(null, '/', DEFAULT_DIR_MODE, 0);
      root.mount = mount;
      root.opfs.dirHandle = rootEntry.dirHandle;
      root.opfs.children = new Map();
      materializePrewalk(Fs, plugin, root, prewalk);
      return root;
    },

    createNode(parent: FsNode | null, name: string, mode: number, dev = 0): FsNode {
      if (!Fs.isDir(mode) && !Fs.isFile(mode) && !Fs.isLink(mode)) {
        throw new Fs.ErrnoError(ERRNO.EINVAL);
      }
      const relPath = parent === null ? '' : joinRel(parent.opfs?.relPath ?? '', name);
      const node = Fs.createNode(parent, name, mode, dev) as FsNode;
      node.node_ops = plugin.node_ops;
      node.stream_ops = plugin.stream_ops;
      node.timestamp = Date.now();
      if (parent !== null) node.mount = parent.mount;
      node.opfs = {
        relPath,
        size: 0,
        mtime: node.timestamp,
      };
      if (Fs.isDir(mode)) node.opfs.children = new Map();
      return node;
    },

    node_ops: undefined!,
    stream_ops: undefined!,
  };

  plugin.node_ops = buildNodeOps(Fs, plugin);
  plugin.stream_ops = buildStreamOps(Fs);

  return plugin;
}

const OPFS_OP_CHAINS = new WeakMap<OpfsMount, Promise<void>>();

function enqueueOpfsOp(mount: OpfsMount, op: () => Promise<void>): void {
  const prev = OPFS_OP_CHAINS.get(mount) ?? Promise.resolve();
  const next = prev.then(op, op);
  OPFS_OP_CHAINS.set(mount, next);
  if (!mount.opts.flush) {
    mount.opts.flush = (): Promise<void> => OPFS_OP_CHAINS.get(mount) ?? Promise.resolve();
  }
}

export async function flushPendingOpfsOps(mount: OpfsMount): Promise<void> {
  await (OPFS_OP_CHAINS.get(mount) ?? Promise.resolve());
}

export interface OpfsBufferedSahProvider {
  provider: OpfsSahProvider;

  preload(prewalk: OpfsPrewalkSnapshot): Promise<void>;

  flush(rootHandle: FileSystemDirectoryHandle): Promise<void>;

  getDirtyPaths(): string[];
}

interface BufferedBacking {
  data: Uint8Array;
  dirty: boolean;
}

class BufferedSyncAccessHandle implements OpfsSyncAccessHandle {
  constructor(
    private readonly backing: BufferedBacking,
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
    this.backing.dirty = true;
    return view.byteLength;
  }
  truncate(newSize: number): void {
    if (newSize === this.backing.data.length) return;
    const grown = new Uint8Array(newSize);
    grown.set(this.backing.data.subarray(0, Math.min(newSize, this.backing.data.length)));
    this.backing.data = grown;
    this.backing.dirty = true;
  }
  getSize(): number {
    return this.backing.data.length;
  }
  flush(): void {}
  close(): void {
    this.onClose();
  }
}

export function createBufferedOpfsSahProvider(): OpfsBufferedSahProvider {
  const backings = new Map<string, BufferedBacking>();
  const dirtyPaths = new Set<string>();
  const provider: OpfsSahProvider = {
    acquire(relPath: string, _fileHandle?: FileSystemFileHandle): OpfsSyncAccessHandle {
      let backing = backings.get(relPath);
      if (!backing) {
        backing = { data: new Uint8Array(), dirty: true };
        backings.set(relPath, backing);
        dirtyPaths.add(relPath);
      }
      return new BufferedSyncAccessHandle(backing, () => {
        if (backing!.dirty) dirtyPaths.add(relPath);
      });
    },
    release(_relPath: string): void {},
  };
  return {
    provider,
    async preload(prewalk: OpfsPrewalkSnapshot): Promise<void> {
      for (const [relPath, entry] of prewalk.entries) {
        if (entry.kind !== 'file') continue;
        const file = await entry.fileHandle.getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        backings.set(relPath, { data, dirty: false });
      }
    },
    async flush(rootHandle: FileSystemDirectoryHandle): Promise<void> {
      for (const [relPath, backing] of backings) {
        if (!backing.dirty) continue;
        const parts = relPath.split('/');
        let cursor = rootHandle;
        for (const part of parts.slice(0, -1)) {
          cursor = await cursor.getDirectoryHandle(part, { create: true });
        }
        const fileHandle = await cursor.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await fileHandle.createWritable();
        const buf = new ArrayBuffer(backing.data.byteLength);
        new Uint8Array(buf).set(backing.data);
        await writable.write(buf);
        await writable.close();
        backing.dirty = false;
      }
    },
    getDirtyPaths(): string[] {
      return [...dirtyPaths];
    },
  };
}

async function ensureDirHandle(node: FsNode): Promise<FileSystemDirectoryHandle> {
  if (node.opfs.dirHandle) return node.opfs.dirHandle;

  const parts = node.opfs.relPath.split('/').filter(Boolean);
  let cursor: FileSystemDirectoryHandle = node.mount.root.opfs.dirHandle!;
  for (const part of parts) {
    cursor = await cursor.getDirectoryHandle(part, { create: true });
  }
  node.opfs.dirHandle = cursor;
  return cursor;
}

async function ensureFileHandle(node: FsNode): Promise<FileSystemFileHandle> {
  if (node.opfs.fileHandle) return node.opfs.fileHandle;
  const parentDir = await ensureDirHandle(node.parent);
  const fileHandle = await parentDir.getFileHandle(node.name, { create: true });
  node.opfs.fileHandle = fileHandle;
  return fileHandle;
}

function renameSubtreeRelPaths(node: FsNode, newRelPath: string): void {
  node.opfs.relPath = newRelPath;
  if (!node.opfs.children) return;
  for (const [name, child] of node.opfs.children) {
    renameSubtreeRelPaths(child, joinRel(newRelPath, name));
  }
}

async function opfsRenameFile(
  node: FsNode,
  oldParent: FsNode,
  oldName: string,
  newParent: FsNode,
  newName: string
): Promise<void> {
  const oldDir = await ensureDirHandle(oldParent);
  const newDir = await ensureDirHandle(newParent);
  const oldHandle = await oldDir.getFileHandle(oldName);
  const srcFile = await oldHandle.getFile();
  const bytes = new Uint8Array(await srcFile.arrayBuffer());
  const newHandle = await newDir.getFileHandle(newName, { create: true });
  const sah = node.mount.opts.sahProvider.acquire(node.opfs.relPath, newHandle);
  try {
    sah.truncate(0);
    if (bytes.byteLength > 0) sah.write(bytes, { at: 0 });
    sah.flush();
  } finally {
    sah.close();
    node.mount.opts.sahProvider.release(node.opfs.relPath);
  }
  await oldDir.removeEntry(oldName);
  node.opfs.fileHandle = newHandle;
}

async function opfsRenameDir(
  node: FsNode,
  oldParent: FsNode,
  oldName: string,
  newParent: FsNode,
  newName: string
): Promise<void> {
  const oldDir = await ensureDirHandle(oldParent);
  const newParentDir = await ensureDirHandle(newParent);
  const oldHandle = await oldDir.getDirectoryHandle(oldName);
  const newHandle = await newParentDir.getDirectoryHandle(newName, { create: true });
  await copyDirRecursive(oldHandle, newHandle);
  await oldDir.removeEntry(oldName, { recursive: true });
  node.opfs.dirHandle = newHandle;
}

async function copyDirRecursive(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle
): Promise<void> {
  const iter = src as unknown as AsyncIterable<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >;
  for await (const [name, entry] of iter) {
    if ((entry as { kind: string }).kind === 'directory') {
      const sub = await dst.getDirectoryHandle(name, { create: true });
      await copyDirRecursive(entry as FileSystemDirectoryHandle, sub);
    } else {
      const srcFile = await (entry as FileSystemFileHandle).getFile();
      const bytes = new Uint8Array(await srcFile.arrayBuffer());
      const dstHandle = await dst.getFileHandle(name, { create: true });
      const writable = await dstHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  }
}
