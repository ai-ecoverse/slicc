import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-xhr-bridge.js';
import type { HeldMeta, KernelFdKind } from '../fd-table.js';
import type { ProcessSys } from '../kernel-streams.js';
import type { FdInfo, WasmSyscall } from '../process.js';
import { FDFLAGS, OFLAGS, RIGHTS } from './wasi-abi.js';
import {
  FileBuffer,
  LocalFile,
  normalize,
  resolveUnder,
  type WasiEntry,
  WasiError,
} from './wasi-files.js';

const SYNTHETIC_DIRS = ['usr', 'bin'];

export interface WasiKernel {
  sys: ProcessSys;

  call(req: WasmSyscall): unknown;
}

type Device = 'null' | 'zero' | 'urandom';

const O_NONBLOCK = 0o4000;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

export type WasiForkFd =
  | { fd: number; type: 'kernel'; nonblock: boolean; append: boolean }
  | { fd: number; type: 'dir'; path: string; preopen?: string }
  | { fd: number; type: 'device'; device: 'null' | 'zero' | 'urandom' };

const DEVICES: Readonly<Record<string, Device>> = {
  '/dev/null': 'null',
  '/dev/zero': 'zero',
  '/dev/urandom': 'urandom',
  '/dev/random': 'urandom',
};

function stdioAlias(path: string): number | undefined {
  const m = /^\/dev\/(?:(stdin)|(stdout)|(stderr)|fd\/(\d+))$/.exec(path);
  if (!m) return undefined;
  return m[1] ? 0 : m[2] ? 1 : m[3] ? 2 : Number(m[4]);
}

