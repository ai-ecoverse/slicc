import { describe, expect, it, vi } from 'vitest';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
} from '../../../src/kernel/wasm-realm/kernel-streams.js';
import {
  closesOnExec,
  O_CLOEXEC,
  trackCloseOnExec,
} from '../../../src/kernel/wasm-realm/process-fds.js';
import {
  describeForFork,
  describeInherited,
  placeKernelStream,
  restoreForkedStreams,
} from '../../../src/kernel/wasm-realm/process-fork.js';

const S_IFREG = 0o100000;
const S_IFCHR = 0o020000;

/** A minimal Emscripten-like FS: a stream table, open by path, dup to a given fd. */
function fakeFs() {
  const streams: (ProcessStream | undefined)[] = [];
  const opened: Array<[string, number]> = [];
  const make = (fields: Partial<ProcessStream> & { fd: number }): ProcessStream =>
    ({
      stream_ops: {},
      flags: 0,
      position: 0,
      shared: {},
      node: { mode: S_IFCHR },
      ...fields,
    }) as ProcessStream;
  const Fs = {
    streams,
    isFile: (mode: number) => (mode & 0o170000) === S_IFREG,
    getStream: (fd: number) => streams[fd] ?? null,
    mkdirTree: vi.fn(),
    open: (path: string, flags: number) => {
      if (path.startsWith('/gone')) throw new Error('ENOENT');
      let fd = 0;
      while (streams[fd]) fd++;
      opened.push([path, flags]);
      const mode = path.startsWith('/dev/slicc-fd') ? S_IFREG : S_IFCHR;
      streams[fd] = make({ fd, path, flags, node: { mode } });
      return streams[fd]!;
    },
    dupStream: (stream: ProcessStream, fd: number) => {
      streams[fd] = { ...stream, fd } as ProcessStream;
      return streams[fd]!;
    },
    closeStream: (fd: number) => {
      streams[fd] = undefined;
    },
  } as unknown as ProcessFs;
  return { Fs, streams, make, opened };
}

function sys(): ProcessSys & { opened: unknown[] } {
  const opened: unknown[] = [];
  let next = 10;
  return {
    opened,
    read: () => new Uint8Array(0),
    write: (_fd, b) => b.length,
    close: () => {},
    pipe: () => [5, 6],
    poll: () => ({ readable: true, writable: true, hangup: false }),
    openVfs: (path, flags, position, opts) => {
      opened.push([path, flags, position, opts]);
      return next++;
    },
    seek: (_fd, offset) => offset,
    flush: () => {},
  };
}

describe('describeForFork', () => {
  it('hands open VFS files to the kernel once per description and describes the table', () => {
    const { Fs, streams, make } = fakeFs();
    const s = sys();
    const kernel = new KernelStreams(Fs, s);
    const shared = {};
    streams[0] = make({ fd: 0, sliccKernelFd: 0, tty: {} });
    streams[1] = make({ fd: 1, sliccKernelFd: 4 });
    streams[3] = make({
      fd: 3,
      flags: 1,
      position: 7,
      shared,
      node: { mode: S_IFREG, live: {} } as never,
    });
    streams[4] = make({
      fd: 4,
      flags: 1,
      position: 7,
      shared,
      node: { mode: S_IFREG, live: {} } as never,
    });
    streams[5] = make({ fd: 5, path: '/dev/null', flags: 2 });
    const table = describeForFork(Fs, s, kernel, () => '/workspace/out.txt');
    expect(s.opened).toEqual([['/workspace/out.txt', 1, 7, undefined]]);
    expect(table).toEqual([
      { fd: 0, kernel: 0, kind: 'tty' },
      { fd: 1, kernel: 4, kind: 'stream' },
      { fd: 3, kernel: 10, kind: 'file' },
      { fd: 4, kernel: 10, kind: 'file' },
      { fd: 5, path: '/dev/null', flags: 2 },
    ]);
    // The parent now reads and writes the file through the kernel too.
    expect(streams[3]!.sliccKernelFd).toBe(10);
    expect(streams[3]!.stream_ops.llseek).toBeDefined();
    expect(streams[3]!.stream_ops.fsync).toBeDefined();
  });

  it("carries FD_CLOEXEC to the child: on kernel descriptors, and in a device's flags", () => {
    const { Fs, streams, make } = fakeFs();
    streams[3] = make({ fd: 3, sliccKernelFd: 3, sliccCloexec: true });
    streams[4] = make({ fd: 4, path: '/dev/null', flags: 2, sliccCloexec: true });
    streams[5] = make({ fd: 5, sliccKernelFd: 6 });
    expect(describeForFork(Fs, sys(), new KernelStreams(Fs, sys()), () => '')).toEqual([
      { fd: 3, kernel: 3, kind: 'stream', cloexec: true },
      { fd: 4, path: '/dev/null', flags: 2 | O_CLOEXEC },
      { fd: 5, kernel: 6, kind: 'stream' },
    ]);
  });

  it('hands the live buffer of an unlinked-while-open file (mkstemp)', () => {
    const { Fs, streams, make } = fakeFs();
    const s = sys();
    const kernel = new KernelStreams(Fs, s);
    const bytes = new TextEncoder().encode('temp-body');
    streams[3] = make({
      fd: 3,
      flags: 2,
      position: 4,
      shared: {},
      node: {
        mode: S_IFREG,
        live: { orphan: true, data: bytes, len: bytes.length },
      } as never,
    });
    describeForFork(Fs, s, kernel, () => '/tmp/gone');
    expect(s.opened).toHaveLength(1);
    const [, , , opts] = s.opened[0] as [
      string,
      number,
      number,
      { contents: Uint8Array; orphan: boolean },
    ];
    expect(opts.orphan).toBe(true);
    expect(new TextDecoder().decode(opts.contents)).toBe('temp-body');
  });
});

