/**
 * `SLICC_LIVE_FS` — an Emscripten-FS plugin that mirrors the live kernel VFS
 * through the realm's synchronous fs bridge (`SyncFsPosixBridge`, SAB or SW
 * transport).
 *
 * Unlike `OPFS_SYNC_FS`, nothing is walked or preloaded at mount time:
 *
 *   - `lookup` / `getattr` / `readdir` ask the bridge on demand, so mounting
 *     `/workspace` costs one round-trip, not a copy of the tree;
 *   - file bytes are fetched on the first read of an open file and held only
 *     while some stream has it open; a dirty buffer is written back on the
 *     last close (or on {@link flushLiveVfs});
 *   - every mutation (`mknod` / `unlink` / `rename` / `chmod` / …) is applied
 *     to the VFS immediately, through the same ACL-gated `ctx.fs` handle the
 *     realm's other sync ops use.
 *
 * Because the backing store is the kernel VFS itself — mounts included — a
 * program Python launches (`subprocess`) sees Python's writes once
 * {@link flushLiveVfs} ran, and Python sees the child's writes once
 * {@link invalidateLiveVfs} dropped the cached nodes. The subprocess shim in
 * `py-realm-shared.ts` brackets every child with exactly that pair.
 */

import type { SyncFsBridgeStat, SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';

/** musl / WASI errno numbers Emscripten uses, keyed by POSIX name. */
const ERRNO_BY_CODE: Readonly<Record<string, number>> = {
  EACCES: 2,
  EBADF: 8,
  EBUSY: 10,
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ELOOP: 32,
  ENAMETOOLONG: 37,
  ENOENT: 44,
  ENOSPC: 51,
  ENOSYS: 52,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  EPERM: 63,
  EROFS: 69,
  ETIMEDOUT: 73,
  EXDEV: 75,
};
const EIO = 29;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const PERM_MASK = 0o7777;
const SEEK_CUR = 1;
const SEEK_END = 2;

/** Per-node plugin state. Paths are derived from the parent chain, never stored. */
interface LiveNodeState {
  /** Cached lstat; `undefined` after an invalidation or a local mutation. */
  stat?: SyncFsBridgeStat;
  /** Open-file buffer (capacity ≥ `len`), present while `openCount > 0`. */
  data?: Uint8Array;
  len: number;
  loaded: boolean;
  dirty: boolean;
  openCount: number;
}

export interface LiveFsNode {
  id: number;
  name: string;
  mode: number;
  parent: LiveFsNode;
  mount: LiveFsMount;
  node_ops: LiveNodeOps;
  stream_ops: LiveStreamOps;
  live: LiveNodeState;
}

export interface LiveFsStream {
  node: LiveFsNode;
  position: number;
  flags: number;
}

export interface LiveFsMount {
  opts: LiveFsMountOpts;
  mountpoint: string;
  root: LiveFsNode;
}

/** `FS.mount(plugin, opts, mountpoint)` options. */
export interface LiveFsMountOpts {
  /** VFS path this mount mirrors (usually the same as the mountpoint). */
  root: string;
  bridge: SyncFsPosixBridge;
}

interface LiveAttr {
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

/** `setattr` payload: Emscripten passes ms numbers (utime) or a `size` (truncate). */
interface LiveSetAttr {
  mode?: number;
  size?: number;
  atime?: number | Date;
  mtime?: number | Date;
  timestamp?: number;
}

export interface LiveNodeOps {
  getattr(node: LiveFsNode): LiveAttr;
  setattr(node: LiveFsNode, attr: LiveSetAttr): void;
  lookup(parent: LiveFsNode, name: string): LiveFsNode;
  mknod(parent: LiveFsNode, name: string, mode: number, dev: number): LiveFsNode;
  rename(oldNode: LiveFsNode, newDir: LiveFsNode, newName: string): void;
  unlink(parent: LiveFsNode, name: string): void;
  rmdir(parent: LiveFsNode, name: string): void;
  readdir(node: LiveFsNode): string[];
  symlink(parent: LiveFsNode, newName: string, target: string): LiveFsNode;
  readlink(node: LiveFsNode): string;
}

export interface LiveStreamOps {
  open(stream: LiveFsStream): void;
  close(stream: LiveFsStream): void;
  read(
    stream: LiveFsStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ): number;
  write(
    stream: LiveFsStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ): number;
  llseek(stream: LiveFsStream, offset: number, whence: number): number;
  fsync(stream: LiveFsStream): void;
}

/** The slice of Emscripten's `FS` object the plugin drives. */
export interface LiveFsApi {
  createNode(parent: LiveFsNode | null, name: string, mode: number, dev?: number): LiveFsNode;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  ErrnoError: new (errno: number) => Error & { errno: number };
  /** Node-name hash; walked by {@link invalidateLiveVfs}. */
  nameTable?: (LiveFsNode | null)[] | null;
  hashRemoveNode?(node: LiveFsNode): void;
  lookupNode?(parent: LiveFsNode, name: string): LiveFsNode;
}

export interface LiveVfsPlugin {
  mount(mount: LiveFsMount): LiveFsNode;
  node_ops: LiveNodeOps;
  stream_ops: LiveStreamOps;
  /** Every mount made through this plugin, for flush / invalidate. */
  mounts: Set<LiveFsMount>;
}

/** Map a bridge error (`.code` = POSIX name) onto an Emscripten `ErrnoError`. */
function toErrno(Fs: LiveFsApi, err: unknown): Error {
  if ((err as { errno?: unknown })?.errno !== undefined && err instanceof Fs.ErrnoError) {
    return err;
  }
  const code = (err as { code?: unknown })?.code;
  const errno = typeof code === 'string' ? (ERRNO_BY_CODE[code] ?? EIO) : EIO;
  return new Fs.ErrnoError(errno);
}

/** VFS path of `node`: the mount's root joined with the names up the parent chain. */
export function liveNodePath(node: LiveFsNode): string {
  const parts: string[] = [];
  let cur = node;
  while (cur !== cur.mount.root) {
    parts.push(cur.name);
    cur = cur.parent;
  }
  const root = node.mount.opts.root.replace(/\/+$/, '');
  return parts.length === 0 ? root || '/' : `${root}/${parts.reverse().join('/')}`;
}

/** Emscripten `st_mode` for a bridge stat. */
function modeFromStat(st: SyncFsBridgeStat): number {
  const type = st.isSymbolicLink ? S_IFLNK : st.isDirectory ? S_IFDIR : S_IFREG;
  const fallback = st.isDirectory || st.isSymbolicLink ? 0o777 : 0o666;
  return type | ((st.mode ?? fallback) & PERM_MASK || fallback);
}

function toMs(v: number | Date | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  return v instanceof Date ? v.getTime() : v;
}

/** The ops tables, filled once built (nodes created earlier point at them). */
interface LiveOpsTables {
  node?: LiveNodeOps;
  stream?: LiveStreamOps;
}

/** Shared node/buffer helpers the two ops tables are built on. */
function createHelpers(Fs: LiveFsApi, ops: LiveOpsTables) {
  const bridgeOf = (node: LiveFsNode): SyncFsPosixBridge => node.mount.opts.bridge;

  /** Run a bridge call, translating its errno into an Emscripten throw. */
  function call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw toErrno(Fs, err);
    }
  }

  function freshState(stat?: SyncFsBridgeStat): LiveNodeState {
    return { ...(stat ? { stat } : {}), len: 0, loaded: false, dirty: false, openCount: 0 };
  }

  function makeNode(parent: LiveFsNode | null, name: string, st: SyncFsBridgeStat): LiveFsNode {
    const node = Fs.createNode(parent, name, modeFromStat(st), 0);
    node.node_ops = ops.node as LiveNodeOps;
    node.stream_ops = ops.stream as LiveStreamOps;
    node.live = freshState(st);
    return node;
  }

  function statOf(node: LiveFsNode): SyncFsBridgeStat {
    if (!node.live.stat) {
      const st = call(() => bridgeOf(node).lstat(liveNodePath(node)));
      node.live.stat = st;
      node.mode = modeFromStat(st);
    }
    return node.live.stat;
  }

  function childPath(parent: LiveFsNode, name: string): string {
    const base = liveNodePath(parent);
    return base === '/' ? `/${name}` : `${base}/${name}`;
  }

  /** Load the file bytes into the node buffer (once per open cycle). */
  function ensureLoaded(node: LiveFsNode): void {
    const s = node.live;
    if (s.loaded) return;
    const bytes = call(() => bridgeOf(node).readFile(liveNodePath(node)));
    s.data = bytes;
    s.len = bytes.length;
    s.loaded = true;
  }

  function ensureCapacity(node: LiveFsNode, need: number): Uint8Array {
    const s = node.live;
    const cur = s.data ?? new Uint8Array(0);
    if (cur.length >= need) return cur;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 256));
    grown.set(cur.subarray(0, s.len));
    s.data = grown;
    return grown;
  }

  /** Write a dirty buffer back to the VFS. */
  function flushNode(node: LiveFsNode): void {
    const s = node.live;
    if (!s.dirty || !s.data) return;
    const bytes = s.data.slice(0, s.len);
    call(() => bridgeOf(node).writeFile(liveNodePath(node), bytes));
    s.dirty = false;
    s.stat = undefined;
  }

  function truncate(node: LiveFsNode, size: number): void {
    const s = node.live;
    if (s.openCount > 0) {
      if (size > 0) ensureLoaded(node);
      else s.loaded = true;
      const buf = ensureCapacity(node, size);
      if (size > s.len) buf.fill(0, s.len, size);
      s.len = size;
      s.dirty = true;
      return;
    }
    // Not open: apply directly so a bare truncate(2) is durable at once.
    const path = liveNodePath(node);
    const bytes = new Uint8Array(size);
    if (size > 0) {
      const cur = call(() => bridgeOf(node).readFile(path));
      bytes.set(cur.subarray(0, Math.min(size, cur.length)));
    }
    call(() => bridgeOf(node).writeFile(path, bytes));
    s.stat = undefined;
  }

  return {
    Fs,
    bridgeOf,
    call,
    makeNode,
    statOf,
    childPath,
    ensureLoaded,
    ensureCapacity,
    flushNode,
    truncate,
  };
}

