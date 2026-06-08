/**
 * Mount write-back (`flushRealmMountWriteBack`) — verifies that any
 * file modifications made under a VFS mount subtree inside the
 * Pyodide MEMFS are routed back through the `vfs` RPC channel
 * (`writeFileBinary` / `mkdir` / `rm`) and reach the source backend
 * (local / s3 / da) rather than the OPFS placeholder.
 *
 * Uses a fake Pyodide FS (recording MEMFS-shaped `readdir` / `stat`
 * / `readFile` plus the materialize writes) and a fake RPC client
 * that records every dispatched `vfs.*` write call. The same fixture
 * is used for materialize + diff: materialize seeds the snapshot,
 * the fake FS gets a manual mutation list applied between phases,
 * then flush diffs them and we assert the RPC traffic.
 */
import type { PyodideInterface } from 'pyodide';
import { describe, expect, it } from 'vitest';
import {
  flushRealmMountWriteBack,
  materializeRealmMounts,
} from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmMountPoint } from '../../../src/kernel/realm/realm-types.js';

const MODE_DIR = 0o040000;
const MODE_FILE = 0o100000;

interface FakeNode {
  type: 'file' | 'directory';
  bytes?: Uint8Array;
}

interface RpcCall {
  op: string;
  args: unknown[];
}

interface FakePy {
  pyodide: PyodideInterface;
  rpc: RealmRpcClient;
  rpcCalls: RpcCall[];
  /** In-memory FS state. Keys are absolute paths; '/' implicit. */
  fs: Map<string, FakeNode>;
  rpcWriteShouldFailFor?: Set<string>;
}

interface FixtureEntry {
  kind: 'file' | 'directory';
  bytes?: Uint8Array;
  children?: Record<string, FixtureEntry>;
}

function file(text: string): FixtureEntry {
  return { kind: 'file', bytes: new TextEncoder().encode(text) };
}

function dir(children: Record<string, FixtureEntry> = {}): FixtureEntry {
  return { kind: 'directory', children };
}

