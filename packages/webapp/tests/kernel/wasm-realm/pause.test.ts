import { describe, expect, it } from 'vitest';
import { FdTable } from '../../../src/kernel/wasm-realm/fd-table.js';
import { WasmProcess } from '../../../src/kernel/wasm-realm/process.js';
import { SIG, sigbit } from '../../../src/kernel/wasm-realm/signals.js';

/** Whether `p` has settled after the microtasks queued so far ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
}

// pause(2): GNU screen's front end waits in it for its server's signal.
describe('pause', () => {
  it('sleeps until a caught signal, which ends it with EINTR', async () => {
    const p = new WasmProcess(1, new FdTable(), {});
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR1), ignored: 0 });
    const waiting = p.syscall({ op: 'sig-pause' });
    expect(await settled(waiting)).toBe(false);
    p.signal(SIG.USR1);
    expect(await waiting).toMatchObject({ ok: false, errno: 'EINTR' });
  });

  it('a signal already pending ends it at once', async () => {
    const p = new WasmProcess(1, new FdTable(), { hasPending: () => true });
    expect(await p.syscall({ op: 'sig-pause' })).toMatchObject({ ok: false, errno: 'EINTR' });
  });

  it("a program's interval timer wakes it whatever SIGALRM's disposition, and is no signal", async () => {
    const timers: number[] = [];
    const raised: number[] = [];
    const p = new WasmProcess(1, new FdTable(), {
      onTimer: (which) => void timers.push(which),
      raise: (sig) => void raised.push(sig),
    });
    // SIGALRM neither caught nor ignored: as a signal its default action would end the process.
    await p.syscall({ op: 'sig-mask', caught: 0, ignored: 0 });
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 5, repeat: false, timer: 0 });
    const waiting = p.syscall({ op: 'sig-pause' });
    expect(await waiting).toMatchObject({ ok: false, errno: 'EINTR' });
    expect(timers).toEqual([0]); // the worker runs the program's expiry
    expect(raised).toEqual([]); // nothing was sent as SIGALRM
    // A plain alarm (no timer) is still the signal.
    await p.syscall({ op: 'proc-alarm', sig: SIG.ALRM, ms: 1, repeat: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(raised).toEqual([SIG.ALRM]);
  });

  it('an ignored signal does not end it', async () => {
    const p = new WasmProcess(1, new FdTable(), {});
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR2), ignored: sigbit(SIG.USR1) });
    const waiting = p.syscall({ op: 'sig-pause' });
    p.signal(SIG.USR1);
    expect(await settled(waiting)).toBe(false);
    p.signal(SIG.USR2);
    expect(await waiting).toMatchObject({ ok: false, errno: 'EINTR' });
  });
});