type LiveHelpers = ReturnType<typeof createHelpers>;

function createNodeOps(h: LiveHelpers): LiveNodeOps {
  const { Fs, bridgeOf, call, makeNode, statOf, childPath, flushNode, truncate } = h;
  return {
    getattr(node) {
      const st = statOf(node);
      const s = node.live;
      const size = Fs.isDir(node.mode) ? 4096 : s.loaded ? s.len : st.size;
      const mtime = new Date(st.mtimeMs ?? 0);
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: mtime,
        mtime,
        ctime: mtime,
        blksize: 4096,
        blocks: Math.ceil(size / 4096),
      };
    },
    setattr(node, attr) {
      const path = liveNodePath(node);
      if (attr.mode !== undefined && attr.mode !== null) {
        const perm = attr.mode & PERM_MASK;
        if (perm !== (node.mode & PERM_MASK)) {
          call(() => bridgeOf(node).chmod(path, perm));
          node.mode = (node.mode & ~PERM_MASK) | perm;
        }
      }
      if (attr.size !== undefined && attr.size !== null && Fs.isFile(node.mode)) {
        truncate(node, attr.size);
      }
      const mtime = toMs(attr.mtime) ?? attr.timestamp;
      if (mtime !== undefined) {
        const atime = toMs(attr.atime) ?? mtime;
        flushNode(node);
        call(() => bridgeOf(node).utimes(path, atime, mtime));
      }
      node.live.stat = undefined;
    },
    lookup(parent, name) {
      const st = call(() => bridgeOf(parent).lstat(childPath(parent, name)));
      return makeNode(parent, name, st);
    },
    mknod(parent, name, mode) {
      const path = childPath(parent, name);
      if (Fs.isDir(mode)) {
        call(() => bridgeOf(parent).mkdir(path));
      } else if (Fs.isFile(mode)) {
        call(() => bridgeOf(parent).writeFile(path, new Uint8Array(0)));
      } else {
        throw new Fs.ErrnoError(ERRNO_BY_CODE.EPERM);
      }
      const node = makeNode(parent, name, {
        isFile: Fs.isFile(mode),
        isDirectory: Fs.isDir(mode),
        isSymbolicLink: false,
        size: 0,
        mode,
        mtimeMs: Date.now(),
      });
      // Force a real stat on the next getattr (mtime / perms from the VFS).
      node.live.stat = undefined;
      return node;
    },
    rename(oldNode, newDir, newName) {
      const from = liveNodePath(oldNode);
      const to = childPath(newDir, newName);
      flushNode(oldNode);
      call(() => bridgeOf(oldNode).rename(from, to));
      // Emscripten re-parents the node itself; the name is ours to update.
      // A node already hashed at the destination is now stale.
      try {
        const existing = Fs.lookupNode?.(newDir, newName);
        if (existing && existing !== oldNode) Fs.hashRemoveNode?.(existing);
      } catch {
        /* nothing cached at the destination */
      }
      oldNode.name = newName;
      oldNode.live.stat = undefined;
    },
    unlink(parent, name) {
      call(() => bridgeOf(parent).unlink(childPath(parent, name)));
    },
    rmdir(parent, name) {
      call(() => bridgeOf(parent).rmdir(childPath(parent, name)));
    },
    readdir(node) {
      return ['.', '..', ...call(() => bridgeOf(node).readdir(liveNodePath(node)))];
    },
    symlink(parent, newName, target) {
      const path = childPath(parent, newName);
      call(() => bridgeOf(parent).symlink(target, path));
      return makeNode(parent, newName, {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        size: target.length,
      });
    },
    readlink(node) {
      if (!Fs.isLink(node.mode)) throw new Fs.ErrnoError(ERRNO_BY_CODE.EINVAL);
      return call(() => bridgeOf(node).readlink(liveNodePath(node)));
    },
  };
}

