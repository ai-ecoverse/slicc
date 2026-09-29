import { describe, expect, it, vi } from 'vitest';
import {
  bytesSource,
  FdTable,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { WasmProcess } from '../../../src/kernel/wasm-realm/process.js';
import { selectFds } from '../../../src/kernel/wasm-realm/select.js';
import { SIG, sigbit } from '../../../src/kernel/wasm-realm/signals.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function table() {
  const fds = new FdTable();
  const pipe = openPipe();
  fds.installAt(3, pipe.read);
  fds.installAt(4, pipe.write);
  fds.installAt(
    5,
    sinkFile(() => {})
  );
  fds.installAt(6, bytesSource(bytes('x')));
  return fds;
}

describe('selectFds', () => {
  it('reports what is ready now; sources and sinks always are', async () => {
    const fds = table();
    const never = new AbortController().signal;
    expect(await selectFds(fds, [3, 6], [4, 5], 0, never)).toEqual({ read: [6], write: [4, 5] });
  });

  it('waits for a pipe to become readable', async () => {
    const fds = table();
    const waiting = selectFds(fds, [3], [], -1, new AbortController().signal);
    await fds.get(4).file.write!(bytes('token'));
    expect(await waiting).toEqual({ read: [3], write: [] });
  });

  it('times out with nothing ready', async () => {
    vi.useFakeTimers();
    try {
      const fds = table();
      const waiting = selectFds(fds, [3], [], 50, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60);
      expect(await waiting).toEqual({ read: [], write: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a pipe whose writers are gone as ready (EOF), and says it hung up', async () => {
    const fds = table();
    const waiting = selectFds(fds, [3], [], -1, new AbortController().signal);
    await fds.close(4);
    expect(await waiting).toEqual({ read: [3], write: [], hangup: [3] });
  });

  it('is interrupted by a caught signal', async () => {
    const fds = table();
    const interrupt = new AbortController();
    const waiting = selectFds(fds, [3], [], -1, interrupt.signal);
    interrupt.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'EINTR' });
  });
});

describe('fd-select syscall', () => {
  it('selects over the process table, and a signal already pending interrupts at once', async () => {
    let pending = false;
    const p = new WasmProcess(1, table(), { hasPending: () => pending, onPending: () => {} });
    expect(await p.syscall({ op: 'fd-select', read: [6], write: [], timeoutMs: -1 })).toEqual({
      ok: true,
      kind: 'json',
      json: { read: [6], write: [] },
    });
    pending = true;
    expect(await p.syscall({ op: 'fd-select', read: [3], write: [], timeoutMs: -1 })).toMatchObject(
      {
        ok: false,
        errno: 'EINTR',
      }
    );
    pending = false;
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.CHLD), ignored: 0 });
    const waiting = p.syscall({ op: 'fd-select', read: [3], write: [], timeoutMs: -1 });
    await Promise.resolve();
    p.signal(SIG.CHLD);
    expect(await waiting).toMatchObject({ ok: false, errno: 'EINTR' });
  });

  it('a read that would block also yields to a pending signal; a ready one does not', async () => {
    const fds = table();
    const p = new WasmProcess(1, fds, { hasPending: () => true });
    expect(await p.syscall({ op: 'fd-read', fd: 3, max: 4 })).toMatchObject({ errno: 'EINTR' });
    expect(await p.syscall({ op: 'fd-read', fd: 6, max: 4 })).toMatchObject({ ok: true });
  });

  it('a write with a signal pending takes what fits and returns the short count', async () => {
    const fds = new FdTable();
    const pipe = openPipe(4);
    fds.installAt(3, pipe.read);
    fds.installAt(4, pipe.write);
    const p = new WasmProcess(1, fds, { hasPending: () => true });
    expect(await p.syscall({ op: 'fd-write', fd: 4, body: bytes('abcdef') })).toEqual({
      ok: true,
      kind: 'json',
      json: 4,
    });
  });

  it('detaches from the interrupt signal when it returns', async () => {
    const interrupt = new AbortController();
    const add = vi.spyOn(interrupt.signal, 'addEventListener');
    const remove = vi.spyOn(interrupt.signal, 'removeEventListener');
    expect(await selectFds(table(), [3], [], 5, interrupt.signal)).toEqual({ read: [], write: [] });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});
