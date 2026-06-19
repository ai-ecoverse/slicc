/**
 * Shared Pyodide constants + the Python realm execution engine.
 *
 * `runPyRealm(init, port)` is the entry point both the standalone
 * worker (`py-realm-worker.ts`) and the in-process test factory
 * use, so we don't duplicate `loadPyodide` + VFS sync logic in two
 * places.
 *
 * Constants (`PYODIDE_VERSION`, `PYODIDE_RUNTIME_CDN`,
 * `PYTHON_RUNNER`) also live here so the kernel-side
 * `realm-factory.ts` and the worker can share the same pin
 * without crossing into the supplemental-commands layer.
 */

import type { PyodideInterface } from 'pyodide';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import { resolvePinnedPackageVersion } from '../../shell/supplemental-commands/shared.js';
import { installMountBombs } from './mount-bomb-fs.js';
import {
  createBufferedOpfsSahProvider,
  createOpfsSyncFs,
  flushPendingOpfsOps,
  type OpfsMount,
  type OpfsSyncFsPlugin,
  prewalkOpfsTree,
} from './opfs-sync-fs.js';
import { installPythonMountGuard } from './python-mount-guard.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type { RealmDoneMsg, RealmErrorMsg, RealmInitMsg, RealmMountPoint } from './realm-types.js';
import { registerSliccFsModule } from './slicc-fs-module.js';

export const PYODIDE_VERSION = resolvePinnedPackageVersion('pyodide', pyodidePackageVersion);

/**
 * The SINGLE documented runtime-CDN exception. Wave 8 moved the
 * pyodide JS loader from jsdelivr to the ipk-installed npm package
 * at `/workspace/node_modules/pyodide/` (served via the preview SW),
 * but pyodide's package-wheel ecosystem lives on jsdelivr — this
 * constant pins the `cdn.jsdelivr.net/pyodide/v<VERSION>/full/`
 * base so any wheel-fetching path stays consistent with the loader
 * version.
 *
 * Every other CDN-resolver in the webapp was retired in Waves 1-7;
 * do NOT add another. New runtime assets must be installed via
 * `ipk add <pkg>` and resolved through the preview SW.
 */
export const PYODIDE_RUNTIME_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Heuristic: does `url` look like a preview-SW URL pointing at the
 * ipk-installed pyodide package? Used by the `loadPyodide` error
 * handler to append `ipk add pyodide` guidance when the browser
 * indexURL 404s — the only failure mode where that guidance helps.
 * The Node and extension branches resolve assets out of band and
 * surface different errors that the hint would only confuse.
 */
function isPyodidePreviewUrl(url: string): boolean {
  return url.includes('/preview/workspace/node_modules/pyodide/');
}

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
    const guidance = isPyodidePreviewUrl(init.pyodideIndexURL ?? '')
      ? ` (run \`ipk add pyodide\` to install the pyodide loader into /workspace/node_modules/)`
      : '';
    const errMsg: RealmErrorMsg = {
      type: 'realm-error',
      message: `loadPyodide: ${message}${guidance}`,
    };
    port.postMessage(errMsg);
    return;
  }

  const pushWarning = (msg: string): void => {
    stderrChunks.push(`Warning: ${msg}\n`);
  };

  const opfsMounts = await mountOpfsIfNeeded(pyodide, init, pushWarning);
  await installMountOverlays(pyodide, init, pushWarning);
  await registerSliccFsModuleSafe(pyodide, rpc, pushWarning);

  try {
    pyodide.FS.chdir(init.cwd);
  } catch {
    /* dir may not exist in Pyodide FS */
  }

  configurePyodideIo(pyodide, init, stdoutChunks, stderrChunks);

  const exitCode = await executePythonCode(pyodide, stderrChunks);

  await flushOpfsIfNeeded(opfsMounts, init, rpc, pushWarning);

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  port.postMessage(done);
}

