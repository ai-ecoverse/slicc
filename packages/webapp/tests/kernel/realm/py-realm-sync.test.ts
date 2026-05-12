/**
 * Direct tests for the VFS↔Pyodide sync helpers in
 * `py-realm-shared.ts`. These pin the bulk-RPC contract introduced
 * in the perf fix (commit b85583bb): pre-sync issues one
 * `vfs.walkTree` per dir and returns a size snapshot; post-sync
 * walks the Pyodide FS, diffs against the snapshot, and emits a
 * single `vfs.writeBatch` containing only new/changed files.
 *
 * Naive per-file `readDir`/`stat`/`readFile` chatter took minutes
 * on workspace-sized cwds; we want to know if anyone reintroduces
 * it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PyodideInterface } from 'pyodide';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { syncVfsToPyodide, syncPyodideToVfs } from '../../../src/kernel/realm/py-realm-shared.js';

interface WalkEntry {
  path: string;
  isDir: boolean;
  size?: number;
  content?: string;
}

interface WriteBatchPayload {
  mkdirs?: string[];
  files?: Array<{ path: string; content: string }>;
}

interface RpcInvocation {
  channel: string;
  op: string;
  args: unknown[];
}

function makeRpc(responses: Map<string, unknown> | ((inv: RpcInvocation) => unknown)): {
  rpc: RealmRpcClient;
  calls: RpcInvocation[];
} {
  const calls: RpcInvocation[] = [];
  const lookup = (inv: RpcInvocation): unknown => {
    if (typeof responses === 'function') return responses(inv);
    return responses.get(`${inv.channel}.${inv.op}:${JSON.stringify(inv.args)}`);
  };
  const rpc = {
    call: vi.fn(async (channel: string, op: string, args: unknown[] = []) => {
      const inv = { channel, op, args };
      calls.push(inv);
      return lookup(inv);
    }),
    dispose: vi.fn(),
  };
  return { rpc: rpc as unknown as RealmRpcClient, calls };
}

/**
 * Tiny stand-in for `pyodide.FS` covering exactly what the sync
 * code touches: `stat`, `mkdirTree`, `writeFile`, `readdir`,
 * `readFile`, `isDir`, `isFile`. Backed by a plain Map so tests
 * can seed and inspect state directly.
 */
function makeFakePyodide(): {
  pyodide: PyodideInterface;
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const DIR_MODE = 0o40000;
  const FILE_MODE = 0o100000;
  const FS = {
    stat: (path: string): { mode: number; size: number } => {
      if (dirs.has(path)) return { mode: DIR_MODE, size: 0 };
      if (files.has(path)) return { mode: FILE_MODE, size: files.get(path)!.length };
      throw Object.assign(new Error(`ENOENT: ${path}`), { errno: 44 });
    },
    mkdirTree: (path: string): void => {
      let cursor = '';
      for (const part of path.split('/').filter(Boolean)) {
        cursor += '/' + part;
        dirs.add(cursor);
      }
      dirs.add('/');
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      const str = typeof content === 'string' ? content : new TextDecoder().decode(content);
      files.set(path, str);
      const slash = path.lastIndexOf('/');
      if (slash > 0) FS.mkdirTree(path.slice(0, slash));
    },
    readFile: (path: string): Uint8Array => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(content);
    },
    readdir: (path: string): string[] => {
      if (!dirs.has(path)) throw new Error(`ENOENT: ${path}`);
      const out = new Set<string>(['.', '..']);
      const prefix = path === '/' ? '/' : `${path}/`;
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === path) continue;
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...out];
    },
    isDir: (mode: number): boolean => (mode & 0o170000) === DIR_MODE,
    isFile: (mode: number): boolean => (mode & 0o170000) === FILE_MODE,
    chdir: vi.fn(),
  };
  return {
    pyodide: { FS } as unknown as PyodideInterface,
    files,
    dirs,
  };
}

