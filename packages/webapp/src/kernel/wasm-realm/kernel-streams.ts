/**
 * `kernel-streams.ts` — kernel descriptors as streams of the program's
 * Emscripten FS, inside a wasm-realm process worker (#3530).
 *
 * A kernel-backed stream reads and writes with blocking `fd-read` /
 * `fd-write` syscalls and answers `poll` from the kernel. The program can
 * dup it (dup, dup2, the fork emulation's cloned fd table) and close the
 * copies; the kernel descriptor closes with the last copy, which is what a
 * pipe reader needs to see end of file. fds 0-2 are backed this way, and so
 * is every `pipe()` the program makes, so a pipe it hands to a child
 * (`posix_spawn` file actions, or a forked child that execs) is shared with
 * that child's worker: the two run concurrently and stream through the kernel.
 */
import type { EmscriptenFsForHook } from '../realm/emscripten-vfs-hook.js';
import type { PollState } from './fd-table.js';
import type { Termios } from './tty.js';
import { wasiErrno } from './wasi-errno.js';

/** musl's poll(2) bits. */
const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;

/** fcntl's O_NONBLOCK (musl): a socket's reads and writes fail with EAGAIN instead of waiting. */
export const O_NONBLOCK = 0o4000;
/** A socket node's mode: S_IFSOCK, rwx for all. */
const SOCKET_MODE = 0o140777;

// musl's open(2) flags (Linux's).
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_NOCTTY = 0o400;
const O_TRUNC = 0o1000;

/** SIGPIPE's default action: a write to a pipe with no reader ends the writer. */
const KILLED_BY_SIGPIPE = 128 + 13;

/**
 * Ends the program from inside a syscall with an exit status, as a signal's
 * default action does; the runtime reports `status` like an `exit()`.
 */
export class ProcessExit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

/** A kernel error from a syscall, carrying its errno name. */
export class SyscallError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A read that must not wait (EAGAIN), or leaves the bytes (recv's MSG_PEEK). */
export interface ReadOptions {
  nonblock?: boolean;
  peek?: boolean;
}

/** The blocking syscalls a process makes on its kernel descriptors. */
export interface ProcessSys {
  /** Up to `max` bytes; empty at end of file. */
  read(fd: number, max: number, opts?: ReadOptions): Uint8Array;
  /** Bytes written (all of them; `nonblock`: what fits now, or EAGAIN). */
  write(fd: number, bytes: Uint8Array, opts?: { nonblock?: boolean }): number;
  close(fd: number): void;
  /** A new kernel pipe: `[read end, write end]`. */
  pipe(): [number, number];
  poll(fd: number): PollState;
  /** Hand a VFS file to the kernel as a shared description; its new kernel fd. */
  openVfs(
    path: string,
    flags: number,
    position: number,
    opts?: { contents?: Uint8Array; orphan?: boolean; truncate?: boolean }
  ): number;
  /** lseek(2) on a kernel description's shared offset. */
  seek(fd: number, offset: number, whence: number): number;
  /** fsync(2): write back a VFS file description's buffered content. */
  flush(fd: number): void;
  /** pread(2) on a VFS file description: up to `max` bytes at `at`, its offset untouched. */
  pread?(fd: number, max: number, at: number): Uint8Array;
  /** Whether the descriptor is a terminal. */
  isatty?(fd: number): boolean;
  /** A new kernel fd on the controlling terminal (`/dev/tty`); ENXIO without one. */
  openTty?(): number;
  /** A terminal's termios / window size (`[rows, cols]`). */
  tcgets?(fd: number): Termios;
  tcsets?(fd: number, termios: Termios): void;
  winsize?(fd: number): [number, number];
  /** `/dev/ptmx`: a new pseudo-terminal's master; `/dev/pts/N`: its slave (`noctty`: O_NOCTTY). */
  openPty?(): number;
  openPts?(n: number, noctty: boolean): number;
}

export interface StreamOps {
  /** fstat(2) of the stream, over its node's own (Emscripten's FS.fstat asks this first). */
  getattr?: (stream: ProcessStream) => object;
  llseek?: (stream: ProcessStream, offset: number, whence: number) => number;
  read?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  close?: (stream: ProcessStream) => void;
  dup?: (stream: ProcessStream) => void;
  poll?: (stream: ProcessStream) => number;
  fsync?: () => number;
}

/** An open stream of the module's FS; `sliccKernelFd` marks one backed by a kernel fd. */
export interface ProcessStream {
  fd: number;
  stream_ops: StreamOps;
  sliccKernelFd?: number;
  /** Backed by a kernel VFS file description (seekable, offset shared across processes). */
  sliccKernelFile?: boolean;
  /** Backed by a kernel socket (O_NONBLOCK counts; send / recv work on it). */
  sliccKernelSocket?: boolean;
  /** FD_CLOEXEC: per fd, where Emscripten's `flags` belong to the shared description. */
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
  /** Emscripten's per-description state (the offset), shared by dups in one worker. */
  shared: object;
}

/** A node of the module's FS, as a socket stream needs one. */
interface FsNode {
  mode: number;
  node_ops: object;
}

/** What makes a socket node (Emscripten's FS, as its SOCKFS uses it). */
interface SocketNodeFs {
  mount(type: { mount(): FsNode }, opts: object, mountpoint: null): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, rdev: number): FsNode;
  createStream(stream: object, fd?: number): ProcessStream;
}

