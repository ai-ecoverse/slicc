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
    parent.closeAll();
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
    const p = new WasmProcess(1, new FdTable(), spawner);
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
