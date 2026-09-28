/**
 * `process-sockets.ts` — BSD sockets inside a wasm-realm process worker
 * (#3571). The runtime publishes this as `Module.sliccKernel.net`; the
 * toolchain's `slicc_socket.c` overrides Emscripten's socket syscalls (whose
 * SOCKFS would open WebSockets) and calls it.
 *
 * A socket is a kernel descriptor (`socket-syscalls.ts`) behind a stream of
 * the program's FS, attached like a pipe end: `read` / `write` / `close` /
 * `dup` / `poll` / `select` work on it as on any kernel stream, and a forked
 * child shares it. `send` / `recv` add their flags (MSG_DONTWAIT, MSG_PEEK,
 * MSG_NOSIGNAL). Every call answers a value or a negative WASI errno, which
 * the shim hands to libc as `errno`.
 */
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
import type { SockAddr, SocketDomain } from './socket.js';
import type { SocketSyscall } from './socket-syscalls.js';
import { wasiErrno } from './wasi-errno.js';

const O_RDWR = 2;
/** SIGPIPE's default action (see kernel-streams.ts). */
const KILLED_BY_SIGPIPE = 128 + 13;

/** What `slicc_socket.c` calls: results, or a negative WASI errno. */
export interface SocketKernel {
  /** socket(2): the program's new fd. */
  socket(domain: SocketDomain, nonblock: boolean): number;
  /** socketpair(2): the two fds. */
  socketpair(domain: SocketDomain, nonblock: boolean): [number, number] | number;
  bind(fd: number, addr: SockAddr): number;
  listen(fd: number, backlog: number): number;
  /** accept4(2): the new fd (O_NONBLOCK when `nonblock`) and the peer. */
  accept(fd: number, nonblock: boolean): { fd: number; peer: SockAddr } | number;
  /** connect(2): 0; -EINPROGRESS on a non-blocking socket (connected already all the same). */
  connect(fd: number, addr: SockAddr): number;
  shutdown(fd: number, how: number): number;
  /** getsockname(2) / getpeername(2). */
  name(fd: number, peer: boolean): SockAddr | number;
  getopt(fd: number, level: number, name: number): { value: number } | number;
  setopt(fd: number, level: number, name: number, value: number): number;
  /** send(2): the count written. */
  send(fd: number, bytes: Uint8Array, flags: { dontwait?: boolean; nosignal?: boolean }): number;
  /** recv(2): the bytes (empty at end of file). */
  recv(fd: number, max: number, flags: { dontwait?: boolean; peek?: boolean }): Uint8Array | number;
}

export interface SocketKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;
  sys: ProcessSys;
  streams: KernelStreams;
  /** Whether the program ignores or handles SIGPIPE (see KernelStreamOptions). */
  sigpipe?: () => boolean;
  /** Whether an EINTR just seen may be retried (SA_RESTART handlers ran). */
  restartable?: () => boolean;
}

/** A syscall's failure as a negative WASI errno. */
function errno(e: unknown): number {
  if (e instanceof SyscallError) return -wasiErrno(e.code);
  const code = (e as { errno?: unknown } | null)?.errno; // FS.ErrnoError
  if (typeof code === 'number') return -code;
  throw e;
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
  /** A syscall that succeeds with nothing to report: 0. */
  const done = (req: SocketSyscall): number => {
    call(req);
    return 0;
  };
  /**
   * Run `op`, answering a failed syscall with its negative errno. One a caught
   * signal interrupted runs again when its handlers asked for SA_RESTART.
   */
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

  /** The socket stream behind a program fd (EBADF, ENOTSOCK). */
  const socketAt = (fd: number): ProcessStream & { sliccKernelFd: number } => {
    const stream = Fs.getStream(fd);
    if (!stream) throw new SyscallError('EBADF');
    if (!stream.sliccKernelSocket || stream.sliccKernelFd === undefined) {
      throw new SyscallError('ENOTSOCK');
    }
    return stream as ProcessStream & { sliccKernelFd: number };
  };
  const kfd = (fd: number): number => socketAt(fd).sliccKernelFd;

  /** A program fd for kernel socket `k`; the kernel descriptor goes back if the FS is full. */
  const install = (k: number, nonblock: boolean): number => {
    let stream: ProcessStream;
    try {
      stream = streams.socketStream(O_RDWR | (nonblock ? O_NONBLOCK : 0));
    } catch (e) {
      sys.close(k);
      throw e;
    }
    streams.attachSocket(stream, k);
    return stream.fd;
  };

  return {
    socket: (domain, nonblock) =>
      guard(() => install(json({ op: 'sock-open', domain }) as number, nonblock)),
    socketpair: (domain, nonblock) =>
      guard(() => {
        const [a, b] = json({ op: 'sock-pair', domain }) as [number, number];
        let first: number;
        try {
          first = install(a, nonblock);
        } catch (e) {
          sys.close(b);
          throw e;
        }
        try {
          return [first, install(b, nonblock)] as [number, number];
        } catch (e) {
          // No room for the second end: the first goes too (its close releases kernel fd `a`).
          const stream = Fs.getStream(first);
          if (stream) stream.stream_ops.close?.(stream);
          Fs.closeStream(first);
          throw e;
        }
      }),
    bind: (fd, addr) => guard(() => done({ op: 'sock-bind', fd: kfd(fd), addr })),
    listen: (fd, backlog) => guard(() => done({ op: 'sock-listen', fd: kfd(fd), backlog })),
    accept: (fd, nonblock) =>
      guard(() => {
        const listener = socketAt(fd);
        const req = {
          op: 'sock-accept' as const,
          fd: listener.sliccKernelFd,
          nonblock: (listener.flags & O_NONBLOCK) !== 0,
        };
        const got = json(req) as { fd: number; peer: SockAddr };
        return { fd: install(got.fd, nonblock), peer: got.peer };
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
          // No reader: SIGPIPE, unless MSG_NOSIGNAL or the program ignores / handles it.
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
