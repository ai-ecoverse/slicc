import { KernelPipe, PipeError } from './pipe.js';

export type KernelErrno =
  | 'EBADF'
  | 'EPIPE'
  | 'EMFILE'
  | 'EINVAL'
  | 'ENOENT'
  | 'ECHILD'
  | 'ENOSYS'
  | 'ESPIPE';

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
  read?(max: number): Promise<Uint8Array>;

  write?(bytes: Uint8Array): Promise<number>;

  close(): void | Promise<void>;

  poll?(): PollState;

  seek?(offset: number, whence: number): Promise<number>;

  flush?(): Promise<void>;
}

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

export class FdTable {
  static readonly MAX_FDS = 1024;
  private fds = new Map<number, OpenFile>();

  get(fd: number): OpenFile {
    const file = this.fds.get(fd);
    if (!file) throw new KernelError('EBADF');
    return file;
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
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
    return file.release();
  }

  fork(): FdTable {
    const child = new FdTable();
    for (const [fd, file] of this.fds) child.fds.set(fd, file.retain());
    return child;
  }

  async closeAll(): Promise<void> {
    const files = [...this.fds.values()];
    this.fds.clear();
    await Promise.all(files.map((file) => Promise.resolve(file.release())));
  }
}
