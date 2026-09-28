import { describe, expect, it } from 'vitest';
import { FdTable, KernelError, OpenFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { selectFds } from '../../../src/kernel/wasm-realm/select.js';
import {
  KernelSocket,
  LoopbackNet,
  loopbackNet,
  ownerKey,
  SHUT_RD,
  SHUT_RDWR,
  SHUT_WR,
  type SockAddr,
} from '../../../src/kernel/wasm-realm/socket.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const inet = (port: number, host = '127.0.0.1'): SockAddr => ({ family: 'inet', host, port });

function listening(net: LoopbackNet, backlog?: number): { listener: KernelSocket; port: number } {
  const listener = net.listen(inet(0), backlog);
  const local = listener.local;
  if (local?.family !== 'inet') throw new Error('no port');
  return { listener, port: local.port };
}

async function connected(net = new LoopbackNet()) {
  const { listener, port } = listening(net);
  const client = net.connect(inet(port));
  const server = await listener.accept();
  return { net, listener, port, client, server };
}

async function errno(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e instanceof KernelError ? e.code : String(e);
  }
  return undefined;
}

describe('LoopbackNet', () => {
  it('connects a client to a listener, both ways, named by the addresses', async () => {
    const { client, server, port } = await connected();
    await client.write(bytes('ping'));
    expect(text(await server.read(100))).toBe('ping');
    await server.write(bytes('pong'));
    expect(text(await client.read(100))).toBe('pong');
    expect(server.local).toEqual(inet(port));
    expect(client.peer).toEqual(inet(port));
    expect(server.peer).toEqual(client.local);
    expect(client.local).toMatchObject({ family: 'inet', host: '127.0.0.1' });
  });

  it('takes ephemeral ports from 32768 and never hands out a bound one', () => {
    const net = new LoopbackNet();
    net.listen(inet(32769));
    expect(listening(net).port).toBe(32768);
    expect(listening(net).port).toBe(32770);
  });

  it('refuses a second bind, a non-loopback bind, and binds any 127.x host by port', () => {
    const net = new LoopbackNet();
    net.listen(inet(80));
    expect(() => net.listen(inet(80, '127.0.0.2'))).toThrow('EADDRINUSE');
    expect(() => net.listen(inet(81, '10.0.0.1'))).toThrow('EADDRNOTAVAIL');
    expect(() => net.listen(inet(0, '0.0.0.0'))).not.toThrow();
  });

  it('connects to 0.0.0.0 and any 127.x as this host; refuses nothing listening; off-loopback is unreachable', async () => {
    const net = new LoopbackNet();
    const { listener, port } = listening(net);
    net.connect(inet(port, '0.0.0.0'));
    net.connect(inet(port, '127.1.2.3'));
    expect((await listener.accept()).local).toEqual(inet(port));
    expect((await listener.accept()).local).toEqual(inet(port, '127.1.2.3'));
    expect(() => net.connect(inet(port + 1))).toThrow('ECONNREFUSED');
    expect(() => net.connect(inet(port, '192.168.1.1'))).toThrow('ENETUNREACH');
  });

  it('refuses a connection a bound but not listening socket, or a full backlog, would take', () => {
    const net = new LoopbackNet();
    const bound = net.socket('inet');
    bound.bind(inet(7000));
    expect(() => net.connect(inet(7000))).toThrow('ECONNREFUSED');
    const { port } = listening(net, 1);
    net.connect(inet(port));
    const refused = net.socket('inet');
    expect(() => refused.connect(inet(port))).toThrow('ECONNREFUSED');

    expect(refused.poll()).toEqual({ readable: false, writable: false, hangup: true });
  });

  it('frees the port when the listener closes; queued clients read end of file', async () => {
    const net = new LoopbackNet();
    const { listener, port } = listening(net);
    const client = net.connect(inet(port));
    listener.close();
    expect(await client.read(10)).toEqual(new Uint8Array(0));
    expect(() => net.connect(inet(port))).toThrow('ECONNREFUSED');
    expect(() => net.listen(inet(port))).not.toThrow();
    expect(await errno(listener.accept())).toBe('EINVAL');
  });

  it('frees a client port at close', async () => {
    const { net, client } = await connected();
    const local = client.local as { port: number };
    client.close();
    expect(() => net.listen(inet(local.port))).not.toThrow();
  });

  it('keeps one namespace per owner key', () => {
    const cone = ownerKey({ kind: 'cone', scoopJid: 'cone-1' });
    expect(cone).toBe('cone:cone-1');
    expect(ownerKey(undefined)).toBe('local');
    expect(ownerKey({ kind: 'system' })).toBe('system:');
    expect(loopbackNet(cone)).toBe(loopbackNet(cone));
    expect(loopbackNet(cone)).not.toBe(loopbackNet('scoop:s1'));
  });
});

