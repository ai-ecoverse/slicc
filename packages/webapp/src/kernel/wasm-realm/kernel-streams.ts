import type { EmscriptenFsForHook } from '../realm/emscripten-vfs-hook.js';
import type { PollState } from './fd-table.js';
import { wasiErrno } from './wasi-errno.js';

const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;

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

export interface ProcessSys {
  read(fd: number, max: number): Uint8Array;

  write(fd: number, bytes: Uint8Array): number;
  close(fd: number): void;

  pipe(): [number, number];
  poll(fd: number): PollState;

  openVfs(
    path: string,
    flags: number,
    position: number,
    opts?: { contents?: Uint8Array; orphan?: boolean }
  ): number;

  seek(fd: number, offset: number, whence: number): number;

  flush(fd: number): void;
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

export interface ProcessStream {
  fd: number;
  stream_ops: StreamOps;
  sliccKernelFd?: number;

  sliccKernelFile?: boolean;
  path?: string;
  flags: number;
  position: number;
  tty?: unknown;
  node: { mode: number; mount?: { type?: unknown } };

  shared: object;
}

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

export interface ProcessPipeFs {
  createPipe(): { readable_fd: number; writable_fd: number };
}

export class KernelStreams {
  private readonly refs = new Map<number, number>();

  constructor(
    private readonly Fs: ProcessFs,
    private readonly sys: ProcessSys,
    private readonly sigpipe?: () => boolean
  ) {}

  attach(stream: ProcessStream, kfd: number): void {
    this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);

    stream.sliccKernelFd = kfd;
    stream.stream_ops = this.ops(kfd, stream.stream_ops);
  }

  attachFile(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd);
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
      write: (_s, buffer, offset, length) => {
        try {
          return this.sys.write(kfd, buffer.slice(offset, offset + length));
        } catch (e) {
          if (e instanceof SyscallError && e.code === 'EPIPE' && !this.sigpipe?.()) {
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
        base.close?.(stream);
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
