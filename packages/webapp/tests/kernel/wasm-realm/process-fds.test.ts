import { describe, expect, it, vi } from 'vitest';
import type { ProcessFs, ProcessStream } from '../../../src/kernel/wasm-realm/kernel-streams.js';
import {
  closesOnExec,
  fdOfPath,
  O_CLOEXEC,
  positionedIo,
  syncFsync,
  trackCloseOnExec,
  useDevFd,
  wasmMemory,
  wrapCloexecSyscalls,
} from '../../../src/kernel/wasm-realm/process-fds.js';

class ErrnoError extends Error {
  constructor(readonly errno: number) {
    super(`errno ${errno}`);
  }
}

const EBADF = 8;
const EINVAL = 28;
const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_DUPFD_CLOEXEC = 1030;

/**
 * An Emscripten-like FS: `flags` live on the description (`shared`), as
 * Emscripten's FSStream keeps them, so a dup sees the same flags.
 */
function fakeFs(cwd = '/') {
  const streams: (ProcessStream | null)[] = [];
  const opened: Array<[string, number]> = [];
  const stream = (fd: number, shared: { flags: number }, path?: string): ProcessStream => {
    const s = { fd, path, stream_ops: {}, node: { mode: 0 }, shared } as unknown as ProcessStream;
    Object.defineProperty(s, 'flags', {
      get: () => shared.flags,
      set: (v: number) => {
        shared.flags = v;
      },
      enumerable: false,
    });
    return s;
  };
  const lowest = () => {
    let fd = 0;
    while (streams[fd]) fd++;
    return fd;
  };
  const Fs = {
    streams,
    ErrnoError,
    cwd: () => cwd,
    getStream: (fd: number) => streams[fd] ?? null,
    open: (path: string, flags: number) => {
      opened.push([path, flags]);
      const fd = lowest();
      streams[fd] = stream(fd, { flags }, path);
      return streams[fd]!;
    },
    // Emscripten's createStream copies own properties: a marker would follow the dup.
    dupStream: (orig: ProcessStream, fd = -1) => {
      const at = fd === -1 ? lowest() : fd;
      const copy = stream(at, orig.shared as { flags: number }, orig.path);
      Object.assign(copy, { ...orig, fd: at });
      streams[at] = copy;
      return copy;
    },
    stat: vi.fn((path: string) => ({ path })),
    fstat: vi.fn((fd: number) => ({ fd })),
    symlink: vi.fn(),
  } as unknown as ProcessFs & { stat: ReturnType<typeof vi.fn>; fstat: ReturnType<typeof vi.fn> };
  return { Fs, streams, opened };
}

describe('fdOfPath', () => {
  it('names the fd of /dev/fd/N, /proc/self/fd/N and /dev/std*, from any cwd', () => {
    expect(fdOfPath('/dev/fd/63', '/')).toBe(63);
    expect(fdOfPath('/proc/self/fd/4', '/')).toBe(4);
    expect(fdOfPath('/dev/stdin', '/')).toBe(0);
    expect(fdOfPath('/dev/stdout', '/')).toBe(1);
    expect(fdOfPath('/dev/stderr', '/')).toBe(2);
    expect(fdOfPath('fd/7', '/dev')).toBe(7);
    expect(fdOfPath('//dev/./fd/../fd/8', '/tmp')).toBe(8);
    for (const other of [
      '/dev/fd',
      '/dev/fd/',
      '/dev/fd/x',
      '/dev/fdx/1',
      '/tmp/dev/fd/1',
      'fd/1',
    ]) {
      expect(fdOfPath(other, '/tmp')).toBeUndefined();
    }
  });
});

describe('trackCloseOnExec', () => {
  it('keeps FD_CLOEXEC per fd: open sets it off the shared flags, a dup starts without it', () => {
    const { Fs, opened } = fakeFs();
    trackCloseOnExec(Fs);
    const a = Fs.open('/x', 2 | O_CLOEXEC);
    expect(opened).toEqual([['/x', 2]]); // the description never carries it
    expect(closesOnExec(a)).toBe(true);
    const b = Fs.dupStream(a, 9);
    expect([closesOnExec(a), closesOnExec(b)]).toEqual([true, false]);
    expect(closesOnExec(Fs.open('/y', 0))).toBe(false);
  });

  it('leaves an FS without open or dup alone', () => {
    const Fs = { getStream: () => null } as unknown as ProcessFs;
    trackCloseOnExec(Fs);
    expect(Fs.open).toBeUndefined();
  });
});