export function deviceOf(path: string): Device | undefined {
  return DEVICES[path];
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

export class WasiFds {
  private readonly table = new Map<number, WasiEntry>();

  private readonly buffers = new Map<string, FileBuffer>();

  constructor(
    private readonly kernel: WasiKernel,
    private readonly fs: SyncFsPosixBridge
  ) {}

  setup(
    cwd: string,
    inherited: ReadonlyArray<{ fd: number; kind?: KernelFdKind; flags?: number }>
  ): void {
    for (const fd of [0, 1, 2]) this.table.set(fd, kernelEntry());
    const preopens = this.preopens(cwd);
    const top = 3 + preopens.length;
    for (const { fd, kind, flags } of inherited) {
      let at = fd;
      if (fd < top) {
        at = this.kernel.call({ op: 'fd-dup', fd, min: top }) as number;
        this.kernel.sys.close(fd);
      }

      const nonblock = ((flags ?? 0) & O_NONBLOCK) !== 0;
      this.table.set(at, { ...kernelEntry(), nonblock, ...(kind ? { kind } : {}) });
    }
    preopens.forEach((entry, i) => {
      this.kernel.call({ op: 'fd-reserve', fd: 3 + i, meta: metaOf(entry) as HeldMeta });
      this.table.set(3 + i, entry);
    });
  }

  private preopens(cwd: string): WasiEntry[] {
    const out: WasiEntry[] = [{ type: 'dir', path: normalize(cwd), preopen: '.' }];
    let names: string[] = [];
    try {
      names = this.fs.readdir('/');
    } catch {
      return out;
    }

    for (const name of [...new Set([...names, 'dev', ...SYNTHETIC_DIRS])].sort()) {
      const path = `/${name}`;
      if (path === '/dev') {
        out.push({ type: 'dir', path, preopen: path });
        continue;
      }
      try {
        if (this.fs.stat(path).isDirectory) out.push({ type: 'dir', path, preopen: path });
      } catch {}
    }
    return out;
  }

  find(fd: number): WasiEntry | undefined {
    if (!this.shared) return this.table.get(fd);
    this.sync();
    return this.table.get(fd) ?? this.fetch(fd);
  }

  private shared: Int32Array | undefined;
  private seen = 0;

  get isShared(): boolean {
    return this.shared !== undefined;
  }

  share(ids: Int32Array, fresh: boolean): void {
    if (!fresh) {
      this.promoteFiles();
      for (const fd of this.cloexec) this.kernel.call({ op: 'fd-cloexec', fd, on: true });
      for (const [fd, e] of this.table) {
        if (e.type === 'kernel' && (e.nonblock || e.append)) this.publishFlags(fd, e);
      }
    } else {
      this.table.clear();
      this.cloexec.clear();
    }
    this.shared = ids;
    this.seen = Atomics.load(ids, GEN);
  }

  private sync(): void {
    const gen = Atomics.load(this.shared as Int32Array, GEN);
    if (gen === this.seen) return;
    this.table.clear();
    this.cloexec.clear();
    this.seen = gen;
  }

  private bump(): void {
    if (!this.shared) return;
    const gen = Atomics.add(this.shared, GEN, 1) + 1;

    if (gen - 1 === this.seen) this.seen = gen;
  }

  private fetch(fd: number): WasiEntry | undefined {
    let info: FdInfo;
    try {
      info = this.kernel.call({ op: 'fd-info', fd }) as FdInfo;
    } catch {
      return undefined;
    }
    const e = entryOf(info);
    if (!e) return undefined;
    this.table.set(fd, e);
    if (info.cloexec) this.cloexec.add(fd);
    return e;
  }

  private listed(): Array<[number, WasiEntry, boolean]> {
    const out: Array<[number, WasiEntry, boolean]> = [];
    for (const info of this.kernel.call({ op: 'fd-list' }) as Array<FdInfo & { fd: number }>) {
      const e = entryOf(info);
      if (e) out.push([info.fd, e, info.cloexec === true]);
    }
    return out;
  }

  private publishFlags(fd: number, e: { nonblock: boolean; append: boolean }): void {
    const flags = (e.nonblock ? O_NONBLOCK : 0) | (e.append ? O_APPEND : 0);
    this.kernel.call({ op: 'fd-setfl', fd, flags });
  }

  setFlags(fd: number, nonblock: boolean, append: boolean): void {
    const e = this.get(fd);
    if (e.type === 'kernel') {
      e.nonblock = nonblock;
      e.append = append;
      if (this.shared) {
        this.publishFlags(fd, e);
        this.bump();
      }
    } else if (e.type === 'file') e.file.append = append;
  }

  setCloexec(fd: number, on: boolean): void {
    this.get(fd);
    if (on) this.cloexec.add(fd);
    else this.cloexec.delete(fd);
    if (this.shared) {
      this.kernel.call({ op: 'fd-cloexec', fd, on });
      this.bump();
    }
  }

  cwd(): string | undefined {
    const dot = this.find(3);
    return dot?.type === 'dir' && dot.preopen === '.' ? dot.path : undefined;
  }

  sockets(): number[] {
    return [...this.table]
      .filter(([, e]) => e.type === 'kernel' && e.kind === 'socket')
      .map(([fd]) => fd)
      .sort((a, b) => a - b);
  }

  terminals(): number[] {
    const fds = this.shared
      ? (this.kernel.call({ op: 'fd-list' }) as Array<FdInfo & { fd: number }>)
          .filter((info) => info.tty)
          .map((info) => info.fd)
      : [...this.table]
          .filter(([, e]) => e.type === 'kernel' && e.kind === 'tty')
          .map(([fd]) => fd);
    return fds.sort((a, b) => a - b);
  }

  adopt(fd: number, kind: KernelFdKind, nonblock: boolean): void {
    this.table.set(fd, { type: 'kernel', kind, nonblock, append: false });
    if (this.shared && nonblock) this.publishFlags(fd, { nonblock, append: false });
    this.bump();
  }

  get(fd: number): WasiEntry {
    const e = this.find(fd);
    if (!e) throw new WasiError('EBADF');
    return e;
  }

  preopen(fd: number): Extract<WasiEntry, { type: 'dir' }> & { preopen: string } {
    const e = this.find(fd);
    if (e?.type !== 'dir' || e.preopen === undefined) throw new WasiError('EBADF');
    return e as Extract<WasiEntry, { type: 'dir' }> & { preopen: string };
  }

  dir(fd: number): Extract<WasiEntry, { type: 'dir' }> {
    const e = this.get(fd);
    if (e.type !== 'dir') throw new WasiError('ENOTDIR');
    return e;
  }

  entries(): IterableIterator<WasiEntry> {
    return this.table.values();
  }

  private install(e: WasiEntry, min = 3): number {
    const meta = metaOf(e);
    const fd = this.kernel.call({
      op: 'fd-reserve',
      ...(min > 3 ? { min } : {}),
      ...(meta ? { meta } : {}),
    }) as number;
    this.table.set(fd, e);
    this.bump();
    return fd;
  }

  readonly cloexec = new Set<number>();

  implicitCloexec = false;

  dup(fd: number, min: number, cloexec: boolean): number {
    const e = this.get(fd);
    let at: number;
    if (e.type === 'kernel') {
      at = this.kernel.call({ op: 'fd-dup', fd, min: Math.max(3, min) }) as number;
      this.table.set(at, { ...e });
    } else {
      if (e.type === 'file') e.file.refs++;
      at = this.install(e.type === 'file' ? e : { ...e }, min);
    }
    if (cloexec) this.setCloexec(at, true);
    this.bump();
    return at;
  }

  pipe(): [number, number] {
    const [r, w] = this.kernel.sys.pipe();
    this.table.set(r, { type: 'kernel', kind: 'stream', nonblock: false, append: false });
    this.table.set(w, { type: 'kernel', kind: 'stream', nonblock: false, append: false });
    this.bump();
    return [r, w];
  }

  chdir(path: string): void {
    const dot = this.find(3);
    if (dot?.type !== 'dir' || dot.preopen !== '.') return;
    dot.path = path;

    this.kernel.call({ op: 'fd-meta', fd: 3, meta: { dir: path, preopen: '.' } });
    this.bump();
  }

  promoteFiles(): void {
    const promoted = new Map<LocalFile, number>();
    for (const [fd, e] of [...this.table]) {
      if (e.type !== 'file') continue;
      const first = promoted.get(e.file);
      if (first !== undefined) {
        this.kernel.call({ op: 'fd-promote', fd, share: first });
      } else {
        const f = e.file;
        this.kernel.call({
          op: 'fd-promote',
          fd,
          path: f.path,
          flags: (f.writable ? (f.readable ? O_RDWR : O_WRONLY) : 0) | (f.append ? O_APPEND : 0),
          position: f.offset,
          contents: f.buffer.contents(),
          ...(f.buffer.isOrphan() ? { orphan: true } : {}),
        });
        promoted.set(f, fd);
      }
      this.table.set(fd, { type: 'kernel', kind: 'file', nonblock: false, append: e.file.append });
    }
    for (const file of promoted.keys()) {
      if (--file.buffer.opens <= 0) this.buffers.delete(file.path);
    }
  }

  snapshot(): WasiForkFd[] {
    const out: WasiForkFd[] = [];

    if (this.shared) return out;
    for (const [fd, e] of this.table) {
      if (e.type === 'kernel')
        out.push({ fd, type: 'kernel', nonblock: e.nonblock, append: e.append });
      else if (e.type === 'dir')
        out.push({ fd, type: 'dir', path: e.path, ...(e.preopen ? { preopen: e.preopen } : {}) });
      else if (e.type === 'device') out.push({ fd, type: 'device', device: e.device });
    }
    return out;
  }

  restore(fds: readonly WasiForkFd[], cloexec: readonly number[]): void {
    this.table.clear();
    for (const f of fds) {
      if (f.type === 'kernel')
        this.table.set(f.fd, { type: 'kernel', nonblock: f.nonblock, append: f.append });
      else if (f.type === 'dir')
        this.table.set(f.fd, {
          type: 'dir',
          path: f.path,
          ...(f.preopen ? { preopen: f.preopen } : {}),
        });
      else this.table.set(f.fd, { type: 'device', device: f.device });
    }
    for (const fd of cloexec) this.cloexec.add(fd);
  }

  inheritable(): Map<number, number> {
    const out = new Map<number, number>();
    const all = this.shared
      ? this.listed()
      : [...this.table].map(([fd, e]): [number, WasiEntry, boolean] => [
          fd,
          e,
          this.cloexec.has(fd),
        ]);
    for (const [fd, e, cloexec] of all) {
      if (e.type !== 'kernel' || cloexec) continue;
      if (this.implicitCloexec && fd > 2) continue;
      out.set(fd, fd);
    }
    return out;
  }

  close(fd: number): void {
    const e = this.get(fd);
    this.table.delete(fd);
    this.cloexec.delete(fd);
    this.kernel.sys.close(fd);
    this.release(e);
    this.bump();
  }

  renumber(from: number, to: number, keep = false): void {
    const e = this.get(from);

    const old = keep ? this.find(to) : this.get(to);
    if (from === to) return;
    this.kernel.call({ op: 'fd-renumber', from, to, ...(keep ? { keep } : {}) });
    this.cloexec.delete(to);
    if (keep) {
      if (e.type === 'file') e.file.refs++;
      this.table.set(to, e.type === 'file' ? e : { ...e });
    } else {
      this.table.delete(from);
      this.table.set(to, e);
      if (this.cloexec.delete(from)) this.cloexec.add(to);
    }
    if (old) this.release(old);
    this.bump();
  }

  private release(e: WasiEntry): void {
    if (e.type !== 'file' || --e.file.refs > 0) return;
    const { buffer } = e.file;
    buffer.flush();
    if (--buffer.opens === 0 && this.buffers.get(buffer.path) === buffer) {
      this.buffers.delete(buffer.path);
    }
  }

  kind(fd: number, e: Extract<WasiEntry, { type: 'kernel' }>): KernelFdKind {
    if (!e.kind) {
      const info = this.kernel.call({ op: 'fd-info', fd }) as {
        tty?: boolean;
        kind?: KernelFdKind;
      };
      e.kind = info.kind ?? (info.tty ? 'tty' : 'stream');
    }
    return e.kind;
  }

  flushAll(): void {
    for (const buffer of this.buffers.values()) buffer.flush();
  }

  flushPath(path: string): void {
    for (const [p, buffer] of this.buffers) if (within(p, path)) buffer.flush();

    if (this.shared) this.kernel.call({ op: 'fd-path-flush', path });
  }

  unlinking(path: string): void {
    this.buffers.get(path)?.load();
    if (this.shared) this.kernel.call({ op: 'fd-path-unlinking', path });
  }

  unlinked(path: string): void {
    if (this.shared) this.kernel.call({ op: 'fd-path-unlinked', path });
    const buffer = this.buffers.get(path);
    if (!buffer) return;
    buffer.orphan();
    this.buffers.delete(path);
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
    if (this.shared) this.kernel.call({ op: 'fd-path-renamed', from, to });
    const moved: Array<[string, FileBuffer]> = [];
    for (const [p, buffer] of this.buffers) {
      if (within(p, from)) moved.push([p, buffer]);
      else if (within(p, to)) {
        buffer.orphan();
        this.buffers.delete(p);
      }
    }
    for (const [p, buffer] of moved) {
      this.buffers.delete(p);
      buffer.path = to + p.slice(from.length);
      this.buffers.set(buffer.path, buffer);
    }
  }

  resolve(dirfd: number, path: string): string {
    if (path.startsWith('/')) return normalize(path);
    return resolveUnder(this.dir(dirfd).path, path);
  }

  open(path: string, oflags: number, rights: bigint, fdflags: number): number {
    const device = deviceOf(path);
    if (device) return this.install({ type: 'device', device });

    if (path === '/dev/tty' || /^\/dev\/tty\d+$/.test(path)) {
      const fd = this.kernel.sys.openTty?.(path === '/dev/tty' ? undefined : path);
      if (fd === undefined) throw new WasiError('ENXIO');
      this.table.set(fd, { ...kernelEntry(), kind: 'tty' });
      this.bump();
      return fd;
    }
    const alias = stdioAlias(path);
    if (alias !== undefined) return this.reopen(alias);
    const s = this.statOrMissing(path);
    if (s && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) throw new WasiError('EEXIST');
    if (oflags & OFLAGS.DIRECTORY && !s?.isDirectory) {
      throw new WasiError(s ? 'ENOTDIR' : 'ENOENT');
    }
    if (s?.isDirectory) return this.install({ type: 'dir', path });
    if (!s && !(oflags & OFLAGS.CREAT)) throw new WasiError('ENOENT');
    if (this.shared) return this.kernelFile(path, s, oflags, rights, fdflags);
    return this.install({ type: 'file', file: this.file(path, s, oflags, rights, fdflags) });
  }

  private file(
    path: string,
    existing: SyncFsBridgeStat | undefined,
    oflags: number,
    rights: bigint,
    fdflags: number
  ): LocalFile {
    const writable =
      (rights & RIGHTS.FD_WRITE) !== 0n || (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) !== 0;
    const readable = (rights & RIGHTS.FD_READ) !== 0n || !writable;
    let buffer = this.buffers.get(path);
    if (buffer) {
      if (oflags & OFLAGS.TRUNC) buffer.truncate(0);
    } else {
      if (!existing) this.fs.writeFile(path, new Uint8Array(0));
      buffer = new FileBuffer(this.fs, path, !existing || (oflags & OFLAGS.TRUNC) !== 0);
      this.buffers.set(path, buffer);
    }
    buffer.opens++;
    return new LocalFile(buffer, readable, writable, (fdflags & FDFLAGS.APPEND) !== 0);
  }

  private kernelFile(
    path: string,
    existing: SyncFsBridgeStat | undefined,
    oflags: number,
    rights: bigint,
    fdflags: number
  ): number {
    const writable =
      (rights & RIGHTS.FD_WRITE) !== 0n || (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) !== 0;
    const readable = (rights & RIGHTS.FD_READ) !== 0n || !writable;
    const append = (fdflags & FDFLAGS.APPEND) !== 0;
    const flags = (writable ? (readable ? O_RDWR : O_WRONLY) : 0) | (append ? O_APPEND : 0);

    if (!existing) this.fs.writeFile(path, new Uint8Array(0));

    const truncate = !existing || (oflags & OFLAGS.TRUNC) !== 0;
    const fd = this.kernel.sys.openVfs(path, flags, 0, truncate ? { truncate } : {});
    this.table.set(fd, { type: 'kernel', kind: 'file', nonblock: false, append });
    if (append) this.publishFlags(fd, { nonblock: false, append });
    this.bump();
    return fd;
  }

  private statOrMissing(path: string): SyncFsBridgeStat | undefined {
    try {
      return this.fs.stat(path);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private reopen(fd: number): number {
    const e = this.get(fd);
    if (e.type === 'kernel') {
      const at = this.kernel.call({ op: 'fd-dup', fd }) as number;
      this.table.set(at, { ...e });
      this.bump();
      return at;
    }
    if (e.type === 'file') e.file.refs++;
    return this.install(e.type === 'file' ? e : { ...e });
  }
}

function kernelEntry(): Extract<WasiEntry, { type: 'kernel' }> {
  return { type: 'kernel', nonblock: false, append: false };
}

const GEN = 2;

function metaOf(e: WasiEntry): HeldMeta | undefined {
  if (e.type === 'dir') return { dir: e.path, ...(e.preopen ? { preopen: e.preopen } : {}) };
  if (e.type === 'device') return { device: e.device };
  return undefined;
}

function entryOf(info: FdInfo): WasiEntry | undefined {
  if (info.meta && 'dir' in info.meta) {
    return {
      type: 'dir',
      path: info.meta.dir,
      ...(info.meta.preopen ? { preopen: info.meta.preopen } : {}),
    };
  }
  if (info.meta && 'device' in info.meta) return { type: 'device', device: info.meta.device };
  if (info.kind === 'held') return undefined;
  return {
    type: 'kernel',
    kind: info.kind,
    nonblock: ((info.flags ?? 0) & O_NONBLOCK) !== 0,
    append: ((info.flags ?? 0) & O_APPEND) !== 0,
  };
}
