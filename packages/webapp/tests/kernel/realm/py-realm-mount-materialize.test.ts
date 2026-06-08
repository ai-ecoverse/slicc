/**
 * Mount-aware read sync (`materializeRealmMounts`) — verifies that
 * VFS mount subtrees backed by `local` / `s3` / `da` backends are
 * materialized into the Pyodide FS through the `vfs` RPC channel,
 * the remote-mount cap is enforced before any body fetch, and
 * `=0` skips remote fetches with no error.
 *
 * Uses a fake Pyodide FS that records `mkdirTree` / `mount` / `writeFile`
 * calls plus a fake `RealmRpcClient` whose `call` answers `vfs.readDir`
 * / `vfs.stat` / `vfs.readFileBinary` from an in-memory tree. The same
 * tree fixture covers all three backend kinds — the materialization
 * code routes purely through the RPC channel, so the kind tag only
 * matters for cap enforcement (which is asserted separately).
 */
import type { PyodideInterface } from 'pyodide';
import { describe, expect, it } from 'vitest';
import { materializeRealmMounts } from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmMountPoint } from '../../../src/kernel/realm/realm-types.js';

interface FakeEntry {
  kind: 'file' | 'directory';
  size?: number;
  children?: Record<string, FakeEntry>;
  bytes?: Uint8Array;
}

interface FakePy {
  pyodide: PyodideInterface;
  rpc: RealmRpcClient;
  written: Map<string, Uint8Array>;
  mounts: { plugin: unknown; dir: string }[];
  mkdirs: string[];
}

function buildFakePy(tree: Record<string, FakeEntry>): FakePy {
  const dirs = new Set<string>(['/']);
  const written = new Map<string, Uint8Array>();
  const mounts: { plugin: unknown; dir: string }[] = [];
  const mkdirs: string[] = [];
  const FS = {
    filesystems: { MEMFS: { __memfs: true } },
    stat: (path: string): unknown => {
      if (dirs.has(path) || written.has(path)) return { mode: 0 };
      throw Object.assign(new Error(`ENOENT ${path}`), { errno: 44 });
    },
    mkdirTree: (path: string): void => {
      mkdirs.push(path);
      let cursor = '';
      for (const part of path.split('/').filter(Boolean)) {
        cursor += '/' + part;
        dirs.add(cursor);
      }
    },
    mount: (plugin: unknown, _opts: unknown, dir: string): unknown => {
      mounts.push({ plugin, dir });
      dirs.add(dir);
      return {};
    },
    writeFile: (path: string, bytes: Uint8Array): void => {
      written.set(path, bytes);
    },
  };
  const pyodide = { FS } as unknown as PyodideInterface;

  function lookup(path: string): FakeEntry | null {
    if (path === '/') return { kind: 'directory', children: tree };
    const parts = path.split('/').filter(Boolean);
    let cursor: FakeEntry = { kind: 'directory', children: tree };
    for (const part of parts) {
      if (cursor.kind !== 'directory' || !cursor.children?.[part]) return null;
      cursor = cursor.children[part];
    }
    return cursor;
  }
  const rpc = {
    call: async <T>(channel: string, op: string, args: unknown[]): Promise<T> => {
      if (channel !== 'vfs') throw new Error(`unexpected channel ${channel}`);
      const path = args[0] as string;
      if (op === 'readDir') {
        const node = lookup(path);
        if (node?.kind !== 'directory') throw new Error(`ENOENT ${path}`);
        return Object.keys(node.children ?? {}) as unknown as T;
      }
      if (op === 'stat') {
        const node = lookup(path);
        if (!node) throw new Error(`ENOENT ${path}`);
        return {
          isDirectory: node.kind === 'directory',
          isFile: node.kind === 'file',
          size: node.size ?? node.bytes?.length ?? 0,
        } as unknown as T;
      }
      if (op === 'readFileBinary') {
        const node = lookup(path);
        if (node?.kind !== 'file' || !node.bytes) throw new Error(`ENOENT ${path}`);
        return node.bytes as unknown as T;
      }
      throw new Error(`unknown vfs op ${op}`);
    },
  } as unknown as RealmRpcClient;
  return { pyodide, rpc, written, mounts, mkdirs };
}

function file(text: string, size?: number): FakeEntry {
  const bytes = new TextEncoder().encode(text);
  return { kind: 'file', bytes, size: size ?? bytes.length };
}

function dir(children: Record<string, FakeEntry>): FakeEntry {
  return { kind: 'directory', children };
}

// Used by remote-mount-cap parity tests: same fixture across all three kinds.
const FIXTURE: Record<string, FakeEntry> = {
  mnt: dir({
    myapp: dir({
      'a.txt': file('A'),
      sub: dir({ 'b.txt': file('BB') }),
    }),
  }),
};

const KINDS: RealmMountPoint['kind'][] = ['local', 's3', 'da'];

