import { describe, expect, it } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-wire.js';
import { FdTable, openPipe } from '../../../src/kernel/wasm-realm/fd-table.js';
import {
  isWasmSyscall,
  WasmProcess,
  type WasmSyscall,
} from '../../../src/kernel/wasm-realm/process.js';
import { SIG, sigbit } from '../../../src/kernel/wasm-realm/signals.js';
import { LoopbackNet, type SockAddr } from '../../../src/kernel/wasm-realm/socket.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const inet = (port: number): SockAddr => ({ family: 'inet', host: '127.0.0.1', port });

function proc(net = new LoopbackNet(), pending = false) {
  return new WasmProcess(1, new FdTable(), { net, hasPending: () => pending });
}

async function sys(p: WasmProcess, req: WasmSyscall): Promise<unknown> {
  const r: SyncFsResult = await p.syscall(req);
  if (!r.ok) return r.errno;
  if (r.kind === 'json') return r.json;
  if (r.kind === 'bytes') return text(r.bytes);
  return 'ok';
}

async function listen(p: WasmProcess, port: number): Promise<number> {
  const fd = (await sys(p, { op: 'sock-open', domain: 'inet' })) as number;
  expect(await sys(p, { op: 'sock-bind', fd, addr: inet(port) })).toBe('ok');
  expect(await sys(p, { op: 'sock-listen', fd, backlog: 4 })).toBe('ok');
  return fd;
}