/** The slice of Emscripten's FS the runtime uses. */
export interface ProcessFs extends EmscriptenFsForHook {
  streams: (ProcessStream | null | undefined)[];
  getStream(fd: number): ProcessStream | null;
  open(path: string, flags: number, mode?: number): ProcessStream;
  dupStream(stream: ProcessStream, fd: number): ProcessStream;
  closeStream(fd: number): void;
  isFile(mode: number): boolean;
  mkdirTree(path: string): void;
  cwd(): string;
  read(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;
  write(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;
  /** stat(2) / fstat(2): the attributes the syscalls write out (absent in a minimal FS). */
  stat?(path: string, dontFollow?: boolean): object;
  fstat?(fd: number): object;
  symlink?(target: string, path: string): void;
  lookupPath?(path: string, opts?: { follow?: boolean }): { node: object };
}

/** Emscripten's PIPEFS: `pipe()` goes through `createPipe`. */
export interface ProcessPipeFs {
  createPipe(): { readable_fd: number; writable_fd: number };
}

/** How a process's streams treat interrupted and broken-pipe writes. */
export interface KernelStreamOptions {
  /**
   * Whether the program ignores or handles SIGPIPE (its handler has then
   * run): the toolchain's `slicc_sigpipe()`. Absent, or false, is SIGPIPE's
   * default action.
   */
  sigpipe?: () => boolean;
  /** Whether an EINTR just seen may be retried (SA_RESTART handlers ran). */
  restartable?: () => boolean;
}

/** A socket stream in O_NONBLOCK mode (pipes and terminals keep blocking, as before). */
function nonblocking(stream: ProcessStream): boolean {
  return stream.sliccKernelSocket === true && (stream.flags & O_NONBLOCK) !== 0;
}

export class KernelStreams {
  /** Emscripten streams per kernel descriptor (dups and fork clones included). */
  private readonly refs = new Map<number, number>();
  /** The pseudo-mount socket nodes hang off (as Emscripten's SOCKFS does), made on first use. */
  private socketRoot: FsNode | undefined;
  private sockets = 0;

  constructor(
    private readonly Fs: ProcessFs,
    private readonly sys: ProcessSys,
    private readonly options: KernelStreamOptions = {}
  ) {}

  /**
   * Back `stream` by kernel descriptor `kfd`. It is a terminal (`stream.tty`,
   * which isatty and the termios ioctls go by) only when the kernel says so:
   * `terminal` true / false when the caller knows, else the kernel is asked.
   */
  attach(stream: ProcessStream, kfd: number, terminal?: boolean): void {
    this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);
    // Emscripten copies a stream's own properties on dup / dup2, so the mark
    // (and the ops) follow the descriptor to whatever fd the program moves it to.
    stream.sliccKernelFd = kfd;
    stream.stream_ops = this.ops(kfd, stream.stream_ops);
    if (terminal ?? this.sys.isatty?.(kfd) ?? false) stream.tty = this.ttyOps(kfd);
    else delete stream.tty;
  }

  /** Emscripten's TTY hooks, answered by the kernel's terminal. */
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

  /**
   * Back `stream` by a kernel VFS file description: reads and writes go at the
   * kernel's offset, which a forked parent and child share, and seeks move it.
   */
  attachFile(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelFile = true;
    stream.stream_ops = {
      ...stream.stream_ops,
      llseek: (_s, offset, whence) => this.call(() => this.sys.seek(kfd, offset, whence)),
      // KernelStreams.ops leaves fsync as a no-op; a VFS description must flush.
      fsync: () =>
        this.call(() => {
          this.sys.flush(kfd);
          return 0;
        }),
    };
  }

  /**
   * Put the terminal devices the program opens on the kernel's terminals:
   * `/dev/tty` is its controlling terminal (its session's, which a pager
   * reads its keys from even when its stdio is not the terminal), and ENXIO
   * without one; any other (the `/dev/tty1` that `ttyname()` names) is the
   * terminal its stdio is on. Without a kernel terminal to use, Emscripten's
   * own console device stays.
   */
  useControllingTerminal(): void {
    if (typeof this.Fs.open !== 'function') return; // an FS without open(): nothing to route
    const open = this.Fs.open.bind(this.Fs);
    this.Fs.open = (path, flags, mode) => {
      const pty = this.openPty(open, path, flags, mode);
      if (pty) return pty;
      const stream = open(path, flags, mode);
      // Emscripten gave it one of its console terminals (`stream.tty`). Keep
      // the description (the access mode asked for) and put it on the kernel
      // terminal.
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
      // One more reference to the descriptor its stdio is on.
      const terminal = this.stdioTerminal();
      if (terminal !== undefined) this.attach(stream, terminal, true);
      return stream;
    };
  }

  /**
   * `/dev/ptmx` and `/dev/pts/N` are the kernel's pseudo-terminals, which
   * Emscripten's FS has no node for: a stream on its own `/dev/null` (only
   * the description is used) put on the kernel's master or slave.
   */
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
    // Both ends get Emscripten's terminal hooks: the kernel answers a master's
    // termios and window size with its slave's, as Linux does (so isatty is
    // true on it too).
    this.attach(stream, kfd, true);
    return stream;
  }