/** Build a FakePy with `backendTree` as the source-of-truth backend state. */
function buildFakePy(backendTree: Record<string, FixtureEntry> = {}): FakePy {
  const fsState = new Map<string, FakeNode>();
  fsState.set('/', { type: 'directory' });
  const rpcCalls: RpcCall[] = [];
  const fakePy: Partial<FakePy> = { fs: fsState, rpcCalls };

  const FS = {
    filesystems: { MEMFS: { __memfs: true } },
    stat: (path: string): { mode: number; size: number } => {
      const node = fsState.get(path);
      if (!node) {
        throw Object.assign(new Error(`ENOENT ${path}`), { errno: 44 });
      }
      return {
        mode: node.type === 'directory' ? MODE_DIR : MODE_FILE,
        size: node.bytes?.length ?? 0,
      };
    },
    isDir: (mode: number): boolean => (mode & 0o170000) === MODE_DIR,
    isFile: (mode: number): boolean => (mode & 0o170000) === MODE_FILE,
    mkdirTree: (path: string): void => {
      let cursor = '';
      for (const part of path.split('/').filter(Boolean)) {
        cursor += '/' + part;
        if (!fsState.has(cursor)) fsState.set(cursor, { type: 'directory' });
      }
      if (path === '/' && !fsState.has('/')) fsState.set('/', { type: 'directory' });
    },
    mount: (_plugin: unknown, _opts: unknown, dir: string): unknown => {
      if (!fsState.has(dir)) fsState.set(dir, { type: 'directory' });
      return {};
    },
    writeFile: (path: string, bytes: Uint8Array): void => {
      fsState.set(path, { type: 'file', bytes: new Uint8Array(bytes) });
    },
    readdir: (path: string): string[] => {
      if (!fsState.has(path) || fsState.get(path)!.type !== 'directory') {
        throw Object.assign(new Error(`ENOTDIR ${path}`), { errno: 54 });
      }
      const prefix = path === '/' ? '/' : path + '/';
      const out = new Set<string>();
      for (const key of fsState.keys()) {
        if (key === path || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return ['.', '..', ...out];
    },
    readFile: (path: string, opts: { encoding: 'binary' }): Uint8Array => {
      const node = fsState.get(path);
      if (node?.type !== 'file' || !node.bytes) {
        throw Object.assign(new Error(`ENOENT ${path}`), { errno: 44 });
      }
      if (opts.encoding !== 'binary') throw new Error('only binary encoding supported');
      return node.bytes;
    },
    chdir: (_path: string): void => {},
  };

  const pyodide = { FS } as unknown as PyodideInterface;

  function lookupBackend(path: string): FixtureEntry | null {
    if (path === '/') return { kind: 'directory', children: backendTree };
    const parts = path.split('/').filter(Boolean);
    let cursor: FixtureEntry = { kind: 'directory', children: backendTree };
    for (const part of parts) {
      if (cursor.kind !== 'directory' || !cursor.children?.[part]) return null;
      cursor = cursor.children[part];
    }
    return cursor;
  }

  const rpc = {
    call: async <T>(channel: string, op: string, args: unknown[]): Promise<T> => {
      if (channel !== 'vfs') throw new Error(`unexpected channel ${channel}`);
      rpcCalls.push({ op, args });
      const path = args[0] as string;
      if (op === 'readDir') {
        const node = lookupBackend(path);
        if (node?.kind !== 'directory') throw new Error(`ENOENT ${path}`);
        return Object.keys(node.children ?? {}) as unknown as T;
      }
      if (op === 'stat') {
        const node = lookupBackend(path);
        if (!node) throw new Error(`ENOENT ${path}`);
        return {
          isDirectory: node.kind === 'directory',
          isFile: node.kind === 'file',
          size: node.bytes?.length ?? 0,
        } as unknown as T;
      }
      if (op === 'readFileBinary') {
        const node = lookupBackend(path);
        if (node?.kind !== 'file' || !node.bytes) throw new Error(`ENOENT ${path}`);
        return node.bytes as unknown as T;
      }
      if (op === 'writeFileBinary' || op === 'mkdir' || op === 'rm') {
        if (fakePy.rpcWriteShouldFailFor?.has(path)) {
          throw new Error(`backend rejected ${op} ${path}`);
        }
        return true as unknown as T;
      }
      throw new Error(`unknown vfs op ${op}`);
    },
  } as unknown as RealmRpcClient;

  fakePy.pyodide = pyodide;
  fakePy.rpc = rpc;
  return fakePy as FakePy;
}

/** Mutate the in-memory FS as if Python had run between materialize and flush. */
function pyWriteFile(py: FakePy, path: string, text: string): void {
  // Ensure parent dirs.
  const parts = path.split('/').filter(Boolean);
  let cursor = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cursor += '/' + parts[i];
    if (!py.fs.has(cursor)) py.fs.set(cursor, { type: 'directory' });
  }
  py.fs.set(path, { type: 'file', bytes: new TextEncoder().encode(text) });
}

function pyMkdir(py: FakePy, path: string): void {
  py.fs.set(path, { type: 'directory' });
}

function pyRm(py: FakePy, path: string): void {
  // Remove the path and all descendants.
  const prefix = path + '/';
  for (const key of [...py.fs.keys()]) {
    if (key === path || key.startsWith(prefix)) py.fs.delete(key);
  }
}

function pickWriteCalls(calls: RpcCall[], op: 'writeFileBinary' | 'mkdir' | 'rm'): RpcCall[] {
  return calls.filter((c) => c.op === op);
}

const FIXTURE: Record<string, FixtureEntry> = {
  mnt: dir({
    myapp: dir({
      'a.txt': file('A'),
      sub: dir({ 'b.txt': file('BB') }),
    }),
  }),
};

const KINDS: RealmMountPoint['kind'][] = ['local', 's3', 'da'];

describe('flushRealmMountWriteBack: routes writes back through the vfs RPC channel', () => {
  for (const kind of KINDS) {
    it(`${kind}: modified file → vfs.writeFileBinary with new bytes`, async () => {
      const py = buildFakePy(FIXTURE);
      const snapshots = await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined,
        py.rpc
      );
      py.rpcCalls.length = 0; // ignore materialize reads
      // Python mutates a.txt
      pyWriteFile(py, '/mnt/myapp/a.txt', 'A-modified');
      await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
      const writes = pickWriteCalls(py.rpcCalls, 'writeFileBinary');
      expect(writes).toHaveLength(1);
      expect(writes[0].args[0]).toBe('/mnt/myapp/a.txt');
      expect(new TextDecoder().decode(writes[0].args[1] as Uint8Array)).toBe('A-modified');
      // No spurious deletes/mkdirs.
      expect(pickWriteCalls(py.rpcCalls, 'rm')).toHaveLength(0);
      expect(pickWriteCalls(py.rpcCalls, 'mkdir')).toHaveLength(0);
    });

    it(`${kind}: new file in existing dir → vfs.writeFileBinary; unchanged file is skipped`, async () => {
      const py = buildFakePy(FIXTURE);
      const snapshots = await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined,
        py.rpc
      );
      py.rpcCalls.length = 0;
      pyWriteFile(py, '/mnt/myapp/sub/c.txt', 'C');
      await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
      const writes = pickWriteCalls(py.rpcCalls, 'writeFileBinary');
      expect(writes).toHaveLength(1);
      expect(writes[0].args[0]).toBe('/mnt/myapp/sub/c.txt');
      // a.txt + sub/b.txt unchanged — not re-uploaded.
    });

    it(`${kind}: new directory → vfs.mkdir`, async () => {
      const py = buildFakePy(FIXTURE);
      const snapshots = await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined,
        py.rpc
      );
      py.rpcCalls.length = 0;
      pyMkdir(py, '/mnt/myapp/newdir');
      await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
      const mkdirs = pickWriteCalls(py.rpcCalls, 'mkdir');
      expect(mkdirs.map((c) => c.args[0])).toContain('/mnt/myapp/newdir');
    });

    it(`${kind}: removed file → vfs.rm of just the file`, async () => {
      const py = buildFakePy(FIXTURE);
      const snapshots = await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined,
        py.rpc
      );
      py.rpcCalls.length = 0;
      pyRm(py, '/mnt/myapp/a.txt');
      await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
      const rms = pickWriteCalls(py.rpcCalls, 'rm');
      expect(rms.map((c) => c.args[0])).toEqual(['/mnt/myapp/a.txt']);
    });

    it(`${kind}: removed subtree → single vfs.rm of the top-level dir (recursive)`, async () => {
      const py = buildFakePy(FIXTURE);
      const snapshots = await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined,
        py.rpc
      );
      py.rpcCalls.length = 0;
      pyRm(py, '/mnt/myapp/sub');
      await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
      const rms = pickWriteCalls(py.rpcCalls, 'rm').map((c) => c.args[0]);
      // Only the top of the removed subtree — descendants are not
      // individually rm'd to avoid spurious ENOENT noise after the
      // recursive parent rm cascades through them.
      expect(rms).toEqual(['/mnt/myapp/sub']);
    });
  }
});

