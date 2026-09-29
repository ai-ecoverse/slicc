/**
 * `wasi-files.ts` — the descriptors a WASI program holds, as the host keeps
 * them in its worker. Every one has the same number in the kernel's table:
 *
 * - A **kernel** descriptor (stdio, a pipe, a socket, an inherited fd) is the
 *   kernel's: reads and writes are SAB round trips that block in the kernel.
 *   The others hold their number there as a placeholder (`fd-reserve`).
 * - A **file** is a VFS file buffered in the worker, as the Emscripten
 *   adapter's live mount does: loaded on first use over the sync-fs bridge,
 *   written back on close / fd_sync, so a read loop costs no round trips.
 * - A **dir** is a VFS directory (a preopen, or one path_open opened).
 * - A **device** is `/dev/null`, `/dev/zero` or `/dev/urandom`, answered here.
 */
import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-xhr-bridge.js';
import type { KernelFdKind } from '../fd-table.js';

export class WasiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * One VFS file's bytes as this process holds them, shared by every open of
 * its path (so two descriptors on one file see each other's writes, as on
 * Unix): loaded on first use, written back on a flush.
 */
export class FileBuffer {
  private data: Uint8Array | undefined;
  private length = 0;
  private dirty = false;
  /** Unlinked or replaced while open: it lives on in memory and is never written back. */
  private orphaned = false;
  /** Open file descriptions on it. */
  opens = 0;

  constructor(
    private readonly fs: SyncFsPosixBridge,
    public path: string,
    /** Created or truncated by the open: start empty, never read the old bytes. */
    empty: boolean
  ) {
    if (empty) {
      this.data = new Uint8Array(0);
      this.dirty = true;
    }
  }

  load(): Uint8Array {
    if (!this.data) {
      this.data = this.fs.readFile(this.path);
      this.length = this.data.length;
    }
    return this.data;
  }

  size(): number {
    this.load();
    return this.length;
  }

  pread(max: number, at: number): Uint8Array {
    const bytes = this.load();
    const n = Math.max(0, Math.min(max, this.length - at));
    return bytes.subarray(at, at + n);
  }

  pwrite(bytes: Uint8Array, at: number): number {
    this.load();
    const end = at + bytes.length;
    this.ensure(end);
    const buf = this.data as Uint8Array;
    if (at > this.length) buf.fill(0, this.length, at);
    buf.set(bytes, at);
    this.length = Math.max(this.length, end);
    this.dirty = true;
    return bytes.length;
  }

  truncate(size: number): void {
    this.load();
    this.ensure(size);
    if (size > this.length) (this.data as Uint8Array).fill(0, this.length, size);
    this.length = size;
    this.dirty = true;
  }

  private ensure(need: number): void {
    const cur = this.data as Uint8Array;
    if (cur.length >= need) return;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 4096));
    grown.set(cur.subarray(0, this.length));
    this.data = grown;
  }

  /** Its path is gone (unlinked, or another file renamed over it): keep the bytes, never write them back. */
  orphan(): void {
    this.orphaned = true;
  }

  /** Write back what changed. */
  flush(): void {
    if (this.orphaned || !this.dirty || !this.data) return;
    this.fs.writeFile(this.path, this.data.slice(0, this.length));
    this.dirty = false;
  }
}

/** One open file description of a buffered file: its offset and access mode. `/dev/fd/N` shares it. */
export class LocalFile {
  offset = 0;
  refs = 1;

  constructor(
    readonly buffer: FileBuffer,
    readonly readable: boolean,
    readonly writable: boolean,
    public append: boolean
  ) {}

  get path(): string {
    return this.buffer.path;
  }

  size(): number {
    return this.buffer.size();
  }

  pread(max: number, at: number): Uint8Array {
    return this.buffer.pread(max, at);
  }

  read(max: number): Uint8Array {
    const out = this.buffer.pread(max, this.offset);
    this.offset += out.length;
    return out;
  }

  pwrite(bytes: Uint8Array, at: number): number {
    return this.buffer.pwrite(bytes, at);
  }

  write(bytes: Uint8Array): number {
    if (this.append) this.offset = this.buffer.size();
    const n = this.buffer.pwrite(bytes, this.offset);
    this.offset += n;
    return n;
  }

