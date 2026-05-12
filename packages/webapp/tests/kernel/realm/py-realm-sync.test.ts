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
import {
  syncVfsToPyodide,
  syncPyodideToVfs,
  type PreSyncSnapshot,
} from '../../../src/kernel/realm/py-realm-shared.js';

function emptySnapshot(): PreSyncSnapshot {
  return { files: new Map(), dirs: new Set() };
}

function snapshotOfFiles(entries: Iterable<[string, number]>): PreSyncSnapshot {
  return { files: new Map(entries), dirs: new Set() };
}

type WalkEntry =
  | { path: string; isDir: true }
  | { path: string; isDir: false; size: number; content?: Uint8Array };

interface WriteBatchPayload {
  mkdirs?: string[];
  files?: Array<{ path: string; content: Uint8Array }>;
}

interface WriteBatchResult {
  ok: true;
  failedMkdirs: Array<{ path: string; error: string }>;
  failedFiles: Array<{ path: string; error: string }>;
}

const OK_BATCH: WriteBatchResult = { ok: true, failedMkdirs: [], failedFiles: [] };

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
  // Internally store bytes (Pyodide's FS is byte-oriented). `files`
  // is exposed as a string view for convenience in text-only tests;
  // the byte view is reachable via `pyodide.FS.readFile(path)` for
  // tests that need binary fidelity.
  const bytes = new Map<string, Uint8Array>();
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const DIR_MODE = 0o40000;
  const FILE_MODE = 0o100000;
  const FS = {
    stat: (path: string): { mode: number; size: number } => {
      if (dirs.has(path)) return { mode: DIR_MODE, size: 0 };
      if (bytes.has(path)) return { mode: FILE_MODE, size: bytes.get(path)!.length };
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
      const raw =
        typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
      bytes.set(path, raw);
      files.set(path, new TextDecoder().decode(raw));
      const slash = path.lastIndexOf('/');
      if (slash > 0) FS.mkdirTree(path.slice(0, slash));
    },
    readFile: (path: string): Uint8Array => {
      const raw = bytes.get(path);
      if (raw === undefined) throw new Error(`ENOENT: ${path}`);
      return raw;
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
    const enc = new TextEncoder();
    const walkResults = new Map<string, WalkEntry[]>([
      [
        '/workspace',
        [
          { path: '/workspace/a.txt', isDir: false, size: 1, content: enc.encode('A') },
          { path: '/workspace/sub', isDir: true },
          { path: '/workspace/sub/b.txt', isDir: false, size: 2, content: enc.encode('BB') },
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
    expect(snapshot.files.get('/workspace/a.txt')).toBe(1);
    expect(snapshot.files.get('/workspace/sub/b.txt')).toBe(2);
    // The snapshot records every directory pre-sync created /
    // touched so post-sync can tell "user mkdir'd this" apart
    // from "pre-sync mirrored it in" and skip the redundant
    // writeBatch.mkdirs entry.
    expect(snapshot.dirs.has('/workspace')).toBe(true);
    expect(snapshot.dirs.has('/workspace/sub')).toBe(true);
    expect(snapshot.dirs.has('/tmp')).toBe(true);
  });

  it('round-trips binary file content byte-for-byte (no TextEncoder/decode coercion)', async () => {
    // The previous string-typed walkTree mojibake'd any PNG / wheel
    // / sqlite file in cwd. With Uint8Array content the bytes hit
    // Pyodide's FS verbatim.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const { rpc } = makeRpc((_inv) => [
      { path: '/workspace/image.png', isDir: false, size: pngBytes.length, content: pngBytes },
    ]);
    const { pyodide } = makeFakePyodide();
    await syncVfsToPyodide(rpc, pyodide, ['/workspace']);
    // Assert via FS readFile directly for byte-fidelity (the fake
    // Pyodide's separate `files` view UTF-8 decodes for ergonomics).
    const stored = pyodide.FS.readFile('/workspace/image.png') as Uint8Array;
    expect(Array.from(stored)).toEqual(Array.from(pngBytes));
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
    const enc = new TextEncoder();
    const warnings: string[] = [];
    const { rpc } = makeRpc((_inv) => [
      { path: '/workspace/big.bin', isDir: false, size: 50_000_000 /* no content */ },
      { path: '/workspace/small.txt', isDir: false, size: 2, content: enc.encode('OK') },
    ]);
    const { pyodide, files } = makeFakePyodide();
    const snapshot = await syncVfsToPyodide(rpc, pyodide, ['/workspace'], (msg) =>
      warnings.push(msg)
    );
    expect(files.has('/workspace/big.bin')).toBe(false);
    expect(files.get('/workspace/small.txt')).toBe('OK');
    expect(snapshot.files.has('/workspace/big.bin')).toBe(false);
    expect(snapshot.files.get('/workspace/small.txt')).toBe(2);
    // The skip surfaces as a stderr warning so the user can
    // correlate Python's `FileNotFoundError` against the real cause.
    expect(warnings.some((w) => w.includes('/workspace/big.bin') && w.includes('cap'))).toBe(true);
  });

  it('tolerates an RPC rejection on one dir, surfaces it via warning, and still syncs the others', async () => {
    const enc = new TextEncoder();
    const warnings: string[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.channel === 'vfs' && inv.op === 'walkTree') {
        if (inv.args[0] === '/missing') throw new Error('ENOENT');
        return [{ path: '/tmp/x', isDir: false, size: 1, content: enc.encode('X') }];
      }
    });
    const { pyodide, files } = makeFakePyodide();
    const snapshot = await syncVfsToPyodide(rpc, pyodide, ['/missing', '/tmp'], (msg) =>
      warnings.push(msg)
    );
    expect(files.get('/tmp/x')).toBe('X');
    expect(snapshot.files.get('/tmp/x')).toBe(1);
    expect(warnings.some((w) => w.includes('/missing') && w.includes('ENOENT'))).toBe(true);
  });
});

