/**
 * `socket.ts` — the wasm realm's virtual loopback network (#3571): stream
 * sockets as kernel files, so native programs (curl, git, a C server) and
 * TypeScript kernel services talk over `127.0.0.1` without the host's network.
 *
 * - A {@link KernelSocket} is an open file description in the process's
 *   `FdTable`: `dup`, fork and exit share and release it like a pipe end.
 *   A connection is two bounded {@link KernelPipe}s, one per direction, so
 *   reads, writes, EOF, EPIPE and `select`/`poll` readiness are the pipe's.
 * - A {@link LoopbackNet} is one address namespace: which ports (`AF_INET`,
 *   any `127.x.x.x`) and paths (`AF_UNIX`, no file on the VFS) are bound, and
 *   which are listening. `connect()` completes against a listener's backlog
 *   at once, as TCP does before `accept()`; with no listener it is
 *   ECONNREFUSED, and an address off loopback is ENETUNREACH (nothing leaves
 *   the realm).
 * - Namespaces are per process owner ({@link loopbackNet}): the cone and each
 *   scoop have their own, which outlives any one `wasm` invocation, so a
 *   server started in one invocation (or a kernel service) is reachable from
 *   the next, and a scoop cannot reach the cone's listeners.
 *
 * A kernel service listens with {@link LoopbackNet.listen} and serves what
 * {@link KernelSocket.accept} returns; its reads and writes are the ones a
 * program's syscalls make.
 */
import { KernelError, type KernelFile, type PollState } from './fd-table.js';
import { KernelPipe, PIPE_CAPACITY, PipeError } from './pipe.js';

/** A socket address: `AF_INET` (IPv4, host in dotted form) or `AF_UNIX`. */
export type SockAddr =
  | { family: 'inet'; host: string; port: number }
  | { family: 'unix'; path: string };

export type SocketDomain = SockAddr['family'];

/** Linux's SOMAXCONN: a larger listen backlog is clamped to it. */
const SOMAXCONN = 4096;
/** Linux's ephemeral port range: an implicit bind (connect, listen, port 0) takes one. */
const EPHEMERAL_FIRST = 32768;
const EPHEMERAL_LAST = 60999;

/** Socket option levels and names the kernel answers itself (Linux / musl numbers). */
const SOL_SOCKET = 1;
const SO_TYPE = 3;
const SO_ERROR = 4;
const SO_SNDBUF = 7;
const SO_RCVBUF = 8;
const SO_ACCEPTCONN = 30;
const SO_DOMAIN = 39;
const SOCK_STREAM = 1;
const AF_UNIX = 1;
const AF_INET = 2;

/** shutdown(2)'s `how`. */
export const SHUT_RD = 0;
export const SHUT_WR = 1;
export const SHUT_RDWR = 2;

function isLoopback(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** A pipe's EPIPE / EINTR as the kernel error a syscall reports. */
async function pipeCall<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof PipeError) throw new KernelError(e.code);
    throw e;
  }
}

/** Waiters for a change of a socket's own state (a connection queued, a shutdown). */
class Changes {
  private waiters: Array<() => void> = [];

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new KernelError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** One end of a connection: the pipe it reads and the pipe it writes. */
interface Link {
  rx: KernelPipe;
  tx: KernelPipe;
}

/** A connected pair of sockets over two fresh pipes. */
function link(a: KernelSocket, b: KernelSocket): void {
  const ab = new KernelPipe();
  const ba = new KernelPipe();
  for (const pipe of [ab, ba]) {
    pipe.openRead();
    pipe.openWrite();
  }
  a.attach({ rx: ba, tx: ab });
  b.attach({ rx: ab, tx: ba });
}

export class KernelSocket implements KernelFile {
  private state: 'open' | 'listening' | 'connected' | 'closed' = 'open';
  /** getsockname(2); set by bind, or implicitly by listen / connect. */
  local: SockAddr | undefined;
  /** getpeername(2) of a connected socket. */
  peer: SockAddr | undefined;
  private link: Link | undefined;
  private readShut = false;
  private writeShut = false;
  /** A listener's connections not yet accepted, and how many it may hold. */
  private readonly queue: KernelSocket[] = [];
  private backlog = 0;
  /** Whether `local` holds a binding in the namespace (released at close). */
  private bound = false;
  private readonly changes = new Changes();
  /** setsockopt(2) values, by `level:name`: kept and read back, mostly without effect. */
  private readonly options = new Map<string, number>();