describe('KernelSocket', () => {
  it('accept waits for a connection, EAGAIN when non-blocking, EINTR when interrupted', async () => {
    const net = new LoopbackNet();
    const { listener, port } = listening(net);
    expect(await errno(listener.accept(undefined, true))).toBe('EAGAIN');
    const interrupt = new AbortController();
    const blocked = listener.accept(interrupt.signal);
    interrupt.abort();
    expect(await errno(blocked)).toBe('EINTR');
    const waiting = listener.accept();
    net.connect(inet(port));
    expect((await waiting).peer).toMatchObject({ family: 'inet' });
  });

  it('shutdown(SHUT_WR) is the peer’s end of file; writing after it is EPIPE', async () => {
    const { client, server } = await connected();
    await client.write(bytes('last'));
    client.shutdown(SHUT_WR);
    expect(text(await server.read(10))).toBe('last');
    expect(await server.read(10)).toEqual(new Uint8Array(0));
    expect(await errno(client.write(bytes('x')))).toBe('EPIPE');

    await server.write(bytes('reply'));
    expect(text(await client.read(10))).toBe('reply');
    expect(client.poll().writable).toBe(true);
  });

  it('shutdown(SHUT_RD) reads end of file; the peer’s writes fail; SHUT_RDWR does both', async () => {
    const { client, server } = await connected();
    client.shutdown(SHUT_RD);
    expect(await client.read(10)).toEqual(new Uint8Array(0));
    expect(await client.peek(10)).toEqual(new Uint8Array(0));
    expect(await errno(server.write(bytes('x')))).toBe('EPIPE');
    client.shutdown(SHUT_RDWR);
    expect(client.poll()).toEqual({ readable: true, writable: true, hangup: false });
    expect(() => client.shutdown(7)).toThrow('EINVAL');
  });

  it('reads end of file and writes EPIPE once the peer closed; poll says hangup', async () => {
    const { client, server } = await connected();
    server.close();
    expect(client.poll()).toEqual({ readable: true, writable: true, hangup: true });
    expect(await client.read(10)).toEqual(new Uint8Array(0));
    expect(await errno(client.write(bytes('x')))).toBe('EPIPE');
    server.close();
  });

  it('reads and peeks zero bytes at once, with nothing buffered', async () => {
    const { server } = await connected();
    expect(await server.read(0)).toEqual(new Uint8Array(0));
    expect(await server.peek(0)).toEqual(new Uint8Array(0));
  });

  it('peeks without consuming', async () => {
    const { client, server } = await connected();
    await client.write(bytes('ab'));
    await client.write(bytes('cd'));
    expect(text(await server.peek(3))).toBe('abc');
    expect(text(await server.read(10))).toBe('abcd');
  });

  it('is ENOTCONN to read, write, peek or shut down before it connects', async () => {
    const socket = new LoopbackNet().socket('inet');
    expect(await errno(socket.read(1))).toBe('ENOTCONN');
    expect(await errno(socket.peek(1))).toBe('ENOTCONN');
    expect(await errno(socket.write(bytes('x')))).toBe('ENOTCONN');
    expect(() => socket.shutdown(SHUT_WR)).toThrow('ENOTCONN');
  });

  it('checks the state and family of bind, listen and connect', async () => {
    const net = new LoopbackNet();
    const { client, port, listener } = await connected(net);
    expect(() => client.connect(inet(port))).toThrow('EISCONN');
    expect(() => client.listen(1)).toThrow('EISCONN');
    expect(() => client.bind(inet(1))).toThrow('EINVAL');
    expect(() => listener.connect(inet(port))).toThrow('EINVAL');
    const unix = net.socket('unix');
    expect(() => unix.bind(inet(1))).toThrow('EAFNOSUPPORT');
    expect(() => unix.connect(inet(1))).toThrow('EAFNOSUPPORT');
    expect(() => unix.listen(1)).toThrow('EINVAL');
    expect(() => unix.bind({ family: 'unix', path: '' })).toThrow('EINVAL');
    listener.listen(64);
    listener.close();
    expect(() => listener.listen(1)).toThrow('EINVAL');
  });

  it('listen() without bind takes an ephemeral port on every address', () => {
    const socket = new LoopbackNet().socket('inet');
    socket.listen(0);
    expect(socket.local).toEqual({ family: 'inet', host: '0.0.0.0', port: 32768 });
    expect(socket.listening).toBe(true);
  });

  it('serves AF_UNIX by path, with an unnamed client', async () => {
    const net = new LoopbackNet();
    const listener = net.listen({ family: 'unix', path: '/tmp/x.sock' });
    const client = net.connect({ family: 'unix', path: '/tmp/x.sock' });
    const server = await listener.accept();
    expect(client.local).toEqual({ family: 'unix', path: '' });
    expect(server.local).toEqual({ family: 'unix', path: '/tmp/x.sock' });
    await client.write(bytes('u'));
    expect(text(await server.read(1))).toBe('u');
  });

  it('pairs two sockets (socketpair)', async () => {
    const [a, b] = KernelSocket.pair(new LoopbackNet(), 'unix');
    await a.write(bytes('pair'));
    expect(text(await b.read(10))).toBe('pair');
    expect(a.peer).toEqual({ family: 'unix', path: '' });
    expect(KernelSocket.pair(new LoopbackNet(), 'inet')[0].local).toEqual(inet(0));
  });

  it('answers the options the kernel knows and keeps the rest', async () => {
    const { client, listener } = await connected();
    expect(client.getOption(1, 3)).toBe(1);
    expect(client.getOption(1, 4)).toBe(0);
    expect(client.getOption(1, 30)).toBe(0);
    expect(listener.getOption(1, 30)).toBe(1);
    expect(client.getOption(1, 39)).toBe(2);
    expect(new LoopbackNet().socket('unix').getOption(1, 39)).toBe(1);
    expect(client.getOption(1, 8)).toBe(65536);
    client.setOption(1, 8, 4096);
    expect(client.getOption(1, 8)).toBe(4096);
    client.setOption(6, 1, 1);
    expect(client.getOption(6, 1)).toBe(1);
    expect(client.getOption(6, 9)).toBe(0);
  });

  it('wakes a waiter on data, on a connection, and on its own shutdown', async () => {
    const { client, server, listener, net, port } = await connected();
    let woke = client.changed();
    await server.write(bytes('x'));
    await woke;
    woke = listener.changed();
    net.connect(inet(port));
    await woke;
    woke = server.changed();
    server.shutdown(SHUT_RDWR);
    await woke;
    const interrupt = new AbortController();
    const waiting = client.changed(interrupt.signal);
    interrupt.abort();
    expect(await errno(waiting)).toBe('EINTR');
    expect(await errno(new LoopbackNet().socket('inet').changed(interrupt.signal))).toBe('EINTR');
  });

  it('select() waits on a listening socket until a client connects', async () => {
    const net = new LoopbackNet();
    const { listener, port } = listening(net);
    const fds = new FdTable();
    const fd = fds.install(new OpenFile(listener), 3);
    const selected = selectFds(fds, [fd], [], -1, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    net.connect(inet(port));
    expect(await selected).toEqual({ read: [fd], write: [] });
  });
});
