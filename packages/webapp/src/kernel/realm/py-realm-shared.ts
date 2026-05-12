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
  let preSyncSnapshot: Map<string, number> = new Map();
  try {
    preSyncSnapshot = await syncVfsToPyodide(rpc, pyodide, syncDirs);
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

  let exitCode: number;
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
    await syncPyodideToVfs(rpc, pyodide, syncDirs, preSyncSnapshot);
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

/**
 * Cap on per-file content shipped in `walkTree`. Files above the cap
 * are still listed (Pyodide gets the directory entry and the size)
 * but their content is not pre-loaded — Python `open()` on one will
 * see ENOENT. The trade-off is intentional: the previous unbounded
 * sync took minutes on workspace-sized trees because each large file
 * blocked the channel. 10 MB covers nearly every text artefact agents
 * actually script against; anything bigger should be read via the
 * shell layer instead.
 */
const WALK_TREE_MAX_FILE_BYTES = 10 * 1024 * 1024;

interface WalkTreeEntry {
  path: string;
  isDir: boolean;
  size?: number;
  content?: string;
}

/**
 * Mirror VFS → Pyodide-FS for `dirs` in a single `walkTree` RPC per
 * directory. Returns `path → size` for every file that was actually
 * mirrored, so the post-execution diff can tell new/modified files
 * apart from untouched ones.
 */
async function syncVfsToPyodide(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[]
): Promise<Map<string, number>> {
  const FS = pyodide.FS;
  const snapshot = new Map<string, number>();

  function ensurePyDir(path: string): void {
    try {
      FS.stat(path);
    } catch {
      FS.mkdirTree(path);
    }
  }

  for (const dir of dirs) {
    ensurePyDir(dir);
    let entries: WalkTreeEntry[];
    try {
      entries = await rpc.call<WalkTreeEntry[]>('vfs', 'walkTree', [
        dir,
        { maxFileBytes: WALK_TREE_MAX_FILE_BYTES },
      ]);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        if (entry.isDir) {
          ensurePyDir(entry.path);
        } else if (entry.content !== undefined) {
          // Parent dir guaranteed by the walk order (directories
          // are emitted before their contents); still defensive.
          const lastSlash = entry.path.lastIndexOf('/');
          if (lastSlash > 0) ensurePyDir(entry.path.slice(0, lastSlash));
          FS.writeFile(entry.path, entry.content);
          snapshot.set(entry.path, entry.size ?? entry.content.length);
        }
      } catch {
        /* skip individual entries — bad path, encoding, etc. */
      }
    }
  }

  return snapshot;
}

/**
 * Mirror Pyodide-FS → VFS for `dirs`, but only for files that are
 * new or whose size changed since `preSyncSnapshot`. Sends one
 * `writeBatch` RPC per `dirs` entry; for a `python -c "print('hi')"`
 * with no FS writes that's a single empty batch (still cheap) instead
 * of N writeFile round-trips.
 *
 * Size-only diffing is a deliberate trade — same-size content changes
 * can slip through. The previous implementation also re-wrote every
 * file every run, so callers that round-trip JSON or other structured
 * data hit it then too; the recommended workaround is the same: write
 * to a fresh path or change the byte count.
 */
async function syncPyodideToVfs(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[],
  preSyncSnapshot: Map<string, number>
): Promise<void> {
  const FS = pyodide.FS;
  const newDirs = new Set<string>();
  const changedFiles: Array<{ path: string; content: string }> = [];

  function walkBack(pyPath: string): void {
    let entries: string[];
    try {
      entries = (FS.readdir(pyPath) as string[]).filter((n) => n !== '.' && n !== '..');
    } catch {
      return;
    }
    for (const name of entries) {
      const full = pyPath === '/' ? `/${name}` : `${pyPath}/${name}`;
      let st: { mode: number; size: number };
      try {
        st = FS.stat(full) as { mode: number; size: number };
      } catch {
        continue;
      }
      if (FS.isDir(st.mode)) {
        if (!preSyncSnapshot.has(full)) newDirs.add(full);
        walkBack(full);
      } else if (FS.isFile(st.mode)) {
        const previousSize = preSyncSnapshot.get(full);
        if (previousSize === undefined || previousSize !== st.size) {
          try {
            const content = new TextDecoder().decode(FS.readFile(full));
            changedFiles.push({ path: full, content });
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
  }

  for (const dir of dirs) walkBack(dir);

  if (newDirs.size === 0 && changedFiles.length === 0) return;
  try {
    await rpc.call('vfs', 'writeBatch', [{ mkdirs: [...newDirs], files: changedFiles }]);
  } catch {
    /* writeBatch already tolerates per-entry failures host-side;
       a top-level reject here means the channel is gone. */
  }
}