  constructor(
    private readonly net: LoopbackNet,
    readonly domain: SocketDomain
  ) {}

  /** Become connected over `link` (the namespace's connect / socketpair). */
  attach(link: Link): void {
    this.link = link;
    this.state = 'connected';
    this.changes.wake();
  }

  get listening(): boolean {
    return this.state === 'listening';
  }

  private connection(): Link {
    if (!this.link || this.state !== 'connected') throw new KernelError('ENOTCONN');
    return this.link;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const { rx } = this.connection();
    if (this.readShut || max <= 0) return new Uint8Array(0);
    return pipeCall(() => rx.read(max, signal));
  }

  async peek(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const { rx } = this.connection();
    if (this.readShut || max <= 0) return new Uint8Array(0);
    return pipeCall(() => rx.peek(max, signal));
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    const { tx } = this.connection();
    if (this.writeShut) throw new KernelError('EPIPE');
    return pipeCall(() => tx.write(bytes, signal));
  }

  poll(): PollState {
    if (this.state === 'listening') {
      return { readable: this.queue.length > 0, writable: false, hangup: false };
    }
    if (this.state !== 'connected' || !this.link) {
      // Not connected (or closed): nothing to wait for; the call that follows fails.
      return { readable: false, writable: false, hangup: true };
    }
    const { rx, tx } = this.link;
    return {
      readable: this.readShut || rx.readReady,
      writable: this.writeShut || tx.writeReady,
      hangup: rx.writersGone && tx.readersGone,
    };
  }

  changed(signal?: AbortSignal): Promise<void> {
    const own = this.changes.wait(signal);
    if (this.state !== 'connected' || !this.link) return own;
    const waits = [own, this.link.rx.changed(signal), this.link.tx.changed(signal)];
    // The losers settle later (or reject on the abort): nobody is listening.
    for (const wait of waits) wait.catch(() => undefined);
    return pipeCall(() => Promise.race(waits));
  }

  bind(addr: SockAddr): void {
    if (this.state !== 'open' || this.local) throw new KernelError('EINVAL');
    if (addr.family !== this.domain) throw new KernelError('EAFNOSUPPORT');
    this.local = this.net.bind(this, addr);
    this.bound = true;
  }

  listen(backlog: number): void {
    if (this.state === 'connected') throw new KernelError('EISCONN');
    if (this.state !== 'open' && this.state !== 'listening') throw new KernelError('EINVAL');
    if (!this.local) {
      // An unbound AF_UNIX socket has no name to listen on; AF_INET takes an ephemeral port.
      if (this.domain === 'unix') throw new KernelError('EINVAL');
      this.bind({ family: 'inet', host: '0.0.0.0', port: 0 });
    }
    this.backlog = Math.min(Math.max(backlog, 1), SOMAXCONN);
    this.state = 'listening';
  }

  /**
   * The next connection, waiting for one (`signal`: EINTR); EAGAIN when
   * `nonblock` and none is queued.
   */
  async accept(signal?: AbortSignal, nonblock = false): Promise<KernelSocket> {
    for (;;) {
      if (this.state !== 'listening') throw new KernelError('EINVAL');
      const next = this.queue.shift();
      if (next) return next;
      if (nonblock) throw new KernelError('EAGAIN');
      await this.changes.wait(signal);
    }
  }

  /** A client connecting to this listener: false when its backlog is full. */
  offer(server: KernelSocket): boolean {
    if (this.state !== 'listening' || this.queue.length >= this.backlog) return false;
    this.queue.push(server);
    this.changes.wake();
    return true;
  }