function createStreamOps(h: LiveHelpers): LiveStreamOps {
  const { Fs, statOf, ensureLoaded, ensureCapacity, flushNode } = h;
  return {
    open(stream) {
      if (!Fs.isFile(stream.node.mode)) return;
      stream.node.live.openCount++;
    },
    close(stream) {
      const node = stream.node;
      if (!Fs.isFile(node.mode)) return;
      const s = node.live;
      s.openCount = Math.max(0, s.openCount - 1);
      if (s.openCount > 0) return;
      try {
        flushNode(node);
      } finally {
        // Drop the buffer so the next open re-reads what the VFS holds now.
        s.data = undefined;
        s.len = 0;
        s.loaded = false;
      }
    },
    read(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (Fs.isDir(node.mode)) throw new Fs.ErrnoError(ERRNO_BY_CODE.EISDIR);
      ensureLoaded(node);
      const s = node.live;
      if (position >= s.len || length <= 0) return 0;
      const n = Math.min(length, s.len - position);
      const out = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n);
      out.set((s.data as Uint8Array).subarray(position, position + n));
      return n;
    },
    write(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (Fs.isDir(node.mode)) throw new Fs.ErrnoError(ERRNO_BY_CODE.EISDIR);
      if (length <= 0) return 0;
      ensureLoaded(node);
      const s = node.live;
      const end = position + length;
      const buf = ensureCapacity(node, end);
      if (position > s.len) buf.fill(0, s.len, position);
      buf.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length), position);
      s.len = Math.max(s.len, end);
      s.dirty = true;
      return length;
    },
    llseek(stream, offset, whence) {
      let pos = offset;
      if (whence === SEEK_CUR) pos += stream.position;
      else if (whence === SEEK_END && Fs.isFile(stream.node.mode)) {
        const s = stream.node.live;
        pos += s.loaded ? s.len : statOf(stream.node).size;
      }
      if (pos < 0) throw new Fs.ErrnoError(ERRNO_BY_CODE.EINVAL);
      return pos;
    },
    fsync(stream) {
      flushNode(stream.node);
    },
  };
}

