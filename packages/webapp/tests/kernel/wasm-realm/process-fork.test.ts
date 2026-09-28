import { describe, expect, it, vi } from 'vitest';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
} from '../../../src/kernel/wasm-realm/kernel-streams.js';
import {
  describeForFork,
  restoreForkedStreams,
} from '../../../src/kernel/wasm-realm/process-fork.js';

const S_IFREG = 0o100000;
const S_IFCHR = 0o020000;

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

    expect(streams[3]!.sliccKernelFd).toBe(10);
    expect(streams[3]!.stream_ops.llseek).toBeDefined();
    expect(streams[3]!.stream_ops.fsync).toBeDefined();
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

describe('restoreForkedStreams', () => {
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
    expect(streams[4]!.node.mode & 0o170000).toBe(S_IFREG);
    expect(streams[5]!.path).toBe('/dev/null');
    expect(streams[6]).toBeUndefined();

    expect(opened.at(-1)).toEqual(['/dev/null', 0o1]);

    expect(streams.filter(Boolean)).toHaveLength(4);
  });
});