  connect(addr: SockAddr): void {
    if (this.state === 'connected') throw new KernelError('EISCONN');
    if (this.state !== 'open') throw new KernelError('EINVAL');
    if (addr.family !== this.domain) throw new KernelError('EAFNOSUPPORT');
    const target = this.net.target(addr);
    if (!this.local) {
      if (addr.family === 'inet') {
        this.local = this.net.bind(this, { family: 'inet', host: '127.0.0.1', port: 0 });
        this.bound = true;
      } else this.local = { family: 'unix', path: '' };
    }
    const server = new KernelSocket(this.net, this.domain);
    // The accepted end is named by the address the client asked for (its port, its 127.x host).
    server.local = addr.family === 'inet' ? { ...addr, host: canonicalHost(addr.host) } : addr;
    server.peer = this.local;
    this.peer = server.local;
    link(this, server);
    if (!target.offer(server)) {
      this.unlink();
      server.close();
      throw new KernelError('ECONNREFUSED');
    }
  }

  /** Back to unconnected after a refused connection. */
  private unlink(): void {
    const link = this.link;
    if (link) {
      link.rx.closeRead();
      link.tx.closeWrite();
    }
    this.link = undefined;
    this.peer = undefined;
    this.state = 'open';
  }

  shutdown(how: number): void {
    const { rx, tx } = this.connection();
    if (how !== SHUT_RD && how !== SHUT_WR && how !== SHUT_RDWR) throw new KernelError('EINVAL');
    if (how !== SHUT_WR && !this.readShut) {
      this.readShut = true;
      rx.closeRead();
    }
    if (how !== SHUT_RD && !this.writeShut) {
      this.writeShut = true;
      tx.closeWrite();
    }
    this.changes.wake();
  }

  /** getsockopt(2): the kernel's own answers, else what setsockopt stored (0 by default). */
  getOption(level: number, name: number): number {
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_TYPE:
          return SOCK_STREAM;
        case SO_ERROR:
          return 0; // connect() completes or fails at once: never an error pending
        case SO_ACCEPTCONN:
          return this.state === 'listening' ? 1 : 0;
        case SO_DOMAIN:
          return this.domain === 'inet' ? AF_INET : AF_UNIX;
        case SO_SNDBUF:
        case SO_RCVBUF:
          return this.options.get(`${level}:${name}`) ?? PIPE_CAPACITY;
      }
    }
    return this.options.get(`${level}:${name}`) ?? 0;
  }

  /**
   * setsockopt(2): kept for getsockopt. TCP_NODELAY, SO_KEEPALIVE,
   * SO_REUSEADDR and the like have nothing to change on a loopback of pipes.
   */
  setOption(level: number, name: number, value: number): void {
    this.options.set(`${level}:${name}`, value);
  }

  close(): void {
    const was = this.state;
    this.state = 'closed';
    if (was === 'listening') {
      // Connections nobody accepted: their clients read EOF.
      for (const pending of this.queue.splice(0)) pending.close();
    }
    if (this.link) {
      if (!this.readShut) this.link.rx.closeRead();
      if (!this.writeShut) this.link.tx.closeWrite();
      this.readShut = true;
      this.writeShut = true;
    }
    if (this.bound && this.local) this.net.release(this.local, this);
    this.bound = false;
    this.changes.wake();
  }

  /** A connected pair (socketpair(2)): each end the other's peer. */
  static pair(net: LoopbackNet, domain: SocketDomain): [KernelSocket, KernelSocket] {
    const a = new KernelSocket(net, domain);
    const b = new KernelSocket(net, domain);
    const name: SockAddr =
      domain === 'inet'
        ? { family: 'inet', host: '127.0.0.1', port: 0 }
        : { family: 'unix', path: '' };
    a.local = b.local = a.peer = b.peer = name;
    link(a, b);
    return [a, b];
  }
}