describe('socket syscalls', () => {
  it('are process syscalls on the SAB wire', () => {
    expect(isWasmSyscall({ op: 'sock-accept' })).toBe(true);
    expect(isWasmSyscall({ op: 'sock-nope' })).toBe(false);
  });

  it('connect, accept, send and recv between two processes of one namespace', async () => {
    const net = new LoopbackNet();
    const server = proc(net);
    const client = proc(net);
    const lfd = await listen(server, 9000);
    const cfd = (await sys(client, { op: 'sock-open', domain: 'inet' })) as number;
    expect(cfd).toBeGreaterThanOrEqual(3);
    expect(
      await sys(client, { op: 'sock-connect', fd: cfd, addr: inet(9000), nonblock: false })
    ).toBe('ok');
    const accepted = (await sys(server, { op: 'sock-accept', fd: lfd, nonblock: false })) as {
      fd: number;
      peer: SockAddr;
    };
    expect(accepted.peer).toEqual(await sys(client, { op: 'sock-name', fd: cfd, peer: false }));
    expect(await sys(client, { op: 'sock-name', fd: cfd, peer: true })).toEqual(inet(9000));
    expect(await sys(client, { op: 'fd-write', fd: cfd, body: bytes('hi') })).toBe(2);
    expect(await sys(server, { op: 'fd-read', fd: accepted.fd, max: 10, peek: true })).toBe('hi');
    expect(await sys(server, { op: 'fd-read', fd: accepted.fd, max: 10 })).toBe('hi');
    expect(await sys(server, { op: 'sock-shutdown', fd: accepted.fd, how: 1 })).toBe('ok');
    expect(await sys(client, { op: 'fd-read', fd: cfd, max: 10 })).toBe('');
  });

  it('reports EINPROGRESS for a non-blocking connect, already connected', async () => {
    const net = new LoopbackNet();
    const p = proc(net);
    await listen(p, 9001);
    const fd = (await sys(p, { op: 'sock-open', domain: 'inet' })) as number;
    expect(await sys(p, { op: 'sock-connect', fd, addr: inet(9001), nonblock: true })).toBe(
      'EINPROGRESS'
    );
    expect(await sys(p, { op: 'fd-poll', fd })).toMatchObject({ writable: true });
    expect(await sys(p, { op: 'sock-getopt', fd, level: 1, name: 4 })).toBe(0);
    expect(await sys(p, { op: 'sock-setopt', fd, level: 6, name: 1, value: 1 })).toBe('ok');
    expect(await sys(p, { op: 'sock-getopt', fd, level: 6, name: 1 })).toBe(1);
    expect(await sys(p, { op: 'sock-connect', fd, addr: inet(9001), nonblock: false })).toBe(
      'EISCONN'
    );
  });

  it('non-blocking reads, writes and accepts answer EAGAIN instead of waiting', async () => {
    const net = new LoopbackNet();
    const p = proc(net);
    const lfd = await listen(p, 9002);
    expect(await sys(p, { op: 'sock-accept', fd: lfd, nonblock: true })).toBe('EAGAIN');
    const fd = (await sys(p, { op: 'sock-open', domain: 'inet' })) as number;
    await sys(p, { op: 'sock-connect', fd, addr: inet(9002), nonblock: false });
    expect(await sys(p, { op: 'fd-read', fd, max: 10, nonblock: true })).toBe('EAGAIN');

    const big = new Uint8Array(100_000);
    expect(await sys(p, { op: 'fd-write', fd, body: big, nonblock: true })).toBe(65536);
    expect(await sys(p, { op: 'fd-write', fd, body: big, nonblock: true })).toBe('EAGAIN');
  });

  it('reads zero bytes at once, blocking or not, with nothing buffered', async () => {
    const net = new LoopbackNet();
    const p = proc(net);
    await listen(p, 9005);
    const fd = (await sys(p, { op: 'sock-open', domain: 'inet' })) as number;
    await sys(p, { op: 'sock-connect', fd, addr: inet(9005), nonblock: false });
    expect(await sys(p, { op: 'fd-read', fd, max: 0, nonblock: true })).toBe('');
    expect(await sys(p, { op: 'fd-read', fd, max: 0 })).toBe('');
    expect(await sys(p, { op: 'fd-read', fd, max: 0, peek: true })).toBe('');
  });

  it('closes a dequeued connection it cannot install (EMFILE): the client reads EOF', async () => {
    const net = new LoopbackNet();
    const p = proc(net);
    const lfd = await listen(p, 9006);
    const client = net.connect(inet(9006));
    for (let fd = 0; fd < FdTable.MAX_FDS; fd++)
      if (!p.fds.has(fd)) p.fds.installAt(fd, openPipe().read);
    expect(await sys(p, { op: 'sock-accept', fd: lfd, nonblock: false })).toBe('EMFILE');
    expect(await client.read(10)).toEqual(new Uint8Array(0));
  });

  it('a pending caught signal interrupts a blocking accept (EINTR)', async () => {
    const p = proc(new LoopbackNet(), true);
    const lfd = await listen(p, 9003);
    expect(await sys(p, { op: 'sock-accept', fd: lfd, nonblock: false })).toBe('EINTR');
  });

  it('a caught signal wakes an accept blocked in the kernel', async () => {
    const p = new WasmProcess(1, new FdTable(), { net: new LoopbackNet() });
    const lfd = await listen(p, 9004);
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR1), ignored: 0 });
    const blocked = sys(p, { op: 'sock-accept', fd: lfd, nonblock: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    p.signal(SIG.USR1);
    expect(await blocked).toBe('EINTR');
  });

  it('is ENOTSOCK on a pipe, EBADF on nothing, ENOTCONN for an unconnected peer name', async () => {
    const p = proc();
    const pipe = openPipe();
    const rfd = p.fds.install(pipe.read, 3);
    expect(await sys(p, { op: 'sock-listen', fd: rfd, backlog: 1 })).toBe('ENOTSOCK');
    expect(await sys(p, { op: 'fd-read', fd: rfd, max: 1, peek: true })).toBe('EOPNOTSUPP');
    expect(await sys(p, { op: 'sock-listen', fd: 99, backlog: 1 })).toBe('EBADF');
    const fd = (await sys(p, { op: 'sock-open', domain: 'unix' })) as number;
    expect(await sys(p, { op: 'sock-name', fd, peer: true })).toBe('ENOTCONN');
    expect(await sys(p, { op: 'sock-name', fd, peer: false })).toEqual({
      family: 'unix',
      path: '',
    });
    const ifd = (await sys(p, { op: 'sock-open', domain: 'inet' })) as number;
    expect(await sys(p, { op: 'sock-name', fd: ifd, peer: false })).toEqual({
      family: 'inet',
      host: '0.0.0.0',
      port: 0,
    });
    expect(await sys(p, { op: 'fd-read', fd: 99, max: 1 })).toBe('EBADF');
  });

  it('makes a socketpair, and gives the first fd back when the table is full', async () => {
    const p = proc();
    const [a, b] = (await sys(p, { op: 'sock-pair', domain: 'unix' })) as [number, number];
    await sys(p, { op: 'fd-write', fd: a, body: bytes('pair') });
    expect(await sys(p, { op: 'fd-read', fd: b, max: 10 })).toBe('pair');
    for (let fd = 0; fd < FdTable.MAX_FDS - 1; fd++)
      if (!p.fds.has(fd)) p.fds.installAt(fd, openPipe().read);
    expect(await sys(p, { op: 'sock-pair', domain: 'unix' })).toBe('EMFILE');
    expect(p.fds.numbers()).toHaveLength(FdTable.MAX_FDS - 1);
  });

  it('uses a namespace of its own when none is given', async () => {
    const p = new WasmProcess(1, new FdTable());
    expect(await listen(p, 80)).toBeGreaterThanOrEqual(3);
    const q = new WasmProcess(2, new FdTable());
    expect(await listen(q, 80)).toBeGreaterThanOrEqual(3);
  });
});
