import { describe, expect, it, vi } from 'vitest';
import {
  KernelStreams,
  ProcessExit,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from '../../../src/kernel/wasm-realm/kernel-streams.js';
import { wireKernelStdio } from '../../../src/kernel/wasm-realm/process-runtime.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

class ErrnoError extends Error {
  constructor(readonly errno: number) {
    super(`errno ${errno}`);
  }
}

function fakeFs(count = 3) {
  const unset = () => -1;
  const streams = Array.from(
    { length: count },
    (_, fd) => ({ fd, stream_ops: { read: unset, write: unset } }) as unknown as ProcessStream
  );
  const fs = { getStream: (fd: number) => streams[fd] ?? null, ErrnoError } as unknown as ProcessFs;
  return { fs, streams };
}

function fakeSys(overrides: Partial<ProcessSys> = {}): ProcessSys & { closed: number[] } {
  const closed: number[] = [];
  return {
    closed,
    read: (_fd, max) => bytes('stdin data').subarray(0, max),
    write: (_fd, b) => b.length,
    close: (fd) => {
      closed.push(fd);
    },
    pipe: () => [3, 4],
    poll: () => ({ readable: true, writable: true, hangup: false }),
    openVfs: () => 9,
    seek: (_fd, offset) => offset,
    ...overrides,
  };
}

describe('KernelStreams', () => {
  it('reads and writes fds 0-2 through the kernel, byte-exact', () => {
    const written: Array<[number, string]> = [];
    const sys = fakeSys({
      write: (fd, b) => {
        written.push([fd, text(b)]);
        return b.length;
      },
    });
    const { fs, streams } = fakeFs();
    wireKernelStdio(fs, new KernelStreams(fs, sys));
    const buf = new Uint8Array(16);
    expect(streams[0]!.stream_ops.read!(streams[0]!, buf, 2, 5)).toBe(5);
    expect(text(buf.subarray(2, 7))).toBe('stdin');
    expect(streams[1]!.stream_ops.write!(streams[1]!, bytes('xxpartial line'), 2, 12)).toBe(12);
    streams[2]!.stream_ops.write!(streams[2]!, bytes('err'), 0, 3);
    expect(written).toEqual([
      [1, 'partial line'],
      [2, 'err'],
    ]);
    expect(streams.map((s) => s.sliccKernelFd)).toEqual([0, 1, 2]);
  });

  it('raises a kernel error as the matching Emscripten errno (EIO = 29)', () => {
    const sys = fakeSys({
      read: () => {
        throw new SyscallError('EBADF');
      },
      write: () => {
        throw new SyscallError('EIO');
      },
    });
    const { fs, streams } = fakeFs();
    wireKernelStdio(fs, new KernelStreams(fs, sys));
    const [s0, s1] = streams;
    expect(() => s1!.stream_ops.write!(s1!, bytes('y'), 0, 1)).toThrow(
      expect.objectContaining({ errno: 29 })
    );
    expect(() => s0!.stream_ops.read!(s0!, new Uint8Array(1), 0, 1)).toThrow(
      expect.objectContaining({ errno: 8 })
    );
  });

  it('closes the kernel descriptor with its last copy', () => {
    const sys = fakeSys();
    const { fs, streams } = fakeFs(1);
    const baseClose = vi.fn();
    streams[0]!.stream_ops.close = baseClose;
    new KernelStreams(fs, sys).attach(streams[0]!, 7);
    const ops = streams[0]!.stream_ops;
    ops.dup!(streams[0]!); // dup2, or the fork emulation's clone
    ops.close!(streams[0]!);
    expect(sys.closed).toEqual([]);
    ops.close!(streams[0]!);
    expect(sys.closed).toEqual([7]);
    expect(baseClose).toHaveBeenCalledTimes(2);
  });

  it('answers poll with the kernel readiness as poll(2) bits', () => {
    const states = [
      { readable: true, writable: false, hangup: false },
      { readable: true, writable: false, hangup: true },
      { readable: false, writable: true, hangup: true },
      { readable: false, writable: false, hangup: false },
    ];
    const sys = fakeSys({ poll: () => states.shift()! });
    const { fs, streams } = fakeFs(1);
    new KernelStreams(fs, sys).attach(streams[0]!, 3);
    const poll = () => streams[0]!.stream_ops.poll!(streams[0]!);
    expect(poll()).toBe(0x041); // POLLIN | POLLRDNORM
    expect(poll()).toBe(0x051); // … | POLLHUP: every writer gone
    expect(poll()).toBe(0x10c); // POLLOUT | POLLWRNORM | POLLERR: every reader gone
    expect(poll()).toBe(0);
  });

  it('makes pipe() return kernel pipes on the pipes Emscripten created', () => {
    const sys = fakeSys({ pipe: () => [5, 6] });
    const { fs, streams } = fakeFs(3);
    const pipefs = { createPipe: () => ({ readable_fd: 1, writable_fd: 2 }) };
    new KernelStreams(fs, sys).usePipes(pipefs);
    expect(pipefs.createPipe()).toEqual({ readable_fd: 1, writable_fd: 2 });
    expect(streams[1]!.sliccKernelFd).toBe(5);
    expect(streams[2]!.sliccKernelFd).toBe(6);
  });

  it('turns a failed pipe() into an Emscripten errno', () => {
    const sys = fakeSys({
      pipe: () => {
        throw new SyscallError('EMFILE');
      },
    });
    const { fs } = fakeFs();
    const pipefs = { createPipe: () => ({ readable_fd: 1, writable_fd: 2 }) };
    new KernelStreams(fs, sys).usePipes(pipefs);
    expect(() => pipefs.createPipe()).toThrow(expect.objectContaining({ errno: 33 }));
  });

  it("ends the program on a write to a pipe with no reader (SIGPIPE's default)", () => {
    const epipe = () => {
      throw new SyscallError('EPIPE');
    };
    const { fs, streams } = fakeFs(1);
    new KernelStreams(fs, fakeSys({ write: epipe })).attach(streams[0]!, 4);
    const write = () => streams[0]!.stream_ops.write!(streams[0]!, bytes('y'), 0, 1);
    expect(write).toThrow(ProcessExit);
    expect(write).toThrow(expect.objectContaining({ status: 141 }));
  });

  it('fails the write with EPIPE when the program ignores or handles SIGPIPE', () => {
    const epipe = () => {
      throw new SyscallError('EPIPE');
    };
    const { fs, streams } = fakeFs(1);
    const handled = vi.fn(() => true);
    new KernelStreams(fs, fakeSys({ write: epipe }), handled).attach(streams[0]!, 4);
    expect(() => streams[0]!.stream_ops.write!(streams[0]!, bytes('y'), 0, 1)).toThrow(
      expect.objectContaining({ errno: 64 })
    );
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("gives the kernel's pipe ends back when Emscripten cannot make its own pipe", () => {
    const sys = fakeSys({ pipe: () => [5, 6] });
    const { fs } = fakeFs();
    const pipefs = {
      createPipe: () => {
        throw new ErrnoError(33); // EMFILE
      },
    };
    new KernelStreams(fs, sys).usePipes(pipefs);
    expect(() => pipefs.createPipe()).toThrow(expect.objectContaining({ errno: 33 }));
    expect(sys.closed).toEqual([5, 6]);
  });
});
