/**
 * `py-realm-worker.ts` — DedicatedWorker entry hosting the
 * `kind:'py'` realm. Used in BOTH standalone and extension modes:
 * Pyodide is a WASM interpreter, so it only needs the
 * `wasm-unsafe-eval` privilege the extension already grants worker
 * scripts. (Contrast with JS realms, where the AsyncFunction
 * constructor is blocked by the extension's
 * `script-src 'self' 'wasm-unsafe-eval'` and we have to fall back
 * to a sandbox iframe.)
 *
 * The worker:
 *   1. Waits for `realm-init` carrying `code`, `filename`, `argv`,
 *      `cwd`, `pyodideIndexURL`, `pyodideSyncDirs`, `stdin?`.
 *   2. `loadPyodide({ indexURL })` — cold-start ~1–2 s on first
 *      call; warm pool is a follow-up.
 *   3. Sync VFS↔Pyodide-FS for the requested directories using the
 *      `vfs` RPC channel.
 *   4. `pyodide.runPythonAsync(PYTHON_RUNNER)` — captures stdout /
 *      stderr / exit code via `setStdout` / `setStderr`.
 *   5. Sync Pyodide-FS back to VFS (in case the script wrote
 *      files).
 *   6. Post `realm-done`.
 *
 * SIGKILL: a runaway `while True: pass` exits when the kernel
 * terminates the worker — Pyodide can't service interrupts inside
 * a tight loop because Python's bytecode interpreter has no yield
 * points there.
 */

/// <reference lib="webworker" />

import type { PyodideInterface } from 'pyodide';
import { RealmRpcClient } from './realm-rpc.js';
import type { RealmDoneMsg, RealmErrorMsg, RealmInitMsg } from './realm-types.js';
import { PYTHON_RUNNER } from './py-realm-shared.js';

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'realm-init') return;
  const init = event.data as RealmInitMsg;
  if (init.kind !== 'py') return;
  void runPython(init).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message };
    self.postMessage(errMsg);
  });
});

async function runPython(init: RealmInitMsg): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const rpc = new RealmRpcClient({
    postMessage: (msg, transfer) =>
      transfer ? self.postMessage(msg, transfer) : self.postMessage(msg),
    addEventListener: (type, handler) => self.addEventListener(type, handler),
    removeEventListener: (type, handler) => self.removeEventListener(type, handler),
  });

  let pyodide: PyodideInterface;
  try {
    const { loadPyodide } = await import('pyodide');
    pyodide = await loadPyodide({
      indexURL: init.pyodideIndexURL,
      fullStdLib: false,
    });
  } catch (err) {
    rpc.dispose();
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message: `loadPyodide: ${message}` };
    self.postMessage(errMsg);
    return;
  }

  const syncDirs = init.pyodideSyncDirs ?? [init.cwd, '/tmp'];
  try {
    await syncVfsToPyodide(rpc, pyodide, syncDirs);
  } catch (err) {
    // Best-effort sync — failures here are surfaced via stderr but
    // shouldn't abort the whole run.
    const message = err instanceof Error ? err.message : String(err);
    stderrChunks.push(`Warning: VFS→Pyodide sync failed: ${message}\n`);
  }

  try {
    pyodide.FS.chdir(init.cwd);
  } catch {
    /* dir may not exist in Pyodide FS */
  }

  pyodide.setStdout({ batched: (msg: string) => stdoutChunks.push(msg + '\n') });
  pyodide.setStderr({ batched: (msg: string) => stderrChunks.push(msg + '\n') });

  let stdinConsumed = false;
  pyodide.setStdin({
    stdin: () => {
      if (stdinConsumed || !init.stdin) return null;
      stdinConsumed = true;
      return init.stdin;
    },
  });
  pyodide.globals.set('__slicc_code', init.code);
  pyodide.globals.set('__slicc_filename', init.filename);
  pyodide.globals.set('__slicc_argv', init.argv);

  let exitCode = 1;
  try {
    await pyodide.runPythonAsync(PYTHON_RUNNER);
    const raw = pyodide.globals.get('__slicc_exit_code');
    exitCode = typeof raw === 'number' ? raw : Number(raw ?? 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrChunks.push(`${message}\n`);
    exitCode = 1;
  }

  try {
    pyodide.runPython('del __slicc_code, __slicc_filename, __slicc_argv, __slicc_exit_code');
  } catch {
    /* best-effort cleanup */
  }

  try {
    await syncPyodideToVfs(rpc, pyodide, syncDirs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrChunks.push(`Warning: Pyodide→VFS sync failed: ${message}\n`);
  }

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  self.postMessage(done);
}

// ---------------------------------------------------------------------------
// VFS ↔ Pyodide-FS sync (over RPC)
// ---------------------------------------------------------------------------

async function syncVfsToPyodide(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[]
): Promise<void> {
  const FS = pyodide.FS;

  function ensurePyDir(path: string): void {
    try {
      FS.stat(path);
    } catch {
      FS.mkdirTree(path);
    }
  }

  async function syncDir(vfsPath: string): Promise<void> {
    ensurePyDir(vfsPath);
    let entries: string[];
    try {
      entries = await rpc.call<string[]>('vfs', 'readDir', [vfsPath]);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = vfsPath === '/' ? `/${name}` : `${vfsPath}/${name}`;
      try {
        const stat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
          'vfs',
          'stat',
          [full]
        );
        if (stat.isDirectory) {
          await syncDir(full);
        } else {
          const content = await rpc.call<string>('vfs', 'readFile', [full]);
          ensurePyDir(vfsPath);
          FS.writeFile(full, content);
        }
      } catch {
        /* skip files we can't read */
      }
    }
  }

  for (const dir of dirs) {
    await syncDir(dir);
  }
}

async function syncPyodideToVfs(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[]
): Promise<void> {
  const FS = pyodide.FS;

  async function writeBack(pyPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = (FS.readdir(pyPath) as string[]).filter((n) => n !== '.' && n !== '..');
    } catch {
      return;
    }
    for (const name of entries) {
      const full = pyPath === '/' ? `/${name}` : `${pyPath}/${name}`;
      try {
        const stat = FS.stat(full) as { mode: number };
        if (FS.isDir(stat.mode)) {
          await rpc.call('vfs', 'mkdir', [full]);
          await writeBack(full);
        } else {
          const content = new TextDecoder().decode(FS.readFile(full));
          await rpc.call('vfs', 'mkdir', [pyPath]);
          await rpc.call('vfs', 'writeFile', [full, content]);
        }
      } catch {
        /* skip */
      }
    }
  }

  for (const dir of dirs) {
    await writeBack(dir);
  }
}

export {};
