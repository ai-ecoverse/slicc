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
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
  WalkTreeEntry,
  WriteBatchResult,
} from './realm-types.js';

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

  // Default `[cwd, '/tmp']` is deliberate: those are the two
  // directories Python code almost always reads from (the working
  // directory the user invoked from + the conventional scratch
  // location). Adding `/workspace/` or `/shared/` to the default
  // would mirror the entire workspace into Pyodide's FS on every
  // invocation — minutes per `python3 -c "print(1)"` even with the
  // bulk-RPC path. Callers that need wider visibility pass an
  // explicit `pyodideSyncDirs`.
  const syncDirs = init.pyodideSyncDirs ?? [init.cwd, '/tmp'];
  const pushWarning = (msg: string): void => {
    stderrChunks.push(`Warning: ${msg}\n`);
  };
  let preSyncSnapshot: PreSyncSnapshot = { files: new Map(), dirs: new Set() };
  try {
    preSyncSnapshot = await syncVfsToPyodide(rpc, pyodide, syncDirs, pushWarning);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`VFS→Pyodide sync failed: ${message}`);
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
    await syncPyodideToVfs(rpc, pyodide, syncDirs, preSyncSnapshot, pushWarning);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`Pyodide→VFS sync failed: ${message}`);
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
 * are listed in the walk (Pyodide sees the directory entry and the
 * `size`) but their content is not pre-loaded — Python `open()` on
 * one fails with ENOENT and the realm pushes a stderr warning naming
 * the file so the symptom is debuggable. The trade-off is
 * intentional: the previous unbounded sync took minutes on workspace-
 * sized trees because every large file blocked the channel. 10 MB
 * covers nearly every text artefact agents actually script against;
 * anything bigger should be read via the shell layer instead.
 */
const WALK_TREE_MAX_FILE_BYTES = 10 * 1024 * 1024;

type WarningSink = (message: string) => void;

/**
 * Snapshot of what pre-sync put into Pyodide-FS. The post-sync diff
 * uses it to tell "user code created this" apart from "pre-sync
 * mirrored it in." Files are size-keyed (same-size content edits
 * slip through — documented trade-off); directories are tracked as
 * a Set because we only need to know whether they pre-existed.
 *
 * Tracking dirs is load-bearing: without it the post-sync emits
 * mkdir for every directory it sees in Pyodide-FS, and read-only
 * VFS mounts like `/proc` (procfs-shaped, emits PID dirs at read
 * time) flood stderr with `EACCES: read-only filesystem` warnings
 * on every python invocation.
 */
export interface PreSyncSnapshot {
  files: Map<string, number>;
  dirs: Set<string>;
}

/**
 * Mirror VFS → Pyodide-FS for `dirs` in a single `walkTree` RPC per
 * directory. Returns the `PreSyncSnapshot` for the post-execution
 * diff so it can tell new/modified entries apart from ones that
 * pre-sync just mirrored in.
 *
 * Skipped files (cap-exceeded, unreadable, missing dir) are surfaced
 * through `pushWarning` so the user can correlate Python's
 * `FileNotFoundError` against the real cause instead of guessing.
 */
