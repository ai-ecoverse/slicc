import { describe, expect, it, vi } from 'vitest';
import { FdTable, openPipe, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { KernelPipe } from '../../../src/kernel/wasm-realm/pipe.js';
import { WasmProcess } from '../../../src/kernel/wasm-realm/process.js';
import {
  defaultAction,
  isSignal,
  SIG,
  sigbit,
  signalsIn,
} from '../../../src/kernel/wasm-realm/signals.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('signal table', () => {
  it('knows default actions, masks and valid numbers', () => {
    expect(defaultAction(SIG.TERM)).toBe('terminate');
    expect(defaultAction(SIG.CHLD)).toBe('ignore');
    expect(defaultAction(SIG.WINCH)).toBe('ignore');
    expect(defaultAction(SIG.TSTP)).toBe('stop');
    expect(defaultAction(SIG.CONT)).toBe('continue');
    expect(signalsIn(sigbit(SIG.INT) | sigbit(SIG.USR1))).toEqual([2, 10]);
    expect(isSignal(0)).toBe(false);
    expect(isSignal(31)).toBe(true);
    expect(isSignal(32)).toBe(false);
  });
});

describe('interruptible pipes', () => {
  it('a caught signal interrupts a blocked read with EINTR and loses no data', async () => {
    const pipe = new KernelPipe();
    pipe.openRead();
    pipe.openWrite();
    const controller = new AbortController();
    const reading = pipe.read(8, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: 'EINTR' });
    await pipe.write(bytes('later'));
    expect(new TextDecoder().decode(await pipe.read(8))).toBe('later');
  });

  it('a blocked write returns its short count, or EINTR when nothing went in', async () => {
    const pipe = new KernelPipe(4);
    pipe.openRead();
    pipe.openWrite();
    const partial = new AbortController();
    const writing = pipe.write(bytes('abcdef'), partial.signal);
    partial.abort();
    expect(await writing).toBe(4);
    const none = new AbortController();
    none.abort();
    await expect(pipe.write(bytes('x'), none.signal)).rejects.toMatchObject({ code: 'EINTR' });
  });
});

describe('WasmProcess signals', () => {
  function proc(options: ConstructorParameters<typeof WasmProcess>[2] = {}) {
    return new WasmProcess(5, new FdTable(), options);
  }

  it('applies SIGKILL and default actions itself', () => {
    const p = proc();
    expect(p.signal(SIG.KILL)).toBe('terminate');
    expect(p.signal(SIG.TERM)).toBe('terminate');
    expect(p.signal(SIG.CHLD)).toBe('ignore');
  });

  it('leaves a caught signal pending and interrupts a blocked read', async () => {
    const onPending = vi.fn();
    const fds = new FdTable();
    const pipe = openPipe();
    fds.installAt(0, pipe.read);
    const p = new WasmProcess(5, fds, { onPending });
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR1), ignored: sigbit(SIG.INT) });
    const reading = p.syscall({ op: 'fd-read', fd: 0, max: 8 });
    await Promise.resolve();
    expect(p.signal(SIG.USR1)).toBe('deliver');
    expect(onPending).toHaveBeenCalledWith(SIG.USR1);
    expect(await reading).toMatchObject({ ok: false, errno: 'EINTR' });
    expect(p.signal(SIG.INT)).toBe('ignore');
    expect(p.signal(SIG.KILL)).toBe('terminate');
  });

  it('routes kill(2) to other processes: ESRCH when there is none, EINVAL for a bad signal', async () => {
    const kill = vi.fn((pid: number) => pid === 7);
    const p = proc({ kill });
    expect(await p.syscall({ op: 'proc-kill', pid: 7, sig: SIG.TERM })).toEqual({
      ok: true,
      kind: 'void',
    });
    expect(await p.syscall({ op: 'proc-kill', pid: 8, sig: SIG.TERM })).toMatchObject({
      errno: 'ESRCH',
    });
    expect(await p.syscall({ op: 'proc-kill', pid: 7, sig: 99 })).toMatchObject({
      errno: 'EINVAL',
    });
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('while it execs, forwards signals to the program and returns its status', async () => {
    const kill = vi.fn(() => true);
    let end!: (code: number) => void;
    const spawner = async () => ({
      pid: 40,
      exited: new Promise<number>((resolve) => (end = resolve)),
    });
    const p = proc({ kill, spawner });
    await p.syscall({
      op: 'proc-spawn',
      file: 'sleep',
      argv: ['sleep'],
      env: {},
      cwd: '/',
      stdio: [],
    });
    const execing = p.syscall({ op: 'proc-exec', pid: 40 });
    await Promise.resolve();
    expect(p.signal(SIG.TERM)).toBe('forward');
    expect(kill).toHaveBeenCalledWith(40, SIG.TERM);
    end(143);
    expect(await execing).toEqual({ ok: true, kind: 'json', json: [40, 143 << 8] });
    expect(p.signal(SIG.TERM)).toBe('terminate');
  });

  it('raises SIGCHLD in the parent when a child exits, if caught', async () => {
    const onPending = vi.fn();
    let end!: (code: number) => void;
    const spawner = async () => ({
      pid: 41,
      exited: new Promise<number>((resolve) => (end = resolve)),
    });
    const p = proc({ onPending, spawner });
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.CHLD), ignored: 0 });
    await p.syscall({ op: 'proc-spawn', file: 'x', argv: ['x'], env: {}, cwd: '/', stdio: [] });
    end(0);
    await vi.waitFor(() => expect(onPending).toHaveBeenCalledWith(SIG.CHLD));
  });

  it('interrupts a blocked waitpid', async () => {
    const spawner = async () => ({ pid: 42, exited: new Promise<number>(() => {}) });
    const p = proc({ spawner, onPending: () => {} });
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR2), ignored: 0 });
    await p.syscall({ op: 'proc-spawn', file: 'x', argv: ['x'], env: {}, cwd: '/', stdio: [] });
    const waiting = p.syscall({ op: 'proc-wait', pid: -1, nohang: false });
    await Promise.resolve();
    p.signal(SIG.USR2);
    expect(await waiting).toMatchObject({ ok: false, errno: 'EINTR' });
  });

  it('keeps sink writes uninterrupted (a sink never blocks)', async () => {
    const out: Uint8Array[] = [];
    const fds = new FdTable();
    fds.installAt(
      1,
      sinkFile((b) => out.push(b))
    );
    const p = new WasmProcess(5, fds);
    expect(await p.syscall({ op: 'fd-write', fd: 1, body: bytes('x') })).toMatchObject({
      ok: true,
    });
  });
});