describe('describeInherited', () => {
  it('passes every fd beyond 2 not close-on-exec, VFS files through the kernel', () => {
    const { Fs, streams, make } = fakeFs();
    const s = sys();
    const kernel = new KernelStreams(Fs, s);
    const vfs = { mode: S_IFREG, live: {} } as never;
    streams[0] = make({ fd: 0, sliccKernelFd: 0, tty: {} });
    streams[3] = make({ fd: 3, sliccKernelFd: 8 });
    streams[4] = make({ fd: 4, sliccKernelFd: 9, sliccCloexec: true });
    streams[5] = make({ fd: 5, flags: 0, position: 2, node: vfs });
    streams[6] = make({ fd: 6, path: '/dev/null' }); // a device: the kernel's own
    streams[7] = make({ fd: 7, node: vfs, sliccCloexec: true }); // never handed over
    expect(describeInherited(Fs, s, kernel, () => '/w/in.txt')).toEqual([
      { fd: 3, kernel: 8 },
      { fd: 5, kernel: 10 },
      { fd: 6, device: 'null' },
    ]);
    expect(s.opened).toEqual([['/w/in.txt', 0, 2, undefined]]);
    expect(streams[5]!.sliccKernelFile).toBe(true); // the parent shares it from now on
  });

  it("hands devices over as the kernel's own (a closed fd otherwise), a memory-FS file stays behind", () => {
    const { Fs, streams, make } = fakeFs();
    const kernel = new KernelStreams(Fs, sys());
    streams[3] = make({ fd: 3, path: '/dev/null' });
    streams[4] = make({ fd: 4, path: '/dev/zero' });
    streams[5] = make({ fd: 5, path: '/dev/urandom' });
    streams[6] = make({ fd: 6, path: '/dev/random' });
    streams[7] = make({ fd: 7, path: '/tmp/own.txt' }); // the module's own FS: no kernel file
    const actions: Array<[number, number]> = [[9, 3]]; // dup2 of /dev/null
    expect(describeInherited(Fs, sys(), kernel, () => '', actions)).toEqual([
      { fd: 3, device: 'null' },
      { fd: 4, device: 'zero' },
      { fd: 5, device: 'urandom' },
      { fd: 6, device: 'urandom' },
      { fd: 9, device: 'null' },
    ]);
  });

  it("applies posix_spawn's file actions beyond fd 2: dup2 to a number, close", () => {
    const { Fs, streams, make } = fakeFs();
    const kernel = new KernelStreams(Fs, sys());
    streams[1] = make({ fd: 1, sliccKernelFd: 1 });
    streams[3] = make({ fd: 3, sliccKernelFd: 8 });
    streams[4] = make({ fd: 4, sliccKernelFd: 9, sliccCloexec: true });
    const actions: Array<[number, number]> = [
      [40, 4], // a dup2 of a close-on-exec fd is inherited
      [41, 1],
      [3, -1], // closed
      [42, 99], // a source that is not open: closed
      [2, 3], // stdio is the caller's: ignored here
    ];
    expect(describeInherited(Fs, sys(), kernel, () => '', actions)).toEqual([
      { fd: 40, kernel: 9 },
      { fd: 41, kernel: 1 },
    ]);
  });
});

describe('describeInherited: file actions in order', () => {
  it('resolves a source against the table the earlier actions left', () => {
    const { Fs, streams, make } = fakeFs();
    const kernel = new KernelStreams(Fs, sys());
    streams[3] = make({ fd: 3, sliccKernelFd: 8 });
    streams[4] = make({ fd: 4, sliccKernelFd: 9, sliccCloexec: true });
    const actions: Array<[number, number]> = [
      [40, 3],
      [41, 40], // 40 exists only in the child: an alias of 3
      [42, 4], // a close-on-exec source dups to an inherited fd
      [43, 42],
      [42, -1], // closing 42 later leaves 43 alone
      [44, 42], // 42 is gone by now: 44 stays closed
    ];
    expect(describeInherited(Fs, sys(), kernel, () => '', actions)).toEqual([
      { fd: 3, kernel: 8 },
      { fd: 40, kernel: 8 },
      { fd: 41, kernel: 8 },
      { fd: 43, kernel: 9 },
    ]);
  });
});