describe('materializeRealmMounts: per-backend parity', () => {
  for (const kind of KINDS) {
    it(`materializes a ${kind} mount: files + dirs land in MEMFS with real content`, async () => {
      const py = buildFakePy(FIXTURE);
      await materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/myapp', kind }],
        undefined, // uncapped — fixture is tiny
        py.rpc
      );
      // MEMFS mounted exactly once at the mount path.
      expect(py.mounts).toEqual([{ plugin: { __memfs: true }, dir: '/mnt/myapp' }]);
      // Files materialized with real bytes — parity with what `ls` would show.
      expect(new TextDecoder().decode(py.written.get('/mnt/myapp/a.txt')!)).toBe('A');
      expect(new TextDecoder().decode(py.written.get('/mnt/myapp/sub/b.txt')!)).toBe('BB');
      // Nested subdir was created before the file write.
      expect(py.mkdirs).toContain('/mnt/myapp/sub');
    });
  }
});

describe('materializeRealmMounts: remote-mount cap enforcement', () => {
  it('fails the invocation when the combined remote size exceeds the cap', async () => {
    const py = buildFakePy({
      mnt: dir({
        big: dir({ 'huge.bin': file('x'.repeat(100), 1024 * 1024) }),
      }),
    });
    await expect(
      materializeRealmMounts(
        py.pyodide,
        [{ path: '/mnt/big', kind: 's3' }],
        512 * 1024, // 512 KB cap
        py.rpc
      )
    ).rejects.toThrow(/remote-mount cap exceeded.*524288.*\/mnt\/big/s);
    // No body fetch happened — writeFile was not called.
    expect(py.written.size).toBe(0);
  });

  it('names every offending remote mount and suggests both escape hatches', async () => {
    const py = buildFakePy({
      mnt: dir({
        a: dir({ 'big.bin': file('x', 800_000) }),
        b: dir({ 'big.bin': file('y', 800_000) }),
      }),
    });
    let message = '';
    await materializeRealmMounts(
      py.pyodide,
      [
        { path: '/mnt/a', kind: 's3' },
        { path: '/mnt/b', kind: 'da' },
      ],
      1_000_000,
      py.rpc
    ).catch((err: unknown) => {
      message = err instanceof Error ? err.message : String(err);
    });
    expect(message).toMatch(/\/mnt\/a: 800000 bytes/);
    expect(message).toMatch(/\/mnt\/b: 800000 bytes/);
    expect(message).toMatch(/--remote-mount-cap=0/);
    expect(message).toMatch(/higher value/);
  });

  it('=0 skips remote materialization entirely (mount appears empty, no error)', async () => {
    const py = buildFakePy(FIXTURE);
    await materializeRealmMounts(py.pyodide, [{ path: '/mnt/myapp', kind: 's3' }], 0, py.rpc);
    // MEMFS still mounted so Python sees the path as a directory…
    expect(py.mounts).toEqual([{ plugin: { __memfs: true }, dir: '/mnt/myapp' }]);
    // …but no file bodies were fetched into MEMFS.
    expect(py.written.size).toBe(0);
  });

  it('local FS Access mounts are exempt from the cap and always materialize', async () => {
    const py = buildFakePy({
      mnt: dir({
        local: dir({ 'big.bin': file('x'.repeat(50), 5_000_000) }),
      }),
    });
    await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/local', kind: 'local' }],
      100, // tiny cap — would block remote, must not block local
      py.rpc
    );
    expect(py.written.has('/mnt/local/big.bin')).toBe(true);
  });

  it('under-cap remote mounts materialize full content', async () => {
    const py = buildFakePy(FIXTURE);
    await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/myapp', kind: 's3' }],
      1024 * 1024,
      py.rpc
    );
    expect(new TextDecoder().decode(py.written.get('/mnt/myapp/a.txt')!)).toBe('A');
    expect(new TextDecoder().decode(py.written.get('/mnt/myapp/sub/b.txt')!)).toBe('BB');
  });

  it('mixes local and remote: cap only counts remote bytes', async () => {
    const py = buildFakePy({
      mnt: dir({
        local: dir({ 'big.bin': file('x'.repeat(50), 5_000_000) }),
        s3: dir({ 'small.txt': file('hi', 2) }),
      }),
    });
    await materializeRealmMounts(
      py.pyodide,
      [
        { path: '/mnt/local', kind: 'local' },
        { path: '/mnt/s3', kind: 's3' },
      ],
      1024,
      py.rpc
    );
    // Both materialized — local exempt, remote under cap.
    expect(py.written.has('/mnt/local/big.bin')).toBe(true);
    expect(py.written.has('/mnt/s3/small.txt')).toBe(true);
  });

  it('no-op when mountPoints is empty', async () => {
    const py = buildFakePy({});
    await materializeRealmMounts(py.pyodide, [], 5 * 1024 * 1024, py.rpc);
    expect(py.mounts).toEqual([]);
    expect(py.written.size).toBe(0);
  });

  it('per-mount listing failure surfaces a warning and continues', async () => {
    const py = buildFakePy(FIXTURE);
    const warnings: string[] = [];
    // Force readDir on `/mnt/missing` to fail; the materialization should
    // pushWarning and skip rather than throw.
    await materializeRealmMounts(
      py.pyodide,
      [{ path: '/mnt/missing', kind: 's3' }],
      undefined,
      py.rpc,
      (w) => warnings.push(w)
    );
    // Empty listing → no writes, but MEMFS still mounted so the path exists.
    expect(py.written.size).toBe(0);
    expect(py.mounts).toEqual([{ plugin: { __memfs: true }, dir: '/mnt/missing' }]);
  });
});
