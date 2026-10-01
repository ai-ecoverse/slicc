import type { EmscriptenFsForHook } from '../realm/emscripten-vfs-hook.js';
import type { PollState } from './fd-table.js';
import type { Termios } from './tty.js';
import { wasiErrno } from './wasi-errno.js';

const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;

export const O_NONBLOCK = 0o4000;

const SOCKET_MODE = 0o140777;

interface PtyPathFs {
  chown?: (path: string, ...rest: number[]) => void;
  lchown?: (path: string, ...rest: number[]) => void;
  chmod?: (path: string, ...rest: number[]) => void;
  lchmod?: (path: string, ...rest: number[]) => void;
  stat?: (path: string, ...rest: unknown[]) => unknown;
  lstat?: (path: string, ...rest: unknown[]) => unknown;
}

const PTY_PATH = /^\/dev\/(?:ptmx|pts\/(\d+))$/;

function isPtyPath(path: string): boolean {
  return PTY_PATH.test(path);
}

function ptyStat(path: string): object {
  const n = PTY_PATH.exec(path)?.[1];
  const now = new Date();
  return {
    dev: 0x16,
    ino: n === undefined ? 2 : 3 + Number(n),
    mode: n === undefined ? 0o20666 : 0o20620,
    nlink: 1,
    uid: 1000,
    gid: 1000,
    rdev: n === undefined ? (5 << 8) | 2 : (136 << 8) | Number(n),
    size: 0,
    blksize: 4096,
    blocks: 0,
    atime: now,
    mtime: now,
    ctime: now,
  };
}

const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_NOCTTY = 0o400;
const O_TRUNC = 0o1000;

const KILLED_BY_SIGPIPE = 128 + 13;

export class ProcessExit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

export class SyscallError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ReadOptions {
  nonblock?: boolean;
  peek?: boolean;
}

export interface ProcessSys {
  read(fd: number, max: number, opts?: ReadOptions): Uint8Array;

  write(fd: number, bytes: Uint8Array, opts?: { nonblock?: boolean }): number;
  close(fd: number): void;

  pipe(): [number, number];
  poll(fd: number): PollState;

  openVfs(
    path: string,
    flags: number,
    position: number,
    opts?: { contents?: Uint8Array; orphan?: boolean; truncate?: boolean }
  ): number;

  seek(fd: number, offset: number, whence: number): number;

  flush(fd: number): void;

  pread?(fd: number, max: number, at: number): Uint8Array;

  isatty?(fd: number): boolean;

  openTty?(): number;

  tcgets?(fd: number): Termios;
  tcsets?(fd: number, termios: Termios): void;
  winsize?(fd: number): [number, number];

  openPty?(): number;
  openPts?(n: number, noctty: boolean): number;

  ptyNumbers?(): number[];
}

export interface StreamOps {
  getattr?: (stream: ProcessStream) => object;
  llseek?: (stream: ProcessStream, offset: number, whence: number) => number;
  read?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  close?: (stream: ProcessStream) => void;
  dup?: (stream: ProcessStream) => void;
  poll?: (stream: ProcessStream) => number;
  fsync?: () => number;
}

export interface ProcessStream {
  fd: number;
  stream_ops: StreamOps;
  sliccKernelFd?: number;

  sliccKernelFile?: boolean;

  sliccKernelSocket?: boolean;

  sliccCloexec?: boolean;
  path?: string;
  flags: number;
  position: number;
  tty?: unknown;
  node: {
    mode: number;
    mount?: { type?: unknown };
    node_ops?: { getattr?: (node: ProcessStream['node']) => object };
  };

  shared: object;
}

interface FsNode {
  mode: number;
  node_ops: object;
}

interface SocketNodeFs {
  mount(type: { mount(): FsNode }, opts: object, mountpoint: null): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, rdev: number): FsNode;
  createStream(stream: object, fd?: number): ProcessStream;
}

export interface ProcessFs extends EmscriptenFsForHook {
  streams: (ProcessStream | null | undefined)[];
  getStream(fd: number): ProcessStream | null;
  open(path: string, flags: number, mode?: number): ProcessStream;
  dupStream(stream: ProcessStream, fd: number): ProcessStream;
  closeStream(fd: number): void;