  /** The kernel descriptor of the terminal the process's stdio is on. */
  private stdioTerminal(): number | undefined {
    for (const fd of [0, 1, 2]) {
      const stream = this.Fs.getStream(fd);
      if (stream?.sliccKernelFd !== undefined && stream.tty) return stream.sliccKernelFd;
    }
    return undefined;
  }

  /**
   * Back `stream` by kernel socket `kfd`: as {@link attach}, and its reads and
   * writes follow the stream's O_NONBLOCK (fcntl, accept4, SOCK_NONBLOCK).
   */
  attachSocket(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelSocket = true;
  }

  /**
   * A new stream of the program for a socket: an S_IFSOCK node (fstat), not
   * yet attached to a kernel descriptor. Where the FS cannot make one (a
   * test's fake), a `/dev/null` stream stands in.
   */
  socketStream(flags: number): ProcessStream {
    const fs = this.Fs as unknown as Partial<SocketNodeFs>;
    if (!fs.mount || !fs.createNode || !fs.createStream) {
      const stream = this.Fs.open('/dev/null', 2 /* O_RDWR */);
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

  /** Make `pipe()` return kernel pipes. */
  usePipes(pipefs: ProcessPipeFs): void {
    const createPipe = pipefs.createPipe.bind(pipefs);
    pipefs.createPipe = () => {
      const [read, write] = this.call(() => this.sys.pipe());
      // Emscripten's own pipe supplies the nodes (fstat, S_ISFIFO); its buffer stays unused.
      let fds: ReturnType<ProcessPipeFs['createPipe']>;
      try {
        fds = createPipe();
      } catch (e) {
        // Its fd table is full (EMFILE): give the kernel its two ends back.
        for (const kfd of [read, write]) {
          try {
            this.sys.close(kfd);
          } catch {
            /* already gone */
          }
        }
        throw e;
      }
      this.attach(this.Fs.getStream(fds.readable_fd) as ProcessStream, read, false);
      this.attach(this.Fs.getStream(fds.writable_fd) as ProcessStream, write, false);
      return fds;
    };
  }

  /** A syscall a caught signal interrupted runs again when its handlers asked for SA_RESTART. */
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
      // A pipe, socket or terminal has no offset: lseek fails with ESPIPE (a
      // VFS file description gets its own, `attachFile`). The placeholder's
      // `/dev/null` seek would succeed, and GNU bash, taking the descriptor for
      // a file, reads ahead and seeks back: `cmd | while read l` lost every
      // line after the first.
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
          // A pipe with no reader: SIGPIPE ends the program unless it ignores
          // or handles the signal; then the write fails with EPIPE.
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
        // A reader's other end gone is POLLHUP (at EOF); a writer's is POLLERR (EPIPE).
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
        } catch {
          // Emscripten's TTY close flushes through `stream.tty`, which a
          // kernel descriptor that is no terminal no longer has.
        }
        const left = (this.refs.get(kfd) ?? 1) - 1;
        if (left > 0) {
          this.refs.set(kfd, left);
          return;
        }
        this.refs.delete(kfd);
        try {
          this.sys.close(kfd);
        } catch {
          /* already gone (the process is exiting) */
        }
      },
    };
  }
}