export async function syncVfsToPyodide(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[],
  pushWarning: WarningSink = () => {}
): Promise<PreSyncSnapshot> {
  const FS = pyodide.FS;
  const snapshot: PreSyncSnapshot = {
    files: new Map<string, number>(),
    dirs: new Set<string>(),
  };

  function ensurePyDir(path: string): void {
    try {
      FS.stat(path);
    } catch {
      FS.mkdirTree(path);
    }
    snapshot.dirs.add(path);
  }

  /**
   * Recursively record every dir/file Pyodide already has under
   * `pyPath` into the snapshot. emscripten boots with a few
   * built-ins inside `/proc` and `/dev` (notably `/proc/self/fd`
   * for file-descriptor tracking) that the VFS procfs mount
   * doesn't expose via `walkTree`. Without this seeding the
   * post-sync diff would flag those as "new" and emit `mkdir`
   * back to the read-only mount.
   */
  function recordExisting(pyPath: string): void {
    let st: { mode: number; size: number };
    try {
      st = FS.stat(pyPath) as { mode: number; size: number };
    } catch {
      return;
    }
    if (FS.isDir(st.mode)) {
      snapshot.dirs.add(pyPath);
      let names: string[];
      try {
        names = (FS.readdir(pyPath) as string[]).filter((n) => n !== '.' && n !== '..');
      } catch {
        return;
      }
      for (const name of names) {
        const full = pyPath === '/' ? `/${name}` : `${pyPath}/${name}`;
        recordExisting(full);
      }
    } else if (FS.isFile(st.mode)) {
      // Size-keyed so a same-size overwrite by the agent's
      // Python still won't re-emit it. New files written by
      // user code aren't in the snapshot, so they DO surface.
      snapshot.files.set(pyPath, st.size);
    }
  }

  for (const dir of dirs) {
    ensurePyDir(dir);
    recordExisting(dir);
    let entries: WalkTreeEntry[];
    try {
      entries = await rpc.call<WalkTreeEntry[]>('vfs', 'walkTree', [
        dir,
        { maxFileBytes: WALK_TREE_MAX_FILE_BYTES },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`VFS→Pyodide sync skipped '${dir}': ${message}`);
      continue;
    }
    for (const entry of entries) {
      try {
        if (entry.isDir) {
          ensurePyDir(entry.path);
          continue;
        }
        if (entry.content === undefined) {
          // File listed without content — either above the
          // WALK_TREE_MAX_FILE_BYTES cap or unreadable by the host.
          // Don't write a stub: an empty file at the same path
          // would mask the failure. Let the listing show through
          // (via `readdir`) but `open()` will surface ENOENT.
          //
          // Warning policy: cap-exceeded files are a documented
          // constraint, not an error — surfacing one on every
          // `python3 -c "..."` invocation just because the user
          // happens to have a large screenshot in cwd is noise the
          // agent reacts to as a fault to fix. Silently skip. By
          // contrast, an unreadable file IS an error worth
          // flagging — those still warn.
          if (entry.size <= WALK_TREE_MAX_FILE_BYTES) {
            pushWarning(`VFS→Pyodide skipped '${entry.path}': unreadable from VFS`);
          }
          continue;
        }
        // Parent dir guaranteed by the walk order (directories are
        // emitted before their contents); still defensive.
        const lastSlash = entry.path.lastIndexOf('/');
        if (lastSlash > 0) ensurePyDir(entry.path.slice(0, lastSlash));
        FS.writeFile(entry.path, entry.content);
        snapshot.files.set(entry.path, entry.size);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushWarning(`VFS→Pyodide entry '${entry.path}' failed: ${message}`);
      }
    }
  }

  return snapshot;
}

/**
 * Mirror Pyodide-FS → VFS for `dirs`, but only for files that are
 * new or whose size changed since `preSyncSnapshot`. Sends one
 * `writeBatch` RPC carrying all the diff entries; for a
 * `python -c "print('hi')"` with no FS writes that's zero RPCs
 * instead of N writeFile round-trips.
 *
 * Size-only diffing is a deliberate trade — same-size content
 * changes can slip through. The previous implementation also
 * re-wrote every file every run, so callers that round-trip JSON or
 * other structured data hit it then too; the recommended workaround
 * is the same: write to a fresh path or change the byte count.
 *
 * Binary outputs (PIL writing PNGs, numpy `.npy`, …) round-trip
 * byte-for-byte: `FS.readFile` returns a `Uint8Array` and we ship
 * it via `WriteBatchPayload.files[].content` (also `Uint8Array`).
 * The previous TextDecoder-based path silently corrupted any
 * non-UTF-8 bytes — fixed here.
 *
 * Host-side per-entry write failures come back in `WriteBatchResult`
 * and surface as stderr warnings so the user notices when their
 * Python output didn't reach VFS.
 */
export async function syncPyodideToVfs(
  rpc: RealmRpcClient,
  pyodide: PyodideInterface,
  dirs: string[],
  preSyncSnapshot: PreSyncSnapshot,
  pushWarning: WarningSink = () => {}
): Promise<void> {
  const FS = pyodide.FS;
  const newDirs = new Set<string>();
  const changedFiles: Array<{ path: string; content: Uint8Array }> = [];

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
        // Only emit mkdir for directories user code actually
        // created. Pre-sync mirrors VFS dirs (incl. read-only
        // mounts like /proc) into Pyodide-FS; without this check
        // we'd try to mkdir them back into the read-only mount
        // and spam EACCES warnings on every python invocation.
        if (!preSyncSnapshot.dirs.has(full)) newDirs.add(full);
        walkBack(full);
      } else if (FS.isFile(st.mode)) {
        const previousSize = preSyncSnapshot.files.get(full);
        if (previousSize === undefined || previousSize !== st.size) {
          try {
            const content = FS.readFile(full) as Uint8Array;
            // Copy out of WASM heap: emscripten can reuse the view
            // after the next FS call, same trap as magick-wasm.
            changedFiles.push({ path: full, content: new Uint8Array(content) });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pushWarning(`Pyodide→VFS read '${full}' failed: ${message}`);
          }
        }
      }
    }
  }

  for (const dir of dirs) walkBack(dir);

  if (newDirs.size === 0 && changedFiles.length === 0) return;
  let result: WriteBatchResult | undefined;
  try {
    result = await rpc.call<WriteBatchResult>('vfs', 'writeBatch', [
      { mkdirs: [...newDirs], files: changedFiles },
    ]);
  } catch (err) {
    // Top-level reject means the channel is gone — partial
    // failures are reported via `result` instead.
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`Pyodide→VFS writeBatch RPC failed: ${message}`);
    return;
  }
  for (const f of result.failedFiles) {
    pushWarning(`Pyodide→VFS write '${f.path}' failed: ${f.error}`);
  }
  for (const d of result.failedMkdirs) {
    pushWarning(`Pyodide→VFS mkdir '${d.path}' failed: ${d.error}`);
  }
}