  close?(stream: ProcessStream): void;
  isFile(mode: number): boolean;
  mkdirTree(path: string): void;
  cwd(): string;
  read(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;
  write(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;

  stat?(path: string, dontFollow?: boolean): object;
  fstat?(fd: number): object;
  symlink?(target: string, path: string): void;
  lookupPath?(path: string, opts?: { follow?: boolean }): { node: object };
}

export interface ProcessPipeFs {
  createPipe(): { readable_fd: number; writable_fd: number };
}

export interface KernelStreamOptions {
  sigpipe?: () => boolean;

  restartable?: () => boolean;
}

function nonblocking(stream: ProcessStream): boolean {
  return stream.sliccKernelSocket === true && (stream.flags & O_NONBLOCK) !== 0;
}

export class KernelStreams {
  private readonly refs = new Map<number, number>();

  private socketRoot: FsNode | undefined;
  private sockets = 0;

  constructor(
    private readonly Fs: ProcessFs,
    private readonly sys: ProcessSys,
    private readonly options: KernelStreamOptions = {}
  ) {}

  attach(stream: ProcessStream, kfd: number, terminal?: boolean): void {
    this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);

    stream.sliccKernelFd = kfd;
    stream.stream_ops = this.ops(kfd, stream.stream_ops);
    if (terminal ?? this.sys.isatty?.(kfd) ?? false) stream.tty = this.ttyOps(kfd);
    else delete stream.tty;
  }

  private ttyOps(kfd: number): object {
    return {
      ops: {
        ioctl_tcgets: () => this.call(() => this.sys.tcgets?.(kfd)),
        ioctl_tcsets: (_tty: unknown, _op: number, termios: Termios) =>
          this.call(() => {
            this.sys.tcsets?.(kfd, termios);
            return 0;
          }),
        ioctl_tiocgwinsz: () => this.call(() => this.sys.winsize?.(kfd) ?? [24, 80]),
        fsync: () => {},
      },
    };
  }

  attachFile(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelFile = true;
    stream.stream_ops = {
      ...stream.stream_ops,
      llseek: (_s, offset, whence) => this.call(() => this.sys.seek(kfd, offset, whence)),

      fsync: () =>
        this.call(() => {
          this.sys.flush(kfd);
          return 0;
        }),
    };
  }

  useControllingTerminal(): void {
    if (typeof this.Fs.open !== 'function') return;
    this.usePtyPaths();
    const open = this.Fs.open.bind(this.Fs);
    this.Fs.open = (path, flags, mode) => {
      const pty = this.openPty(open, path, flags, mode);
      if (pty) return pty;
      const stream = open(path, flags, mode);

      if (!stream.tty) return stream;
      if (stream.path === '/dev/tty' && this.sys.openTty) {
        let kfd: number;
        try {
          kfd = this.call(() => this.sys.openTty?.() as number);
        } catch (e) {
          this.Fs.closeStream(stream.fd);
          throw e;
        }
        this.attach(stream, kfd, true);
        return stream;
      }

      const terminal = this.stdioTerminal();
      if (terminal !== undefined) this.attach(stream, terminal, true);
      return stream;
    };
  }

  private openPty(
    open: NonNullable<ProcessFs['open']>,
    path: string,
    flags: number,
    mode?: number
  ): ProcessStream | undefined {
    const pts = /^\/dev\/pts\/(\d+)$/.exec(path);
    if (path !== '/dev/ptmx' && !pts) return undefined;
    const { openPty, openPts } = this.sys;
    if (!openPty || !openPts) return undefined;
    const kfd = this.call(() =>
      pts ? openPts(Number(pts[1]), (flags & O_NOCTTY) !== 0) : openPty()
    ) as number;
    let stream: ProcessStream;
    try {
      stream = open('/dev/null', flags & ~(O_CREAT | O_EXCL | O_TRUNC), mode);
    } catch (e) {
      this.sys.close(kfd);
      throw e;
    }

    this.attach(stream, kfd, true);
    return stream;
  }

  private usePtyPaths(): void {
    const fs = this.Fs as unknown as PtyPathFs;
    for (const name of ['chown', 'lchown', 'chmod', 'lchmod'] as const) {
      const original = fs[name];
      if (typeof original !== 'function') continue;
      fs[name] = (path: string, ...rest: number[]) =>
        isPtyPath(path) ? this.existingPty(path) : original.call(fs, path, ...rest);
    }
    for (const name of ['stat', 'lstat'] as const) {
      const original = fs[name];
      if (typeof original !== 'function') continue;
      fs[name] = (path: string, ...rest: unknown[]) => {
        if (!isPtyPath(path)) return original.call(fs, path, ...rest);
        this.existingPty(path);
        return ptyStat(path);
      };
    }
  }

  private existingPty(path: string): void {
    const n = PTY_PATH.exec(path)?.[1];
    const exists =
      n === undefined
        ? this.sys.openPty !== undefined
        : (this.sys.ptyNumbers?.().includes(Number(n)) ?? false);
    if (!exists) throw new this.Fs.ErrnoError(wasiErrno('ENOENT'));
  }

  private stdioTerminal(): number | undefined {
    for (const fd of [0, 1, 2]) {
      const stream = this.Fs.getStream(fd);
      if (stream?.sliccKernelFd !== undefined && stream.tty) return stream.sliccKernelFd;
    }
    return undefined;
  }

  attachSocket(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelSocket = true;
  }

  socketStream(flags: number): ProcessStream {
    const fs = this.Fs as unknown as Partial<SocketNodeFs>;
    if (!fs.mount || !fs.createNode || !fs.createStream) {
      const stream = this.Fs.open('/dev/null', 2);
      stream.flags = flags;
      return stream;
    }
    this.socketRoot ??= fs.mount(
      { mount: () => (fs.createNode as SocketNodeFs['createNode'])(null, '/', 0o40777, 0) },
      {},
      null
    );
    const ino = ++this.sockets;
    const node = fs.createNode(this.socketRoot, `socket:${ino}`, SOCKET_MODE, 0);
    const now = new Date();
    const stat = { dev: 0, ino, mode: SOCKET_MODE, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0 };
    const times = { atime: now, mtime: now, ctime: now, blksize: 4096, blocks: 0 };
    node.node_ops = { getattr: () => ({ ...stat, ...times }) };
    return fs.createStream({ node, flags, seekable: false, position: 0, stream_ops: {} });
  }

  usePipes(pipefs: ProcessPipeFs): void {
    const createPipe = pipefs.createPipe.bind(pipefs);
    pipefs.createPipe = () => {
      const [read, write] = this.call(() => this.sys.pipe());

      let fds: ReturnType<ProcessPipeFs['createPipe']>;
      try {
        fds = createPipe();
      } catch (e) {
        for (const kfd of [read, write]) {
          try {
            this.sys.close(kfd);
          } catch {}
        }
        throw e;
      }
      this.attach(this.Fs.getStream(fds.readable_fd) as ProcessStream, read, false);
      this.attach(this.Fs.getStream(fds.writable_fd) as ProcessStream, write, false);
      return fds;
    };
  }

  private restarting<T>(syscall: () => T): T {
    for (;;) {
      try {
        return syscall();
      } catch (e) {
        if (!(e instanceof SyscallError && e.code === 'EINTR' && this.options.restartable?.())) {
          throw e;
        }
      }
    }
  }

  private call<T>(syscall: () => T): T {
    try {
      return syscall();
    } catch (e) {
      if (e instanceof SyscallError) throw new this.Fs.ErrnoError(wasiErrno(e.code));
      throw e;
    }
  }

  private ops(kfd: number, base: StreamOps): StreamOps {
    return {
      ...base,

      llseek: () =>
        this.call(() => {
          throw new SyscallError('ESPIPE');
        }),
      read: (s, buffer, offset, length) =>
        this.call(() => {
          const opts = nonblocking(s) ? { nonblock: true } : undefined;
          const bytes = this.restarting(() => this.sys.read(kfd, length, opts));
          buffer.set(bytes, offset);
          return bytes.length;
        }),
      write: (s, buffer, offset, length) => {
        try {
          const bytes = buffer.slice(offset, offset + length);
          const opts = nonblocking(s) ? { nonblock: true } : undefined;
          return this.restarting(() => this.sys.write(kfd, bytes, opts));
        } catch (e) {
          if (e instanceof SyscallError && e.code === 'EPIPE' && !this.options.sigpipe?.()) {
            throw new ProcessExit(KILLED_BY_SIGPIPE);
          }
          return this.call(() => {
            throw e;
          });
        }
      },
      fsync: () => 0,
      poll: () => {
        const state = this.call(() => this.sys.poll(kfd));
        let mask = 0;
        if (state.readable) mask |= POLLIN | POLLRDNORM;
        if (state.writable) mask |= POLLOUT | POLLWRNORM;

        if (state.hangup) mask |= state.readable ? POLLHUP : POLLERR;
        return mask;
      },
      dup: (stream) => {
        base.dup?.(stream);
        this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);
      },
      close: (stream) => {
        try {
          base.close?.(stream);
        } catch {}
        const left = (this.refs.get(kfd) ?? 1) - 1;
        if (left > 0) {
          this.refs.set(kfd, left);
          return;
        }
        this.refs.delete(kfd);
        try {
          this.sys.close(kfd);
        } catch {}
      },
    };
  }
}
