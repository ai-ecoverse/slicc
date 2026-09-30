import { KernelPipe, PipeError } from './pipe.js';
import type { KernelTty } from './tty.js';

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

export interface PollState {
  readable: boolean;

  writable: boolean;

  hangup: boolean;
}

export interface KernelFile {
  read?(max: number, signal?: AbortSignal): Promise<Uint8Array>;

  peek?(max: number, signal?: AbortSignal): Promise<Uint8Array>;

  write?(bytes: Uint8Array, signal?: AbortSignal): Promise<number>;

  close(): void | Promise<void>;

  poll?(): PollState;

  changed?(signal?: AbortSignal): Promise<void>;

  seek?(offset: number, whence: number): Promise<number>;

  flush?(): Promise<void>;

  pread?(max: number, at: number): Promise<Uint8Array>;
  pwrite?(bytes: Uint8Array, at: number): Promise<number>;

  resize?(size: number): Promise<void>;

  stat?(): Promise<{ path: string; size: number; orphan?: true }>;

  tty?: KernelTty;

  stat?(): Promise<{ size: number; path: string; orphan?: true }>;
  held?: true;

  heldMeta?: HeldMeta;
}

export type HeldMeta = { dir: string; preopen?: string } | { device: 'null' | 'zero' | 'urandom' };

export function pollFile(file: KernelFile): PollState {
  return file.poll?.() ?? { readable: !!file.read, writable: !!file.write, hangup: false };
}

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

export function sinkFile(onData: (bytes: Uint8Array) => void): OpenFile {
  return new OpenFile({
    write: async (bytes) => {
      onData(bytes.slice());
      return bytes.length;
    },
    close: () => {},
  });
}

export function nullFile(): OpenFile {
  return new OpenFile({
    read: async () => new Uint8Array(0),
    write: async (bytes) => bytes.length,
    close: () => {},
  });
}

export function heldFile(meta?: HeldMeta): OpenFile {
  return new OpenFile({ held: true, ...(meta ? { heldMeta: meta } : {}), close: () => {} });
}

export type KernelFdKind = 'tty' | 'stream' | 'file' | 'socket' | 'held';

export function kernelFdKind(file: KernelFile): Exclude<KernelFdKind, 'socket'> {
  if (file.held) return 'held';
  if (file.tty) return 'tty';
  return file.seek ? 'file' : 'stream';
}

export class FdTable {
  static readonly MAX_FDS = 1024;
  private fds = new Map<number, OpenFile>();
  private readonly cloexec = new Set<number>();

  private readonly status = new Map<number, number>();

  get(fd: number): OpenFile {
    const file = this.fds.get(fd);
    if (!file) throw new KernelError('EBADF');
    return file;
  }

  stdioTerminal(): KernelTty | undefined {
    for (const fd of [0, 1, 2]) {
      const tty = this.fds.get(fd)?.file.tty;
      if (tty) return tty;
    }
    return undefined;
  }

  numbers(): number[] {
    return [...this.fds.keys()].sort((a, b) => a - b);
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  setCloseOnExec(fd: number): void {
    this.get(fd);
    this.cloexec.add(fd);
  }

  clearCloseOnExec(fd: number): void {
    this.get(fd);
    this.cloexec.delete(fd);
  }

  closesOnExec(fd: number): boolean {
    return this.cloexec.has(fd);
  }

  setStatusFlags(fd: number, flags: number): void {
    this.get(fd);
    this.status.set(fd, flags);
  }

  statusFlags(fd: number): number | undefined {
    return this.status.get(fd);
  }

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

  dup(fd: number, min = 0): number {
    return this.install(this.get(fd).retain(), min);
  }

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

  fork(): FdTable {
    const child = new FdTable();
    for (const [fd, file] of this.fds) child.fds.set(fd, file.retain());
    for (const fd of this.cloexec) child.cloexec.add(fd);
    for (const [fd, flags] of this.status) child.status.set(fd, flags);
    return child;
  }

  async closeAll(): Promise<void> {
    const files = [...this.fds.values()];
    this.fds.clear();
    this.cloexec.clear();
    this.status.clear();
    await Promise.all(files.map((file) => Promise.resolve(file.release())));
  }
}
