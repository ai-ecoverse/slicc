import { describe, expect, it, vi } from 'vitest';
import {
  type ChildSpawner,
  ChildTable,
  SpawnError,
  waitStatus,
} from '../../../src/kernel/wasm-realm/children.js';
import { FdTable, OpenFile, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { WasmProcess } from '../../../src/kernel/wasm-realm/process.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const REQ = { file: 'tool', argv: ['tool'], env: {}, cwd: '/' };

function controllable() {
  const ends = new Map<number, (code: number) => void>();
  const tables: FdTable[] = [];
  let next = 100;
  const spawner: ChildSpawner = async (_req, fds) => {
    tables.push(fds);
    const pid = next++;
    return { pid, exited: new Promise<number>((resolve) => ends.set(pid, resolve)) };
  };
  return { spawner, ends, tables };
}

async function readAll(table: FdTable, fd: number): Promise<string> {
  return text(await table.get(fd).file.read!(64));
}

describe('ChildTable', () => {
  it("shares the parent's descriptors, hands over input, and opens /dev/null", async () => {
    const out: string[] = [];
    const parent = new FdTable();
    parent.installAt(
      1,
      sinkFile((b) => out.push(text(b)))
    );
    const { spawner, tables } = controllable();
    const children = new ChildTable(parent, spawner);
    await children.spawn(REQ, [{ input: bytes('in') }, { fd: 1 }, { none: true }]);
    const [child] = tables;
    expect(await readAll(child!, 0)).toBe('in');
    await child!.get(1).file.write!(bytes('shared'));
    expect(out).toEqual(['shared']);
    expect(await readAll(child!, 2)).toBe('');
  });

  it("inherits the parent's descriptors beyond 0-2 at the numbers asked for", async () => {
    const out: string[] = [];
    const parent = new FdTable();
    parent.installAt(
      7,
      sinkFile((b) => out.push(text(b)))
    );
    const { spawner, tables } = controllable();
    const children = new ChildTable(parent, spawner);

    await children.spawn(
      REQ,
      [{ none: true }],
      [
        { fd: 63, kernel: 7 },
        { fd: 1, kernel: 7 },
      ]
    );
    const [child] = tables;
    expect(child!.numbers()).toEqual([0, 63]);
    await child!.get(63).file.write!(bytes('via 63'));
    expect(out).toEqual(['via 63']);

    await parent.close(7);
    await child!.get(63).file.write!(bytes(' still'));
    expect(out).toEqual(['via 63', ' still']);
  });

  it('fails an inherited slot naming a closed parent descriptor with EBADF, releasing the rest', async () => {
    const { spawner } = controllable();
    const parent = new FdTable();
    const closed = vi.fn();
    parent.installAt(3, new OpenFile({ close: closed }));
    const children = new ChildTable(parent, spawner);
    await expect(
      children.spawn(
        REQ,
        [],
        [
          { fd: 3, kernel: 3 },
          { fd: 4, kernel: 9 },
        ]
      )
    ).rejects.toMatchObject({ code: 'EBADF' });
    await parent.close(3);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('waits for a given child or any, and honors nohang', async () => {
    const { spawner, ends } = controllable();
    const children = new ChildTable(new FdTable(), spawner);
    const a = await children.spawn(REQ, []);
    const b = await children.spawn(REQ, []);
    expect(await children.wait(-1, true)).toEqual([0, 0]);
    const waitingB = children.wait(b, false);
    ends.get(b)!(3);
    expect(await waitingB).toEqual([b, waitStatus(3)]);
    ends.get(a)!(0);
    expect(await children.wait(-1, false)).toEqual([a, 0]);
    await expect(children.wait(-1, false)).rejects.toMatchObject({ code: 'ECHILD' });
  });

  it('detaches from the interrupt signal once a wait is over', async () => {
    const { spawner, ends } = controllable();
    const children = new ChildTable(new FdTable(), spawner);
    const interrupt = new AbortController();
    const add = vi.spyOn(interrupt.signal, 'addEventListener');
    const remove = vi.spyOn(interrupt.signal, 'removeEventListener');
    const pid = await children.spawn(REQ, []);
    const waiting = children.wait(pid, false, interrupt.signal);
    ends.get(pid)!(0);
    expect(await waiting).toEqual([pid, 0]);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });

  it('returns an already exited child without waiting', async () => {
    const { spawner, ends } = controllable();
    const children = new ChildTable(new FdTable(), spawner);
    const pid = await children.spawn(REQ, []);
    ends.get(pid)!(1);
    await Promise.resolve();
    expect(await children.wait(-1, true)).toEqual([pid, waitStatus(1)]);
  });

  it('keeps captured output for the parent to collect once after the wait', async () => {
    const { spawner, ends, tables } = controllable();
    const children = new ChildTable(new FdTable(), spawner);
    const pid = await children.spawn(REQ, [{ none: true }, { capture: true }, { capture: true }]);
    await tables[0]!.get(1).file.write!(bytes('o1'));
    await tables[0]!.get(1).file.write!(bytes('o2'));
    await tables[0]!.get(2).file.write!(bytes('e'));
    ends.get(pid)!(0);
    await children.wait(pid, false);
    expect(text(children.captured(pid, 1))).toBe('o1o2');
    expect(text(children.captured(pid, 1))).toBe('');
    expect(text(children.captured(pid, 2))).toBe('e');
  });

  it('fails with ENOSYS without a spawner, and releases descriptors when spawning fails', async () => {
    const parent = new FdTable();
    const close = vi.fn();
    parent.installAt(1, new OpenFile({ write: async (b) => b.length, close }));
    await expect(new ChildTable(parent, undefined).spawn(REQ, [])).rejects.toMatchObject({
      code: 'ENOSYS',
    });
    const failing = new ChildTable(parent, async () => {
      throw new SpawnError('ENOENT');
    });
    await expect(failing.spawn(REQ, [{ none: true }, { fd: 1 }])).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await parent.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a slot naming a closed parent descriptor with EBADF', async () => {
    const { spawner } = controllable();
    const children = new ChildTable(new FdTable(), spawner);
    await expect(children.spawn(REQ, [{ fd: 5 }])).rejects.toMatchObject({ code: 'EBADF' });
  });
});

describe('WasmProcess child syscalls', () => {
  it('spawns, waits and collects captured output; errors are errnos', async () => {
    const { spawner, ends, tables } = controllable();
    const p = new WasmProcess(1, new FdTable(), { spawner });
    const spawned = await p.syscall({
      op: 'proc-spawn',
      ...REQ,
      stdio: [{ none: true }, { capture: true }],
    });
    expect(spawned).toEqual({ ok: true, kind: 'json', json: 100 });
    await tables[0]!.get(1).file.write!(bytes('hi'));
    ends.get(100)!(2);
    expect(await p.syscall({ op: 'proc-wait', pid: 100, nohang: false })).toEqual({
      ok: true,
      kind: 'json',
      json: [100, waitStatus(2)],
    });
    const captured = await p.syscall({ op: 'proc-captured', pid: 100, slot: 1 });
    expect(captured.ok && captured.kind === 'bytes' && text(captured.bytes)).toBe('hi');
    expect(await p.syscall({ op: 'proc-wait', pid: -1, nohang: false })).toMatchObject({
      ok: false,
      errno: 'ECHILD',
    });
    const none = new WasmProcess(2, new FdTable());
    expect(await none.syscall({ op: 'proc-spawn', ...REQ, stdio: [] })).toMatchObject({
      ok: false,
      errno: 'ENOSYS',
    });
  });
});

describe('fork', () => {
  const state = { memory: new Uint8Array(0), currData: 0, forkSp: 0, callStackNames: [], ppid: 1 };

  it("gives the child a copy of the parent's descriptor table and tracks it like a spawn", async () => {
    const out: string[] = [];
    const parent = new FdTable();
    parent.installAt(
      1,
      sinkFile((b) => out.push(text(b)))
    );
    parent.installAt(
      7,
      sinkFile((b) => out.push(`7:${text(b)}`))
    );
    let childFds!: FdTable;
    let end!: (code: number) => void;
    const forker = vi.fn(async (_state, fds: FdTable) => {
      childFds = fds;
      return { pid: 50, exited: new Promise<number>((resolve) => (end = resolve)) };
    });
    const p = new WasmProcess(1, parent, { forker });
    expect(await p.syscall({ op: 'proc-fork', state })).toEqual({
      ok: true,
      kind: 'json',
      json: 50,
    });
    expect(forker.mock.calls[0]![0]).toBe(state);
    await childFds.get(1).file.write!(bytes('from child'));
    await childFds.get(7).file.write!(bytes('x'));
    expect(out).toEqual(['from child', '7:x']);
    end(0);
    expect(await p.syscall({ op: 'proc-wait', pid: 50, nohang: false })).toEqual({
      ok: true,
      kind: 'json',
      json: [50, 0],
    });
  });

  it('fails with ENOSYS without a forker, and releases the copy when forking fails', async () => {
    expect(
      await new WasmProcess(1, new FdTable()).syscall({ op: 'proc-fork', state })
    ).toMatchObject({
      ok: false,
      errno: 'ENOSYS',
    });
    const close = vi.fn();
    const parent = new FdTable();
    parent.installAt(3, new OpenFile({ read: async () => new Uint8Array(0), close }));
    const failing = new WasmProcess(1, parent, {
      forker: async () => {
        throw new SpawnError('ENOENT');
      },
    });
    expect(await failing.syscall({ op: 'proc-fork', state })).toMatchObject({ errno: 'ENOENT' });
    await parent.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('VFS file syscalls', () => {
  it('hands a VFS file to the kernel and seeks its shared offset', async () => {
    const fs = {
      readFileBuffer: async () => bytes('0123456789'),
      writeFile: async () => {},
    };
    const p = new WasmProcess(1, new FdTable(), { fs });
    const opened = await p.syscall({ op: 'fd-open-vfs', path: '/f', flags: 0, position: 4 });
    expect(opened).toEqual({ ok: true, kind: 'json', json: 3 });
    const r = await p.syscall({ op: 'fd-read', fd: 3, max: 2 });
    expect(r.ok && r.kind === 'bytes' && text(r.bytes)).toBe('45');
    expect(await p.syscall({ op: 'fd-seek', fd: 3, offset: -1, whence: 2 })).toEqual({
      ok: true,
      kind: 'json',
      json: 9,
    });
    const none = new WasmProcess(2, new FdTable());
    expect(
      await none.syscall({ op: 'fd-open-vfs', path: '/f', flags: 0, position: 0 })
    ).toMatchObject({ errno: 'ENOSYS' });
    const pipe = await p.syscall({ op: 'fd-pipe' });
    const [readEnd] = (pipe.ok && pipe.kind === 'json' ? pipe.json : []) as number[];
    expect(await p.syscall({ op: 'fd-seek', fd: readEnd!, offset: 0, whence: 0 })).toMatchObject({
      errno: 'ESPIPE',
    });
  });

  it('keeps orphan contents across open-vfs and flushes writable files', async () => {
    const writes: string[] = [];
    const fs = {
      readFileBuffer: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async (_p: string, content: Uint8Array) => {
        writes.push(text(content));
      },
    };
    const p = new WasmProcess(1, new FdTable(), { fs });
    const opened = await p.syscall({
      op: 'fd-open-vfs',
      path: '/tmp/gone',
      flags: 2,
      position: 0,
      contents: bytes('live'),
      orphan: true,
    });
    expect(opened).toEqual({ ok: true, kind: 'json', json: 3 });
    const r = await p.syscall({ op: 'fd-read', fd: 3, max: 4 });
    expect(r.ok && r.kind === 'bytes' && text(r.bytes)).toBe('live');
    await p.exit();
    expect(writes).toEqual([]);

    const w = new WasmProcess(2, new FdTable(), { fs });
    await w.syscall({ op: 'fd-open-vfs', path: '/out', flags: 1, position: 0 });
    await w.syscall({ op: 'fd-write', fd: 3, body: bytes('done') });
    expect(await w.syscall({ op: 'fd-flush', fd: 3 })).toEqual({ ok: true, kind: 'void' });
    expect(writes).toEqual(['done']);
  });
});

describe('VFS files of one process (a threaded WASI process opens them all here)', () => {
  function memFs(files: Record<string, string>) {
    return {
      readFileBuffer: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return bytes(files[p]!);
      },
      writeFile: async (p: string, content: Uint8Array) => {
        files[p] = text(content);
      },
    };
  }
  const json = (r: Awaited<ReturnType<WasmProcess['syscall']>>) =>
    r.ok && r.kind === 'json' ? r.json : r;
  const O_RDWR = 2;

  it('two opens of a path share its bytes; pread and pwrite leave the offset; resize and size', async () => {
    const files: Record<string, string> = { '/f': 'hello' };
    const p = new WasmProcess(1, new FdTable(), { fs: memFs(files) });
    const a = json(await p.syscall({ op: 'fd-open-vfs', path: '/f', flags: O_RDWR, position: 0 }));
    const b = json(await p.syscall({ op: 'fd-open-vfs', path: '/f', flags: 0, position: 0 }));
    expect(
      json(await p.syscall({ op: 'fd-pwrite', fd: a as number, offset: 5, body: bytes(' world') }))
    ).toBe(6);
    const r = await p.syscall({ op: 'fd-pread', fd: b as number, offset: 6, max: 100 });
    expect(r.ok && r.kind === 'bytes' && text(r.bytes)).toBe('world');
    expect(json(await p.syscall({ op: 'fd-seek', fd: a as number, offset: 0, whence: 1 }))).toBe(0);
    await p.syscall({ op: 'fd-resize', fd: a as number, size: 8 });
    expect(json(await p.syscall({ op: 'fd-vfs-stat', fd: b as number }))).toEqual({
      path: '/f',
      size: 8,
    });

    expect(
      await p.syscall({ op: 'fd-pwrite', fd: b as number, offset: 0, body: bytes('x') })
    ).toMatchObject({ errno: 'EBADF' });
    const pipe = json(await p.syscall({ op: 'fd-pipe' })) as number[];
    expect(await p.syscall({ op: 'fd-pread', fd: pipe[0]!, offset: 0, max: 1 })).toMatchObject({
      errno: 'ESPIPE',
    });
    await p.exit();
    expect(files['/f']).toBe('hello wo');
  });

  it('an unlinked file keeps its bytes and is never written back; a renamed one follows its path', async () => {
    const files: Record<string, string> = { '/tmp/scratch': 'kept', '/a': 'A', '/b': 'B' };
    const p = new WasmProcess(1, new FdTable(), { fs: memFs(files) });
    const scratch = json(
      await p.syscall({ op: 'fd-open-vfs', path: '/tmp/scratch', flags: O_RDWR, position: 0 })
    ) as number;
    await p.syscall({ op: 'fd-path-unlinking', path: '/tmp/scratch' });
    delete files['/tmp/scratch'];
    await p.syscall({ op: 'fd-path-unlinked', path: '/tmp/scratch' });
    await p.syscall({ op: 'fd-write', fd: scratch, body: bytes('!') });
    const r = await p.syscall({ op: 'fd-pread', fd: scratch, offset: 0, max: 10 });
    expect(r.ok && r.kind === 'bytes' && text(r.bytes)).toBe('!ept');
    expect(json(await p.syscall({ op: 'fd-vfs-stat', fd: scratch }))).toEqual({
      path: '/tmp/scratch',
      size: 4,
      orphan: true,
    });

    const a = json(
      await p.syscall({ op: 'fd-open-vfs', path: '/a', flags: O_RDWR, position: 1 })
    ) as number;
    const b = json(
      await p.syscall({ op: 'fd-open-vfs', path: '/b', flags: O_RDWR, position: 1 })
    ) as number;
    await p.syscall({ op: 'fd-write', fd: a, body: bytes('a') });
    await p.syscall({ op: 'fd-write', fd: b, body: bytes('b') });

    files['/b'] = files['/a']!;
    delete files['/a'];
    await p.syscall({ op: 'fd-path-renamed', from: '/a', to: '/b' });
    expect(json(await p.syscall({ op: 'fd-vfs-stat', fd: a }))).toEqual({ path: '/b', size: 2 });
    await p.exit();
    expect(files).toEqual({ '/b': 'Aa' });
  });

  it('flushes what is open at or beneath a path, for a stat of it', async () => {
    const files: Record<string, string> = {};
    const p = new WasmProcess(1, new FdTable(), { fs: memFs(files) });
    const fd = json(
      await p.syscall({ op: 'fd-open-vfs', path: '/d/new', flags: 1, position: 0, truncate: true })
    ) as number;
    await p.syscall({ op: 'fd-write', fd, body: bytes('data') });
    await p.syscall({ op: 'fd-path-flush', path: '/d' });
    expect(files).toEqual({ '/d/new': 'data' });
  });
});

describe('death by signal', () => {
  it('reports a child a signal ended as WIFSIGNALED, else its exit code', async () => {
    let end!: (code: number) => void;
    let sig: number | undefined;
    const spawner: ChildSpawner = async () => ({
      pid: 60,
      exited: new Promise<number>((resolve) => (end = resolve)),
      termsig: () => sig,
    });
    const children = new ChildTable(new FdTable(), spawner);
    await children.spawn(REQ, []);
    sig = SIG_INT;
    end(130);
    expect(await children.wait(60, false)).toEqual([60, SIG_INT]);
    expect(waitStatus(3)).toBe(3 << 8);
    expect(waitStatus(130, 2)).toBe(2);
  });

  it("a process that exec'd a program a signal ended reports that signal", async () => {
    let end!: (code: number) => void;
    const spawner: ChildSpawner = async () => ({
      pid: 61,
      exited: new Promise<number>((resolve) => (end = resolve)),
      termsig: () => SIG_INT,
    });
    const p = new WasmProcess(1, new FdTable(), { spawner });
    await p.syscall({ op: 'proc-spawn', ...REQ, stdio: [] });
    const execing = p.syscall({ op: 'proc-exec', pid: 61 });
    end(130);
    expect(await execing).toEqual({ ok: true, kind: 'json', json: [61, SIG_INT] });
    expect(p.execTermsig).toBe(SIG_INT);
  });
});

const SIG_INT = 2;
