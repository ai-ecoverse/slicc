import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-xhr-bridge.js';
import type { KernelFdKind } from '../fd-table.js';
import {
  CLOCK,
  E,
  FDFLAGS,
  FILETYPE,
  FSTFLAGS,
  LOOKUP_SYMLINK_FOLLOW,
  PREOPENTYPE_DIR,
  RIFLAGS,
  RIGHTS,
  SDFLAGS,
  SIZE,
  WASI_SIGNAL_TO_POSIX,
  WHENCE,
  wasiErrnoOf,
} from './wasi-abi.js';
import { deviceOf, WasiFds, type WasiKernel } from './wasi-fds.js';
import {
  type DirListing,
  normalize,
  pathInode,
  resolveUnder,
  type WasiEntry,
  WasiError,
} from './wasi-files.js';
import { WasiMemory } from './wasi-memory.js';
import { pollOneoff } from './wasi-poll.js';

export class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface WasiHostOptions {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  pid: number;
  kernel: WasiKernel;
  fs: SyncFsPosixBridge;

  inherited?: ReadonlyArray<{ fd: number; kind?: KernelFdKind; flags?: number }>;
}

type WasiFunction = (...args: never[]) => number | undefined;

const NS_PER_MS = 1_000_000n;

const MAX_READ = 1024 * 1024;
const SIGPIPE_EXIT = 141;

interface Filestat {
  filetype: number;
  size: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

function filetypeOf(s: SyncFsBridgeStat | null | undefined): number {
  if (!s) return FILETYPE.UNKNOWN;
  if (s.isSymbolicLink) return FILETYPE.SYMBOLIC_LINK;
  if (s.isDirectory) return FILETYPE.DIRECTORY;
  return s.isFile ? FILETYPE.REGULAR_FILE : FILETYPE.UNKNOWN;
}

function filestatOf(path: string, s: SyncFsBridgeStat): Filestat {
  return {
    filetype: filetypeOf(s),
    size: BigInt(s.size ?? 0),
    ino: s.ino !== undefined ? BigInt(s.ino) : pathInode(path),
    mtimeNs: BigInt(Math.round(s.mtimeMs ?? 0)) * NS_PER_MS,
  };
}

function kernelFiletype(kind: string): { filetype: number; seeks: boolean } {
  switch (kind) {
    case 'tty':
      return { filetype: FILETYPE.CHARACTER_DEVICE, seeks: false };
    case 'socket':
      return { filetype: FILETYPE.SOCKET_STREAM, seeks: false };
    case 'file':
      return { filetype: FILETYPE.REGULAR_FILE, seeks: true };
    default:
      return { filetype: FILETYPE.UNKNOWN, seeks: false };
  }
}

export class WasiHost {
  readonly mem = new WasiMemory();
  readonly fds: WasiFds;
  private readonly started = performance.now();
  private cache: Record<string, WasiFunction> | undefined;

  private readonly listening: number[];

  constructor(private readonly o: WasiHostOptions) {
    this.fds = new WasiFds(o.kernel, o.fs);
    this.fds.setup(o.cwd, o.inherited ?? []);
    this.listening = this.fds.sockets();
  }

  imports(): Record<string, WasiFunction> {
    this.cache ??= wrap({
      ...this.processImports(),
      ...this.ioImports(),
      ...this.statImports(),
      ...this.pathImports(),
      poll_oneoff: (inPtr: number, outPtr: number, n: number, nevents: number) =>
        pollOneoff(
          { mem: this.mem, fds: this.fds, kernel: this.o.kernel, now: (id) => this.now(id) },
          inPtr,
          outPtr,
          n,
          nevents
        ),
      ...this.socketImports(),
    });
    return this.cache;
  }

  now(id: number): bigint {
    if (id === CLOCK.REALTIME) return BigInt(Date.now()) * NS_PER_MS;
    return BigInt(Math.round((performance.now() - this.started) * 1e6)) + 1n;
  }

