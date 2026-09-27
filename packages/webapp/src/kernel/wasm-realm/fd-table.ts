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
 * (every description gains a reference), `closeAll` is exit.
 */
import { KernelPipe, PipeError } from './pipe.js';

/** POSIX errno names the kernel reports to a process. */
export type KernelErrno = 'EBADF' | 'EPIPE' | 'EMFILE' | 'EINVAL' | 'ENOENT' | 'ECHILD' | 'ENOSYS';

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
  /** Up to `max` bytes, waiting for data; empty means end of file. Absent: not readable. */
  read?(max: number): Promise<Uint8Array>;
  /** Write every byte, waiting as needed. Absent: not writable. */
  write?(bytes: Uint8Array): Promise<number>;
  /** The last reference is gone. */
  close(): void;
  /** Readiness; absent means never waits (a byte source, a sink). */
  poll?(): PollState;
}

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

  release(): void {
    this.refs -= 1;
    if (this.refs === 0) this.file.close();
  }
}

/** The two ends of a new pipe, each its own open file description. */
export function openPipe(capacity?: number): { read: OpenFile; write: OpenFile } {
  const pipe = new KernelPipe(capacity);
  pipe.openRead();
  pipe.openWrite();
  return {
    read: new OpenFile({
      read: (max) => pipe.read(max),
      close: () => pipe.closeRead(),
      poll: () => ({ readable: pipe.readReady, writable: false, hangup: pipe.writersGone }),
    }),
    write: new OpenFile({
      write: async (bytes) => {
        try {
          return await pipe.write(bytes);
        } catch (e) {
          if (e instanceof PipeError) throw new KernelError('EPIPE');
          throw e;
        }
      },
      close: () => pipe.closeWrite(),
      poll: () => ({ readable: false, writable: pipe.writeReady, hangup: pipe.readersGone }),
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

/** Per-process table of fd numbers → open file descriptions. */
export class FdTable {
  static readonly MAX_FDS = 1024;
  private fds = new Map<number, OpenFile>();

  /** The description behind `fd`, or EBADF. */
  get(fd: number): OpenFile {
    const file = this.fds.get(fd);
    if (!file) throw new KernelError('EBADF');
    return file;
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  /** Install `file` (whose reference the table takes over) at the lowest free fd ≥ `min`. */
  install(file: OpenFile, min = 0): number {
    for (let fd = min; fd < FdTable.MAX_FDS; fd++) {
      if (!this.fds.has(fd)) {
        this.fds.set(fd, file);
        return fd;
      }
    }
    file.release();
    throw new KernelError('EMFILE');
  }

  /** Install `file` at exactly `fd`, closing what was there. */
  installAt(fd: number, file: OpenFile): void {
    if (fd < 0 || fd >= FdTable.MAX_FDS) {
      file.release();
      throw new KernelError('EBADF');
    }
    const previous = this.fds.get(fd);
    this.fds.set(fd, file);
    previous?.release();
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

  close(fd: number): void {
    const file = this.get(fd);
    this.fds.delete(fd);
    file.release();
  }

  /** The table of a forked child: every description gains a reference. */
  fork(): FdTable {
    const child = new FdTable();
    for (const [fd, file] of this.fds) child.fds.set(fd, file.retain());
    return child;
  }

  /** Process exit: release every description. */
  closeAll(): void {
    const files = [...this.fds.values()];
    this.fds.clear();
    for (const file of files) file.release();
  }
}