describe('flushRealmMountWriteBack: backend rejections surface as warnings', () => {
  it('continues after a failed writeFileBinary and surfaces a stderr warning', async () => {
    const py = buildFakePy(FIXTURE);
    const snapshots = await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/myapp', kind: 's3' }],
      undefined,
      py.rpc
    );
    py.rpcCalls.length = 0;
    pyWriteFile(py, '/mnt/myapp/a.txt', 'A-modified');
    pyWriteFile(py, '/mnt/myapp/sub/b.txt', 'BB-modified');
    py.rpcWriteShouldFailFor = new Set(['/mnt/myapp/a.txt']);

    const warnings: string[] = [];
    await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc, (w) => warnings.push(w));

    // Both writes attempted; second succeeded.
    const writes = pickWriteCalls(py.rpcCalls, 'writeFileBinary').map((c) => c.args[0]);
    expect(writes).toEqual(expect.arrayContaining(['/mnt/myapp/a.txt', '/mnt/myapp/sub/b.txt']));
    // Failure surfaced as a warning naming the offending path.
    expect(warnings.some((w) => w.includes('/mnt/myapp/a.txt') && /write-back/.test(w))).toBe(true);
  });

  it('continues after a failed rm and surfaces a stderr warning', async () => {
    const py = buildFakePy(FIXTURE);
    const snapshots = await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/myapp', kind: 'da' }],
      undefined,
      py.rpc
    );
    py.rpcCalls.length = 0;
    pyRm(py, '/mnt/myapp/a.txt');
    py.rpcWriteShouldFailFor = new Set(['/mnt/myapp/a.txt']);

    const warnings: string[] = [];
    await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc, (w) => warnings.push(w));
    expect(warnings.some((w) => w.includes('/mnt/myapp/a.txt') && /remove/.test(w))).toBe(true);
  });
});