  truncate(size: number): void {
    this.buffer.truncate(size);
  }

  flush(): void {
    this.buffer.flush();
  }
}

export interface DirListing {
  names: string[];
  stats: Map<string, SyncFsBridgeStat | null>;
}

export type WasiEntry =
  | {
      /** The kernel's descriptor of the same number. */
      type: 'kernel';
      /** Filled in on first need (fd-info). */
      kind?: KernelFdKind;
      nonblock: boolean;
      append: boolean;
    }
  | { type: 'file'; file: LocalFile }
  | {
      type: 'dir';
      path: string;
      /** The name fd_prestat_dir_name reports, for a preopen. */
      preopen?: string;
      listing?: DirListing;
    }
  | { type: 'device'; device: 'null' | 'zero' | 'urandom' };

/** Normalize an absolute path: no `.`, `..` or empty segments; never above `/`. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** `path` under directory `dir` (absolute paths stand on their own). */
export function resolveUnder(dir: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${dir}/${path}`);
}

/** A stable inode for a path when the backend names none (as the live VFS mount does). */
export function pathInode(path: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < path.length; i++) {
    h ^= BigInt(path.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/**
 * The bridge with metadata cached per path, as the Emscripten adapter's live
 * mount caches its nodes: a stat loop costs no round trips. Any mutation this
 * process makes drops the cache; so must a child's exit (`invalidate`), since
 * other processes change the VFS too.
 */
export function cachingBridge(
  bridge: SyncFsPosixBridge
): SyncFsPosixBridge & { invalidate(): void } {
  const stats = new Map<string, SyncFsBridgeStat | Error>();
  const lstats = new Map<string, SyncFsBridgeStat | Error>();
  const cached = (map: typeof stats, path: string, get: () => SyncFsBridgeStat) => {
    let hit = map.get(path);
    if (hit === undefined) {
      try {
        hit = get();
      } catch (e) {
        hit = e as Error;
      }
      map.set(path, hit);
    }
    if (hit instanceof Error) throw hit;
    return hit;
  };
  const invalidate = () => {
    stats.clear();
    lstats.clear();
  };
  /** A mutation: the cache is stale after it, whether it worked or not. */
  const mutating = <T>(op: () => T): T => {
    try {
      return op();
    } finally {
      invalidate();
    }
  };
  return {
    readFile: (p) => bridge.readFile(p),
    readdir: (p) => bridge.readdir(p),
    // A listing's lstats answer the stats that usually follow it (an entry
    // that is no symlink stats as it lstats).
    ...(bridge.readdirStat
      ? {
          readdirStat: (p: string) => {
            const list = (bridge.readdirStat as NonNullable<typeof bridge.readdirStat>)(p);
            const base = p === '/' ? '' : p;
            for (const [name, st] of list) {
              if (!st) continue;
              lstats.set(`${base}/${name}`, st);
              if (!st.isSymbolicLink) stats.set(`${base}/${name}`, st);
            }
            return list;
          },
        }
      : {}),
    readlink: (p) => bridge.readlink(p),
    stat: (p) => cached(stats, p, () => bridge.stat(p)),
    lstat: (p) => cached(lstats, p, () => bridge.lstat(p)),
    exists: (p) => {
      try {
        cached(stats, p, () => bridge.stat(p));
        return true;
      } catch {
        return false;
      }
    },
    writeFile: (p, bytes) => mutating(() => bridge.writeFile(p, bytes)),
    mkdir: (p) => mutating(() => bridge.mkdir(p)),
    rm: (p) => mutating(() => bridge.rm(p)),
    rename: (from, to) => mutating(() => bridge.rename(from, to)),
    unlink: (p) => mutating(() => bridge.unlink(p)),
    rmdir: (p) => mutating(() => bridge.rmdir(p)),
    symlink: (target, link) => mutating(() => bridge.symlink(target, link)),
    chmod: (p, mode) => mutating(() => bridge.chmod(p, mode)),
    utimes: (p, a, m) => mutating(() => bridge.utimes(p, a, m)),
    invalidate,
  };
}
