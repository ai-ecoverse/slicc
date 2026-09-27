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

/** The blocking syscalls a process makes on its kernel descriptors. */
export interface ProcessSys {
  /** Up to `max` bytes; empty at end of file. */
  read(fd: number, max: number): Uint8Array;
  /** Bytes written (all of them). */
  write(fd: number, bytes: Uint8Array): number;
  close(fd: number): void;
  /** A new kernel pipe: `[read end, write end]`. */
  pipe(): [number, number];
  poll(fd: number): PollState;
  /** Hand a VFS file to the kernel as a shared description; its new kernel fd. */
  openVfs(
    path: string,
    flags: number,
    position: number,
    opts?: { contents?: Uint8Array; orphan?: boolean }
  ): number;
  /** lseek(2) on a kernel description's shared offset. */
  seek(fd: number, offset: number, whence: number): number;
  /** fsync(2): write back a VFS file description's buffered content. */
  flush(fd: number): void;
  /** Whether the descriptor is a terminal. */
  isatty?(fd: number): boolean;
  /** A terminal's termios / window size (`[rows, cols]`). */
  tcgets?(fd: number): Termios;
  tcsets?(fd: number, termios: Termios): void;
  winsize?(fd: number): [number, number];
}

export interface StreamOps {
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
  path?: string;
  flags: number;
  position: number;
  tty?: unknown;
  node: { mode: number; mount?: { type?: unknown } };
  /** Emscripten's per-description state (the offset), shared by dups in one worker. */
  shared: object;
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

export class KernelStreams {
  /** Emscripten streams per kernel descriptor (dups and fork clones included). */
  private readonly refs = new Map<number, number>();

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
   * Make a terminal device the program opens (`/dev/tty`, or the
   * `/dev/tty1` that `ttyname()` names) its controlling terminal: the kernel
   * terminal its stdio is on. A pager such as less reads its keys there.
   * Without one, Emscripten's own console device stays.
   */
  useControllingTerminal(): void {
    if (typeof this.Fs.open !== 'function') return; // an FS without open(): nothing to route
    const open = this.Fs.open.bind(this.Fs);
    this.Fs.open = (path, flags, mode) => {
      const stream = open(path, flags, mode);
      // Emscripten gave it one of its console terminals (`stream.tty`). Keep
      // the description (the access mode asked for) and put it on the kernel
      // terminal: one more reference to that descriptor.
      const terminal = stream.tty ? this.controllingTerminal() : undefined;
      if (terminal !== undefined) this.attach(stream, terminal, true);
      return stream;
    };
  }

  /** The kernel descriptor of the terminal the process's stdio is on. */
  private controllingTerminal(): number | undefined {
    for (const fd of [0, 1, 2]) {
      const stream = this.Fs.getStream(fd);
      if (stream?.sliccKernelFd !== undefined && stream.tty) return stream.sliccKernelFd;
    }
    return undefined;
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
      read: (_s, buffer, offset, length) =>
        this.call(() => {
          const bytes = this.restarting(() => this.sys.read(kfd, length));
          buffer.set(bytes, offset);
          return bytes.length;
        }),
      write: (_s, buffer, offset, length) => {
        try {
          return this.restarting(() => this.sys.write(kfd, buffer.slice(offset, offset + length)));
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
