import { describe, expect, it } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../../../src/kernel/realm/sync-sab-bridge.js';
import {
  KernelStreams,
  O_NONBLOCK,
  ProcessExit,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from '../../../src/kernel/wasm-realm/kernel-streams.js';
import {
  describeForFork,
  restoreForkedStreams,
} from '../../../src/kernel/wasm-realm/process-fork.js';
import { createSocketKernel } from '../../../src/kernel/wasm-realm/process-sockets.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

class ErrnoError extends Error {
  constructor(readonly errno: number) {
    super(`errno ${errno}`);
  }
}

type Node = { mode: number; node_ops: { getattr?: () => { mode: number; ino: number } } };

function fakeFs(opts: { full?: boolean; room?: number } = {}) {
  const streams: (ProcessStream | null)[] = [];
  let room = opts.room ?? Number.POSITIVE_INFINITY;
  const place = (stream: object, fd = -1): ProcessStream => {
    if (opts.full || room-- <= 0) throw new ErrnoError(33);
    let at = fd;
    if (at < 0) for (at = 0; streams[at]; at++);
    const s = { shared: {}, position: 0, ...stream, fd: at } as ProcessStream;
    streams[at] = s;
    return s;
  };
  const Fs = {
    streams,
    ErrnoError,
    getStream: (fd: number) => streams[fd] ?? null,
    mount: (type: { mount(): Node }) => type.mount(),
    createNode: (_parent: unknown, _name: string, mode: number): Node => ({ mode, node_ops: {} }),
    createStream: place,
    open: (path: string, flags: number) =>
      place({ path, flags, stream_ops: {}, node: { mode: 0o20000 } }),
    dupStream: (stream: ProcessStream, fd: number) => place({ ...stream }, fd),
    closeStream: (fd: number) => {
      streams[fd] = null;
    },
    isFile: () => false,
    mkdirTree: () => {},
    read: (s: ProcessStream, buf: Uint8Array, at: number, len: number) =>
      s.stream_ops.read?.(s, buf, at, len) ?? 0,
    write: (s: ProcessStream, buf: Uint8Array, at: number, len: number) =>
      s.stream_ops.write?.(s, buf, at, len) ?? 0,
  } as unknown as ProcessFs;
  return { Fs, streams };
}

type Req = { op: string; [key: string]: unknown };
const json = (value: unknown): SyncFsResult => ({ ok: true, kind: 'json', json: value });
const fail = (errno: string): SyncFsResult => ({ ok: false, errno, message: errno });
const done: SyncFsResult = { ok: true, kind: 'void' };

function setup(answer: (req: Req) => SyncFsResult, sysOverrides: Partial<ProcessSys> = {}) {
  const calls: Req[] = [];
  const transport = {
    call: (req: Req) => {
      calls.push(req);
      return answer(req);
    },
  } as unknown as SyncSabTransport;
  const closed: number[] = [];
  const io: Array<[string, number, unknown]> = [];
  const sys = {
    read: (fd: number, max: number, o?: unknown) => {
      io.push(['read', fd, o]);
      return bytes('data').subarray(0, max);
    },
    write: (fd: number, b: Uint8Array, o?: unknown) => {
      io.push(['write', fd, o]);
      return b.length;
    },
    close: (fd: number) => void closed.push(fd),
    poll: () => ({ readable: true, writable: true, hangup: false }),
    ...sysOverrides,
  } as unknown as ProcessSys;
  const { Fs, streams } = fakeFs();
  const kstreams = new KernelStreams(Fs, sys);
  const net = createSocketKernel({ transport, Fs, sys, streams: kstreams });
  return { net, calls, closed, io, Fs, streams, kstreams, sys };
}

describe('createSocketKernel', () => {
  it('opens a socket as an S_IFSOCK stream of the program, backed by the kernel fd', () => {
    const { net, Fs, calls } = setup(() => json(12));
    const fd = net.socket('inet', true);
    const stream = Fs.getStream(fd) as ProcessStream & { node: Node };
    expect(calls).toEqual([{ op: 'sock-open', domain: 'inet' }]);
    expect(stream.sliccKernelFd).toBe(12);
    expect(stream.sliccKernelSocket).toBe(true);
    expect(stream.flags & O_NONBLOCK).toBe(O_NONBLOCK);
    expect(stream.node.mode & 0o170000).toBe(0o140000);
    expect(stream.node.node_ops.getattr?.()).toMatchObject({ mode: 0o140777 });
  });

  it('answers a failed syscall with its negative WASI errno', () => {
    const { net } = setup(() => fail('EAFNOSUPPORT'));
    expect(net.socket('inet', false)).toBe(-5);
    expect(net.bind(99, { family: 'inet', host: '127.0.0.1', port: 1 })).toBe(-8);
  });

  it('is ENOTSOCK on a program fd that is no socket', () => {
    const { net, Fs } = setup(() => done);
    const file = Fs.open('/dev/null', 2);
    expect(net.listen(file.fd, 1)).toBe(-57);
  });

  it('passes bind, listen, connect, shutdown and options to the socket’s kernel fd', () => {
    const { net, calls } = setup((req) => {
      if (req.op === 'sock-open') return json(5);
      if (req.op === 'sock-getopt') return json(1);
      if (req.op === 'sock-name') return json({ family: 'inet', host: '127.0.0.1', port: 80 });
      return done;
    });
    const fd = net.socket('inet', false);
    const addr = { family: 'inet' as const, host: '127.0.0.1', port: 80 };
    expect(net.bind(fd, addr)).toBe(0);
    expect(net.listen(fd, 8)).toBe(0);
    expect(net.connect(fd, addr)).toBe(0);
    expect(net.shutdown(fd, 1)).toBe(0);
    expect(net.setopt(fd, 6, 1, 1)).toBe(0);
    expect(net.getopt(fd, 6, 1)).toEqual({ value: 1 });
    expect(net.name(fd, true)).toEqual(addr);
    expect(calls.slice(1)).toEqual([
      { op: 'sock-bind', fd: 5, addr },
      { op: 'sock-listen', fd: 5, backlog: 8 },
      { op: 'sock-connect', fd: 5, addr, nonblock: false },
      { op: 'sock-shutdown', fd: 5, how: 1 },
      { op: 'sock-setopt', fd: 5, level: 6, name: 1, value: 1 },
      { op: 'sock-getopt', fd: 5, level: 6, name: 1 },
      { op: 'sock-name', fd: 5, peer: true },
    ]);
  });

  it('connects non-blocking when the stream is O_NONBLOCK (EINPROGRESS)', () => {
    const { net, calls } = setup((req) => (req.op === 'sock-open' ? json(5) : fail('EINPROGRESS')));
    const fd = net.socket('inet', true);
    expect(net.connect(fd, { family: 'inet', host: '127.0.0.1', port: 1 })).toBe(-26);
    expect(calls[1]).toMatchObject({ op: 'sock-connect', nonblock: true });
  });

  it('accepts onto a new stream, non-blocking as accept4 asks, the listener’s own mode to the kernel', () => {
    const peer = { family: 'inet', host: '127.0.0.1', port: 40000 };
    const { net, Fs, calls } = setup((req) =>
      req.op === 'sock-open' ? json(5) : json({ fd: 6, peer })
    );
    const lfd = net.socket('inet', true);
    const r = net.accept(lfd, false) as { fd: number; peer: unknown };
    expect(r.peer).toEqual(peer);
    expect(Fs.getStream(r.fd)?.sliccKernelFd).toBe(6);
    expect((Fs.getStream(r.fd)?.flags ?? 0) & O_NONBLOCK).toBe(0);
    expect(calls[1]).toEqual({ op: 'sock-accept', fd: 5, nonblock: true });
  });

  it('retries a call a caught signal interrupted when its handlers asked for SA_RESTART', () => {
    let tries = 0;
    const { net } = setup(() => (++tries < 3 ? fail('EINTR') : json(7)));
    expect(net.socket('unix', false)).toBe(-27);
    const calls: Req[] = [];
    const again = createSocketKernel({
      transport: {
        call: (req: Req) => {
          calls.push(req);
          return calls.length < 3 ? fail('EINTR') : json(7);
        },
      } as unknown as SyncSabTransport,
      ...fakeFsKit(),
      restartable: () => true,
    });
    expect(again.socket('unix', false)).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(3);
  });

  it('makes a socketpair, and gives the kernel fds back when the program’s table is full', () => {
    const { net, Fs } = setup(() => json([7, 8]));
    const pair = net.socketpair('unix', false) as [number, number];
    expect(pair.map((fd) => Fs.getStream(fd)?.sliccKernelFd)).toEqual([7, 8]);
    const closed: number[] = [];
    const { Fs: fullFs } = fakeFs({ full: true });
    const sys = { close: (fd: number) => void closed.push(fd) } as unknown as ProcessSys;
    const full = createSocketKernel({
      transport: { call: () => json([7, 8]) } as unknown as SyncSabTransport,
      Fs: fullFs,
      sys,
      streams: new KernelStreams(fullFs, sys),
    });
    expect(full.socketpair('unix', false)).toBe(-33);
    expect(closed).toEqual([7, 8]);
  });

  it('sends and receives with MSG_DONTWAIT / MSG_PEEK, O_NONBLOCK counting too', () => {
    const { net, io } = setup(() => json(5));
    const fd = net.socket('inet', false);
    expect(net.send(fd, bytes('abc'), {})).toBe(3);
    expect(net.send(fd, bytes('abc'), { dontwait: true })).toBe(3);
    expect(text(net.recv(fd, 2, { peek: true }) as Uint8Array)).toBe('da');
    const nb = net.socket('inet', true);
    net.recv(nb, 4, {});
    expect(io).toEqual([
      ['write', 5, { nonblock: false }],
      ['write', 5, { nonblock: true }],
      ['read', 5, { nonblock: false, peek: true }],
      ['read', 5, { nonblock: true, peek: false }],
    ]);
  });

  it('ends the program with SIGPIPE on a broken send, unless MSG_NOSIGNAL', () => {
    const { net } = setup(() => json(5), {
      write: () => {
        throw new SyscallError('EPIPE');
      },
    });
    const fd = net.socket('inet', false);
    expect(() => net.send(fd, bytes('x'), {})).toThrow(ProcessExit);
    expect(net.send(fd, bytes('x'), { nosignal: true })).toBe(-64);
  });

  it('closes the first end when the second finds the program’s table full (no fd leaks)', () => {
    const closed: number[] = [];
    const { Fs, streams } = fakeFs({ room: 1 });
    const sys = { close: (fd: number) => void closed.push(fd) } as unknown as ProcessSys;
    const net = createSocketKernel({
      transport: { call: () => json([7, 8]) } as unknown as SyncSabTransport,
      Fs,
      sys,
      streams: new KernelStreams(Fs, sys),
    });
    expect(net.socketpair('unix', false)).toBe(-33);
    expect(closed.sort()).toEqual([7, 8]);
    expect(streams.filter(Boolean)).toEqual([]);
  });

  it('answers an FS error (a full fd table) with its errno and gives the kernel fd back', () => {
    const closed: number[] = [];
    const { Fs } = fakeFs({ full: true });
    const sys = { close: (fd: number) => void closed.push(fd) } as unknown as ProcessSys;
    const net = createSocketKernel({
      transport: { call: () => json(5) } as unknown as SyncSabTransport,
      Fs,
      sys,
      streams: new KernelStreams(Fs, sys),
    });
    expect(net.socket('inet', false)).toBe(-33);
    expect(closed).toEqual([5]);
  });

  it('lets a non-syscall error through', () => {
    const { net } = setup(() => {
      throw new TypeError('bug');
    });
    expect(() => net.socket('inet', false)).toThrow(TypeError);
  });
});

function fakeFsKit() {
  const { Fs } = fakeFs();
  const sys = { close: () => {} } as unknown as ProcessSys;
  return { Fs, sys, streams: new KernelStreams(Fs, sys) };
}

describe('socket streams', () => {
  it('read and write non-blocking while the stream is O_NONBLOCK', () => {
    const { net, Fs, io } = setup(() => json(5));
    const fd = net.socket('inet', false);
    const stream = Fs.getStream(fd) as ProcessStream;
    const buf = new Uint8Array(8);
    Fs.read(stream, buf, 0, 4);
    stream.flags |= O_NONBLOCK;
    Fs.read(stream, buf, 0, 4);
    Fs.write(stream, bytes('x'), 0, 1);
    expect(io).toEqual([
      ['read', 5, undefined],
      ['read', 5, { nonblock: true }],
      ['write', 5, { nonblock: true }],
    ]);
  });

  it('stand on /dev/null where the FS cannot make a socket node', () => {
    const { Fs } = fakeFs();
    const bare = { ...Fs, mount: undefined } as unknown as ProcessFs;
    const stream = new KernelStreams(bare, {} as ProcessSys).socketStream(2 | O_NONBLOCK);
    expect(stream.path).toBe('/dev/null');
    expect(stream.flags).toBe(2 | O_NONBLOCK);
  });

  it('survive a fork as sockets, keeping O_NONBLOCK', () => {
    const { net, Fs, sys, kstreams } = setup(() => json(5));
    const fd = net.socket('inet', true);
    const table = describeForFork(Fs, sys, kstreams, () => '/');
    expect(table).toEqual([{ fd, kernel: 5, kind: 'socket', flags: 2 | O_NONBLOCK }]);
    const child = fakeFs();
    const childStreams = new KernelStreams(child.Fs, sys);
    restoreForkedStreams(child.Fs, childStreams, table);
    const restored = child.Fs.getStream(fd) as ProcessStream;
    expect(restored.sliccKernelFd).toBe(5);
    expect(restored.sliccKernelSocket).toBe(true);
    expect(restored.flags & O_NONBLOCK).toBe(O_NONBLOCK);
  });
});