/** Mount OPFS dirs if the kernel provided an opfsMountDbName. */
async function mountOpfsIfNeeded(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<OpfsRealmMount[]> {
  if (init.opfsMountDbName === undefined) return [];

  // Default `[cwd, '/tmp']` is deliberate: those are the two
  // directories Python code almost always reads from (the working
  // directory the user invoked from + the conventional scratch
  // location). Adding `/workspace/` or `/shared/` to the default
  // would mirror the entire workspace into Pyodide's FS on every
  // invocation — minutes per `python3 -c "print(1)"` even with the
  // bulk-RPC path. Callers that need wider visibility pass an
  // explicit `pyodideMountDirs`.
  const syncDirs = init.pyodideMountDirs ?? [init.cwd, '/tmp'];
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  const exactMountPaths = new Set(mountPoints.map((m) => m.path));

  try {
    const mounted = await mountOpfsDirsAndSyncIn(
      pyodide,
      syncDirs,
      init.opfsMountDbName,
      pushWarning,
      { skipMountPaths: exactMountPaths }
    );
    return mounted.mounts;
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount failed: ${describeRealmError(err)}`);
    return [];
  }
}

/** Install mount bombs and Python mount guard for overlapping mount paths. */
async function installMountOverlays(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<void> {
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  if (mountPoints.length === 0) return;

  try {
    installMountBombs(
      pyodide.FS as unknown as Parameters<typeof installMountBombs>[0],
      mountPoints.map((mp) => mp.path),
      pushWarning
    );
  } catch (err) {
    pushWarning(`bomb overlay install failed: ${describeRealmError(err)}`);
  }

  // Python-level guard: the bomb FS sets a friendly `.message` on
  // its `ErrnoError`, but CPython rebuilds the OSError from the raw
  // integer errno for stdlib calls, so only "I/O error" survives.
  // This wraps the hot stdlib entry points and raises an OSError
  // carrying the guidance directly. Bomb FS remains as the C-level
  // backstop for paths the Python wrappers can't see (pandas fopen,
  // C extensions).
  try {
    await installPythonMountGuard(
      pyodide,
      mountPoints.map((mp) => mp.path)
    );
  } catch (err) {
    pushWarning(`python mount guard install failed: ${describeRealmError(err)}`);
  }
}

/** Register the async `slicc.fs` Python module with warning on failure. */
async function registerSliccFsModuleSafe(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  try {
    await registerSliccFsModule(pyodide, rpc);
  } catch (err) {
    pushWarning(`slicc.fs registration failed: ${describeRealmError(err)}`);
  }
}

/** Configure stdout, stderr, stdin, and globals for user code execution. */
function configurePyodideIo(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  stdoutChunks: string[],
  stderrChunks: string[]
): void {
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
}

/** Execute the Python runner and return the exit code. */
async function executePythonCode(
  pyodide: PyodideInterface,
  stderrChunks: string[]
): Promise<number> {
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
  return exitCode;
}

/** Flush OPFS mounts and invalidate kernel VFS cache if applicable. */
async function flushOpfsIfNeeded(
  opfsMounts: OpfsRealmMount[],
  init: RealmInitMsg,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  if (init.opfsMountDbName === undefined) return;

  try {
    await flushOpfsRealmMounts(opfsMounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`Pyodide→VFS OPFS flush failed: ${message}`);
  }
  // Invalidate the kernel VFS's in-memory cache for paths Python
  // wrote to via synchronous `open()`. The OPFS layer already has
  // the correct data (flushed above); this makes the kernel re-read
  // from OPFS on next access instead of serving stale cached content.
  try {
    await invalidateDirtyPathsInKernelVfs(opfsMounts, rpc);
  } catch (err) {
    pushWarning(`Pyodide→kernel VFS invalidation failed: ${describeRealmError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// OPFS-native mount path (OPFS_SYNC_FS plugin)
// ---------------------------------------------------------------------------

type WarningSink = (message: string) => void;

/**
 * Top-level directory names Emscripten / Pyodide already own when
 * `loadPyodide` finishes. Mounting OPFS_SYNC_FS over any of these
 * collides with the built-in mount (Emscripten rejects with EBUSY)
 * or shadows runtime-critical state (`/lib` is Pyodide's stdlib).
 * Used by the cwd=='/' fan-out so a kernel-side `/tmp` OPFS dir
 * doesn't shadow Pyodide's writable scratch dir.
 */
const EMSCRIPTEN_BUILTIN_ROOT_DIRS = new Set(['dev', 'proc', 'lib', 'tmp', 'home']);

/**
 * Render any error from the realm mount/sync paths as a single
 * human-readable line. Emscripten's `ErrnoError` carries `.errno`
 * and (sometimes) `.code` but is not always `instanceof Error`, so
 * `String(err)` collapses it to `[object Object]`. This helper
 * surfaces the POSIX cause (name + message + errno + code) for
 * Emscripten-shaped throws, the message for real `Error`s, and
 * falls back to `String(err)` for everything else.
 */
export function describeRealmError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; errno?: unknown; code?: unknown };
    const hasErrno = typeof e.errno === 'number';
    const hasCode = typeof e.code === 'string';
    if (hasErrno || hasCode) {
      const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
      const message = typeof e.message === 'string' ? e.message : '';
      const detail: string[] = [];
      if (hasErrno) detail.push(`errno ${e.errno as number}`);
      if (hasCode) detail.push(e.code as string);
      const suffix = detail.length ? ` (${detail.join(', ')})` : '';
      return message ? `${name}: ${message}${suffix}` : `${name}${suffix}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

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
  getDirtyPaths: () => string[];
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
  pushWarning: WarningSink = () => {},
  opts: { skipMountPaths?: ReadonlySet<string> } = {}
): Promise<MountedOpfsResult> {
  const mounts: OpfsRealmMount[] = [];
  const skip = opts.skipMountPaths ?? new Set<string>();
  const storage = (navigator as unknown as { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) {
    pushWarning('VFS→Pyodide OPFS mount skipped: navigator.storage.getDirectory unavailable');
    return { mounts };
  }
  let opfsRoot: FileSystemDirectoryHandle;
  try {
    opfsRoot = await storage.getDirectory();
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount: getDirectory() failed: ${describeRealmError(err)}`);
    return { mounts };
  }
  let kernelDbHandle: FileSystemDirectoryHandle;
  try {
    kernelDbHandle = await opfsRoot.getDirectoryHandle(opfsDbName, { create: true });
  } catch (err) {
    pushWarning(
      `VFS→Pyodide OPFS mount: opening '${opfsDbName}' failed: ${describeRealmError(err)}`
    );
    return { mounts };
  }

  const plugin = ensureOpfsSyncFsRegistered(pyodide);

  for (const dir of dirs) {
    if (dir === '/') {
      await mountRootChildren(pyodide, plugin, kernelDbHandle, skip, mounts, pushWarning);
      continue;
    }
    if (skip.has(dir)) continue;
    try {
      let handle: FileSystemDirectoryHandle = kernelDbHandle;
      for (const part of dir.split('/').filter(Boolean)) {
        handle = await handle.getDirectoryHandle(part, { create: true });
      }
      await mountOpfsChild(pyodide, plugin, dir, handle, mounts);
    } catch (err) {
      pushWarning(`VFS→Pyodide OPFS mount '${dir}' failed: ${describeRealmError(err)}`);
    }
  }

  return { mounts };
}

/**
 * Emscripten rejects `FS.mount(_, _, '/')` with EBUSY because its root
 * MEMFS is already mounted. Fan out to the top-level children of the
 * kernel OPFS subtree instead so Python can still reach the VFS by
 * absolute path (`/workspace`, …) when the shell cwd is `/`. Built-in
 * mount points are skipped so we don't shadow `/dev`, `/proc`, `/lib`,
 * `/tmp`, `/home`.
 */
async function mountRootChildren(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  kernelDbHandle: FileSystemDirectoryHandle,
  skip: ReadonlySet<string>,
  mounts: OpfsRealmMount[],
  pushWarning: WarningSink
): Promise<void> {
  try {
    const iter = kernelDbHandle as unknown as AsyncIterable<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    >;
    for await (const [name, childHandle] of iter) {
      if ((childHandle as { kind: string }).kind !== 'directory') continue;
      if (EMSCRIPTEN_BUILTIN_ROOT_DIRS.has(name)) continue;
      const childPath = `/${name}`;
      // Skip OPFS mount when this path is itself a VFS mount —
      // the realm-mount materialization step will mount MEMFS at
      // the same path, and Emscripten cannot stack two mounts on
      // one node.
      if (skip.has(childPath)) continue;
      try {
        await mountOpfsChild(
          pyodide,
          plugin,
          childPath,
          childHandle as FileSystemDirectoryHandle,
          mounts
        );
      } catch (err) {
        pushWarning(`VFS→Pyodide OPFS mount '${childPath}' failed: ${describeRealmError(err)}`);
      }
    }
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount '/' failed: ${describeRealmError(err)}`);
  }
}

/**
 * Shared per-dir mount step: ensure the Pyodide-side directory
 * exists (`mkdirTree`), prewalk the OPFS subtree, hand the plugin
 * an `{ rootHandle, prewalk, sahProvider }` opts object, and record
 * the resulting `OpfsRealmMount` so `flushOpfsRealmMounts` can drain
 * queued ops + dirty buffers at `realm-done`.
 */
async function mountOpfsChild(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  pyPath: string,
  handle: FileSystemDirectoryHandle,
  mounts: OpfsRealmMount[]
): Promise<void> {
  try {
    pyodide.FS.stat(pyPath);
  } catch {
    pyodide.FS.mkdirTree(pyPath);
  }
  const prewalk = await prewalkOpfsTree(handle);
  const buffered = createBufferedOpfsSahProvider();
  await buffered.preload(prewalk);
  const opts = { rootHandle: handle, prewalk, sahProvider: buffered.provider };
  const fsMount = pyodide.FS as unknown as {
    mount: (plugin: OpfsSyncFsPlugin, opts: unknown, dir: string) => unknown;
  };
  const rootNode = fsMount.mount(plugin, opts, pyPath) as { mount?: OpfsMount } | undefined;
  const mount =
    rootNode?.mount ??
    ({ opts, mountpoint: pyPath, root: rootNode as never } as unknown as OpfsMount);
  mounts.push({
    pyPath,
    mount,
    rootHandle: handle,
    flushBuffers: buffered.flush,
    getDirtyPaths: buffered.getDirtyPaths,
  });
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

/**
 * After OPFS flush, tell the kernel VFS to invalidate its in-memory
 * cache for paths Python wrote to. The kernel's `WebAccessFS.stat()`
 * fallback will re-read fresh metadata from OPFS on next access.
 */
async function invalidateDirtyPathsInKernelVfs(
  mounts: OpfsRealmMount[],
  rpc: RealmRpcClient
): Promise<void> {
  const absPaths: string[] = [];
  for (const entry of mounts) {
    for (const relPath of entry.getDirtyPaths()) {
      absPaths.push(entry.pyPath === '/' ? `/${relPath}` : `${entry.pyPath}/${relPath}`);
    }
  }
  if (absPaths.length > 0) {
    await rpc.call('vfs', 'invalidatePaths', [absPaths]);
  }
}
