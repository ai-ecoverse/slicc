/**
 * #3530 phase 5f, in-process: the WASIX socket address codec and `resolve`,
 * signal delivery to a program's handler callback (and the kernel's default
 * action when it has none), and the kernel's alarm and repeated-signal
 * escalation. Real programs: `../wasix-programs.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { FdTable } from '../../../../src/kernel/wasm-realm/fd-table.js';
import { WasmProcess } from '../../../../src/kernel/wasm-realm/process.js';
import { SIG, sigbit } from '../../../../src/kernel/wasm-realm/signals.js';
import { E, EVENTTYPE } from '../../../../src/kernel/wasm-realm/wasi/wasi-abi.js';
import type { WasiFds } from '../../../../src/kernel/wasm-realm/wasi/wasi-fds.js';
import { WasiMemory } from '../../../../src/kernel/wasm-realm/wasi/wasi-memory.js';
import { pollOneoff } from '../../../../src/kernel/wasm-realm/wasi/wasi-poll.js';
import { WasiSignals } from '../../../../src/kernel/wasm-realm/wasi/wasi-signals.js';
import {
  readAddr,
  resolveName,
  writeAddr,
} from '../../../../src/kernel/wasm-realm/wasi/wasix-sockets.js';

describe('WASIX addresses (__wasi_addr_port_t)', () => {
  it('round-trips inet4 (port little-endian at 2, address at 4) and unix paths', () => {
    const view = new DataView(new ArrayBuffer(256));
    writeAddr(view, 16, { family: 'inet', host: '127.0.0.1', port: 8080 });
    expect(view.getUint8(16)).toBe(1);
    expect(view.getUint16(18, true)).toBe(8080);
    expect([20, 21, 22, 23].map((i) => view.getUint8(i))).toEqual([127, 0, 0, 1]);
    expect(readAddr(view, 16)).toEqual({ family: 'inet', host: '127.0.0.1', port: 8080 });
    writeAddr(view, 16, { family: 'unix', path: '/tmp/sock' });
    expect(readAddr(view, 16)).toEqual({ family: 'unix', path: '/tmp/sock' });
  });

  it('an IPv6 address is the loopback it stands for here (:: binds everything)', () => {
    const view = new DataView(new ArrayBuffer(256));
    view.setUint8(0, 2);
    view.setUint16(2, 443, true);
    expect(readAddr(view, 0)).toEqual({ family: 'inet', host: '0.0.0.0', port: 443 });
    view.setUint8(19, 1); // ::1
    expect(readAddr(view, 0)).toEqual({ family: 'inet', host: '127.0.0.1', port: 443 });
    view.setUint8(0, 9);
    expect(() => readAddr(view, 0)).toThrow();
  });

  it('resolve answers loopback names and literal addresses; the proxy resolves the rest', () => {
    expect(resolveName('localhost')).toEqual([127, 0, 0, 1]);
    expect(resolveName('::1')).toEqual([127, 0, 0, 1]);
    expect(resolveName('10.1.2.3')).toEqual([10, 1, 2, 3]);
    expect(resolveName('example.com')).toBeUndefined();
    expect(resolveName('300.1.1.1')).toBeUndefined();
  });
});

describe('WasiSignals', () => {
  it('reports nothing caught until the program registers its callback; then the terminating signals', () => {
    const s = new WasiSignals(() => {});
    const handler = vi.fn();
    s.bind({ __wasm_signal: handler } as unknown as WebAssembly.Exports);
    expect(s.masks()).toBeNull();
    s.register('__wasm_signal');
    const caught = s.masks()?.caught ?? 0;
    for (const sig of [SIG.INT, SIG.TERM, SIG.USR1, SIG.ALRM])
      expect(caught & sigbit(sig)).not.toBe(0);
    // Python sets SIGPIPE to SIG_IGN, which the libc would call as a function.
    expect(caught & sigbit(SIG.PIPE)).toBe(0);
    s.raise(SIG.USR1);
    expect(handler).toHaveBeenCalledWith(SIG.USR1);
  });

  it('an export the program does not have is no callback (the one it had stays)', () => {
    const s = new WasiSignals(() => {});
    s.bind({ __wasm_signal: vi.fn() } as unknown as WebAssembly.Exports);
    s.register('__wasm_signal');
    s.register('__wasm_signal_blocked');
    expect(s.masks()).not.toBeNull();
  });

  it('no handler (the libc aborts, or raises SIGABRT in the default action): the kernel’s default action instead', () => {
    const fallBack = vi.fn();
    const s = new WasiSignals(fallBack);
    const exports: { __wasm_signal: (sig: number) => void } = {
      __wasm_signal: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      },
    };
    s.bind(exports as unknown as WebAssembly.Exports);
    s.register('__wasm_signal');
    s.raise(SIG.TERM);
    expect(fallBack).toHaveBeenCalledWith(SIG.TERM);
    // TERM is the kernel's now: no longer reported caught.
    expect((s.masks()?.caught ?? 0) & sigbit(SIG.TERM)).toBe(0);
    // abort() inside a default action is that action (SIGABRT raised by the libc).
    exports.__wasm_signal = () => {
      expect(s.raised(SIG.ABRT)).toBe(true);
    };
    s.raise(SIG.HUP);
    expect(fallBack).toHaveBeenLastCalledWith(SIG.HUP);
    // Outside a delivery, SIGABRT is the program's own.
    expect(s.raised(SIG.ABRT)).toBe(false);
  });
});

describe('the kernel: alarms and a repeated signal', () => {
  it('proc-alarm raises its signal after the interval, again if repeating, never after a cancel', async () => {
    const raised: number[] = [];
    const p = new WasmProcess(3300, new FdTable(), { raise: (sig) => void raised.push(sig) });
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 10, repeat: true });
    await new Promise((r) => setTimeout(r, 35));
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 0, repeat: false });
    const n = raised.length;
    expect(n).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(raised.length).toBe(n);
  });

  it('proc-alarm with firstMs: a one-shot fires once; a repeating one first after firstMs, then every ms', async () => {
    const raised: number[] = [];
    const p = new WasmProcess(3302, new FdTable(), { raise: (sig) => void raised.push(sig) });
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 0, firstMs: 10, repeat: false });
    await new Promise((r) => setTimeout(r, 40));
    expect(raised).toEqual([SIG.ALRM]);
    raised.length = 0;
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 5, firstMs: 40, repeat: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(raised).toEqual([]); // not before the first
    await new Promise((r) => setTimeout(r, 50));
    expect(raised.length).toBeGreaterThanOrEqual(2);
    await p.exit();
  });

  it('a terminating signal that arrives while the same one still waits for the program ends it', async () => {
    let pending = 0;
    const p = new WasmProcess(3301, new FdTable(), {
      onPending: (sig) => void (pending |= sigbit(sig)),
      pendingBits: () => pending,
    });
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.INT), ignored: 0 });
    // First ^C: the program's handler, at its next syscall.
    expect(p.signal(SIG.INT)).toBe('deliver');
    // Second ^C before it got there (a loop without syscalls): the default action.
    expect(p.signal(SIG.INT)).toBe('terminate');
  });
});

describe('poll_oneoff interrupted by a signal', () => {
  /** One clock subscription (relative, `ms`), polled with a kernel whose select is interrupted. */
  function sleep(interruptWakes: boolean) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const mem = new WasiMemory();
    mem.bind(memory);
    const v = new DataView(memory.buffer);
    v.setBigUint64(0, 7n, true); // userdata
    v.setUint8(8, EVENTTYPE.CLOCK);
    v.setUint32(16, 1, true); // monotonic
    v.setBigUint64(24, 5_000_000_000n, true); // 5 s, relative
    const kernel = {
      sys: {} as never,
      call: () => {
        throw Object.assign(new Error('EINTR'), { code: 'EINTR' });
      },
    };
    const run = () =>
      pollOneoff({ mem, fds: {} as WasiFds, kernel, now: () => 0n, interruptWakes }, 0, 64, 1, 128);
    return { run, v };
  }

  it('is EINTR to a current libc', () => {
    expect(() => sleep(false).run()).toThrow('EINTR');
  });

  it('ends as its clocks firing for the older wasix-libc (which turns EINTR into ENOTSUP)', () => {
    const { run, v } = sleep(true);
    expect(run()).toBe(E.SUCCESS);
    expect(v.getUint32(128, true)).toBe(1);
    expect(v.getBigUint64(64, true)).toBe(7n);
    expect(v.getUint8(64 + 10)).toBe(EVENTTYPE.CLOCK);
  });
});

describe('fd-vfs-stat', () => {
  it('answers a VFS description’s own size and path; ESPIPE for anything else', async () => {
    const files = new Map<string, Uint8Array>();
    const fs = {
      readFileBuffer: async (p: string) => files.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, c: Uint8Array) => void files.set(p, c),
    };
    const p = new WasmProcess(3302, new FdTable(), { fs: fs as never });
    const r = await p.syscall({ op: 'fd-open-vfs', path: '/w/a.txt', flags: 2, position: 0 });
    const fd = r.ok && r.kind === 'json' ? (r.json as number) : -1;
    await p.syscall({ op: 'fd-write', fd, body: new TextEncoder().encode('hello') });
    // Its size before any write-back.
    expect(await p.syscall({ op: 'fd-vfs-stat', fd })).toEqual({
      ok: true,
      kind: 'json',
      json: { size: 5, path: '/w/a.txt' },
    });
    const [rd] = (
      (await p.syscall({ op: 'fd-pipe' })) as { ok: true; kind: 'json'; json: [number, number] }
    ).json;
    expect(await p.syscall({ op: 'fd-vfs-stat', fd: rd })).toMatchObject({
      ok: false,
      errno: 'ESPIPE',
    });
  });
});
