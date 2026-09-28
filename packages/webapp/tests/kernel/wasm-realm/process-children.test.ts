import { describe, expect, it, vi } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../../../src/kernel/realm/sync-sab-bridge.js';
import { createProcessKernel } from '../../../src/kernel/wasm-realm/process-children.js';
import type { ProcessFs, ProcessStream } from '../../../src/kernel/wasm-realm/process-runtime.js';
import type { ForkStream } from '../../../src/kernel/wasm-realm/protocol.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

type Req = { op: string; [key: string]: unknown };

/** A transport answering from `answer`, recording every request. */
function transport(answer: (req: Req) => SyncFsResult) {
  const calls: Req[] = [];
  const t = {
    call: (req: Req) => {
      calls.push(req);
      return answer(req);
    },
  } as unknown as SyncSabTransport;
  return { t, calls };
}

/** An Emscripten-ish FS: fds 0-2 are kernel descriptors, fd 5 a file holding `data`, fd 6 a sink. */
function fs(data = 'file-data') {
  const written: string[] = [];
  let offset = 0;
  const stream = (fd: number, kernel?: number) =>
    ({ fd, stream_ops: {}, sliccKernelFd: kernel }) as unknown as ProcessStream;
  const streams: Record<number, ProcessStream> = {
    0: stream(0, 0),
    1: stream(1, 1),
    2: stream(2, 2),
    5: stream(5),
    6: stream(6),
  };
  const Fs = {
    getStream: (fd: number) => streams[fd] ?? null,
    cwd: () => '/work',
    read: (_s: ProcessStream, buffer: Uint8Array, at: number, length: number) => {
      const chunk = bytes(data).subarray(offset, offset + length);
      buffer.set(chunk, at);
      offset += chunk.length;
      return chunk.length;
    },
    write: (_s: ProcessStream, buffer: Uint8Array, at: number, length: number) => {
      written.push(text(buffer.subarray(at, at + length)));
      return length;
    },
  } as unknown as ProcessFs;
  return { Fs, written };
}

function kernel(answer: (req: Req) => SyncFsResult, data?: string) {
  const { t, calls } = transport(answer);
  const { Fs, written } = fs(data);
  const deps = {
    beforeSpawn: vi.fn(),
    afterChild: vi.fn(),
    describeFork: vi.fn((): ForkStream[] => []),
  };
  const k = createProcessKernel({ transport: t, Fs, env: { HOME: '/' }, ...deps });
  return { k, calls, written, ...deps };
}

const json = (value: unknown): SyncFsResult => ({ ok: true, kind: 'json', json: value });
const void0: SyncFsResult = { ok: true, kind: 'void' };