describe('flushRealmMountWriteBack: edge cases', () => {
  it('no-op when nothing changed: zero write/mkdir/rm calls', async () => {
    const py = buildFakePy(FIXTURE);
    const snapshots = await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/myapp', kind: 'local' }],
      undefined,
      py.rpc
    );
    py.rpcCalls.length = 0;
    await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
    expect(py.rpcCalls).toEqual([]);
  });

  it('cap=0 mount (empty MEMFS baseline): new writes still flush back to backend', async () => {
    // Snapshot is empty for skipped remote mounts; any write Python
    // makes is therefore "new" and routes through writeFileBinary.
    const py = buildFakePy(FIXTURE);
    const snapshots = await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/myapp', kind: 's3' }],
      0,
      py.rpc
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].files.size).toBe(0);
    py.rpcCalls.length = 0;
    pyWriteFile(py, '/mnt/myapp/output.bin', 'computed');
    await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
    const writes = pickWriteCalls(py.rpcCalls, 'writeFileBinary');
    expect(writes).toHaveLength(1);
    expect(writes[0].args[0]).toBe('/mnt/myapp/output.bin');
  });

  it('multiple mounts: each subtree diffed independently', async () => {
    const py = buildFakePy({
      mnt: dir({
        a: dir({ 'one.txt': file('1') }),
        b: dir({ 'two.txt': file('2') }),
      }),
    });
    const snapshots = await materializeRealmMounts(
      py.pyodide,
      [
        { path: '/mnt/a', kind: 'local' },
        { path: '/mnt/b', kind: 's3' },
      ],
      undefined,
      py.rpc
    );
    py.rpcCalls.length = 0;
    pyWriteFile(py, '/mnt/a/one.txt', 'one-new');
    pyRm(py, '/mnt/b/two.txt');
    await flushRealmMountWriteBack(py.pyodide, snapshots, py.rpc);
    const writes = pickWriteCalls(py.rpcCalls, 'writeFileBinary').map((c) => c.args[0]);
    const rms = pickWriteCalls(py.rpcCalls, 'rm').map((c) => c.args[0]);
    expect(writes).toEqual(['/mnt/a/one.txt']);
    expect(rms).toEqual(['/mnt/b/two.txt']);
  });

  it('empty snapshots: no work, no RPC traffic', async () => {
    const py = buildFakePy();
    await flushRealmMountWriteBack(py.pyodide, [], py.rpc);
    expect(py.rpcCalls).toEqual([]);
  });
});
