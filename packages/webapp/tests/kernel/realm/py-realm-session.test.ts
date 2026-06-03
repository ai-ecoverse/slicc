/**
 * Tests for `PyRealmSession` warm reuse + per-run state reset.
 *
 * A fake Pyodide (loaded via an injected `loaderImport`) lets us
 * assert that `loadPyodide` runs ONCE across many runs (warm reuse
 * skips cold boot), the module baseline is captured once, the reset
 * snippet runs only on reused runs, and stale scratch files are
 * cleared before a reused run re-mirrors VFS. The
 * `RealmRpcClient.walkTree` calls are answered by a responding port.
 */

import type { PyodideInterface } from 'pyodide';
import { describe, expect, it, vi } from 'vitest';
import {
  PY_BASELINE_SNIPPET,
  PY_RESET_SNIPPET,
  PyRealmSession,
} from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmInitMsg } from '../../../src/kernel/realm/realm-types.js';

const DIR_MODE = 0o40000;
const FILE_MODE = 0o100000;

function makeFakePyodide(): {
  pyodide: PyodideInterface;
  files: Map<string, Uint8Array>;
  runPython: ReturnType<typeof vi.fn>;
} {
  const dirs = new Set<string>(['/', '/workspace', '/tmp']);
  const files = new Map<string, Uint8Array>();
  const globals = new Map<string, unknown>();
  const enc = new TextEncoder();
  let stdoutCb: ((s: string) => void) | null = null;
  const FS = {
    stat: (p: string) => {
      if (dirs.has(p)) return { mode: DIR_MODE, size: 0 };
      const f = files.get(p);
      if (f) return { mode: FILE_MODE, size: f.length };
      throw new Error(`ENOENT: ${p}`);
    },
    mkdirTree: (p: string) => {
      let c = '';
      for (const part of p.split('/').filter(Boolean)) {
        c += `/${part}`;
        dirs.add(c);
      }
      dirs.add('/');
    },
    writeFile: (p: string, c: string | Uint8Array) =>
      files.set(p, typeof c === 'string' ? enc.encode(c) : new Uint8Array(c)),
    readFile: (p: string) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f;
    },
    readdir: (p: string) => {
      if (!dirs.has(p)) throw new Error(`ENOENT: ${p}`);
      const out = new Set<string>(['.', '..']);
      const prefix = p === '/' ? '/' : `${p}/`;
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix) || key === p) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...out];
    },
    isDir: (m: number) => (m & 0o170000) === DIR_MODE,
    isFile: (m: number) => (m & 0o170000) === FILE_MODE,
    chdir: vi.fn(),
    rmdir: (p: string) => void dirs.delete(p),
    unlink: (p: string) => void files.delete(p),
  };
  const runPython = vi.fn((_code: string) => {});
  const pyodide = {
    FS,
    runPython,
    runPythonAsync: vi.fn(async (_code: string) => {
      stdoutCb?.('hello');
      globals.set('__slicc_exit_code', 0);
    }),
    setStdout: vi.fn((o: { batched: (s: string) => void }) => {
      stdoutCb = o.batched;
    }),
    setStderr: vi.fn(),
    setStdin: vi.fn(),
    globals: {
      set: (k: string, v: unknown) => globals.set(k, v),
      get: (k: string) => globals.get(k),
    },
  } as unknown as PyodideInterface;
  return { pyodide, files, runPython };
}

function makeRespondingPort(): { port: RealmPortLike; posted: unknown[] } {
  const handlers = new Set<(e: MessageEvent) => void>();
  const posted: unknown[] = [];
  const port: RealmPortLike = {
    postMessage: (msg) => {
      posted.push(msg);
      const m = msg as { type?: string; id?: number; op?: string };
      if (m.type !== 'realm-rpc-req') return;
      const result = m.op === 'writeBatch' ? { ok: true, failedMkdirs: [], failedFiles: [] } : [];
      queueMicrotask(() => {
        for (const h of [...handlers]) {
          h({ data: { type: 'realm-rpc-res', id: m.id, result } } as MessageEvent);
        }
      });
    },
    addEventListener: (_t, h) => void handlers.add(h),
    removeEventListener: (_t, h) => void handlers.delete(h),
  };
  return { port, posted };
}

const init: RealmInitMsg = {
  type: 'realm-init',
  kind: 'py',
  code: 'print("hi")',
  argv: ['-c'],
  env: {},
  cwd: '/workspace',
  filename: '-c',
  pyodideSyncDirs: ['/workspace', '/tmp'],
};

describe('PyRealmSession warm reuse + reset', () => {
  it('loads Pyodide once, captures the baseline once, and resets only on reused runs', async () => {
    const { pyodide, files, runPython } = makeFakePyodide();
    const loadPyodide = vi.fn(async () => pyodide);
    const loader = async () => ({ loadPyodide }) as unknown as typeof import('pyodide');

    const session = await PyRealmSession.create(init, loader);
    expect(loadPyodide).toHaveBeenCalledTimes(1);
    const baselineCalls = () =>
      runPython.mock.calls.filter((c) => c[0] === PY_BASELINE_SNIPPET).length;
    const resetCalls = () => runPython.mock.calls.filter((c) => c[0] === PY_RESET_SNIPPET).length;
    expect(baselineCalls()).toBe(1);
    expect(resetCalls()).toBe(0);

    // First run: no reset (nothing carried yet).
    await session.run(init, makeRespondingPort().port);
    expect(resetCalls()).toBe(0);

    // A file the previous run left in cwd that VFS no longer has.
    pyodide.FS.writeFile('/workspace/leak.txt', 'stale');
    expect(files.has('/workspace/leak.txt')).toBe(true);

    // Second run: warm reuse — no second load — and state reset.
    const { port, posted } = makeRespondingPort();
    await session.run(init, port);
    expect(loadPyodide).toHaveBeenCalledTimes(1);
    expect(baselineCalls()).toBe(1);
    expect(resetCalls()).toBe(1);
    expect(files.has('/workspace/leak.txt')).toBe(false); // scratch cleared
    const done = posted.find((m) => (m as { type?: string }).type === 'realm-done') as {
      stdout: string;
      exitCode: number;
    };
    expect(done).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
  });
});