describe('placeKernelStream', () => {
  it('gives aliases of one description one inode: the same description id, or kernel fd', () => {
    const { Fs } = fakeFs();
    const kernel = new KernelStreams(Fs, sys());
    const ino = (entry: Parameters<typeof placeKernelStream>[2]) => {
      const s = placeKernelStream(Fs, kernel, entry);
      return (s.stream_ops.getattr!(s) as { ino: number }).ino;
    };
    // Started with (init): kernel fd = program fd, so the description id tells aliases apart.
    const a = ino({ fd: 60, kernel: 60, kind: 'stream', desc: 7 });
    const b = ino({ fd: 61, kernel: 61, kind: 'stream', desc: 7 });
    const c = ino({ fd: 62, kernel: 62, kind: 'stream', desc: 8 });
    // Restored after a fork: aliases share the parent's kernel fd.
    const d = ino({ fd: 70, kernel: 5, kind: 'stream' });
    const e = ino({ fd: 71, kernel: 5, kind: 'stream' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).toBe(e);
    expect(d).not.toBe(a);
  });

  it('gives each stream placeholder a FIFO identity of its own, and sets FD_CLOEXEC', () => {
    const { Fs, streams } = fakeFs();
    const getattr = vi.fn(() => ({ dev: 3, ino: 7, mode: S_IFCHR, size: 0 }));
    const open = Fs.open.bind(Fs);
    Fs.open = (path, flags) => {
      const stream = open(path, flags);
      stream.node = { mode: S_IFCHR, node_ops: { getattr } };
      return stream;
    };
    const kernel = new KernelStreams(Fs, sys());
    const a = placeKernelStream(Fs, kernel, { fd: 62, kernel: 62, kind: 'stream' });
    const b = placeKernelStream(Fs, kernel, { fd: 63, kernel: 63, kind: 'stream', cloexec: true });
    const statA = a.stream_ops.getattr!(a) as { mode: number; ino: number; dev: number };
    const statB = b.stream_ops.getattr!(b) as { mode: number; ino: number };
    expect(statA.mode & 0o170000).toBe(0o010000); // S_IFIFO
    expect(statA.dev).toBe(3);
    expect(statA.ino).not.toBe(statB.ino); // two pipes are two files to diff
    expect([closesOnExec(a), closesOnExec(b)]).toEqual([false, true]);
    expect(streams[62]!.sliccKernelFd).toBe(62);
    const tty = placeKernelStream(Fs, kernel, { fd: 70, kernel: 0, kind: 'tty' });
    expect(tty.stream_ops.getattr).toBeUndefined(); // a terminal keeps its device node
  });
});

describe('restoreForkedStreams', () => {
  it('keeps FD_CLOEXEC on a device reopened below its number and moved there', () => {
    const { Fs, streams } = fakeFs();
    trackCloseOnExec(Fs);
    restoreForkedStreams(Fs, new KernelStreams(Fs, sys()), [
      { fd: 5, path: '/dev/null', flags: 2 | O_CLOEXEC },
      { fd: 6, path: '/dev/null', flags: 2 },
    ]);
    expect(streams[5]?.path).toBe('/dev/null');
    expect([closesOnExec(streams[5]!), closesOnExec(streams[6]!)]).toEqual([true, false]);
    expect(streams.filter(Boolean)).toHaveLength(2);
  });

  it("replaces the runtime's streams with the parent's table", () => {
    const { Fs, streams, make, opened } = fakeFs();
    streams[0] = make({ fd: 0, path: '/dev/stdin' });
    streams[1] = make({ fd: 1, path: '/dev/stdout' });
    const kernel = new KernelStreams(Fs, sys());
    restoreForkedStreams(Fs, kernel, [
      { fd: 0, kernel: 0, kind: 'tty' },
      { fd: 1, kernel: 7, kind: 'stream' },
      { fd: 4, kernel: 10, kind: 'file' },
      { fd: 5, path: '/dev/null', flags: 0o1101 },
      { fd: 6, path: '/gone/dir', flags: 0 },
    ]);
    expect(streams.map((s) => s?.sliccKernelFd)).toEqual([
      0,
      7,
      undefined,
      undefined,
      10,
      undefined,
    ]);
    expect(streams[4]!.sliccKernelFile).toBe(true);
    expect(streams[4]!.node.mode & 0o170000).toBe(S_IFREG); // fstat keeps the file type
    expect(streams[5]!.path).toBe('/dev/null');
    expect(streams[6]).toBeUndefined(); // gone since the fork: stays closed
    // A device reopens without create / excl / truncate.
    expect(opened.at(-1)).toEqual(['/dev/null', 0o1]);
    // Exactly the four placed descriptors: no placeholder temp is left behind.
    expect(streams.filter(Boolean)).toHaveLength(4);
  });
});
