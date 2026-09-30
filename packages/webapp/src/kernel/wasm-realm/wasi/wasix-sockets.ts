/**
 * `wasix-sockets.ts` — the sockets a WASIX program opens itself (#3530
 * phase 5f): `sock_open`, `sock_bind`, `sock_listen`, `sock_connect`,
 * `sock_accept_v2`, names, options and `resolve`, on the kernel's sockets in
 * its owner's loopback namespace (`socket-syscalls.ts`) — the ones
 * Emscripten programs use. Data moves through preview1's `sock_recv` /
 * `sock_send` (`sock_recv_from` / `sock_send_to` are those on a connected
 * stream). HTTP leaves through the realm's proxy, which `http_proxy` /
 * `https_proxy` name, as it does for every program; only loopback names
 * resolve.
 *
 * `__wasi_addr_port_t` (110 bytes): a family tag (1 inet4, 2 inet6, 3
 * unix), then at offset 2 the port (little-endian) and the address bytes,
 * or the unix path.
 */
import type { SockAddr } from '../socket.js';
import { E, FDFLAGS } from './wasi-abi.js';
import { WasiError } from './wasi-files.js';
import type { WasiFunction, WasiHost } from './wasi-host.js';

const INET4 = 1;
const INET6 = 2;
const UNIX = 3;
const STREAM = 1;
const ADDR_IP_SIZE = 18;
const LOOPBACK = '127.0.0.1';

/** WASIX socket options, as POSIX [level, name] the kernel keeps. */
const OPTIONS: Readonly<Record<number, readonly [number, number]>> = {
  1: [1, 15], // REUSE_PORT → SO_REUSEPORT
  2: [1, 2], // REUSE_ADDR → SO_REUSEADDR
  3: [6, 1], // NO_DELAY → TCP_NODELAY
  4: [1, 5], // DONT_ROUTE
  6: [1, 6], // BROADCAST
  10: [1, 30], // LISTENING → SO_ACCEPTCONN
  11: [1, 4], // LAST_ERROR → SO_ERROR
  12: [1, 9], // KEEP_ALIVE
  14: [1, 10], // OOB_INLINE
  15: [1, 8], // RECV_BUF_SIZE → SO_RCVBUF
  16: [1, 7], // SEND_BUF_SIZE → SO_SNDBUF
  25: [1, 3], // TYPE → SO_TYPE
};

/** An address from `ptr` (an IPv6 one as the loopback it stands for here). */
export function readAddr(view: DataView, ptr: number): SockAddr {
  const tag = view.getUint8(ptr);
  if (tag === UNIX) {
    let end = ptr + 2;
    while (end < ptr + 110 && view.getUint8(end) !== 0) end++;
    const path = new TextDecoder().decode(
      new Uint8Array(view.buffer, ptr + 2, end - ptr - 2).slice()
    );
    return { family: 'unix', path };
  }
  const port = view.getUint16(ptr + 2, true);
  if (tag === INET4) {
    const host = [0, 1, 2, 3].map((i) => view.getUint8(ptr + 4 + i)).join('.');
    return { family: 'inet', host, port };
  }
  if (tag === INET6) {
    const bytes = new Uint8Array(view.buffer, ptr + 4, 16);
    const any = bytes.every((b) => b === 0);
    return { family: 'inet', host: any ? '0.0.0.0' : LOOPBACK, port };
  }
  throw new WasiError('EAFNOSUPPORT');
}

/** `addr` into the `__wasi_addr_port_t` at `ptr`. */
export function writeAddr(view: DataView, ptr: number, addr: SockAddr | undefined): void {
  new Uint8Array(view.buffer, ptr, 110).fill(0);
  if (!addr) return;
  if (addr.family === 'unix') {
    view.setUint8(ptr, UNIX);
    new Uint8Array(view.buffer, ptr + 2, 107).set(
      new TextEncoder().encode(addr.path).subarray(0, 107)
    );
    return;
  }
  view.setUint8(ptr, INET4);
  view.setUint16(ptr + 2, addr.port, true);
  const octets = ipv4(addr.host) ?? [127, 0, 0, 1];
  octets.forEach((b, i) => void view.setUint8(ptr + 4 + i, b));
}

/** A dotted IPv4 address's bytes, or undefined. */
function ipv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

/** What `resolve` answers for `name`: loopback names and literal IPv4 addresses (the proxy resolves the rest). */
export function resolveName(name: string): number[] | undefined {
  if (name === 'localhost' || name === 'localhost.localdomain' || name === 'ip6-localhost') {
    return [127, 0, 0, 1];
  }
  if (name === '::1') return [127, 0, 0, 1];
  return ipv4(name);
}

