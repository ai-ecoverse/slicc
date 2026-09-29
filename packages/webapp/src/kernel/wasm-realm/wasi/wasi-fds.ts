import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-xhr-bridge.js';
import type { KernelFdKind } from '../fd-table.js';
import type { ProcessSys } from '../kernel-streams.js';
import type { WasmSyscall } from '../process.js';
import { FDFLAGS, OFLAGS, RIGHTS } from './wasi-abi.js';
import {
  FileBuffer,
  LocalFile,
  normalize,
  resolveUnder,
  type WasiEntry,
  WasiError,
} from './wasi-files.js';

export interface WasiKernel {
  sys: ProcessSys;

  call(req: WasmSyscall): unknown;
}

type Device = 'null' | 'zero' | 'urandom';

const O_NONBLOCK = 0o4000;

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
      this.kernel.call({ op: 'fd-reserve', fd: 3 + i });
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

    for (const name of [...new Set([...names, 'dev'])].sort()) {
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
    return this.table.get(fd);
  }

  sockets(): number[] {
    return [...this.table]
      .filter(([, e]) => e.type === 'kernel' && e.kind === 'socket')
      .map(([fd]) => fd)
      .sort((a, b) => a - b);
  }

  adopt(fd: number, kind: KernelFdKind, nonblock: boolean): void {
    this.table.set(fd, { type: 'kernel', kind, nonblock, append: false });
  }

  get(fd: number): WasiEntry {
    const e = this.table.get(fd);
    if (!e) throw new WasiError('EBADF');
    return e;
  }

  preopen(fd: number): Extract<WasiEntry, { type: 'dir' }> & { preopen: string } {
    const e = this.table.get(fd);
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

  private install(e: WasiEntry): number {
    const fd = this.kernel.call({ op: 'fd-reserve' }) as number;
    this.table.set(fd, e);
    return fd;
  }

  close(fd: number): void {
    const e = this.get(fd);
    this.table.delete(fd);
    this.kernel.sys.close(fd);
    this.release(e);
  }

  renumber(from: number, to: number): void {
    const e = this.get(from);
    const old = this.get(to);
    if (from === to) return;
    this.kernel.call({ op: 'fd-renumber', from, to });
    this.table.delete(from);
    this.table.set(to, e);
    this.release(old);
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
  }

  unlinking(path: string): void {
    this.buffers.get(path)?.load();
  }

  unlinked(path: string): void {
    const buffer = this.buffers.get(path);
    if (!buffer) return;
    buffer.orphan();
    this.buffers.delete(path);
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
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
    if (path === '/dev/tty') {
      const fd = this.kernel.sys.openTty?.();
      if (fd === undefined) throw new WasiError('ENXIO');
      this.table.set(fd, { ...kernelEntry(), kind: 'tty' });
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
      return at;
    }
    if (e.type === 'file') e.file.refs++;
    return this.install(e.type === 'file' ? e : { ...e });
  }
}

function kernelEntry(): Extract<WasiEntry, { type: 'kernel' }> {
  return { type: 'kernel', nonblock: false, append: false };
}