describe('createProcessKernel', () => {
  it("sends the fds a child inherits beyond 0-2, after posix_spawn's file actions", () => {
    const { t, calls } = transport(() => json(8));
    const { Fs } = fs();
    const inherit = vi.fn((actions?: ReadonlyArray<readonly [number, number]>) =>
      (actions ?? []).length ? [{ fd: 40, kernel: 12 }] : []
    );
    const order: string[] = [];
    const k = createProcessKernel({
      transport: t,
      Fs,
      env: {},
      beforeSpawn: () => order.push('flush'),
      afterChild: vi.fn(),
      describeFork: () => [],
      inherit: (actions) => {
        order.push('inherit');
        return inherit(actions);
      },
    });
    expect(k.spawn('diff', ['diff'], null, null, [0, 1, 2])).toBe(8);
    expect(calls[0]).not.toHaveProperty('inherit'); // nothing to inherit: no field
    expect(k.spawn('cat', ['cat'], null, null, [0, 1, 2], [[40, 9]])).toBe(8);
    expect(inherit).toHaveBeenLastCalledWith([[40, 9]]);
    expect(calls[1]).toMatchObject({ op: 'proc-spawn', inherit: [{ fd: 40, kernel: 12 }] });
    // The VFS is flushed before a file is handed to the kernel.
    expect(order).toEqual(['flush', 'inherit', 'flush', 'inherit']);
  });

  it('hands kernel descriptors to the kernel and returns at once', () => {
    const { k, calls, beforeSpawn } = kernel(() => json(7));
    expect(k.spawn('make', ['make', '-j'], null, null, [0, 1, 2])).toBe(7);
    expect(beforeSpawn).toHaveBeenCalled();
    expect(calls).toEqual([
      {
        op: 'proc-spawn',
        file: 'make',
        argv: ['make', '-j'],
        env: { HOME: '/' },
        cwd: '/work',
        stdio: [{ fd: 0 }, { fd: 1 }, { fd: 2 }],
      },
    ]);
  });

  it('feeds a program-internal stdin and runs a capturing child to completion', () => {
    const { k, calls, written, afterChild } = kernel((req) => {
      if (req.op === 'proc-spawn') return json(9);
      if (req.op === 'proc-wait') return json([9, 256]);
      return { ok: true, kind: 'bytes', bytes: bytes('captured') };
    });
    expect(k.spawn('sed', ['sed'], { A: '1' }, '/x', [5, 6, -1])).toBe(9);
    const spawn = calls[0] as unknown as { stdio: unknown[]; env: unknown; cwd: unknown };
    expect(spawn.stdio).toEqual([{ input: bytes('file-data') }, { capture: true }, { none: true }]);
    expect(spawn.env).toEqual({ A: '1' });
    expect(spawn.cwd).toBe('/x');
    expect(calls.map((c) => c.op)).toEqual(['proc-spawn', 'proc-wait', 'proc-captured']);
    expect(written).toEqual(['captured']);
    expect(afterChild).toHaveBeenCalled();
    // The program's own waitpid gets the status without asking the kernel again.
    expect(k.wait(9, false)).toEqual([9, 256]);
    expect(calls).toHaveLength(3);
  });

  it('returns a negative WASI errno when the kernel refuses', () => {
    const { k } = kernel(() => ({ ok: false, errno: 'ENOENT', message: 'ENOENT' }));
    expect(k.spawn('nope', ['nope'], null, null, [0, 1, 2])).toBe(-44);
    expect(k.wait(-1, false)).toBe(-44);
  });

  it('waits through the kernel, invalidating the VFS view only when a child was reaped', () => {
    const answers = [json([0, 0]), json([4, 0])];
    const { k, afterChild } = kernel(() => answers.shift()!);
    expect(k.wait(-1, true)).toEqual([0, 0]);
    expect(afterChild).not.toHaveBeenCalled();
    expect(k.wait(-1, false)).toEqual([4, 0]);
    expect(afterChild).toHaveBeenCalledTimes(1);
  });

  it('forks: pushes buffered writes, describes the fd table, and returns the child pid', () => {
    const { k, calls, beforeSpawn, describeFork } = kernel(() => json(21));
    const table = [{ fd: 1, kernel: 1, kind: 'stream' as const }];
    describeFork.mockReturnValue(table);
    const state = {
      memory: new Uint8Array(2),
      currData: 4,
      forkSp: 8,
      callStackNames: [],
      ppid: 3,
    };
    expect(k.fork(state)).toBe(21);
    expect(beforeSpawn).toHaveBeenCalled();
    expect(calls).toEqual([{ op: 'proc-fork', state: { ...state, streams: table, cwd: '/work' } }]);
    const refused = kernel(() => ({ ok: false, errno: 'ENOSYS', message: 'ENOSYS' }));
    expect(refused.k.fork(state)).toBe(-52);
  });

  it('kill(): raises in place for itself, asks the kernel for another pid or a group', () => {
    const { t, calls } = transport(() => ({ ok: false, errno: 'ESRCH', message: 'ESRCH' }));
    const { Fs } = fs();
    const raise = vi.fn();
    const k = createProcessKernel({
      transport: t,
      Fs,
      env: {},
      beforeSpawn: () => {},
      afterChild: () => {},
      describeFork: () => [],
      pid: 9,
      raise,
    });
    expect(k.kill(9, 15)).toBe(0);
    expect(raise.mock.calls).toEqual([[15]]);
    expect(k.kill(12, 15)).toBe(-71); // ESRCH
    expect(k.kill(-12, 15)).toBe(-71);
    expect(k.kill(0, 10)).toBe(-71); // its own group: the kernel signals every member
    expect(calls).toEqual([
      { op: 'proc-kill', pid: 12, sig: 15 },
      { op: 'proc-kill', pid: -12, sig: 15 },
      { op: 'proc-kill', pid: 0, sig: 10 },
    ]);
  });

  it('process groups, sessions and the terminal’s foreground group go to the kernel', () => {
    const { k, calls } = kernel((req) => {
      if (req.op === 'proc-setsid') return { ok: false, errno: 'EPERM', message: 'EPERM' };
      if (req.op === 'proc-getsid') return { ok: true, kind: 'void' };
      return req.op === 'proc-setpgid' || req.op === 'tty-pgrp-set' ? void0 : json(7);
    });
    expect(k.setpgid(0, 7)).toBe(0);
    expect(k.getpgid(0)).toBe(7);
    expect(k.getsid(3)).toBe(-29); // no number: EIO
    expect(k.setsid()).toBe(-63); // EPERM
    expect(k.tcgetpgrp(0)).toBe(7);
    expect(k.tcsetpgrp(1, 7)).toBe(0);
    expect(k.tcgetpgrp(5)).toBe(-59); // not a kernel descriptor: ENOTTY
    expect(k.tcsetpgrp(5, 7)).toBe(-59);
    expect(calls).toEqual([
      { op: 'proc-setpgid', pid: 0, pgid: 7 },
      { op: 'proc-getpgid', pid: 0 },
      { op: 'proc-getsid', pid: 3 },
      { op: 'proc-setsid' },
      { op: 'tty-pgrp-get', fd: 0 },
      { op: 'tty-pgrp-set', fd: 1, pgrp: 7 },
    ]);
  });

  it('wait(): WUNTRACED and WCONTINUED ask the kernel for stops and continues', () => {
    const { k, calls, afterChild } = kernel(() => json([4, 0x137f]));
    expect(k.wait(-1, true, 2 | 8)).toEqual([4, 0x137f]);
    expect(k.wait(4, false)).toEqual([4, 0x137f]);
    expect(calls).toEqual([
      { op: 'proc-wait', pid: -1, nohang: true, untraced: true, continued: true },
      { op: 'proc-wait', pid: 4, nohang: false },
    ]);
    expect(afterChild).toHaveBeenCalled();
  });

  it('execWait(): waits as the exec replacement and returns the wait status', () => {
    const { k, calls, afterChild } = kernel(() => json([30, 143 << 8]));
    expect(k.execWait(30)).toBe(143 << 8);
    expect(calls).toEqual([{ op: 'proc-exec', pid: 30 }]);
    expect(afterChild).toHaveBeenCalled();
  });

  it('waitpid restarts after an SA_RESTART handler, else reports EINTR', () => {
    const answers: SyncFsResult[] = [{ ok: false, errno: 'EINTR', message: 'EINTR' }, json([5, 0])];
    const { t } = transport(() => answers.shift()!);
    const { Fs } = fs();
    const k = createProcessKernel({
      transport: t,
      Fs,
      env: {},
      beforeSpawn: () => {},
      afterChild: () => {},
      describeFork: () => [],
      restartable: () => true,
    });
    expect(k.wait(-1, false)).toEqual([5, 0]);
    const plain = kernel(() => ({ ok: false, errno: 'EINTR', message: 'EINTR' }));
    expect(plain.k.wait(-1, false)).toBe(-27);
  });

  it('select(): kernel fds go to the kernel and map back; others fall back (null)', () => {
    const { k, calls } = kernel(() => json({ read: [1], write: [] }));
    expect(k.select([0, 1], [2], 100)).toEqual({ read: [1], write: [] });
    expect(calls).toEqual([{ op: 'fd-select', read: [0, 1], write: [2], timeoutMs: 100 }]);
    expect(k.select([5], [], 0)).toBeNull(); // fd 5 is a file of the program's own FS
    const refused = kernel(() => ({ ok: false, errno: 'EINTR', message: 'EINTR' }));
    expect(refused.k.select([0], [], -1)).toBe(-27);
  });
});