  private environ(): string[] {
    const listen = this.listening.length > 0 ? { SLICC_LISTEN_FDS: this.listening.join(' ') } : {};
    const env = { PWD: this.o.cwd, ...this.o.env, ...listen };
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  private processImports(): Record<string, WasiFunction> {
    const { mem } = this;
    return {
      args_get: (argv: number, buf: number) => void mem.putStrings(this.o.args, argv, buf),
      args_sizes_get: (n: number, size: number) => void mem.putSizes(this.o.args, n, size),
      environ_get: (envp: number, buf: number) => void mem.putStrings(this.environ(), envp, buf),
      environ_sizes_get: (n: number, size: number) => void mem.putSizes(this.environ(), n, size),
      clock_res_get: (_id: number, out: number) => void mem.view().setBigUint64(out, 1000n, true),
      clock_time_get: (id: number, _precision: bigint, out: number) =>
        void mem.view().setBigUint64(out, this.now(id), true),
      random_get: (buf: number, len: number) => {
        for (let at = 0; at < len; at += 65536) {
          const chunk = new Uint8Array(Math.min(65536, len - at));
          crypto.getRandomValues(chunk);
          mem.bytes(buf + at, chunk.length).set(chunk);
        }
      },
      sched_yield: () => E.SUCCESS,
      proc_exit: (code: number) => {
        throw new WasiExit(code);
      },
      proc_raise: (sig: number) => {
        const posix = WASI_SIGNAL_TO_POSIX[sig];
        if (posix === undefined) throw new WasiError('EINVAL');
        this.o.kernel.call({ op: 'proc-kill', pid: this.o.pid, sig: posix });
      },
    };
  }

  private ioImports(): Record<string, WasiFunction> {
    const { mem, fds } = this;
    return {
      fd_write: (fd: number, iovs: number, n: number, out: number) =>
        void mem.view().setUint32(out, this.write(fd, mem.gather(iovs, n)), true),
      fd_read: (fd: number, iovs: number, n: number, out: number) => {
        const data = this.read(fd, mem.capacity(iovs, n));
        mem.view().setUint32(out, mem.scatter(iovs, n, data), true);
      },
      fd_pread: (fd: number, iovs: number, n: number, at: bigint, out: number) => {
        const data = this.file(fd, 'read').pread(mem.capacity(iovs, n), Number(at));
        mem.view().setUint32(out, mem.scatter(iovs, n, data), true);
      },
      fd_pwrite: (fd: number, iovs: number, n: number, at: bigint, out: number) =>
        void mem
          .view()
          .setUint32(out, this.file(fd, 'write').pwrite(mem.gather(iovs, n), Number(at)), true),
      fd_seek: (fd: number, offset: bigint, whence: number, out: number) =>
        void mem.view().setBigUint64(out, BigInt(this.seek(fd, Number(offset), whence)), true),
      fd_tell: (fd: number, out: number) =>
        void mem.view().setBigUint64(out, BigInt(this.seek(fd, 0, WHENCE.CUR)), true),
      fd_close: (fd: number) => void fds.close(fd),
      fd_renumber: (from: number, to: number) => void fds.renumber(from, to),
      fd_sync: (fd: number) => void this.sync(fd),
      fd_datasync: (fd: number) => void this.sync(fd),
      fd_advise: (fd: number) => void fds.get(fd),
      fd_allocate: (fd: number, offset: bigint, len: bigint) => {
        const file = this.file(fd);
        const end = Number(offset + len);
        if (end > file.size()) file.truncate(end);
      },
    };
  }

  private statImports(): Record<string, WasiFunction> {
    const { mem, fds } = this;
    return {
      fd_fdstat_get: (fd: number, out: number) => void this.fdstat(fd, out),
      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const e = fds.get(fd);
        if (e.type === 'kernel') {
          e.nonblock = (flags & FDFLAGS.NONBLOCK) !== 0;
          e.append = (flags & FDFLAGS.APPEND) !== 0;
        } else if (e.type === 'file') e.file.append = (flags & FDFLAGS.APPEND) !== 0;
      },
      fd_fdstat_set_rights: (fd: number) => void fds.get(fd),
      fd_filestat_get: (fd: number, out: number) =>
        void this.writeFilestat(out, this.fdFilestat(fd)),
      fd_filestat_set_size: (fd: number, size: bigint) => void this.file(fd).truncate(Number(size)),
      fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) => {
        const e = fds.get(fd);
        if (e.type === 'file') {
          e.file.flush();
          this.setTimes(e.file.path, atim, mtim, flags);
        } else if (e.type === 'dir') this.setTimes(e.path, atim, mtim, flags);
      },
      fd_prestat_get: (fd: number, out: number) => {
        const name = new TextEncoder().encode(fds.preopen(fd).preopen);
        mem.view().setUint8(out, PREOPENTYPE_DIR);
        mem.view().setUint32(out + 4, name.length, true);
      },
      fd_prestat_dir_name: (fd: number, buf: number, len: number) => {
        const name = new TextEncoder().encode(fds.preopen(fd).preopen);
        mem.bytes(buf, Math.min(len, name.length)).set(name.subarray(0, len));
      },
      fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) =>
        void this.readdir(fd, buf, len, Number(cookie), used),
    };
  }

  private pathImports(): Record<string, WasiFunction> {
    const { mem, fds, o } = this;
    const at = (dirfd: number, p: number, l: number) => fds.resolve(dirfd, mem.string(p, l));
    return {
      path_open: (
        dirfd: number,
        _lookup: number,
        p: number,
        l: number,
        oflags: number,
        rights: bigint,
        _inheriting: bigint,
        fdflags: number,
        out: number
      ) => void mem.view().setUint32(out, fds.open(at(dirfd, p, l), oflags, rights, fdflags), true),
      path_filestat_get: (dirfd: number, lookup: number, p: number, l: number, out: number) =>
        void this.writeFilestat(out, this.pathFilestat(at(dirfd, p, l), lookup)),
      path_filestat_set_times: (
        dirfd: number,
        _lookup: number,
        p: number,
        l: number,
        atim: bigint,
        mtim: bigint,
        flags: number
      ) => {
        const path = at(dirfd, p, l);
        fds.flushPath(path);
        this.setTimes(path, atim, mtim, flags);
      },
      path_create_directory: (dirfd: number, p: number, l: number) => {
        const path = at(dirfd, p, l);
        if (o.fs.exists(path)) throw new WasiError('EEXIST');
        o.fs.mkdir(path);
      },
      path_remove_directory: (dirfd: number, p: number, l: number) =>
        void o.fs.rmdir(at(dirfd, p, l)),
      path_unlink_file: (dirfd: number, p: number, l: number) => {
        const path = at(dirfd, p, l);
        if (o.fs.lstat(path).isDirectory) throw new WasiError('EISDIR');
        fds.unlinking(path);
        o.fs.unlink(path);
        fds.unlinked(path);
      },
      path_rename: (fd: number, p: number, l: number, fd2: number, p2: number, l2: number) => {
        const from = at(fd, p, l);
        const to = at(fd2, p2, l2);
        fds.flushPath(from);
        o.fs.rename(from, to);
        fds.renamed(from, to);
      },
      path_symlink: (tp: number, tl: number, dirfd: number, p: number, l: number) =>
        void o.fs.symlink(mem.string(tp, tl), at(dirfd, p, l)),
      path_readlink: (
        dirfd: number,
        p: number,
        l: number,
        buf: number,
        len: number,
        used: number
      ) => {
        const target = new TextEncoder().encode(o.fs.readlink(at(dirfd, p, l)));
        const n = Math.min(len, target.length);
        mem.bytes(buf, n).set(target.subarray(0, n));
        mem.view().setUint32(used, n, true);
      },

      path_link: () => E.NOTSUP,
    };
  }

  private socket(fd: number): Extract<WasiEntry, { type: 'kernel' }> {
    const e = this.fds.get(fd);
    if (e.type !== 'kernel' || this.fds.kind(fd, e) !== 'socket') throw new WasiError('ENOTSOCK');
    return e;
  }

  private socketImports(): Record<string, WasiFunction> {
    const { mem, fds, o } = this;
    return {
      sock_accept: (fd: number, flags: number, out: number) => {
        const listener = this.socket(fd);
        const r = o.kernel.call({ op: 'sock-accept', fd, nonblock: listener.nonblock }) as {
          fd: number;
        };
        fds.adopt(r.fd, 'socket', (flags & FDFLAGS.NONBLOCK) !== 0);
        mem.view().setUint32(out, r.fd, true);
      },
      sock_recv: (
        fd: number,
        iovs: number,
        n: number,
        riflags: number,
        outLen: number,
        outFlags: number
      ) => {
        const e = this.socket(fd);
        const peek = (riflags & RIFLAGS.PEEK) !== 0;
        const want = mem.capacity(iovs, n);
        const data =
          (riflags & RIFLAGS.WAITALL) !== 0 && !peek
            ? this.recvAll(fd, want, e.nonblock)
            : o.kernel.sys.read(fd, Math.min(want, MAX_READ), { nonblock: e.nonblock, peek });
        mem.view().setUint32(outLen, mem.scatter(iovs, n, data), true);
        mem.view().setUint16(outFlags, 0, true);
      },

      sock_send: (fd: number, iovs: number, n: number, _flags: number, out: number) => {
        const e = this.socket(fd);
        const sent = o.kernel.sys.write(fd, mem.gather(iovs, n), { nonblock: e.nonblock });
        mem.view().setUint32(out, sent, true);
      },
      sock_shutdown: (fd: number, how: number) => {
        this.socket(fd);
        const both = SDFLAGS.RD | SDFLAGS.WR;
        if (how === 0 || (how & ~both) !== 0) throw new WasiError('EINVAL');

        o.kernel.call({
          op: 'sock-shutdown',
          fd,
          how: how === both ? 2 : how === SDFLAGS.WR ? 1 : 0,
        });
      },
    };
  }

  private recvAll(fd: number, want: number, nonblock: boolean): Uint8Array {
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < want) {
      let chunk: Uint8Array;
      try {
        chunk = this.o.kernel.sys.read(fd, Math.min(want - got, MAX_READ), { nonblock });
      } catch (err) {
        if (got === 0) throw err;
        break;
      }
      if (chunk.length === 0) break;
      chunks.push(chunk);
      got += chunk.length;
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private file(fd: number, access?: 'read' | 'write') {
    const e = this.fds.get(fd);
    if (e.type !== 'file') {
      throw new WasiError(e.type === 'dir' ? 'EISDIR' : e.type === 'kernel' ? 'ESPIPE' : 'EINVAL');
    }
    if ((access === 'read' && !e.file.readable) || (access === 'write' && !e.file.writable)) {
      throw new WasiError('EBADF');
    }
    return e.file;
  }

  private write(fd: number, data: Uint8Array): number {
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      try {
        return this.o.kernel.sys.write(fd, data, { nonblock: e.nonblock });
      } catch (err) {
        if ((err as { code?: string }).code === 'EPIPE') throw new WasiExit(SIGPIPE_EXIT);
        throw err;
      }
    }
    if (e.type === 'device') return data.length;
    return this.file(fd, 'write').write(data);
  }

  private read(fd: number, max: number): Uint8Array {
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      return this.o.kernel.sys.read(fd, Math.min(max, MAX_READ), { nonblock: e.nonblock });
    }
    if (e.type === 'device') {
      if (e.device === 'null') return new Uint8Array(0);
      const out = new Uint8Array(Math.min(max, 65536));
      return e.device === 'zero' ? out : crypto.getRandomValues(out);
    }
    return this.file(fd, 'read').read(max);
  }

  private seek(fd: number, offset: number, whence: number): number {
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      if (this.fds.kind(fd, e) !== 'file') throw new WasiError('ESPIPE');
      return this.o.kernel.sys.seek(fd, offset, whence);
    }
    if (e.type === 'device') return 0;
    const file = this.file(fd);
    const base = whence === WHENCE.SET ? 0 : whence === WHENCE.CUR ? file.offset : file.size();
    if (whence > WHENCE.END || base + offset < 0) throw new WasiError('EINVAL');
    file.offset = base + offset;
    return file.offset;
  }

  private sync(fd: number): void {
    const e = this.fds.get(fd);
    if (e.type === 'file') e.file.flush();
    else if (e.type === 'kernel' && this.fds.kind(fd, e) === 'file') this.o.kernel.sys.flush(fd);
  }

  private fdstat(fd: number, out: number): void {
    const e = this.fds.get(fd);
    let filetype: number = FILETYPE.CHARACTER_DEVICE;
    let seeks = true;
    let flags = 0;
    if (e.type === 'kernel') {
      ({ filetype, seeks } = kernelFiletype(this.fds.kind(fd, e)));
      if (e.nonblock) flags |= FDFLAGS.NONBLOCK;
      if (e.append) flags |= FDFLAGS.APPEND;
    } else if (e.type === 'file') {
      filetype = FILETYPE.REGULAR_FILE;
      if (e.file.append) flags |= FDFLAGS.APPEND;
    } else if (e.type === 'dir') filetype = FILETYPE.DIRECTORY;
    const v = this.mem.view();
    v.setUint8(out, filetype);
    v.setUint16(out + 2, flags, true);

    const rights = seeks ? RIGHTS.ALL : RIGHTS.ALL & ~(RIGHTS.FD_SEEK | RIGHTS.FD_TELL);
    v.setBigUint64(out + 8, rights, true);
    v.setBigUint64(out + 16, RIGHTS.ALL, true);
  }

  private writeFilestat(ptr: number, f: Filestat): void {
    const v = this.mem.view();
    v.setBigUint64(ptr, 1n, true);
    v.setBigUint64(ptr + 8, f.ino, true);
    v.setUint8(ptr + 16, f.filetype);
    v.setBigUint64(ptr + 24, 1n, true);
    v.setBigUint64(ptr + 32, f.size, true);
    v.setBigUint64(ptr + 40, f.mtimeNs, true);
    v.setBigUint64(ptr + 48, f.mtimeNs, true);
    v.setBigUint64(ptr + 56, f.mtimeNs, true);
  }

  private fdFilestat(fd: number): Filestat {
    const e = this.fds.get(fd);
    if (e.type === 'dir') return filestatOf(e.path, this.o.fs.stat(e.path));
    if (e.type === 'file') {
      let s: SyncFsBridgeStat | undefined;
      try {
        s = this.o.fs.stat(e.file.path);
      } catch {}

      return {
        ...filestatOf(e.file.path, s ?? { isFile: true, isDirectory: false, size: 0 }),
        size: BigInt(e.file.size()),
      };
    }
    const filetype =
      e.type === 'kernel'
        ? kernelFiletype(this.fds.kind(fd, e)).filetype
        : FILETYPE.CHARACTER_DEVICE;
    return { filetype, size: 0n, ino: BigInt(fd + 1), mtimeNs: 0n };
  }

  private pathFilestat(path: string, lookup: number): Filestat {
    if (deviceOf(path)) {
      return { filetype: FILETYPE.CHARACTER_DEVICE, size: 0n, ino: pathInode(path), mtimeNs: 0n };
    }
    this.fds.flushPath(path);
    const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
    return filestatOf(path, follow ? this.o.fs.stat(path) : this.o.fs.lstat(path));
  }

  private setTimes(path: string, atim: bigint, mtim: bigint, flags: number): void {
    const now = Date.now();
    let current: number | undefined;
    const kept = (): number => (current ??= this.o.fs.stat(path).mtimeMs ?? now);
    const pick = (set: number, setNow: number, value: bigint): number =>
      flags & setNow ? now : flags & set ? Number(value / NS_PER_MS) : kept();
    this.o.fs.utimes(
      path,
      pick(FSTFLAGS.ATIM, FSTFLAGS.ATIM_NOW, atim),
      pick(FSTFLAGS.MTIM, FSTFLAGS.MTIM_NOW, mtim)
    );
  }

  private readdir(fd: number, buf: number, len: number, cookie: number, usedPtr: number): void {
    const dir = this.fds.dir(fd);
    if (cookie === 0 || !dir.listing) dir.listing = this.list(dir.path);
    const { names, stats } = dir.listing;
    let at = 0;
    for (let i = cookie; i < names.length && at < len; i++) {
      const name = names[i];
      const full =
        name === '.'
          ? dir.path
          : name === '..'
            ? normalize(`${dir.path}/..`)
            : resolveUnder(dir.path, name);
      if (!stats.has(name)) stats.set(name, this.lstatOrNull(full));
      const st = stats.get(name) ?? null;
      const record = direntRecord(
        i + 1,
        st?.ino !== undefined ? BigInt(st.ino) : pathInode(full),
        name,
        filetypeOf(st)
      );
      const n = Math.min(record.length, len - at);
      this.mem.bytes(buf + at, n).set(record.subarray(0, n));
      at += n;
    }
    this.mem.view().setUint32(usedPtr, at, true);
  }

  private list(path: string): DirListing {
    const { fs } = this.o;
    if (!fs.readdirStat) return { names: ['.', '..', ...fs.readdir(path)], stats: new Map() };
    const listed = fs.readdirStat(path);
    return { names: ['.', '..', ...listed.map(([name]) => name)], stats: new Map(listed) };
  }

  private lstatOrNull(path: string): SyncFsBridgeStat | null {
    try {
      return this.o.fs.lstat(path);
    } catch {
      return null;
    }
  }

  flushAll(): void {
    this.fds.flushAll();
  }
}

function direntRecord(next: number, ino: bigint, name: string, filetype: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const record = new Uint8Array(SIZE.DIRENT + nameBytes.length);
  const v = new DataView(record.buffer);
  v.setBigUint64(0, BigInt(next), true);
  v.setBigUint64(8, ino, true);
  v.setUint32(16, nameBytes.length, true);
  v.setUint8(20, filetype);
  record.set(nameBytes, SIZE.DIRENT);
  return record;
}

function wrap(table: Record<string, WasiFunction>): Record<string, WasiFunction> {
  const out: Record<string, WasiFunction> = {};
  for (const [name, fn] of Object.entries(table)) {
    out[name] = (...args: never[]) => {
      try {
        return fn(...args) ?? E.SUCCESS;
      } catch (e) {
        if (e instanceof WasiExit) throw e;
        if (e instanceof WasiError) return wasiErrnoOf(e.code);
        const code = (e as { code?: unknown } | null)?.code;
        if (typeof code === 'string') return wasiErrnoOf(code);
        if (e instanceof RangeError) return E.FAULT;
        throw e;
      }
    };
  }
  return out;
}