describe('syncVfsToPyodide (bulk walkTree)', () => {
  it('issues exactly one walkTree RPC per syncDir — not per file', async () => {
    const walkResults = new Map<string, WalkEntry[]>([
      [
        '/workspace',
        [
          { path: '/workspace/a.txt', isDir: false, size: 1, content: 'A' },
          { path: '/workspace/sub', isDir: true },
          { path: '/workspace/sub/b.txt', isDir: false, size: 2, content: 'BB' },
        ],
      ],
      ['/tmp', []],
    ]);
    const { rpc, calls } = makeRpc((inv) => {
      if (inv.channel === 'vfs' && inv.op === 'walkTree') {
        return walkResults.get(inv.args[0] as string) ?? [];
      }
      throw new Error(`unexpected RPC: ${inv.channel}.${inv.op}`);
    });
    const { pyodide, files } = makeFakePyodide();

    const snapshot = await syncVfsToPyodide(rpc, pyodide, ['/workspace', '/tmp']);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.op === 'walkTree')).toBe(true);
    expect(files.get('/workspace/a.txt')).toBe('A');
    expect(files.get('/workspace/sub/b.txt')).toBe('BB');
    expect(snapshot.get('/workspace/a.txt')).toBe(1);
    expect(snapshot.get('/workspace/sub/b.txt')).toBe(2);
  });

  it('caps content with a maxFileBytes hint passed to walkTree', async () => {
    const { rpc, calls } = makeRpc((_inv) => []);
    const { pyodide } = makeFakePyodide();
    await syncVfsToPyodide(rpc, pyodide, ['/workspace']);
    const walk = calls.find((c) => c.op === 'walkTree')!;
    const opts = walk.args[1] as { maxFileBytes?: number };
    expect(opts).toBeTruthy();
    expect(opts.maxFileBytes).toBeGreaterThanOrEqual(1024 * 1024); // at least 1MB
    expect(opts.maxFileBytes).toBeLessThanOrEqual(100 * 1024 * 1024); // sanity
  });

  it('skips entries with no content (over-the-cap files) so Pyodide sees the dir layout without a corrupt body', async () => {
    const { rpc } = makeRpc((_inv) => [
      { path: '/workspace/big.bin', isDir: false, size: 50_000_000 /* no content */ },
      { path: '/workspace/small.txt', isDir: false, size: 2, content: 'OK' },
    ]);
    const { pyodide, files } = makeFakePyodide();
    const snapshot = await syncVfsToPyodide(rpc, pyodide, ['/workspace']);
    expect(files.has('/workspace/big.bin')).toBe(false);
    expect(files.get('/workspace/small.txt')).toBe('OK');
    expect(snapshot.has('/workspace/big.bin')).toBe(false);
    expect(snapshot.get('/workspace/small.txt')).toBe(2);
  });

  it('tolerates an RPC rejection on one dir and still syncs the others', async () => {
    const { rpc } = makeRpc((inv) => {
      if (inv.channel === 'vfs' && inv.op === 'walkTree') {
        if (inv.args[0] === '/missing') throw new Error('ENOENT');
        return [{ path: '/tmp/x', isDir: false, size: 1, content: 'X' }];
      }
    });
    const { pyodide, files } = makeFakePyodide();
    const snapshot = await syncVfsToPyodide(rpc, pyodide, ['/missing', '/tmp']);
    expect(files.get('/tmp/x')).toBe('X');
    expect(snapshot.get('/tmp/x')).toBe(1);
  });
});

describe('syncPyodideToVfs (diff-only writeBatch)', () => {
  it('writes nothing when no files changed between pre- and post-execution', async () => {
    const { rpc, calls } = makeRpc(new Map());
    const { pyodide } = makeFakePyodide();
    pyodide.FS.writeFile('/workspace/a.txt', 'A');
    const snapshot = new Map<string, number>([['/workspace/a.txt', 1]]);

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    // No writeBatch at all when nothing changed.
    expect(calls.find((c) => c.op === 'writeBatch')).toBeUndefined();
  });

  it('emits exactly one writeBatch carrying only new + size-changed files', async () => {
    const written: WriteBatchPayload[] = [];
    const { rpc, calls } = makeRpc((inv) => {
      if (inv.channel === 'vfs' && inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return true;
      }
    });

    const { pyodide } = makeFakePyodide();
    // Pre-existing files, captured in the snapshot.
    pyodide.FS.writeFile('/workspace/unchanged.txt', 'same'); // 4 bytes
    pyodide.FS.writeFile('/workspace/edited.txt', 'old'); // 3 bytes
    const snapshot = new Map<string, number>([
      ['/workspace/unchanged.txt', 4],
      ['/workspace/edited.txt', 3],
    ]);
    // Now the agent's Python writes — one new, one resized.
    pyodide.FS.writeFile('/workspace/edited.txt', 'longer-edit'); // 11 bytes
    pyodide.FS.writeFile('/workspace/new.txt', 'created');

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    const batches = calls.filter((c) => c.op === 'writeBatch');
    expect(batches).toHaveLength(1);
    expect(written[0].files?.map((f) => f.path).sort()).toEqual([
      '/workspace/edited.txt',
      '/workspace/new.txt',
    ]);
    expect(written[0].files?.find((f) => f.path === '/workspace/edited.txt')?.content).toBe(
      'longer-edit'
    );
    expect(written[0].files?.find((f) => f.path === '/workspace/new.txt')?.content).toBe('created');
  });

  it('includes brand-new directories in writeBatch.mkdirs', async () => {
    const written: WriteBatchPayload[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return true;
      }
    });
    const { pyodide } = makeFakePyodide();
    const snapshot = new Map<string, number>();
    pyodide.FS.mkdirTree('/workspace/new-dir');
    pyodide.FS.writeFile('/workspace/new-dir/hello.txt', 'hi');

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    expect(written[0].mkdirs).toContain('/workspace/new-dir');
    expect(written[0].files?.[0].path).toBe('/workspace/new-dir/hello.txt');
  });

  it('does not regress same-size content changes through (documented trade-off)', async () => {
    // Same byte count → diff says nothing changed. This is the
    // intentional perf trade in the design; if it ever flips to
    // hash-based diffing the test should be updated, not deleted.
    const written: WriteBatchPayload[] = [];
    const { rpc, calls } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return true;
      }
    });
    const { pyodide } = makeFakePyodide();
    pyodide.FS.writeFile('/workspace/notes.txt', 'abc');
    const snapshot = new Map<string, number>([['/workspace/notes.txt', 3]]);
    pyodide.FS.writeFile('/workspace/notes.txt', 'XYZ'); // same length, different bytes

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    expect(calls.find((c) => c.op === 'writeBatch')).toBeUndefined();
    expect(written).toHaveLength(0);
  });
});
