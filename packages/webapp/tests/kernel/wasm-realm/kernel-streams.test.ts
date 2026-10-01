import { describe, expect, it, vi } from 'vitest';
import {
  KernelStreams,
  ProcessExit,
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from '../../../src/kernel/wasm-realm/kernel-streams.js';
import { wireKernelFd, wireKernelStdio } from '../../../src/kernel/wasm-realm/process-runtime.js';

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
    flush: () => {},
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

  it('refuses lseek on a pipe, socket or terminal (ESPIPE = 70), whatever the placeholder under it', () => {
    const { fs, streams } = fakeFs();
    streams[0]!.stream_ops = { ...streams[0]!.stream_ops, llseek: () => 0 };
    wireKernelStdio(fs, new KernelStreams(fs, fakeSys()));
    expect(() => streams[0]!.stream_ops.llseek!(streams[0]!, 0, 1)).toThrow(
      expect.objectContaining({ errno: 70 })
    );
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
    ops.dup!(streams[0]!);
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
    expect(poll()).toBe(0x041);
    expect(poll()).toBe(0x051);
    expect(poll()).toBe(0x10c);
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
    new KernelStreams(fs, fakeSys({ write: epipe }), { sigpipe: handled }).attach(streams[0]!, 4);
    expect(() => streams[0]!.stream_ops.write!(streams[0]!, bytes('y'), 0, 1)).toThrow(
      expect.objectContaining({ errno: 64 })
    );
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('routes fsync on a promoted VFS file to the kernel flush', () => {
    const flushed: number[] = [];
    const sys = fakeSys({
      flush: (fd) => {
        flushed.push(fd);
      },
    });
    const { fs, streams } = fakeFs(1);
    new KernelStreams(fs, sys).attachFile(streams[0]!, 11);
    expect(streams[0]!.stream_ops.fsync!()).toBe(0);
    expect(flushed).toEqual([11]);
  });

  it("gives the kernel's pipe ends back when Emscripten cannot make its own pipe", () => {
    const sys = fakeSys({ pipe: () => [5, 6] });
    const { fs } = fakeFs();
    const pipefs = {
      createPipe: () => {
        throw new ErrnoError(33);
      },
    };
    new KernelStreams(fs, sys).usePipes(pipefs);
    expect(() => pipefs.createPipe()).toThrow(expect.objectContaining({ errno: 33 }));
    expect(sys.closed).toEqual([5, 6]);
  });

  it('retries an interrupted read when the handlers asked for SA_RESTART', () => {
    let calls = 0;
    const sys = fakeSys({
      read: () => {
        calls += 1;
        if (calls === 1) throw new SyscallError('EINTR');
        return bytes('ok');
      },
    });
    const { fs, streams } = fakeFs(1);
    const restartable = vi.fn(() => true);
    new KernelStreams(fs, sys, { restartable }).attach(streams[0]!, 0);
    const buf = new Uint8Array(4);
    expect(streams[0]!.stream_ops.read!(streams[0]!, buf, 0, 4)).toBe(2);
    expect(calls).toBe(2);
  });

  it('fails an interrupted read with EINTR otherwise', () => {
    const sys = fakeSys({
      read: () => {
        throw new SyscallError('EINTR');
      },
    });
    const { fs, streams } = fakeFs(1);
    new KernelStreams(fs, sys, { restartable: () => false }).attach(streams[0]!, 0);
    expect(() => streams[0]!.stream_ops.read!(streams[0]!, new Uint8Array(1), 0, 1)).toThrow(
      expect.objectContaining({ errno: 27 })
    );
  });

  it('puts a terminal device the program opens on its kernel terminal, with its own access mode', () => {
    const { fs, streams } = fakeFs();
    const opened: Array<[string, number]> = [];
    (fs as unknown as { open: (path: string, flags: number) => ProcessStream }).open = (
      path,
      flags
    ) => {
      opened.push([path, flags]);

      const tty = path.startsWith('/dev/tty') ? { ops: {} } : undefined;
      return { fd: 9, flags, path, stream_ops: {}, tty } as unknown as ProcessStream;
    };
    const reads: number[] = [];
    const sys = fakeSys({
      isatty: (fd) => fd === 2,
      read: (fd) => {
        reads.push(fd);
        return bytes('q');
      },
    });
    const kernel = new KernelStreams(fs, sys);
    kernel.useControllingTerminal();
    expect(fs.open('/dev/tty', 0).sliccKernelFd).toBeUndefined();
    wireKernelStdio(fs, kernel);
    const tty = fs.open('/dev/tty1', 0);
    expect(tty.flags).toBe(0);
    expect(tty.sliccKernelFd).toBe(2);
    expect(tty.tty).toBeDefined();
    const buf = new Uint8Array(1);
    expect(tty.stream_ops.read?.(tty, buf, 0, 1)).toBe(1);
    expect(reads).toEqual([2]);

    tty.stream_ops.close?.(tty);
    expect(sys.closed).toEqual([]);
    expect(fs.open('/etc/passwd', 0).sliccKernelFd).toBeUndefined();
    expect(opened.map(([path]) => path)).toEqual(['/dev/tty', '/dev/tty1', '/etc/passwd']);
    void streams;
  });

  it('chown / chmod / stat by path on /dev/pts/N and /dev/ptmx answer for the kernel ptys', () => {
    const { fs } = fakeFs();
    let ptys = [3];
    const sys = {
      close: () => {},
      openPty: () => 0,
      ptyNumbers: () => ptys,
    } as unknown as ProcessSys;
    const calls: string[] = [];
    Object.assign(fs, {
      open: (path: string, flags: number) =>
        ({ fd: 9, flags, path, stream_ops: {} }) as unknown as ProcessStream,
      chown: (p: string) => void calls.push(`chown ${p}`),
      chmod: (p: string) => void calls.push(`chmod ${p}`),
      stat: (p: string) => {
        calls.push(`stat ${p}`);
        return { mode: 0o100644 };
      },
    });
    new KernelStreams(fs, sys).useControllingTerminal();
    const f = fs as unknown as {
      chown(p: string, u: number, g: number): void;
      chmod(p: string, m: number): void;
      stat(p: string): { mode: number; rdev: number; uid: number };
    };
    f.chown('/dev/pts/3', 1000, 5);
    f.chmod('/dev/pts/3', 0o620);
    expect(f.stat('/dev/pts/3')).toMatchObject({ mode: 0o20620, rdev: (136 << 8) | 3, uid: 1000 });
    expect(f.stat('/dev/ptmx').mode).toBe(0o20666);
    expect(calls).toEqual([]);

    f.chown('/tmp/x', 1000, 1000);
    expect(f.stat('/tmp/x').mode).toBe(0o100644);
    expect(calls).toEqual(['chown /tmp/x', 'stat /tmp/x']);

    const enoent = { errno: 44 };
    expect(() => f.stat('/dev/pts/999')).toThrow(expect.objectContaining(enoent));
    expect(() => f.chmod('/dev/pts/999', 0o620)).toThrow(expect.objectContaining(enoent));
    ptys = [];
    expect(() => f.chown('/dev/pts/3', 1000, 5)).toThrow(expect.objectContaining(enoent));
    expect(f.stat('/dev/ptmx').mode).toBe(0o20666);
  });

  it("names a terminal stream after its device, which ttyname() reads back; the panel's keeps its path", () => {
    const { fs, streams } = fakeFs();
    const names: Record<number, string> = { 0: '/dev/pts/2' };
    const sys = {
      close: () => {},
      isatty: (fd: number) => fd !== 2,
      ttyName: (fd: number) => names[fd],
    } as unknown as ProcessSys;
    for (const s of streams) (s as { path?: string }).path = '/dev/tty';
    Object.assign(fs, { stat: (p: string) => ({ dev: 22, ino: p.length }) });
    wireKernelStdio(fs, new KernelStreams(fs, sys));
    expect(streams.map((s) => (s as { path?: string }).path)).toEqual([
      '/dev/pts/2',
      '/dev/tty',
      '/dev/tty',
    ]);

    const named = streams[0] as ProcessStream;
    expect(named.stream_ops.getattr?.(named)).toEqual({ dev: 22, ino: '/dev/pts/2'.length });

    Object.assign(fs, { stat: () => ({ dev: 136, ino: 2 }) });
    expect(named.stream_ops.getattr?.(named)).toEqual({ dev: 136, ino: 2 });
    expect((streams[1] as ProcessStream).stream_ops.getattr).toBeUndefined();
  });

  it('a stream opened on /dev/pts/N or /dev/ptmx keeps that path, not its vessel', () => {
    const { fs } = fakeFs();
    const sys = {
      close: () => {},
      openPty: () => 7,
      openPts: () => 8,
      ptyNumbers: () => [0],
      tcgets: () => ({}),
    } as unknown as ProcessSys;
    Object.assign(fs, {
      open: (path: string, flags: number) =>
        ({ fd: 9, flags, path, stream_ops: {} }) as unknown as ProcessStream,
    });
    new KernelStreams(fs, sys).useControllingTerminal();
    expect(fs.open('/dev/pts/0', 2).path).toBe('/dev/pts/0');
    expect(fs.open('/dev/ptmx', 2).path).toBe('/dev/ptmx');
  });

  it('without kernel pseudo-terminals, /dev/ptmx and /dev/pts/N do not exist', () => {
    const { fs } = fakeFs();
    Object.assign(fs, { open: () => ({}), stat: () => ({ mode: 0o100644 }) });
    new KernelStreams(fs, { close: () => {} } as unknown as ProcessSys).useControllingTerminal();
    const f = fs as unknown as { stat(p: string): unknown };
    expect(() => f.stat('/dev/ptmx')).toThrow(expect.objectContaining({ errno: 44 }));
    expect(() => f.stat('/dev/pts/0')).toThrow(expect.objectContaining({ errno: 44 }));
  });

  it("opens /dev/tty on the kernel's controlling terminal, or fails with ENXIO", () => {
    const { fs } = fakeFs();
    const closed: number[] = [];
    Object.assign(fs, {
      open: (path: string, flags: number) =>
        ({ fd: 9, flags, path, stream_ops: {}, tty: { ops: {} } }) as unknown as ProcessStream,
      closeStream: (fd: number) => closed.push(fd),
    });
    let ctty: number | undefined = 7;
    const sys = fakeSys({
      openTty: () => {
        if (ctty === undefined) throw new SyscallError('ENXIO');
        return ctty;
      },
    });
    const kernel = new KernelStreams(fs, sys);
    kernel.useControllingTerminal();
    const tty = fs.open('/dev/tty', 2);
    expect([tty.sliccKernelFd, tty.flags, tty.tty !== undefined]).toEqual([7, 2, true]);

    tty.stream_ops.close?.(tty);
    expect(sys.closed).toEqual([7]);
    ctty = undefined;
    expect(() => fs.open('/dev/tty', 2)).toThrow(expect.objectContaining({ errno: 60 }));
    expect(closed).toEqual([9]);
  });

  it("opens a terminal device by name (/dev/tty1) on the kernel's, else the one its stdio is on", () => {
    const { fs, streams } = fakeFs();
    Object.assign(fs, {
      open: (path: string, flags: number) =>
        ({ fd: 9, flags, path, stream_ops: {}, tty: { ops: {} } }) as unknown as ProcessStream,
    });
    (streams[0] as ProcessStream).sliccKernelFd = 0;
    (streams[0] as { tty?: object }).tty = {};
    const asked: Array<string | undefined> = [];
    let known = true;
    const sys = fakeSys({
      openTty: (name?: string) => {
        asked.push(name);
        if (!known) throw new SyscallError('ENXIO');
        return 11;
      },
    });
    new KernelStreams(fs, sys).useControllingTerminal();

    expect(fs.open('/dev/tty1', 2).sliccKernelFd).toBe(11);
    expect(asked).toEqual(['/dev/tty1']);
    known = false;
    expect(fs.open('/dev/tty1', 2).sliccKernelFd).toBe(0);
  });

  it('a named terminal open that fails for another reason (EMFILE) fails, closing its stream', () => {
    const { fs, streams } = fakeFs();
    const closed: number[] = [];
    Object.assign(fs, {
      open: (path: string, flags: number) =>
        ({ fd: 9, flags, path, stream_ops: {}, tty: { ops: {} } }) as unknown as ProcessStream,
      closeStream: (fd: number) => closed.push(fd),
    });
    (streams[0] as ProcessStream).sliccKernelFd = 0;
    const sys = fakeSys({
      openTty: () => {
        throw new SyscallError('EMFILE');
      },
    });
    new KernelStreams(fs, sys).useControllingTerminal();
    expect(() => fs.open('/dev/tty1', 2)).toThrow(expect.objectContaining({ errno: 33 }));
    expect(closed).toEqual([9]);
  });

  it('wireKernelFd opens a kernel descriptor beyond stdio at its own number', () => {
    const streams: Record<number, ProcessStream> = {};
    const closed: number[] = [];
    const fs = {
      ErrnoError,
      getStream: (fd: number) => streams[fd] ?? null,
      open: () => (streams[5] = { fd: 5, stream_ops: {} } as unknown as ProcessStream),
      dupStream: (s: ProcessStream, fd: number) => (streams[fd] = { ...s, fd }),
      closeStream: (fd: number) => {
        closed.push(fd);
        delete streams[fd];
      },
    } as unknown as ProcessFs;
    const written: Array<[number, string]> = [];
    const sys = fakeSys({
      write: (fd, b) => {
        written.push([fd, text(b)]);
        return b.length;
      },
      isatty: () => false,
    });
    wireKernelFd(fs, new KernelStreams(fs, sys), { fd: 97, kind: 'stream' });
    expect(closed).toEqual([5]);
    const stream = streams[97]!;
    expect(stream.sliccKernelFd).toBe(97);
    stream.stream_ops.write?.(stream, bytes('state'), 0, 5);
    expect(written).toEqual([[97, 'state']]);
  });

  it('marks a terminal fd as a TTY (isatty, termios, window size) and nothing else', () => {
    const termios = { c_iflag: 1, c_oflag: 2, c_cflag: 3, c_lflag: 4, c_cc: [] };
    const set: unknown[] = [];
    const sys = fakeSys({
      isatty: (fd) => fd === 0,
      tcgets: () => termios,
      tcsets: (_fd, t) => void set.push(t),
      winsize: () => [30, 100],
    });
    const { fs, streams } = fakeFs(3);
    streams[1]!.tty = { ops: {} };
    const kernel = new KernelStreams(fs, sys);
    kernel.attach(streams[0]!, 0);
    kernel.attach(streams[1]!, 1);
    kernel.attach(streams[2]!, 5, false);
    expect(streams[1]!.tty).toBeUndefined();
    expect(streams[2]!.tty).toBeUndefined();
    const ops = (streams[0]!.tty as { ops: Record<string, (...a: unknown[]) => unknown> }).ops;
    expect(ops.ioctl_tcgets!(streams[0])).toBe(termios);
    expect(ops.ioctl_tcsets!(null, 0x5402, termios)).toBe(0);
    expect(set).toEqual([termios]);
    expect(ops.ioctl_tiocgwinsz!(null)).toEqual([30, 100]);
  });
});
