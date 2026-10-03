import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  FdTable,
  KernelError,
  kernelFdKind,
  nullFile,
  OpenFile,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('FdTable', () => {
  it('keeps FD_CLOEXEC per fd: set on an open fd, dropped when the fd is reused, copied on fork', async () => {
    const t = new FdTable();
    expect(() => t.setCloseOnExec(4)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    t.installAt(4, nullFile());
    t.installAt(5, nullFile());
    t.setCloseOnExec(4);
    t.setCloseOnExec(5);
    expect([t.closesOnExec(4), t.closesOnExec(5), t.closesOnExec(6)]).toEqual([true, true, false]);
    expect(t.fork().closesOnExec(4)).toBe(true);
    t.installAt(4, nullFile()); // dup2 over it: a new fd
    await t.close(5);
    expect(t.install(nullFile(), 5)).toBe(5);
    expect([t.closesOnExec(4), t.closesOnExec(5)]).toEqual([false, false]);
    t.setStatusFlags(4, 0o4000);
    expect(t.fork().statusFlags(4)).toBe(0o4000);
    t.installAt(4, nullFile());
    expect(t.statusFlags(4)).toBeUndefined();
    t.setCloseOnExec(4);
    t.setStatusFlags(4, 0o4000);
    await t.closeAll();
    t.installAt(4, nullFile());
    expect([t.closesOnExec(4), t.statusFlags(4)]).toEqual([false, undefined]);
  });

  it('closeAll releases every description even when a writeback fails', async () => {
    const t = new FdTable();
    const closed: string[] = [];
    t.installAt(3, new OpenFile({ close: () => Promise.reject(new KernelError('EIO')) }));
    t.installAt(4, new OpenFile({ close: () => void closed.push('4') }));
    await expect(t.closeAll()).resolves.toBeUndefined();
    expect(closed).toEqual(['4']);
  });

  it('names how a runtime backs a descriptor', () => {
    expect(kernelFdKind(nullFile().file)).toBe('stream');
    expect(kernelFdKind({ seek: async () => 0, close() {} })).toBe('file');
    expect(kernelFdKind({ tty: {} as never, seek: async () => 0, close() {} })).toBe('tty');
  });

  it('installs at the lowest free fd', async () => {
    const t = new FdTable();
    expect(t.install(nullFile())).toBe(0);
    expect(t.install(nullFile())).toBe(1);
    await t.close(0);
    expect(t.install(nullFile())).toBe(0);
    expect(t.install(nullFile(), 10)).toBe(10);
  });

  it('reports EBADF for a closed or unknown fd', () => {
    const t = new FdTable();
    expect(() => t.get(3)).toThrow(KernelError);
    expect(() => t.close(3)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('dup2 shares a description; the pipe stays open until the last fd closes', async () => {
    const t = new FdTable();
    const { read, write } = openPipe();
    const r = t.install(read, 3);
    const w = t.install(write, 3);
    t.dup2(w, 1); // like `>&` in a child: stdout is the pipe
    await t.close(w);
    await t.get(1).file.write?.(bytes('via fd 1'));
    expect(text(await t.get(r).file.read!(64))).toBe('via fd 1');
    await t.close(1); // the last write end
    expect(await t.get(r).file.read!(64)).toHaveLength(0);
  });

  it('dup2 onto an open fd closes what was there', async () => {
    const t = new FdTable();
    const { read, write } = openPipe();
    const r = t.install(read);
    t.installAt(1, write);
    t.dup2(r, 1); // replace the only write end with the read end
    expect(await t.get(r).file.read!(8)).toHaveLength(0); // EOF: no writer left
  });

  it('a forked table holds its own references', async () => {
    const parent = new FdTable();
    const { read, write } = openPipe();
    const r = parent.install(read);
    const w = parent.install(write);
    const child = parent.fork();
    await parent.close(w); // the parent keeps only the read end
    await child.get(w).file.write?.(bytes('from child'));
    await child.closeAll(); // child exit closes its write end: now EOF
    expect(text(await parent.get(r).file.read!(64))).toBe('from child');
    expect(await parent.get(r).file.read!(64)).toHaveLength(0);
  });

  it('a pipe write with no reader left is EPIPE', async () => {
    const t = new FdTable();
    const { read, write } = openPipe();
    const r = t.install(read);
    const w = t.install(write);
    await t.close(r);
    await expect(t.get(w).file.write!(bytes('x'))).rejects.toMatchObject({ code: 'EPIPE' });
  });

  it('bytesSource serves its data once, sinkFile collects writes', async () => {
    const src = bytesSource(bytes('abc'));
    expect(text(await src.file.read!(2))).toBe('ab');
    expect(text(await src.file.read!(2))).toBe('c');
    expect(await src.file.read!(2)).toHaveLength(0);
    const got: string[] = [];
    const sink = sinkFile((b) => got.push(text(b)));
    await sink.file.write!(bytes('out'));
    expect(got).toEqual(['out']);
  });

  it('closeAll releases every description', async () => {
    const t = new FdTable();
    const { read, write } = openPipe();
    const other = new FdTable();
    const r = other.install(read);
    t.install(write);
    t.dup(0);
    await t.closeAll();
    expect(await other.get(r).file.read!(8)).toHaveLength(0);
  });
});
