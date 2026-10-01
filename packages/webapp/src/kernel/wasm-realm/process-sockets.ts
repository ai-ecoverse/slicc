import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import {
  type KernelStreams,
  O_NONBLOCK,
  ProcessExit,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';
import { setCloseOnExec } from './process-fds.js';
import type { SockAddr, SocketDomain } from './socket.js';
import type { SocketSyscall } from './socket-syscalls.js';
import { wasiErrno } from './wasi-errno.js';

const O_RDWR = 2;

const KILLED_BY_SIGPIPE = 128 + 13;

export interface SocketKernel {
  socket(domain: SocketDomain, nonblock: boolean, cloexec?: boolean): number;

  socketpair(domain: SocketDomain, nonblock: boolean, cloexec?: boolean): [number, number] | number;
  bind(fd: number, addr: SockAddr): number;
  listen(fd: number, backlog: number): number;

  accept(fd: number, nonblock: boolean, cloexec?: boolean): { fd: number; peer: SockAddr } | number;

  connect(fd: number, addr: SockAddr): number;
  shutdown(fd: number, how: number): number;

  name(fd: number, peer: boolean): SockAddr | number;
  getopt(fd: number, level: number, name: number): { value: number } | number;
  setopt(fd: number, level: number, name: number, value: number): number;

  send(fd: number, bytes: Uint8Array, flags: { dontwait?: boolean; nosignal?: boolean }): number;

  recv(fd: number, max: number, flags: { dontwait?: boolean; peek?: boolean }): Uint8Array | number;
}

export interface SocketKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;
  sys: ProcessSys;
  streams: KernelStreams;

  sigpipe?: () => boolean;

  restartable?: () => boolean;
}

function errno(e: unknown): number {
  if (e instanceof SyscallError) return -wasiErrno(e.code);
  const code = (e as { errno?: unknown } | null)?.errno;
  if (typeof code === 'number') return -code;
  throw e;
}

const O_WRONLY = 0o1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;

function socketNode(Fs: ProcessFs, addr: SockAddr): { remove(): void } | undefined {
  if (addr.family !== 'unix' || !addr.path || addr.path.startsWith('\0')) return undefined;
  const fs = Fs as ProcessFs & { unlink?(path: string): void };
  let stream: ProcessStream;
  try {
    stream = Fs.open(addr.path, O_WRONLY | O_CREAT | O_EXCL, 0o755);
  } catch (e) {
    if ((e as { errno?: unknown })?.errno === wasiErrno('EEXIST')) {
      throw new SyscallError('EADDRINUSE');
    }
    throw e;
  }

  if (Fs.close) Fs.close(stream);
  else Fs.closeStream(stream.fd);
  return { remove: () => fs.unlink?.(addr.path) };
}

export function createSocketKernel(deps: SocketKernelDeps): SocketKernel {
  const { transport, Fs, sys, streams } = deps;

  const call = (req: SocketSyscall): SyncFsResult => {
    const r = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r;
  };
  const json = (req: SocketSyscall): unknown => {
    const r = call(req);
    return r.ok && r.kind === 'json' ? r.json : undefined;
  };

  const done = (req: SocketSyscall): number => {
    call(req);
    return 0;
  };

  const guard = <T>(op: () => T): T | number => {
    for (;;) {
      try {
        return op();
      } catch (e) {
        const restart = e instanceof SyscallError && e.code === 'EINTR' && deps.restartable?.();
        if (!restart) return errno(e);
      }
    }
  };

  const socketAt = (fd: number): ProcessStream & { sliccKernelFd: number } => {
    const stream = Fs.getStream(fd);
    if (!stream) throw new SyscallError('EBADF');
    if (!stream.sliccKernelSocket || stream.sliccKernelFd === undefined) {
      throw new SyscallError('ENOTSOCK');
    }
    return stream as ProcessStream & { sliccKernelFd: number };
  };
  const kfd = (fd: number): number => socketAt(fd).sliccKernelFd;

  const install = (k: number, nonblock: boolean, cloexec = false): number => {
    let stream: ProcessStream;
    try {
      stream = streams.socketStream(O_RDWR | (nonblock ? O_NONBLOCK : 0));
    } catch (e) {
      sys.close(k);
      throw e;
    }
    streams.attachSocket(stream, k);
    setCloseOnExec(stream, cloexec);
    return stream.fd;
  };

  return {
    socket: (domain, nonblock, cloexec) =>
      guard(() => install(json({ op: 'sock-open', domain }) as number, nonblock, cloexec)),
    socketpair: (domain, nonblock, cloexec) =>
      guard(() => {
        const [a, b] = json({ op: 'sock-pair', domain }) as [number, number];
        let first: number;
        try {
          first = install(a, nonblock, cloexec);
        } catch (e) {
          sys.close(b);
          throw e;
        }
        try {
          return [first, install(b, nonblock, cloexec)] as [number, number];
        } catch (e) {
          const stream = Fs.getStream(first);
          if (stream) stream.stream_ops.close?.(stream);
          Fs.closeStream(first);
          throw e;
        }
      }),
    bind: (fd, addr) =>
      guard(() => {
        const node = socketNode(Fs, addr);
        try {
          return done({ op: 'sock-bind', fd: kfd(fd), addr });
        } catch (e) {
          node?.remove();
          throw e;
        }
      }),
    listen: (fd, backlog) => guard(() => done({ op: 'sock-listen', fd: kfd(fd), backlog })),
    accept: (fd, nonblock, cloexec) =>
      guard(() => {
        const listener = socketAt(fd);
        const req = {
          op: 'sock-accept' as const,
          fd: listener.sliccKernelFd,
          nonblock: (listener.flags & O_NONBLOCK) !== 0,
        };
        const got = json(req) as { fd: number; peer: SockAddr };
        return { fd: install(got.fd, nonblock, cloexec), peer: got.peer };
      }),
    connect: (fd, addr) =>
      guard(() => {
        const stream = socketAt(fd);
        const nonblock = (stream.flags & O_NONBLOCK) !== 0;
        return done({ op: 'sock-connect', fd: stream.sliccKernelFd, addr, nonblock });
      }),
    shutdown: (fd, how) => guard(() => done({ op: 'sock-shutdown', fd: kfd(fd), how })),
    name: (fd, peer) => guard(() => json({ op: 'sock-name', fd: kfd(fd), peer }) as SockAddr),
    getopt: (fd, level, name) =>
      guard(() => ({ value: json({ op: 'sock-getopt', fd: kfd(fd), level, name }) as number })),
    setopt: (fd, level, name, value) =>
      guard(() => done({ op: 'sock-setopt', fd: kfd(fd), level, name, value })),
    send: (fd, bytes, flags) =>
      guard(() => {
        const stream = socketAt(fd);
        const nonblock = flags.dontwait === true || (stream.flags & O_NONBLOCK) !== 0;
        try {
          return sys.write(stream.sliccKernelFd, bytes, { nonblock });
        } catch (e) {
          const broken = e instanceof SyscallError && e.code === 'EPIPE';
          if (broken && !flags.nosignal && !deps.sigpipe?.())
            throw new ProcessExit(KILLED_BY_SIGPIPE);
          throw e;
        }
      }),
    recv: (fd, max, flags) =>
      guard(() => {
        const stream = socketAt(fd);
        const nonblock = flags.dontwait === true || (stream.flags & O_NONBLOCK) !== 0;
        return sys.read(stream.sliccKernelFd, max, { nonblock, peek: flags.peek === true });
      }),
  };
}
