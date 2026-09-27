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
import { wasiErrno } from './wasi-errno.js';

/** musl's poll(2) bits. */
const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;

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
}

export interface StreamOps {
  read?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  close?: (stream: ProcessStream) => void;
  dup?: (stream: ProcessStream) => void;
  poll?: (stream: ProcessStream) => number;
  fsync?: () => number;
}

/** An open stream of the module's FS; `sliccKernelFd` marks one backed by a kernel fd. */
export interface ProcessStream {
  stream_ops: StreamOps;
  sliccKernelFd?: number;
}

/** The slice of Emscripten's FS the runtime uses. */
export interface ProcessFs extends EmscriptenFsForHook {
  getStream(fd: number): ProcessStream | null;
  mkdirTree(path: string): void;
  cwd(): string;
  read(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;
  write(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;
}

/** Emscripten's PIPEFS: `pipe()` goes through `createPipe`. */
export interface ProcessPipeFs {
  createPipe(): { readable_fd: number; writable_fd: number };
}

export class KernelStreams {
  /** Emscripten streams per kernel descriptor (dups and fork clones included). */
  private readonly refs = new Map<number, number>();

  constructor(
    private readonly Fs: ProcessFs,
    private readonly sys: ProcessSys
  ) {}

  /** Back `stream` by kernel descriptor `kfd`. */
  attach(stream: ProcessStream, kfd: number): void {
    this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);
    // Emscripten copies a stream's own properties on dup / dup2, so the mark
    // (and the ops) follow the descriptor to whatever fd the program moves it to.
    stream.sliccKernelFd = kfd;
    stream.stream_ops = this.ops(kfd, stream.stream_ops);
  }

  /** Make `pipe()` return kernel pipes. */
  usePipes(pipefs: ProcessPipeFs): void {
    const createPipe = pipefs.createPipe.bind(pipefs);
    pipefs.createPipe = () => {
      const [read, write] = this.call(() => this.sys.pipe());
      // Emscripten's own pipe supplies the nodes (fstat, S_ISFIFO); its buffer stays unused.
      const fds = createPipe();
      this.attach(this.Fs.getStream(fds.readable_fd) as ProcessStream, read);
      this.attach(this.Fs.getStream(fds.writable_fd) as ProcessStream, write);
      return fds;
    };
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
          const bytes = this.sys.read(kfd, length);
          buffer.set(bytes, offset);
          return bytes.length;
        }),
      write: (_s, buffer, offset, length) =>
        this.call(() => this.sys.write(kfd, buffer.slice(offset, offset + length))),
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
        base.close?.(stream);
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
