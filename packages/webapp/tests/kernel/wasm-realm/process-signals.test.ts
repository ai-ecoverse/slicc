import { describe, expect, it, vi } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../../../src/kernel/realm/sync-sab-bridge.js';
import {
  SAB_HEADER_I32,
  SAB_I_SIGNALS,
  SAB_I_TIMERS,
} from '../../../src/kernel/realm/sync-sab-wire.js';
import { SignalGate } from '../../../src/kernel/wasm-realm/process-signals.js';
import { SIG, sigbit } from '../../../src/kernel/wasm-realm/signals.js';

const ok: SyncFsResult = { ok: true, kind: 'void' };

function setup(masks = { caught: sigbit(SIG.USR1), ignored: 0, restart: 0 }) {
  const header = new Int32Array(new SharedArrayBuffer(SAB_HEADER_I32 * 4));
  const calls: string[] = [];
  let onCall: (() => void) | undefined;
  const raw = {
    call: (req: { op: string }) => {
      calls.push(req.op);
      onCall?.();
      return ok;
    },
  } as unknown as SyncSabTransport;
  const raised: number[] = [];
  const hooks = { masks: vi.fn(() => masks), raise: vi.fn((sig: number) => void raised.push(sig)) };
  const gate = new SignalGate(raw, header, hooks);
  return { gate, header, calls, raised, hooks, setOnCall: (f: () => void) => (onCall = f) };
}

describe('SignalGate', () => {
  it('reports dispositions before a call, once per change', () => {
    const { gate, calls } = setup();
    const t = gate.transport();
    t.call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x');
    t.call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x');
    expect(calls).toEqual(['sig-mask', 'fd-read', 'fd-read']);
  });

  it('a mask query that throws, or that makes a syscall itself, neither recurses nor fails the call', () => {
    const { gate, calls, hooks } = setup();
    const t = gate.transport();
    // An assertions build aborting in the query writes its message: a syscall through the gate.
    hooks.masks.mockImplementation(() => {
      t.call({ op: 'fd-write', fd: 2, body: new Uint8Array(1) }, Infinity, 'abort message');
      throw new Error('Assertion failed: native function called after runtime exit');
    });
    expect(t.call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x')).toEqual(ok);
    expect(hooks.masks).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['fd-write', 'fd-read']); // nothing reported
  });

  it('runs an expired timer through the program, not as a signal; SIGALRM SA_RESTART decides a restart', () => {
    const { gate, header, raised, hooks, setOnCall } = setup({
      caught: 0,
      ignored: 0,
      restart: sigbit(SIG.ALRM),
    });
    const fired: number[] = [];
    Object.assign(hooks, { timer: (w: number) => void fired.push(w) });
    setOnCall(() => Atomics.or(header, SAB_I_TIMERS, 1));
    gate.transport().call({ op: 'sig-pause' }, Infinity, 'x');
    expect(fired).toEqual([0]);
    expect(raised).toEqual([]); // a kill(SIGALRM) would land in SAB_I_SIGNALS instead
    expect(gate.restartable()).toBe(true);
    expect(Atomics.load(header, SAB_I_TIMERS)).toBe(0);
  });

  it('runs the handlers of the signals pending after a call', () => {
    const { gate, header, raised, setOnCall } = setup();
    setOnCall(() => Atomics.or(header, SAB_I_SIGNALS, sigbit(SIG.USR1) | sigbit(SIG.TERM)));
    gate.transport().call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x');
    expect(raised).toEqual([SIG.USR1, SIG.TERM]);
    expect(Atomics.load(header, SAB_I_SIGNALS)).toBe(0);
  });

  it('allows a restart only when every handler run asked for SA_RESTART', () => {
    const restart = sigbit(SIG.CHLD);
    const { gate, header, setOnCall } = setup({
      caught: restart | sigbit(SIG.USR1),
      ignored: 0,
      restart,
    });
    const t = gate.transport();
    setOnCall(() => Atomics.or(header, SAB_I_SIGNALS, sigbit(SIG.CHLD)));
    t.call({ op: 'proc-wait', pid: -1, nohang: false }, Infinity, 'x');
    expect(gate.restartable()).toBe(true);
    setOnCall(() => Atomics.or(header, SAB_I_SIGNALS, sigbit(SIG.USR1)));
    t.call({ op: 'proc-wait', pid: -1, nohang: false }, Infinity, 'x');
    expect(gate.restartable()).toBe(false);
  });

  it("keeps the interrupted call's signals when a handler makes syscalls of its own", () => {
    const restart = sigbit(SIG.CHLD);
    const { gate, header, hooks, setOnCall } = setup({ caught: restart, ignored: 0, restart });
    const t = gate.transport();
    hooks.raise.mockImplementation(() => {
      setOnCall(() => {});
      t.call({ op: 'fd-write', fd: 1, body: new Uint8Array(1) }, Infinity, 'handler');
    });
    setOnCall(() => Atomics.or(header, SAB_I_SIGNALS, restart));
    t.call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x');
    expect(gate.restartable()).toBe(true);
  });

  it('does nothing about dispositions for a program without signal support', () => {
    const { gate, calls, hooks } = setup();
    hooks.masks.mockReturnValue(null as never);
    gate.transport().call({ op: 'fd-read', fd: 0, max: 1 }, Infinity, 'x');
    expect(calls).toEqual(['fd-read']);
  });
});
