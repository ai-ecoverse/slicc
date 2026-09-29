import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-xhr-bridge.js';
import type { KernelFdKind } from '../fd-table.js';

export class WasiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class FileBuffer {
  private data: Uint8Array | undefined;
  private length = 0;
  private dirty = false;

  private orphaned = false;

  opens = 0;

  constructor(
    private readonly fs: SyncFsPosixBridge,
    public path: string,

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

  orphan(): void {
    this.orphaned = true;
  }

  flush(): void {
    if (this.orphaned || !this.dirty || !this.data) return;
    this.fs.writeFile(this.path, this.data.slice(0, this.length));
    this.dirty = false;
  }
}

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
      type: 'kernel';

      kind?: KernelFdKind;
      nonblock: boolean;
      append: boolean;
    }
  | { type: 'file'; file: LocalFile }
  | {
      type: 'dir';
      path: string;

      preopen?: string;
      listing?: DirListing;
    }
  | { type: 'device'; device: 'null' | 'zero' | 'urandom' };

export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function resolveUnder(dir: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${dir}/${path}`);
}

export function pathInode(path: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < path.length; i++) {
    h ^= BigInt(path.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

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