export function wasixSocketImports(
  host: WasiHost,
  preview1: Record<string, WasiFunction>
): Record<string, WasiFunction> {
  const { mem, fds, o } = host;
  const call = (req: Parameters<typeof o.kernel.call>[0]) => o.kernel.call(req);
  /** A socket's entry (ENOTSOCK for another descriptor). */
  const socket = (fd: number) => {
    const e = fds.get(fd);
    if (e.type !== 'kernel' || fds.kind(fd, e) !== 'socket') throw new WasiError('ENOTSOCK');
    return e;
  };
  const option = (opt: number): readonly [number, number] | undefined => OPTIONS[opt];
  return {
    sock_open: (af: number, type: number, _proto: number, out: number) => {
      if (af !== INET4 && af !== INET6 && af !== UNIX) throw new WasiError('EAFNOSUPPORT');
      if (type !== STREAM) throw new WasiError('EPROTONOSUPPORT');
      const fd = call({ op: 'sock-open', domain: af === UNIX ? 'unix' : 'inet' }) as number;
      fds.adopt(fd, 'socket', false);
      mem.view().setUint32(out, fd, true);
    },
    sock_bind: (fd: number, addr: number) => {
      socket(fd);
      call({ op: 'sock-bind', fd, addr: readAddr(mem.view(), addr) });
    },
    sock_listen: (fd: number, backlog: number) => {
      socket(fd);
      call({ op: 'sock-listen', fd, backlog });
    },
    sock_connect: (fd: number, addr: number) => {
      const e = socket(fd);
      call({ op: 'sock-connect', fd, addr: readAddr(mem.view(), addr), nonblock: e.nonblock });
    },
    sock_accept_v2: (fd: number, flags: number, outFd: number, outAddr: number) => {
      const e = socket(fd);
      const r = call({ op: 'sock-accept', fd, nonblock: e.nonblock }) as {
        fd: number;
        peer?: SockAddr;
      };
      fds.adopt(r.fd, 'socket', (flags & FDFLAGS.NONBLOCK) !== 0);
      mem.view().setUint32(outFd, r.fd, true);
      writeAddr(mem.view(), outAddr, r.peer);
    },
    sock_addr_local: (fd: number, out: number) => {
      socket(fd);
      writeAddr(mem.view(), out, call({ op: 'sock-name', fd, peer: false }) as SockAddr);
    },
    sock_addr_peer: (fd: number, out: number) => {
      socket(fd);
      writeAddr(mem.view(), out, call({ op: 'sock-name', fd, peer: true }) as SockAddr);
    },
    // A connected stream: the peer is the one it is connected to.
    sock_recv_from: (
      fd: number,
      iovs: number,
      n: number,
      riflags: number,
      outLen: number,
      outFlags: number,
      outAddr: number
    ) => {
      const r = preview1.sock_recv(
        fd as never,
        iovs as never,
        n as never,
        riflags as never,
        outLen as never,
        outFlags as never
      );
      if (r !== E.SUCCESS) return r;
      writeAddr(mem.view(), outAddr, call({ op: 'sock-name', fd, peer: true }) as SockAddr);
      return E.SUCCESS;
    },
    sock_send_to: (
      fd: number,
      iovs: number,
      n: number,
      flags: number,
      _addr: number,
      out: number
    ) => preview1.sock_send(fd as never, iovs as never, n as never, flags as never, out as never),
    sock_status: (fd: number, out: number) => {
      socket(fd);
      mem.view().setUint8(out, 1); // opened
    },
    sock_get_opt_flag: (fd: number, opt: number, out: number) => {
      socket(fd);
      const pair = option(opt);
      const v = pair
        ? (call({ op: 'sock-getopt', fd, level: pair[0], name: pair[1] }) as number)
        : 0;
      mem.view().setUint8(out, v ? 1 : 0);
    },
    sock_set_opt_flag: (fd: number, opt: number, flag: number) => {
      socket(fd);
      const pair = option(opt);
      if (pair) call({ op: 'sock-setopt', fd, level: pair[0], name: pair[1], value: flag ? 1 : 0 });
    },
    sock_get_opt_size: (fd: number, opt: number, out: number) => {
      socket(fd);
      const pair = option(opt);
      const v = pair
        ? (call({ op: 'sock-getopt', fd, level: pair[0], name: pair[1] }) as number)
        : 0;
      mem.view().setBigUint64(out, BigInt(v), true);
    },
    sock_set_opt_size: (fd: number, opt: number, size: bigint) => {
      socket(fd);
      const pair = option(opt);
      if (pair) call({ op: 'sock-setopt', fd, level: pair[0], name: pair[1], value: Number(size) });
    },
    // Timeouts: programs time out through poll (Python's settimeout does); none is kept.
    sock_get_opt_time: (fd: number, _opt: number, out: number) => {
      socket(fd);
      new Uint8Array(mem.view().buffer, out, 16).fill(0);
    },
    sock_set_opt_time: (fd: number) => void socket(fd),
    // No sendfile: callers (Python's socket.sendfile) fall back to send.
    sock_send_file: () => E.NOSYS,
    // host (name, len), port, addrs, naddrs → count
    resolve: (
      name: number,
      len: number,
      _port: number,
      addrs: number,
      naddrs: number,
      out: number
    ) => {
      const ip = resolveName(mem.string(name, len));
      if (!ip) throw new WasiError('ENOENT');
      if (naddrs < 1) throw new WasiError('EINVAL');
      const view = mem.view();
      new Uint8Array(view.buffer, addrs, ADDR_IP_SIZE).fill(0);
      view.setUint8(addrs, INET4);
      ip.forEach((b, i) => void view.setUint8(addrs + 2 + i, b));
      view.setUint32(out, 1, true);
    },
  };
}