describe('wrapCloexecSyscalls', () => {
  function setup() {
    const { Fs, streams } = fakeFs();
    trackCloseOnExec(Fs);
    Fs.open('/0', 0);
    Fs.open('/1', 0);
    const heap = new Int32Array(16);
    const fcntl = vi.fn((fd: number, cmd: number, varargs: number) => {
      if (cmd === F_DUPFD) {
        let to = heap[varargs >> 2]!;
        while (streams[to]) to++;
        return Fs.dupStream(Fs.getStream(fd)!, to).fd;
      }
      if (cmd === F_GETFL) return (Fs.getStream(fd)?.flags ?? 0) | O_CLOEXEC;
      return 0; // Emscripten: F_GETFD / F_SETFD are no-ops
    });
    const pipe2 = vi.fn((ptr: number, flags: number) => {
      const r = Fs.open('pipe-r', flags).fd;
      const w = Fs.open('pipe-w', flags).fd;
      heap[ptr >> 2] = r;
      heap[(ptr >> 2) + 1] = w;
      return 0;
    });
    const dup3 = vi.fn((fd: number, to: number, flags: number) => {
      const s = Fs.dupStream(Fs.getStream(fd)!, to);
      if (flags & O_CLOEXEC) s.flags |= O_CLOEXEC; // Emscripten: on the description
      return s.fd;
    });
    const socket = vi.fn((_domain: number, _type: number) => Fs.open('socket', 2).fd);
    const accept4 = vi.fn(
      (_fd: number, _a: number, _l: number, _flags: number) => Fs.open('conn', 2).fd
    );
    const other = vi.fn(() => 0);
    // Minified import names, one object for both namespaces, as the glue builds them.
    const table = { a: fcntl, b: pipe2, c: dup3, d: socket, e: accept4, f: other };
    const imports = { env: table, wasi_snapshot_preview1: table } as unknown as WebAssembly.Imports;
    wrapCloexecSyscalls(
      imports,
      { fcntl, pipe2, dup3, socket, accept4 },
      {
        fs: () => Fs,
        heap: () => heap,
      }
    );
    const call = (name: keyof typeof table, ...args: number[]) =>
      (table[name] as unknown as (...a: number[]) => number)(...args);
    return { Fs, streams, heap, call, table, other };
  }

  it('answers F_GETFD / F_SETFD from the fd, and F_GETFL without O_CLOEXEC', () => {
    const { heap, call } = setup();
    expect(call('a', 0, F_GETFD, 0)).toBe(0);
    heap[1] = 1; // FD_CLOEXEC
    expect(call('a', 0, F_SETFD, 4)).toBe(0);
    expect(call('a', 0, F_GETFD, 0)).toBe(1);
    expect(call('a', 1, F_GETFD, 0)).toBe(0); // per fd
    expect(call('a', 0, F_GETFL, 0) & O_CLOEXEC).toBe(0);
    heap[1] = 0;
    call('a', 0, F_SETFD, 4);
    expect(call('a', 0, F_GETFD, 0)).toBe(0);
    expect(call('a', 42, F_GETFD, 0)).toBe(-EBADF);
    expect(call('a', 42, F_SETFD, 4)).toBe(-EBADF);
  });

  it('F_DUPFD_CLOEXEC and dup3(O_CLOEXEC) mark only the new fd; F_DUPFD and dup2 do not', () => {
    const { heap, call, Fs } = setup();
    heap[2] = 20;
    const cloexec = call('a', 0, F_DUPFD_CLOEXEC, 8);
    const plain = call('a', 0, F_DUPFD, 8);
    expect([cloexec, plain]).toEqual([20, 21]);
    expect([call('a', cloexec, F_GETFD, 0), call('a', plain, F_GETFD, 0)]).toEqual([1, 0]);
    expect(call('c', 0, 30, O_CLOEXEC)).toBe(30);
    expect(call('c', 0, 31, 0)).toBe(31);
    expect([30, 31, 0].map((fd) => call('a', fd, F_GETFD, 0))).toEqual([1, 0, 0]);
    // The description (shared by 0, 20, 21, 30, 31) never took O_CLOEXEC.
    expect(Fs.getStream(0)!.flags & O_CLOEXEC).toBe(0);
  });

  it('marks both ends of pipe2(O_CLOEXEC), a SOCK_CLOEXEC socket and accept4', () => {
    const { heap, call } = setup();
    expect(call('b', 16, O_CLOEXEC)).toBe(0);
    const [r, w] = [heap[4]!, heap[5]!];
    expect([call('a', r, F_GETFD, 0), call('a', w, F_GETFD, 0)]).toEqual([1, 1]);
    call('b', 24, 0);
    expect(call('a', heap[6]!, F_GETFD, 0)).toBe(0);
    const s = call('d', 2, 1 | O_CLOEXEC, 0);
    const conn = call('e', s, 0, 0, O_CLOEXEC);
    const plain = call('d', 2, 1, 0);
    expect([s, conn, plain].map((fd) => call('a', fd, F_GETFD, 0))).toEqual([1, 1, 0]);
  });

  it("wraps an assertions build's imports by name, around Asyncify's own wrappers", () => {
    const { Fs } = fakeFs();
    trackCloseOnExec(Fs);
    Fs.open('/0', 0);
    const fcntl = vi.fn(() => 0);
    const ioctl = vi.fn(() => -22);
    const kernel = {
      ptyNumber: vi.fn(() => 0),
      ptyLock: vi.fn(),
      setControllingTerminal: vi.fn(),
      setPacketMode: vi.fn(),
      setWinsize: vi.fn(),
    };
    // Asyncify (with assertions) has put each import behind a checking wrapper.
    const checked = (f: (...a: number[]) => number) => vi.fn((...a: number[]) => f(...a));
    const asyncifyFcntl = checked(fcntl);
    const asyncifyIoctl = checked(ioctl);
    const other = checked(() => 7);
    const env = {
      __syscall_fcntl64: asyncifyFcntl,
      __syscall_ioctl: asyncifyIoctl,
      __syscall_dup: other,
    };
    const imports = { env } as unknown as WebAssembly.Imports;
    const heap = new Int32Array(16);
    wrapCloexecSyscalls(imports, { fcntl, ioctl }, { fs: () => Fs, heap: () => heap, pty: kernel });
    heap[1] = 1; // FD_CLOEXEC
    expect(env.__syscall_fcntl64(0, F_SETFD, 4)).toBe(0);
    expect(env.__syscall_fcntl64(0, F_GETFD, 0)).toBe(1);
    // The pty request reaches the kernel (it never did: identity found no import).
    (Fs.getStream(0) as unknown as { sliccKernelFd: number }).sliccKernelFd = 9;
    heap[0] = 16;
    expect(env.__syscall_ioctl(0, 0x40045431, 0)).toBe(0); // TIOCSPTLCK
    expect(kernel.ptyLock).toHaveBeenCalledWith(9, false);
    // Anything else still goes through Asyncify's wrapper to the glue's.
    expect(env.__syscall_ioctl(0, 0x5401, 0)).toBe(-22);
    expect(asyncifyIoctl).toHaveBeenCalledTimes(1);
    expect(env.__syscall_dup).toBe(other);
  });

  it("puts ITIMER_REAL on the kernel's clock and leaves the other timers to the glue", () => {
    const setitimer = vi.fn((_which: number, _ms: number) => 0);
    const armed: number[] = [];
    const env = { _setitimer_js: setitimer };
    wrapCloexecSyscalls(
      { env } as unknown as WebAssembly.Imports,
      { setitimer },
      {
        fs: () => undefined,
        heap: () => undefined,
        timer: { arm: (ms) => void armed.push(ms) },
      }
    );
    expect(env._setitimer_js(0, 1500)).toBe(0); // alarm(2)-ish: the kernel arms it
    expect(env._setitimer_js(0, 0)).toBe(0); // cancel
    expect(armed).toEqual([1500, 0]);
    expect(setitimer).not.toHaveBeenCalled();
    env._setitimer_js(1, 10); // ITIMER_VIRTUAL stays the glue's
    expect(setitimer).toHaveBeenCalledWith(1, 10);
  });

  it('leaves the rest of the import object, and a glue without them, alone', () => {
    const { table, other } = setup();
    expect(table.f).toBe(other);
    const imports = { env: { a: other } } as unknown as WebAssembly.Imports;
    wrapCloexecSyscalls(imports, undefined, { fs: () => undefined, heap: () => undefined });
    wrapCloexecSyscalls(imports, {}, { fs: () => undefined, heap: () => undefined });
    expect(imports.env!.a).toBe(other);
  });
});