/** `0.0.0.0` (INADDR_ANY) as a connect target is this host: `127.0.0.1`. */
function canonicalHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

/** The namespace key of an address: inet by port (any 127.x host), unix by path. */
function keyOf(addr: SockAddr): string {
  return addr.family === 'inet' ? `inet:${addr.port}` : `unix:${addr.path}`;
}

export class LoopbackNet {
  /** Bound addresses (listening or not) and their sockets. */
  private readonly bound = new Map<string, KernelSocket>();
  private nextEphemeral = EPHEMERAL_FIRST;

  /** A new unconnected socket of `domain` (socket(2)). */
  socket(domain: SocketDomain): KernelSocket {
    return new KernelSocket(this, domain);
  }

  /**
   * A kernel service's listener on `addr` (port 0: an ephemeral one; read
   * `local` for it). Its {@link KernelSocket.accept} yields connections;
   * `close()` stops listening.
   */
  listen(addr: SockAddr, backlog = 128): KernelSocket {
    const socket = this.socket(addr.family);
    socket.bind(addr);
    socket.listen(backlog);
    return socket;
  }

  /** A kernel-side client connection to `addr` (ECONNREFUSED: nothing listens there). */
  connect(addr: SockAddr): KernelSocket {
    const socket = this.socket(addr.family);
    socket.connect(addr);
    return socket;
  }

  /** Take `addr` for `socket`; port 0 picks a free ephemeral port. The address as bound. */
  bind(socket: KernelSocket, addr: SockAddr): SockAddr {
    if (addr.family === 'unix') {
      if (addr.path === '') throw new KernelError('EINVAL');
    } else if (addr.host !== '0.0.0.0' && !isLoopback(addr.host)) {
      throw new KernelError('EADDRNOTAVAIL');
    }
    const named =
      addr.family === 'inet' && addr.port === 0 ? { ...addr, port: this.ephemeral() } : addr;
    const key = keyOf(named);
    if (this.bound.has(key)) throw new KernelError('EADDRINUSE');
    this.bound.set(key, socket);
    return named;
  }

  /** `socket` closed: its address is free again. */
  release(addr: SockAddr, socket: KernelSocket): void {
    const key = keyOf(addr);
    if (this.bound.get(key) === socket) this.bound.delete(key);
  }

  /** The listener a connect to `addr` reaches: ENETUNREACH off loopback, ECONNREFUSED when none. */
  target(addr: SockAddr): KernelSocket {
    if (addr.family === 'inet' && !isLoopback(canonicalHost(addr.host))) {
      throw new KernelError('ENETUNREACH');
    }
    const socket = this.bound.get(keyOf(addr));
    if (!socket?.listening) throw new KernelError('ECONNREFUSED');
    return socket;
  }

  private ephemeral(): number {
    const span = EPHEMERAL_LAST - EPHEMERAL_FIRST + 1;
    for (let i = 0; i < span; i++) {
      const port = this.nextEphemeral;
      this.nextEphemeral = port === EPHEMERAL_LAST ? EPHEMERAL_FIRST : port + 1;
      if (!this.bound.has(`inet:${port}`)) return port;
    }
    throw new KernelError('EADDRINUSE');
  }
}

/** The namespaces, by process owner (the kernel worker's lifetime). */
const namespaces = new Map<string, LoopbackNet>();

/**
 * The loopback namespace of a process owner: the cone, one scoop, the system.
 * The key is {@link ownerKey}'s; the namespace lives as long as the kernel.
 */
export function loopbackNet(owner: string): LoopbackNet {
  let net = namespaces.get(owner);
  if (!net) {
    net = new LoopbackNet();
    namespaces.set(owner, net);
  }
  return net;
}

/** A namespace key for a process-table owner (`kind` and scoop JID); `local` without one. */
export function ownerKey(owner: { kind: string; scoopJid?: string } | undefined): string {
  return owner ? `${owner.kind}:${owner.scoopJid ?? ''}` : 'local';
}
