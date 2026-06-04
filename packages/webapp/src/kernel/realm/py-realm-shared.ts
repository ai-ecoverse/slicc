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
import {
  createBufferedOpfsSahProvider,
  createOpfsSyncFs,
  flushPendingOpfsOps,
  type OpfsMount,
  type OpfsSyncFsPlugin,
  prewalkOpfsTree,
} from './opfs-sync-fs.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
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
 * mounts the per-dir OPFS subtrees via `OPFS_SYNC_FS`, runs the
 * user code, flushes the mounts, then posts `realm-done`. Used by
 * both `py-realm-worker.ts` (worker context) and the in-process
 * test factory.
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
  // explicit `pyodideMountDirs`.
  const syncDirs = init.pyodideMountDirs ?? [init.cwd, '/tmp'];
  const pushWarning = (msg: string): void => {
    stderrChunks.push(`Warning: ${msg}\n`);
  };
  let opfsMounts: OpfsRealmMount[] = [];
  // The kernel detects the OPFS-backed VFS and passes the dbName
  // through `init.opfsMountDbName`. The realm worker has no
  // `localStorage` shim, so this is the only signal we get. The
  // in-tree `OPFS_SYNC_FS` plugin mounts each syncDir against the
  // same-origin OPFS subtree the kernel owns; queued mutations are
  // flushed via `flushOpfsRealmMounts` before `realm-done` so the
  // on-disk view is consistent when the kernel takes back over.
  if (init.opfsMountDbName !== undefined) {
    try {
      const mounted = await mountOpfsDirsAndSyncIn(
        pyodide,
        syncDirs,
        init.opfsMountDbName,
        pushWarning
      );
      opfsMounts = mounted.mounts;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`VFS→Pyodide OPFS mount failed: ${message}`);
    }
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

  if (init.opfsMountDbName !== undefined) {
    try {
      await flushOpfsRealmMounts(opfsMounts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`Pyodide→VFS OPFS flush failed: ${message}`);
    }
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
// OPFS-native mount path (OPFS_SYNC_FS plugin)
// ---------------------------------------------------------------------------

type WarningSink = (message: string) => void;

/**
 * Per-dir OPFS mount state the realm passes to
 * `flushOpfsRealmMounts` before `realm-done` to drain queued
 * mutations + write dirty buffers back.
 */
export interface OpfsRealmMount {
  pyPath: string;
  mount: OpfsMount;
  rootHandle: FileSystemDirectoryHandle;
  flushBuffers: (rootHandle: FileSystemDirectoryHandle) => Promise<void>;
}

export interface MountedOpfsResult {
  mounts: OpfsRealmMount[];
}

/**
 * Lazily register the in-tree `OPFS_SYNC_FS` plugin on
 * `pyodide.FS.filesystems`. Idempotent — re-mount calls share the
 * single plugin object so node-op identity stays stable across
 * mount points. Emscripten's mount table is keyed on the plugin
 * reference, so re-creating it would shadow the in-flight mounts.
 */
function ensureOpfsSyncFsRegistered(pyodide: PyodideInterface): OpfsSyncFsPlugin {
  const filesystems = (pyodide.FS as unknown as { filesystems: Record<string, unknown> })
    .filesystems;
  let plugin = filesystems.OPFS_SYNC_FS as OpfsSyncFsPlugin | undefined;
  if (!plugin) {
    plugin = createOpfsSyncFs(pyodide.FS as unknown as Parameters<typeof createOpfsSyncFs>[0]);
    filesystems.OPFS_SYNC_FS = plugin;
  }
  return plugin;
}

/**
 * For each `dir`, resolve the same-origin OPFS handle the kernel
 * worker owns (`OPFS-root / <opfsDbName> / <vfsPath…>`), `prewalk`
 * the subtree, then `pyodide.FS.mount(OPFS_SYNC_FS, …, dir)`. The
 * plugin builds the Pyodide-FS tree from the prewalk snapshot
 * synchronously, so Python sees the OPFS contents the instant the
 * mount returns — no `syncfs(true)` round trip needed.
 *
 * Sub-handles are created with `{ create: true }` so a fresh OPFS
 * subtree boots cleanly — `/tmp` and freshly-created cwds don't
 * exist on disk yet but Python expects them to be writable.
 *
 * Write-back relies on the mount's own queued-op chain + buffered
 * provider rather than a Pyodide-FS walk. Per-dir failures (handle
 * resolution, prewalk, mount) surface through `pushWarning` and the
 * loop continues with the next dir.
 */
export async function mountOpfsDirsAndSyncIn(
  pyodide: PyodideInterface,
  dirs: string[],
  opfsDbName: string,
  pushWarning: WarningSink = () => {}
): Promise<MountedOpfsResult> {
  const mounts: OpfsRealmMount[] = [];
  const storage = (navigator as unknown as { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) {
    pushWarning('VFS→Pyodide OPFS mount skipped: navigator.storage.getDirectory unavailable');
    return { mounts };
  }
  let opfsRoot: FileSystemDirectoryHandle;
  try {
    opfsRoot = await storage.getDirectory();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`VFS→Pyodide OPFS mount: getDirectory() failed: ${message}`);
    return { mounts };
  }
  let kernelDbHandle: FileSystemDirectoryHandle;
  try {
    kernelDbHandle = await opfsRoot.getDirectoryHandle(opfsDbName, { create: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`VFS→Pyodide OPFS mount: opening '${opfsDbName}' failed: ${message}`);
    return { mounts };
  }

  const plugin = ensureOpfsSyncFsRegistered(pyodide);

  for (const dir of dirs) {
    try {
      let handle: FileSystemDirectoryHandle = kernelDbHandle;
      for (const part of dir.split('/').filter(Boolean)) {
        handle = await handle.getDirectoryHandle(part, { create: true });
      }
      try {
        pyodide.FS.stat(dir);
      } catch {
        pyodide.FS.mkdirTree(dir);
      }
      const prewalk = await prewalkOpfsTree(handle);
      const buffered = createBufferedOpfsSahProvider();
      await buffered.preload(prewalk);
      const opts = { rootHandle: handle, prewalk, sahProvider: buffered.provider };
      const fsMount = pyodide.FS as unknown as {
        mount: (plugin: OpfsSyncFsPlugin, opts: unknown, dir: string) => unknown;
      };
      const rootNode = fsMount.mount(plugin, opts, dir) as { mount?: OpfsMount } | undefined;
      const mount =
        rootNode?.mount ??
        ({ opts, mountpoint: dir, root: rootNode as never } as unknown as OpfsMount);
      mounts.push({ pyPath: dir, mount, rootHandle: handle, flushBuffers: buffered.flush });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`VFS→Pyodide OPFS mount '${dir}' failed: ${message}`);
    }
  }

  return { mounts };
}

// ---------------------------------------------------------------------------
// OPFS-native write-back (flush queued ops + dirty buffers)
// ---------------------------------------------------------------------------

/**
 * Drain every mount's queued OPFS mutation chain (`mknod`, `unlink`,
 * `rename`, …) then write each buffered SAH's dirty bytes back to
 * the OPFS subtree. Must run before the realm posts `realm-done`
 * so the kernel sees a consistent on-disk view — the plugin's
 * `node_ops` return synchronously after enqueueing async work, and
 * without this flush the kernel can race the still-pending writes.
 *
 * Errors propagate to the caller; `runPyRealm` wraps the call in a
 * `pushWarning` try/catch so a flush failure still emits
 * `realm-done` with the partial output.
 */
export async function flushOpfsRealmMounts(mounts: OpfsRealmMount[]): Promise<void> {
  for (const entry of mounts) {
    await flushPendingOpfsOps(entry.mount);
    await entry.flushBuffers(entry.rootHandle);
  }
}