describe('syncFsync', () => {
  const asyncSync = () =>
    Object.assign(
      vi.fn(() => 'suspended'),
      { isAsync: true }
    );
  const streamOf = (stream_ops: object, mount?: object) =>
    ({ fd: 3, stream_ops, node: { mode: 0, mount } }) as unknown as ProcessStream;
  const fsWith = (stream?: ProcessStream) =>
    ({ getStream: (fd: number) => (fd === 3 ? stream : null) }) as unknown as ProcessFs;
  const fdSync = (imports: { a: { fd_sync: unknown } }) =>
    imports.a.fd_sync as unknown as (fd: number) => unknown;

  it('answers an Asyncify fd_sync from the stream, and leaves a plain one alone', () => {
    const fsync = vi.fn(() => 0);
    const plain = vi.fn(() => 0);
    const imports = { a: { fd_sync: asyncSync() }, b: { fd_sync: plain }, c: {} };
    syncFsync(imports as unknown as WebAssembly.Imports, () => fsWith(streamOf({ fsync })));
    expect(fdSync(imports)(3)).toBe(0);
    expect(fsync).toHaveBeenCalledOnce();
    expect(imports.b.fd_sync).toBe(plain);
  });

  it('returns EBADF without an FS or a stream, the op result, and 0 without an op', () => {
    const run = (fs: ProcessFs | undefined, fd = 3) => {
      const imports = { a: { fd_sync: asyncSync() } };
      syncFsync(imports as unknown as WebAssembly.Imports, () => fs);
      return fdSync(imports)(fd);
    };
    expect(run(undefined)).toBe(EBADF);
    expect(run(fsWith(streamOf({})), 4)).toBe(EBADF);
    expect(run(fsWith(streamOf({ fsync: () => 29 })))).toBe(29);
    expect(run(fsWith(streamOf({ fsync: () => undefined })))).toBe(0);
    expect(run(fsWith(streamOf({})))).toBe(0);
  });

  it('turns a thrown ErrnoError or coded error into its errno, and rethrows anything else', () => {
    const run = (error: unknown) => {
      const imports = { a: { fd_sync: asyncSync() } };
      const fsync = () => {
        throw error;
      };
      syncFsync(imports as unknown as WebAssembly.Imports, () => fsWith(streamOf({ fsync })));
      return fdSync(imports)(3);
    };
    expect(run(new ErrnoError(28))).toBe(28);
    expect(run(Object.assign(new Error('x'), { code: 'EBADF' }))).toBe(EBADF);
    expect(() => run(new TypeError('bug'))).toThrow('bug');
  });

  it('keeps the asynchronous fd_sync for a mount that persists itself', () => {
    const original = asyncSync();
    const fsync = vi.fn(() => 0);
    const imports = { a: { fd_sync: original } };
    const stream = streamOf({ fsync }, { type: { syncfs: () => {} } });
    syncFsync(imports as unknown as WebAssembly.Imports, () => fsWith(stream));
    expect(fdSync(imports)(3)).toBe('suspended');
    expect(original).toHaveBeenCalledWith(3);
    expect(fsync).not.toHaveBeenCalled();
  });
});

