/**
 * `fd-table.ts` — open file descriptions and per-process fd tables for the
 * wasm realm (#3530).
 *
 * A {@link KernelFile} is what an open file description refers to: a pipe
 * end, a byte source (stdin a slicc command handed over), an output sink, or
 * `/dev/null`. {@link OpenFile} counts the fds pointing at one description,
 * across processes, and closes the file when the last one goes: that is what
 * lets a pipe inherited by several processes reach EOF only when its last
 * writer exits. A process's {@link FdTable} maps fd numbers to descriptions:
 * `dup` / `dup2` / `close` share and release them, `fork` copies the table
 * (every description gains a reference), `closeAll` is exit. An fd can be
 * marked close-on-exec before the process starts: the program sees it with
 * FD_CLOEXEC set, so the programs it runs do not inherit it.
 */
import { KernelPipe, PipeError } from './pipe.js';
import type { KernelTty } from './tty.js';

/** POSIX errno names the kernel reports to a process. */
export type KernelErrno =
  | 'EBADF'
  | 'EPIPE'
  | 'EMFILE'
  | 'EINVAL'
  | 'ENOENT'
  | 'ECHILD'
  | 'ENOSYS'
  | 'ESPIPE'
  | 'EINTR'
  | 'ESRCH'
  | 'ENOTTY'
  | 'ENXIO'
  | 'EPERM'
  | 'EIO'
  | 'EACCES'
  // Sockets (socket.ts).
  | 'EAGAIN'
  | 'ENOTSOCK'
  | 'EAFNOSUPPORT'
  | 'EPROTONOSUPPORT'
  | 'EOPNOTSUPP'
  | 'EADDRINUSE'
  | 'EADDRNOTAVAIL'
  | 'ENETUNREACH'
  | 'ECONNREFUSED'
  | 'EINPROGRESS'
  | 'EISCONN'
  | 'ENOTCONN';

export class KernelError extends Error {
  constructor(readonly code: KernelErrno) {
    super(code);
  }
}

/** poll(2) readiness of an open file description. */
export interface PollState {
  /** A read would not wait (data, or end of file). */
  readable: boolean;
  /** A write would not wait. */
  writable: boolean;
  /** The other end of a pipe is gone (POLLHUP for a reader, POLLERR for a writer). */
  hangup: boolean;
}

