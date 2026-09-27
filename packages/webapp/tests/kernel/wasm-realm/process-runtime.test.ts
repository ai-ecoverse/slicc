import { describe, expect, it } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import type { SyncSabTransport } from '../../../src/kernel/realm/sync-sab-bridge.js';
import {
  glueBody,
  kernelSys,
  type ProcessFs,
  type ProcessSys,
  SyscallError,
  wireKernelStdio,
} from '../../../src/kernel/wasm-realm/process-runtime.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function transport(reply: (req: unknown) => SyncFsResult): SyncSabTransport {
  return { call: (req) => reply(req) };
}

describe('kernelSys', () => {
  it('turns fd-read / fd-write results into bytes and counts', () => {
    const seen: unknown[] = [];
    const sys = kernelSys(
      transport((req) => {
        seen.push(req);
        return (req as { op: string }).op === 'fd-read'
          ? { ok: true, kind: 'bytes', bytes: bytes('in') }
          : { ok: true, kind: 'json', json: 5 };
      })
    );
    expect(text(sys.read(0, 16))).toBe('in');
    expect(sys.write(1, bytes('hello'))).toBe(5);
    expect(seen).toEqual([
      { op: 'fd-read', fd: 0, max: 16 },
      { op: 'fd-write', fd: 1, body: bytes('hello') },
    ]);
  });

  it('raises a kernel errno as SyscallError', () => {
    const sys = kernelSys(transport(() => ({ ok: false, errno: 'EPIPE', message: 'EPIPE' })));
    expect(() => sys.write(1, bytes('x'))).toThrow(SyscallError);
    expect(() => sys.read(0, 1)).toThrow(expect.objectContaining({ code: 'EPIPE' }));
  });
});

describe('wireKernelStdio', () => {
  class ErrnoError extends Error {
    constructor(readonly errno: number) {
      super(`errno ${errno}`);
    }
  }
  type Op = (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number;
  function fakeFs() {
    const unset: Op = () => -1;
    const streams = [0, 1, 2].map(() => ({ stream_ops: { read: unset, write: unset } }));
    const fs = {
      getStream: (fd: number) => streams[fd] ?? null,
      ErrnoError,
    } as unknown as ProcessFs;
    return { fs, streams };
  }

  it('reads and writes fds 0-2 through the kernel, byte-exact', () => {
    const written: Array<[number, string]> = [];
    const sys: ProcessSys = {
      read: (_fd, max) => bytes('stdin data').subarray(0, max),
      write: (fd, b) => {
        written.push([fd, text(b)]);
        return b.length;
      },
    };
    const { fs, streams } = fakeFs();
    wireKernelStdio(fs, sys);
    const buf = new Uint8Array(16);
    const n = streams[0].stream_ops.read(null, buf, 2, 5);
    expect(n).toBe(5);
    expect(text(buf.subarray(2, 7))).toBe('stdin');
    const out = bytes('xxpartial line');
    expect(streams[1].stream_ops.write(null, out, 2, 12)).toBe(12);
    streams[2].stream_ops.write(null, bytes('err'), 0, 3);
    expect(written).toEqual([
      [1, 'partial line'],
      [2, 'err'],
    ]);
  });

  it('raises a kernel error as the matching Emscripten errno (EPIPE = 64)', () => {
    const sys: ProcessSys = {
      read: () => {
        throw new SyscallError('EBADF');
      },
      write: () => {
        throw new SyscallError('EPIPE');
      },
    };
    const { fs, streams } = fakeFs();
    wireKernelStdio(fs, sys);
    expect(() => streams[1].stream_ops.write(null, bytes('y'), 0, 1)).toThrow(
      expect.objectContaining({ errno: 64 })
    );
    expect(() => streams[0].stream_ops.read(null, new Uint8Array(1), 0, 1)).toThrow(
      expect.objectContaining({ errno: 8 })
    );
  });
});

describe('glueBody', () => {
  it("drops an extensionless output's shebang line and keeps other glue as is", () => {
    expect(glueBody('#!/usr/bin/env node\nvar Module = 1;\n')).toBe('var Module = 1;\n');
    expect(glueBody('var Module = 1;')).toBe('var Module = 1;');
  });
});