describe('positionedIo', () => {
  const file = new TextEncoder().encode('0123456789');
  const setup = (stream: Partial<ProcessStream> | undefined, withMemory = true) => {
    const memory = new ArrayBuffer(256);
    const view = new DataView(memory);
    const sys = {
      pread: vi.fn((_fd: number, max: number, at: number) => file.slice(at, at + max)),
      pwrite: vi.fn((_fd: number, bytes: Uint8Array, _at: number) => bytes.length),
    };
    const original = vi.fn(() => 'original');
    const imports = { a: { fd_pread: original, fd_pwrite: original }, b: null, c: 'x' };
    const fs = { getStream: (fd: number) => (fd === 3 ? stream : null) } as unknown as ProcessFs;
    positionedIo(imports as unknown as WebAssembly.Imports, {
      fs: () => fs,
      memory: () => (withMemory ? memory : undefined),
      sys,
    });
    const call = (
      name: 'fd_pread' | 'fd_pwrite',
      vecs: Array<[number, number]>,
      offset: bigint
    ) => {
      vecs.forEach(([ptr, len], i) => {
        view.setUint32(16 + i * 8, ptr, true);
        view.setUint32(16 + i * 8 + 4, len, true);
      });
      const fn = imports.a[name] as unknown as (...args: unknown[]) => unknown;
      return fn(3, 16, vecs.length, offset, 8);
    };
    const raw = (name: 'fd_pread' | 'fd_pwrite', ...args: Array<number | bigint>) =>
      (imports.a[name] as unknown as (...a: Array<number | bigint>) => unknown)(...args);
    return { memory, view, sys, original, call, raw };
  };
  const kernelFile = { sliccKernelFile: true, sliccKernelFd: 11 } as Partial<ProcessStream>;

  it('reads a kernel file at the offset into each iovec, stopping short at end of file', () => {
    const { memory, view, sys, call } = setup(kernelFile);
    expect(
      call(
        'fd_pread',
        [
          [64, 3],
          [96, 4],
        ],
        2n
      )
    ).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory, 64, 3))).toBe('234');
    expect(new TextDecoder().decode(new Uint8Array(memory, 96, 4))).toBe('5678');
    expect(view.getUint32(8, true)).toBe(7);
    expect(sys.pread.mock.calls).toEqual([
      [11, 3, 2],
      [11, 4, 5],
    ]);
    expect(
      call(
        'fd_pread',
        [
          [64, 8],
          [96, 8],
        ],
        6n
      )
    ).toBe(0);
    expect(view.getUint32(8, true)).toBe(4);
    expect(sys.pread).toHaveBeenCalledTimes(3);
  });

  it('writes each iovec of a kernel file at the offset', () => {
    const { memory, view, sys, call } = setup(kernelFile);
    new Uint8Array(memory, 64, 2).set([65, 66]);
    new Uint8Array(memory, 96, 1).set([67]);
    expect(
      call(
        'fd_pwrite',
        [
          [64, 2],
          [96, 1],
        ],
        5n
      )
    ).toBe(0);
    expect(view.getUint32(8, true)).toBe(3);
    expect(sys.pwrite.mock.calls.map(([fd, bytes, at]) => [fd, [...bytes], at])).toEqual([
      [11, [65, 66], 5],
      [11, [67], 7],
    ]);
  });

  it('takes a legalized offset as signed halves, and refuses a negative or unsafe one', () => {
    const { view, sys, call, raw } = setup(kernelFile);
    view.setUint32(16, 64, true);
    view.setUint32(20, 1, true);
    expect(raw('fd_pread', 3, 16, 1, 2, 0, 8)).toBe(0);
    expect(raw('fd_pread', 3, 16, 1, -(2 ** 31), 0, 8)).toBe(0);
    expect(sys.pread.mock.calls).toEqual([
      [11, 1, 2],
      [11, 1, 2 ** 31],
    ]);
    expect(raw('fd_pread', 3, 16, 1, 0, -1, 8)).toBe(EINVAL);
    expect(call('fd_pwrite', [[64, 1]], -1n)).toBe(EINVAL);
    expect(call('fd_pwrite', [[64, 1]], 2n ** 63n - 1n)).toBe(EINVAL);
    expect(call('fd_pread', [[64, 1]], 2n ** 64n - 1n)).toBe(EINVAL);
    expect(sys.pread).toHaveBeenCalledTimes(2);
    expect(sys.pwrite).not.toHaveBeenCalled();
  });

  it("leaves other streams, and calls before the module's memory exists, to Emscripten", () => {
    expect(setup({ sliccKernelFd: 4 }).call('fd_pread', [[64, 1]], 0n)).toBe('original');
    expect(setup(undefined).call('fd_pwrite', [[64, 1]], 0n)).toBe('original');
    expect(setup(kernelFile, false).call('fd_pread', [[64, 1]], 0n)).toBe('original');
  });

  it('returns the errno of a failed kernel call', () => {
    const { sys, view, call } = setup(kernelFile);
    view.setUint32(8, 99, true);
    sys.pread.mockImplementation(() => {
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    });
    expect(call('fd_pread', [[64, 1]], 0n)).toBe(EBADF);
    sys.pwrite.mockImplementation(() => {
      throw new ErrnoError(28);
    });
    expect(call('fd_pwrite', [[64, 1]], 0n)).toBe(28);
    expect(view.getUint32(8, true)).toBe(99);
  });
});