/** Build the plugin. Register it as `FS.filesystems.SLICC_LIVE_FS`. */
export function createLiveVfsPlugin(Fs: LiveFsApi): LiveVfsPlugin {
  const mounts = new Set<LiveFsMount>();
  const ops: LiveOpsTables = {};
  const h = createHelpers(Fs, ops);
  const nodeOps = createNodeOps(h);
  const streamOps = createStreamOps(h);
  ops.node = nodeOps;
  ops.stream = streamOps;
  return {
    mounts,
    node_ops: nodeOps,
    stream_ops: streamOps,
    mount(mount) {
      const st = h.call(() => mount.opts.bridge.stat(mount.opts.root));
      if (!st.isDirectory) throw new Fs.ErrnoError(ERRNO_BY_CODE.ENOTDIR);
      const root = h.makeNode(null, '/', st);
      mounts.add(mount);
      return root;
    },
  };
}

/** Is `node` one of `plugin`'s nodes? */
function ownedBy(plugin: LiveVfsPlugin, node: LiveFsNode | null | undefined): node is LiveFsNode {
  return !!node && plugin.mounts.has(node.mount);
}

/**
 * Write back every dirty open buffer, so a child process reads what Python
 * wrote even through a file Python still holds open.
 */
export function flushLiveVfs(Fs: LiveFsApi, plugin: LiveVfsPlugin): void {
  for (const head of Fs.nameTable ?? []) {
    for (let node = head; node; node = (node as { name_next?: LiveFsNode }).name_next ?? null) {
      if (!ownedBy(plugin, node) || !node.live.dirty || !node.live.data) continue;
      try {
        const bytes = node.live.data.slice(0, node.live.len);
        node.mount.opts.bridge.writeFile(liveNodePath(node), bytes);
        node.live.dirty = false;
      } catch (err) {
        throw toErrno(Fs, err);
      }
    }
  }
}

/**
 * Forget what the plugin cached about the VFS: every stat, and every hashed
 * node that no stream holds open (so the next lookup re-asks the bridge).
 * Called after a child process ran, since it may have changed anything.
 */
export function invalidateLiveVfs(Fs: LiveFsApi, plugin: LiveVfsPlugin): void {
  const table = Fs.nameTable ?? [];
  const drop: LiveFsNode[] = [];
  for (const head of table) {
    for (let node = head; node; node = (node as { name_next?: LiveFsNode }).name_next ?? null) {
      if (!ownedBy(plugin, node)) continue;
      node.live.stat = undefined;
      if (node !== node.mount.root && node.live.openCount === 0) drop.push(node);
    }
  }
  if (!Fs.hashRemoveNode) return;
  for (const node of drop) Fs.hashRemoveNode(node);
}