/** What an open file description refers to. */
export interface KernelFile {
  /**
   * Up to `max` bytes, waiting for data; empty means end of file. Absent: not
   * readable. `signal` interrupts a wait with EINTR (a caught signal).
   */
  read?(max: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** As `read`, but the bytes stay to be read again (recv's MSG_PEEK). Absent: EOPNOTSUPP. */
  peek?(max: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Write every byte, waiting as needed (`signal`: as for read). Absent: not writable. */
  write?(bytes: Uint8Array, signal?: AbortSignal): Promise<number>;
  /** The last reference is gone. May return a promise when writeback is in flight. */
  close(): void | Promise<void>;
  /** Readiness; absent means never waits (a byte source, a sink). */
  poll?(): PollState;
  /** Resolves when the readiness may have changed (`signal`: EINTR). Absent: never changes. */
  changed?(signal?: AbortSignal): Promise<void>;
  /** lseek(2) on the shared offset; absent: not seekable (ESPIPE). */
  seek?(offset: number, whence: number): Promise<number>;
  /** Write back buffered content (a VFS file). */
  flush?(): Promise<void>;
  /** A terminal: its termios and window size (isatty, tcgetattr, TIOCGWINSZ). */
  tty?: KernelTty;
  /**
   * Held by the process's own worker (a WASI program's buffered VFS file,
   * directory or device): the kernel only keeps its number taken, so the
   * program's fds and the kernel's stay one numbering.
   */
  held?: true;
  /**
   * What a held number stands for in its worker (a WASI directory or
   * device), so another thread of the process can open it too.
   */
  heldMeta?: HeldMeta;
}

/** A WASI worker-held descriptor, as the kernel keeps it for the process's other threads. */
export type HeldMeta = { dir: string; preopen?: string } | { device: 'null' | 'zero' | 'urandom' };

/** A description's readiness: its own answer, or ready in whatever direction it serves. */
export function pollFile(file: KernelFile): PollState {
  return file.poll?.() ?? { readable: !!file.read, writable: !!file.write, hangup: false };
}

/** One open file description: shared by every fd (in any process) dup'd from it. */
export class OpenFile {
  private refs = 1;

  constructor(readonly file: KernelFile) {}

  retain(): this {
    this.refs += 1;
    return this;
  }

  release(): void | Promise<void> {
    this.refs -= 1;
    if (this.refs === 0) return this.file.close();
  }
}

/** The two ends of a new pipe, each its own open file description. */
export function openPipe(capacity?: number): { read: OpenFile; write: OpenFile } {
  const pipe = new KernelPipe(capacity);
  pipe.openRead();
  pipe.openWrite();
  return {
    read: new OpenFile({
      read: async (max, signal) => {
        try {
          return await pipe.read(max, signal);
        } catch (e) {
          if (e instanceof PipeError) throw new KernelError(e.code);
          throw e;
        }
      },
      close: () => pipe.closeRead(),
      poll: () => ({ readable: pipe.readReady, writable: false, hangup: pipe.writersGone }),
      changed: (signal) => pipe.changed(signal),
    }),
    write: new OpenFile({
      write: async (bytes, signal) => {
        try {
          return await pipe.write(bytes, signal);
        } catch (e) {
          if (e instanceof PipeError) throw new KernelError(e.code);
          throw e;
        }
      },
      close: () => pipe.closeWrite(),
      poll: () => ({ readable: false, writable: pipe.writeReady, hangup: pipe.readersGone }),
      changed: (signal) => pipe.changed(signal),
    }),
  };
}

/** A readable file serving `data` once, then end of file (a command's buffered stdin). */
export function bytesSource(data: Uint8Array): OpenFile {
  let offset = 0;
  return new OpenFile({
    read: async (max) => {
      const out = data.subarray(offset, offset + max);
      offset += out.length;
      return out;
    },
    close: () => {},
  });
}

/** A writable file handing every write to `onData` (a command's stdout / stderr). */
export function sinkFile(onData: (bytes: Uint8Array) => void): OpenFile {
  return new OpenFile({
    write: async (bytes) => {
      onData(bytes.slice());
      return bytes.length;
    },
    close: () => {},
  });
}

/** `/dev/null`: reads end at once, writes vanish. */
export function nullFile(): OpenFile {
  return new OpenFile({
    read: async () => new Uint8Array(0),
    write: async (bytes) => bytes.length,
    close: () => {},
  });
}

/** A number a WASI program's worker holds a descriptor under (see {@link KernelFile.held}). */
export function heldFile(meta?: HeldMeta): OpenFile {
  return new OpenFile({ held: true, ...(meta ? { heldMeta: meta } : {}), close: () => {} });
}

/**
 * How a process's runtime backs a kernel descriptor: a terminal, a seekable
 * VFS file, a socket, a stream, or one its worker holds itself.
 */
export type KernelFdKind = 'tty' | 'stream' | 'file' | 'socket' | 'held';

/** The kind of a descriptor that is no socket (the host tells sockets apart). */
export function kernelFdKind(file: KernelFile): Exclude<KernelFdKind, 'socket'> {
  if (file.held) return 'held';
  if (file.tty) return 'tty';
  return file.seek ? 'file' : 'stream';
}

/** Per-process table of fd numbers → open file descriptions. */
export class FdTable {
  static readonly MAX_FDS = 1024;
  private fds = new Map<number, OpenFile>();
  private readonly cloexec = new Set<number>();
  /** Status flags a runtime keeps per stream (a socket's O_NONBLOCK), for a process starting on them. */
  private readonly status = new Map<number, number>();

  /** The description behind `fd`, or EBADF. */
  get(fd: number): OpenFile {
    const file = this.fds.get(fd);
    if (!file) throw new KernelError('EBADF');
    return file;
  }

  /** The terminal fd 0, 1 or 2 is on (the first that is one), if any. */
  stdioTerminal(): KernelTty | undefined {
    for (const fd of [0, 1, 2]) {
      const tty = this.fds.get(fd)?.file.tty;
      if (tty) return tty;
    }
    return undefined;
  }

  /** The open descriptor numbers, lowest first. */
  numbers(): number[] {
    return [...this.fds.keys()].sort((a, b) => a - b);
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  /** FD_CLOEXEC on `fd`: the process keeps it, the programs it execs or spawns do not get it. */
  setCloseOnExec(fd: number): void {
    this.get(fd);
    this.cloexec.add(fd);
  }

  /** Clear FD_CLOEXEC on `fd`. */
  clearCloseOnExec(fd: number): void {
    this.get(fd);
    this.cloexec.delete(fd);
  }

  closesOnExec(fd: number): boolean {
    return this.cloexec.has(fd);
  }

  /** Record the status flags the program starting on `fd` gives its stream. */
  setStatusFlags(fd: number, flags: number): void {
    this.get(fd);
    this.status.set(fd, flags);
  }

  statusFlags(fd: number): number | undefined {
    return this.status.get(fd);
  }

  /** Install `file` (whose reference the table takes over) at the lowest free fd ≥ `min`. */
  install(file: OpenFile, min = 0): number {
    for (let fd = min; fd < FdTable.MAX_FDS; fd++) {
      if (!this.fds.has(fd)) {
        this.fds.set(fd, file);
        return fd;
      }
    }
    void Promise.resolve(file.release()).catch(() => undefined);
    throw new KernelError('EMFILE');
  }

  /** Install `file` at exactly `fd`, closing what was there. */
  installAt(fd: number, file: OpenFile): void {
    if (fd < 0 || fd >= FdTable.MAX_FDS) {
      void Promise.resolve(file.release()).catch(() => undefined);
      throw new KernelError('EBADF');
    }
    const previous = this.fds.get(fd);
    this.fds.set(fd, file);
    this.cloexec.delete(fd);
    this.status.delete(fd);
    void Promise.resolve(previous?.release()).catch(() => undefined);
  }

  /** dup(2): a new fd, the lowest free one, sharing `fd`'s description. */
  dup(fd: number, min = 0): number {
    return this.install(this.get(fd).retain(), min);
  }

  /** dup2(2): `newFd` shares `oldFd`'s description; a no-op when they are equal. */
  dup2(oldFd: number, newFd: number): number {
    const file = this.get(oldFd);
    if (oldFd !== newFd) this.installAt(newFd, file.retain());
    return newFd;
  }

  close(fd: number): void | Promise<void> {
    const file = this.get(fd);
    this.fds.delete(fd);
    this.cloexec.delete(fd);
    this.status.delete(fd);
    return file.release();
  }

  /** The table of a forked child: every description gains a reference. */
  fork(): FdTable {
    const child = new FdTable();
    for (const [fd, file] of this.fds) child.fds.set(fd, file.retain());
    for (const fd of this.cloexec) child.cloexec.add(fd);
    for (const [fd, flags] of this.status) child.status.set(fd, flags);
    return child;
  }

  /** Process exit: release every description and wait for any writeback. */
  async closeAll(): Promise<void> {
    const files = [...this.fds.values()];
    this.fds.clear();
    this.cloexec.clear();
    this.status.clear();
    await Promise.all(files.map((file) => Promise.resolve(file.release())));
  }
}
