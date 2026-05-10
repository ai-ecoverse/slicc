/**
 * Shared Pyodide constants + the Python realm execution engine.
 *
 * `runPyRealm(init, port)` is the entry point both the standalone
 * worker (`py-realm-worker.ts`) and the in-process test factory
 * use, so we don't duplicate `loadPyodide` + VFS sync logic in two
 * places.
 *
 * Constants (`PYODIDE_VERSION`, `PYODIDE_CDN`, `PYTHON_RUNNER`)
 * also live here so the kernel-side `realm-factory.ts` and the
 * worker can share the same CDN-pin without crossing into the
 * supplemental-commands layer.
 */

import type { PyodideInterface } from 'pyodide';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import { resolvePinnedPackageVersion } from '../../shell/supplemental-commands/shared.js';
import { RealmRpcClient, type RealmPortLike } from './realm-rpc.js';
import type { RealmDoneMsg, RealmErrorMsg, RealmInitMsg } from './realm-types.js';

export const PYODIDE_VERSION = resolvePinnedPackageVersion('pyodide', pyodidePackageVersion);
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * The Python "runner" — wraps user code in `compile`/`exec` with a
 * `__main__` namespace, captures `SystemExit` exit code into
 * `__slicc_exit_code`, and prints any other traceback. Identical
 * to the legacy in-kernel Python execution path.
 */
export const PYTHON_RUNNER = `
import sys
import traceback

__slicc_exit_code = 0
try:
    sys.argv = __slicc_argv
    exec(compile(__slicc_code, __slicc_filename, "exec"), {"__name__": "__main__", "__file__": __slicc_filename})
except SystemExit as exc:
    code = exc.code
    if code is None:
        __slicc_exit_code = 0
    elif isinstance(code, int):
        __slicc_exit_code = code
    else:
        print(code, file=sys.stderr)
        __slicc_exit_code = 1
except BaseException:
    traceback.print_exc()
    __slicc_exit_code = 1
`;

// ---------------------------------------------------------------------------
// Python realm execution engine
// ---------------------------------------------------------------------------

/**
 * Run a `kind:'py'` realm against `port`. Loads Pyodide via the
 * supplied `loaderImport` (default: dynamic `import('pyodide')`),
 * syncs VFS↔Pyodide-FS via the `vfs` RPC channel, runs the user
 * code, then posts `realm-done`. Used by both `py-realm-worker.ts`
 * (worker context) and the in-process test factory.
 */
export async function runPyRealm(
  init: RealmInitMsg,
  port: RealmPortLike,
  loaderImport: () => Promise<typeof import('pyodide')> = () => import('pyodide')
): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const rpc = new RealmRpcClient(port);

  let pyodide: PyodideInterface;
  try {
    const mod = await loaderImport();
    pyodide = await mod.loadPyodide({
      indexURL: init.pyodideIndexURL,
      fullStdLib: false,
    });
  } catch (err) {
    rpc.dispose();
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message: `loadPyodide: ${message}` };
    port.postMessage(errMsg);
    return;
  }

  const syncDirs = init.pyodideSyncDirs ?? [init.cwd, '/tmp'];
  try {
    await syncVfsToPyodide(rpc, pyodide, syncDirs);
  } catch (err) {
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
  port.postMessage(done);
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
