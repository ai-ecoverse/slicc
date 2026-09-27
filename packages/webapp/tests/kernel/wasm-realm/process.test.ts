import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  FdTable,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { isWasmSyscall, WasmProcess } from '../../../src/kernel/wasm-realm/process.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function stdio(stdin: string, out: string[]): FdTable {
  const t = new FdTable();
  t.install(bytesSource(bytes(stdin)));
  t.install(sinkFile((b) => out.push(text(b))));
  t.install(sinkFile((b) => out.push(`err:${text(b)}`)));
  return t;
}

describe('WasmProcess syscalls', () => {
  it('reads stdin, writes stdout, and reports EOF as empty bytes', async () => {
    const out: string[] = [];
    const p = new WasmProcess(2000, stdio('in', out));
    const r1 = await p.syscall({ op: 'fd-read', fd: 0, max: 64 });
    expect(r1.ok && r1.kind === 'bytes' && text(r1.bytes)).toBe('in');
    const r2 = await p.syscall({ op: 'fd-read', fd: 0, max: 64 });
    expect(r2.ok && r2.kind === 'bytes' && r2.bytes.length).toBe(0);
    const w = await p.syscall({ op: 'fd-write', fd: 1, body: bytes('out') });
    expect(w).toEqual({ ok: true, kind: 'json', json: 3 });
    await p.syscall({ op: 'fd-write', fd: 2, body: bytes('oops') });
    expect(out).toEqual(['out', 'err:oops']);
  });

  it('maps kernel errors to errnos: EBADF for a closed fd or the wrong direction', async () => {
    const p = new WasmProcess(2001, stdio('', []));
    expect(await p.syscall({ op: 'fd-write', fd: 0, body: bytes('x') })).toMatchObject({
      ok: false,
      errno: 'EBADF',
    });
    await p.syscall({ op: 'fd-close', fd: 1 });
    expect(await p.syscall({ op: 'fd-write', fd: 1, body: bytes('x') })).toMatchObject({
      ok: false,
      errno: 'EBADF',
    });
  });

  it('a write into a pipe whose reader is gone is EPIPE', async () => {
    const t = new FdTable();
    const { read, write } = openPipe();
    t.install(write);
    read.release();
    const p = new WasmProcess(2002, t);
    expect(await p.syscall({ op: 'fd-write', fd: 0, body: bytes('y\n') })).toMatchObject({
      ok: false,
      errno: 'EPIPE',
    });
  });

  it("exit releases the process's descriptors: a pipe reader sees EOF", async () => {
    const { read, write } = openPipe();
    const writerFds = new FdTable();
    writerFds.install(write);
    const writer = new WasmProcess(2003, writerFds);
    await writer.syscall({ op: 'fd-write', fd: 0, body: bytes('last') });
    writer.exit();
    writer.exit();
    expect(text(await read.file.read!(64))).toBe('last');
    expect(await read.file.read!(64)).toHaveLength(0);
  });

  it('tells process syscalls from sync-fs requests', () => {
    expect(isWasmSyscall({ op: 'fd-read' })).toBe(true);
    expect(isWasmSyscall({ op: 'read' })).toBe(false);
    expect(isWasmSyscall({})).toBe(false);
  });
});

describe('WasmProcess pipes and poll', () => {
  it('makes a kernel pipe above the stdio fds and reports readiness', async () => {
    const p = new WasmProcess(3000, stdio('', []));
    const made = await p.syscall({ op: 'fd-pipe' });
    expect(made).toEqual({ ok: true, kind: 'json', json: [3, 4] });
    const poll = async (fd: number) => {
      const r = await p.syscall({ op: 'fd-poll', fd });
      return r.ok && r.kind === 'json' ? r.json : r;
    };
    expect(await poll(3)).toEqual({ readable: false, writable: false, hangup: false });
    expect(await poll(4)).toEqual({ readable: false, writable: true, hangup: false });
    await p.syscall({ op: 'fd-write', fd: 4, body: bytes('x') });
    expect(await poll(3)).toMatchObject({ readable: true });
    await p.syscall({ op: 'fd-close', fd: 4 });
    expect(await poll(3)).toEqual({ readable: true, writable: false, hangup: true });

    expect(await poll(0)).toEqual({ readable: true, writable: false, hangup: false });
    expect(await poll(1)).toEqual({ readable: false, writable: true, hangup: false });
    expect(await p.syscall({ op: 'fd-poll', fd: 9 })).toMatchObject({ ok: false, errno: 'EBADF' });
  });
});