describe('syncPyodideToVfs (diff-only writeBatch)', () => {
  it('writes nothing when no files changed between pre- and post-execution', async () => {
    const { rpc, calls } = makeRpc(new Map());
    const { pyodide } = makeFakePyodide();
    pyodide.FS.writeFile('/workspace/a.txt', 'A');
    const snapshot = snapshotOfFiles([['/workspace/a.txt', 1]]);

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    // No writeBatch at all when nothing changed.
    expect(calls.find((c) => c.op === 'writeBatch')).toBeUndefined();
  });

  it('emits exactly one writeBatch carrying only new + size-changed files', async () => {
    const written: WriteBatchPayload[] = [];
    const { rpc, calls } = makeRpc((inv) => {
      if (inv.channel === 'vfs' && inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return OK_BATCH;
      }
    });

    const { pyodide } = makeFakePyodide();
    // Pre-existing files, captured in the snapshot.
    pyodide.FS.writeFile('/workspace/unchanged.txt', 'same'); // 4 bytes
    pyodide.FS.writeFile('/workspace/edited.txt', 'old'); // 3 bytes
    const snapshot = snapshotOfFiles([
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
    const edited = written[0].files?.find((f) => f.path === '/workspace/edited.txt');
    const created = written[0].files?.find((f) => f.path === '/workspace/new.txt');
    expect(edited?.content).toBeInstanceOf(Uint8Array);
    expect(decode(edited!.content)).toBe('longer-edit');
    expect(decode(created!.content)).toBe('created');
  });

  it('round-trips binary file content byte-for-byte through writeBatch (no TextDecoder corruption)', async () => {
    // PIL writes PNG, numpy writes .npy: non-UTF-8 bytes that the
    // previous TextDecoder-based path silently corrupted into U+FFFD.
    const written: WriteBatchPayload[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return OK_BATCH;
      }
    });
    const { pyodide } = makeFakePyodide();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    pyodide.FS.writeFile('/workspace/out.png', pngBytes);

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], emptySnapshot());

    const persisted = written[0].files?.find((f) => f.path === '/workspace/out.png');
    expect(persisted?.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(persisted!.content)).toEqual(Array.from(pngBytes));
  });

  it('includes brand-new directories in writeBatch.mkdirs', async () => {
    const written: WriteBatchPayload[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return OK_BATCH;
      }
    });
    const { pyodide } = makeFakePyodide();
    const snapshot = emptySnapshot();
    pyodide.FS.mkdirTree('/workspace/new-dir');
    pyodide.FS.writeFile('/workspace/new-dir/hello.txt', 'hi');

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    expect(written[0].mkdirs).toContain('/workspace/new-dir');
    expect(written[0].files?.[0].path).toBe('/workspace/new-dir/hello.txt');
  });

  it('does NOT mkdir directories that pre-sync already populated (read-only mount safety)', async () => {
    // The whole point of the dirs snapshot: pre-sync mirrors VFS
    // directories (incl. read-only mounts like /proc) into Pyodide-FS.
    // Post-sync used to treat every dir it saw as new and emit
    // mkdir back to the read-only mount, flooding stderr with
    // EACCES warnings on every python invocation. The dirs snapshot
    // prevents that.
    const written: WriteBatchPayload[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return OK_BATCH;
      }
    });
    const { pyodide } = makeFakePyodide();
    pyodide.FS.mkdirTree('/proc/1');
    pyodide.FS.mkdirTree('/proc/1024');
    pyodide.FS.mkdirTree('/proc/self');
    const snapshot: PreSyncSnapshot = {
      files: new Map(),
      dirs: new Set(['/proc', '/proc/1', '/proc/1024', '/proc/self']),
    };

    await syncPyodideToVfs(rpc, pyodide, ['/proc'], snapshot);

    // No writeBatch at all because nothing changed under /proc.
    expect(written).toHaveLength(0);
  });

  it('does not regress same-size content changes through (documented trade-off)', async () => {
    // Same byte count → diff says nothing changed. This is the
    // intentional perf trade in the design; if it ever flips to
    // hash-based diffing the test should be updated, not deleted.
    const written: WriteBatchPayload[] = [];
    const { rpc, calls } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        written.push(inv.args[0] as WriteBatchPayload);
        return OK_BATCH;
      }
    });
    const { pyodide } = makeFakePyodide();
    pyodide.FS.writeFile('/workspace/notes.txt', 'abc');
    const snapshot = snapshotOfFiles([['/workspace/notes.txt', 3]]);
    pyodide.FS.writeFile('/workspace/notes.txt', 'XYZ'); // same length, different bytes

    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], snapshot);

    expect(calls.find((c) => c.op === 'writeBatch')).toBeUndefined();
    expect(written).toHaveLength(0);
  });

  it('surfaces per-entry failedFiles from writeBatch as stderr warnings', async () => {
    // The host swallowed write rejections silently before; now the
    // realm receives them and the user sees a warning instead of
    // their output disappearing into the void.
    const warnings: string[] = [];
    const { rpc } = makeRpc((inv) => {
      if (inv.op === 'writeBatch') {
        return {
          ok: true,
          failedMkdirs: [],
          failedFiles: [{ path: '/workspace/lost.txt', error: 'EACCES: denied' }],
        } satisfies WriteBatchResult;
      }
    });
    const { pyodide } = makeFakePyodide();
    pyodide.FS.writeFile('/workspace/lost.txt', 'will-vanish');
    await syncPyodideToVfs(rpc, pyodide, ['/workspace'], emptySnapshot(), (msg) =>
      warnings.push(msg)
    );

    expect(warnings.some((w) => w.includes('/workspace/lost.txt') && w.includes('EACCES'))).toBe(
      true
    );
  });
});