describe('wasmMemory', () => {
  it('finds the exported memory, else an imported one', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const exported = { exports: { m: memory } } as unknown as WebAssembly.Instance;
    const bare = { exports: {} } as unknown as WebAssembly.Instance;
    expect(wasmMemory(exported, {})).toBe(memory);
    expect(wasmMemory(bare, { env: { memory } })).toBe(memory);
    expect(wasmMemory(bare, { env: {} })).toBeUndefined();
  });
});

describe('useDevFd', () => {
  it('opens /dev/fd/N as a dup of fd N at the lowest free fd, O_CLOEXEC per open', () => {
    const { Fs, opened } = fakeFs();
    trackCloseOnExec(Fs);
    useDevFd(Fs);
    expect(Fs.symlink).toHaveBeenCalledWith('/proc/self/fd', '/dev/fd');
    const pipe = Fs.open('/pipe', 0);
    const copy = Fs.open('/dev/fd/0', 0);
    expect(copy.fd).toBe(1);
    expect(copy.shared).toBe(pipe.shared); // one description: offset and all
    expect(closesOnExec(copy)).toBe(false);
    const std = Fs.open('/dev/stdin', O_CLOEXEC);
    expect(std.shared).toBe(pipe.shared);
    expect(closesOnExec(std)).toBe(true);
    expect(opened.map(([p]) => p)).toEqual(['/pipe']); // never opened by path
    expect(() => Fs.open('/proc/self/fd/9', 0)).toThrow(expect.objectContaining({ errno: EBADF }));
    expect(Fs.open('/etc/passwd', 0).path).toBe('/etc/passwd');
  });

  it('stats /dev/fd/N as fstat(N); lstat and other paths go to the FS', () => {
    const { Fs } = fakeFs('/dev');
    const { stat, fstat } = Fs as unknown as Record<'stat' | 'fstat', ReturnType<typeof vi.fn>>;
    useDevFd(Fs);
    Fs.open('/pipe', 0);
    expect(Fs.stat?.('fd/0')).toEqual({ fd: 0 });
    expect(fstat).toHaveBeenCalledWith(0);
    expect(Fs.stat?.('/dev/fd/0', true)).toEqual({ path: '/dev/fd/0' });
    expect(Fs.stat?.('/etc')).toEqual({ path: '/etc' });
    expect(stat).toHaveBeenCalledTimes(2);
    expect(() => Fs.stat?.('/dev/fd/5')).toThrow(expect.objectContaining({ errno: EBADF }));
  });

  it("gives Emscripten's /proc/self/fd a directory's and its entries a symlink's attributes", () => {
    const { Fs } = fakeFs();
    const entry = { id: 4, node_ops: { readlink: () => '/x' } };
    const dir = {
      node_ops: { lookup: vi.fn(() => entry), readdir: () => ['0'] },
    };
    Object.assign(Fs, { lookupPath: vi.fn(() => ({ node: dir })) });
    useDevFd(Fs);
    const ops = dir.node_ops as unknown as {
      getattr: () => { mode: number };
      lookup: (
        p: object,
        n: string
      ) => { node_ops: { getattr: () => { mode: number; ino: number } } };
      readdir: () => string[];
    };
    expect(ops.getattr().mode).toBe(0o040555);
    expect(ops.readdir()).toEqual(['0']);
    const found = ops.lookup(dir, '3');
    expect(found.node_ops.getattr()).toMatchObject({ mode: 0o120700, ino: 4 });
    // Twice is harmless: a directory that has attributes already is left alone.
    useDevFd(Fs);
    expect((dir.node_ops as unknown as { getattr: unknown }).getattr).toBe(ops.getattr);
  });

  it('copes with an FS without /proc, symlink or stat', () => {
    const Fs = {
      getStream: () => null,
      cwd: () => '/',
      open: vi.fn(() => ({ fd: 3 })),
      symlink: () => {
        throw new ErrnoError(20);
      },
      lookupPath: () => {
        throw new ErrnoError(44);
      },
    } as unknown as ProcessFs;
    useDevFd(Fs);
    expect(Fs.open('/tmp/a', 0)).toEqual({ fd: 3 });
    expect(Fs.stat).toBeUndefined();
    const bare = { getStream: () => null } as unknown as ProcessFs;
    useDevFd(bare);
    expect(bare.open).toBeUndefined();
  });
});
