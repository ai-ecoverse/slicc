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
import type { RealmDoneMsg, RealmErrorMsg, RealmInitMsg, RealmMountPoint } from './realm-types.js';

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
  // Mount paths that exactly match a syncDir are skipped here so
  // the realm-mount materialization step can mount MEMFS over them
  // without an EBUSY collision against an OPFS subtree.
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  const exactMountPaths = new Set(mountPoints.map((m) => m.path));
  if (init.opfsMountDbName !== undefined) {
    try {
      const mounted = await mountOpfsDirsAndSyncIn(
        pyodide,
        syncDirs,
        init.opfsMountDbName,
        pushWarning,
        { skipMountPaths: exactMountPaths }
      );
      opfsMounts = mounted.mounts;
    } catch (err) {
      pushWarning(`VFS→Pyodide OPFS mount failed: ${describeRealmError(err)}`);
    }
  }

  // Materialize VFS mount subtrees into MEMFS via the `vfs` RPC
  // channel. Local FS Access mounts always materialize; remote
  // (s3/da) mounts are subject to `remoteMountCapBytes` (0 = skip).
  // Cap exceeded throws — caught below to fail the invocation with
  // a clear error before user code runs. The returned snapshots feed
  // `flushRealmMountWriteBack` after user code completes.
  let mountMaterializationFailure: string | null = null;
  let mountSnapshots: RealmMountSnapshot[] = [];
  if (mountPoints.length > 0) {
    try {
      mountSnapshots = await materializeRealmMounts(
        pyodide,
        mountPoints,
        init.remoteMountCapBytes,
        rpc,
        pushWarning
      );
    } catch (err) {
      mountMaterializationFailure = err instanceof Error ? err.message : String(err);
    }
  }
  if (mountMaterializationFailure !== null) {
    rpc.dispose();
    const done: RealmDoneMsg = {
      type: 'realm-done',
      stdout: '',
      stderr: stderrChunks.join('') + mountMaterializationFailure + '\n',
      exitCode: 1,
    };
    port.postMessage(done);
    return;
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

  // Mount write-back: diff each materialized mount subtree against
  // its current MEMFS state and route created/modified/removed
  // entries back through the `vfs` RPC channel so the source backend
  // (local FS Access / S3 / DA) persists Python's edits. Runs before
  // the OPFS flush so backend errors surface as warnings before
  // realm-done.
  if (mountSnapshots.length > 0) {
    try {
      await flushRealmMountWriteBack(pyodide, mountSnapshots, rpc, pushWarning);
    } catch (err) {
      pushWarning(`mount write-back failed: ${describeRealmError(err)}`);
    }
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
      // Emscripten rejects `FS.mount(_, _, '/')` with EBUSY because
      // its root MEMFS is already mounted. Fan out to the top-level
      // children of the kernel OPFS subtree instead so Python can
      // still reach the VFS by absolute path (`/workspace`, …) when
      // the shell cwd is `/`. Built-in mount points are skipped so
      // we don't shadow `/dev`, `/proc`, `/lib`, `/tmp`, `/home`.
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
  mounts.push({ pyPath, mount, rootHandle: handle, flushBuffers: buffered.flush });
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

// ---------------------------------------------------------------------------
// Mount materialization (VFS mount subtrees → MEMFS in the realm)
// ---------------------------------------------------------------------------

/**
 * One file/dir entry discovered while walking a mount subtree via
 * the `vfs` RPC channel. `size` is only meaningful for files; dirs
 * report 0 since the cap only counts file bytes.
 */
interface MountListingEntry {
  absPath: string;
  type: 'file' | 'directory';
  size: number;
}

/**
 * Recursively enumerate every file and directory under `root` via
 * the realm RPC channel. Calls `vfs.readDir` per directory and
 * `vfs.stat` per entry to discover the listing + file sizes. Used
 * for both the cap pre-check and the materialization populate pass.
 *
 * Per-entry failures are best-effort: a single bad `stat` skips
 * that entry rather than failing the whole walk. The caller surfaces
 * a warning if the entire walk fails.
 */
async function walkMountViaRpc(rpc: RealmRpcClient, root: string): Promise<MountListingEntry[]> {
  const out: MountListingEntry[] = [];
  async function visit(path: string): Promise<void> {
    let names: string[];
    try {
      names = await rpc.call<string[]>('vfs', 'readDir', [path]);
    } catch {
      return;
    }
    for (const name of names) {
      const child = path === '/' ? `/${name}` : `${path}/${name}`;
      let st: { isDirectory: boolean; isFile: boolean; size: number };
      try {
        st = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
          'vfs',
          'stat',
          [child]
        );
      } catch {
        continue;
      }
      if (st.isDirectory) {
        out.push({ absPath: child, type: 'directory', size: 0 });
        await visit(child);
      } else if (st.isFile) {
        out.push({ absPath: child, type: 'file', size: st.size ?? 0 });
      }
    }
  }
  await visit(root);
  return out;
}

/**
 * Build the actionable cap-exceeded error message used to fail the
 * Python invocation. Names each remote mount with its individual
 * contribution plus the cap, and suggests the two escape hatches
 * ({@code --remote-mount-cap=0} or a higher value).
 */
function formatCapExceededError(
  totalBytes: number,
  capBytes: number,
  perMount: { path: string; bytes: number }[]
): string {
  const offenders = perMount.filter((e) => e.bytes > 0);
  const lines = offenders.map((e) => `  ${e.path}: ${e.bytes} bytes`);
  return (
    `remote-mount cap exceeded: ${totalBytes} bytes across ${offenders.length} ` +
    `remote mount(s) > cap ${capBytes} bytes\n` +
    lines.join('\n') +
    (lines.length > 0 ? '\n' : '') +
    `Re-run with --remote-mount-cap=0 (disable remote mounts) or a higher value.`
  );
}

/**
 * Materialize each {@link RealmMountPoint} into the Pyodide FS so
 * Python reads of `<mountPath>/…` return real backend content. For
 * each overlapping mount this:
 *   1. ensures the mount path exists in the Pyodide FS;
 *   2. mounts MEMFS over it (so the OPFS placeholder underneath is
 *      shadowed);
 *   3. populates the MEMFS subtree with files + dirs walked via the
 *      `vfs` RPC channel (`readDir` / `stat` / `readFileBinary`).
 *
 * Remote-mount cap enforcement: BEFORE fetching any file bodies the
 * function sums the listing sizes of all remote (s3/da) mounts. If
 * the total exceeds `remoteMountCapBytes`, it throws an error whose
 * message names the offending mount(s) and the total vs cap — the
 * caller converts this throw into a `realm-done` with exit 1 so the
 * `python3` invocation fails cleanly before user code runs. A cap
 * of `0` short-circuits remote materialization (remote mounts appear
 * as empty MEMFS dirs; no fetches, no error). `undefined` disables
 * the cap entirely. Local FS Access mounts are exempt and always
 * materialize.
 */
export async function materializeRealmMounts(
  pyodide: PyodideInterface,
  mountPoints: readonly RealmMountPoint[],
  remoteMountCapBytes: number | undefined,
  rpc: RealmRpcClient,
  pushWarning: WarningSink = () => {}
): Promise<RealmMountSnapshot[]> {
  if (mountPoints.length === 0) return [];
  const skipRemoteFetch = remoteMountCapBytes === 0;
  const listings = new Map<string, MountListingEntry[]>();
  const sizes = new Map<string, number>();

  // Phase 1: list every overlapping mount up-front so the cap check
  // sees the total before any body fetch happens.
  for (const mp of mountPoints) {
    if (mp.kind !== 'local' && skipRemoteFetch) {
      listings.set(mp.path, []);
      sizes.set(mp.path, 0);
      continue;
    }
    try {
      const listing = await walkMountViaRpc(rpc, mp.path);
      listings.set(mp.path, listing);
      let total = 0;
      for (const e of listing) if (e.type === 'file') total += e.size;
      sizes.set(mp.path, total);
    } catch (err) {
      pushWarning(`mount '${mp.path}': listing failed: ${describeRealmError(err)}`);
      listings.set(mp.path, []);
      sizes.set(mp.path, 0);
    }
  }

  // Phase 2: enforce remote cap. Local mounts are exempt; only s3/da
  // count toward the budget.
  if (remoteMountCapBytes !== undefined && remoteMountCapBytes > 0) {
    const perRemote: { path: string; bytes: number }[] = [];
    let total = 0;
    for (const mp of mountPoints) {
      if (mp.kind === 'local') continue;
      const bytes = sizes.get(mp.path) ?? 0;
      total += bytes;
      perRemote.push({ path: mp.path, bytes });
    }
    if (total > remoteMountCapBytes) {
      throw new Error(formatCapExceededError(total, remoteMountCapBytes, perRemote));
    }
  }

  // Phase 3: mount MEMFS over each path + populate. Capture per-mount
  // snapshots (the files we wrote and the dirs we created) so the
  // post-exec write-back can diff MEMFS against the materialized
  // baseline.
  const FS = pyodide.FS as unknown as {
    stat: (path: string) => unknown;
    mkdirTree: (path: string) => void;
    mount: (plugin: unknown, opts: unknown, dir: string) => unknown;
    writeFile: (path: string, data: Uint8Array) => void;
    filesystems: Record<string, unknown>;
  };
  const MEMFS = FS.filesystems.MEMFS;
  const snapshots: RealmMountSnapshot[] = [];
  for (const mp of mountPoints) {
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>();
    try {
      try {
        FS.stat(mp.path);
      } catch {
        FS.mkdirTree(mp.path);
      }
      if (MEMFS) {
        try {
          FS.mount(MEMFS, {}, mp.path);
        } catch (err) {
          pushWarning(`mount '${mp.path}': MEMFS overlay failed: ${describeRealmError(err)}`);
        }
      }
      if (mp.kind === 'local' || !skipRemoteFetch) {
        const listing = listings.get(mp.path) ?? [];
        for (const entry of listing) {
          if (entry.type === 'directory') {
            try {
              FS.mkdirTree(entry.absPath);
              dirs.add(entry.absPath);
            } catch {
              /* exists */
            }
            continue;
          }
          try {
            const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [entry.absPath]);
            const parent = entry.absPath.slice(0, entry.absPath.lastIndexOf('/')) || '/';
            try {
              FS.mkdirTree(parent);
            } catch {
              /* exists */
            }
            const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            FS.writeFile(entry.absPath, data);
            files.set(entry.absPath, data);
          } catch (err) {
            pushWarning(`mount '${entry.absPath}': read failed: ${describeRealmError(err)}`);
          }
        }
      }
    } catch (err) {
      pushWarning(`mount '${mp.path}': materialize failed: ${describeRealmError(err)}`);
    }
    snapshots.push({ path: mp.path, kind: mp.kind, files, dirs });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Mount write-back (MEMFS → backend via the `vfs` RPC channel)
// ---------------------------------------------------------------------------

/**
 * Per-mount snapshot captured at the end of {@link materializeRealmMounts}.
 * The {@link files} map carries the exact bytes written into MEMFS
 * (keyed by absolute Pyodide-FS path) and {@link dirs} carries every
 * directory created under the mount root. {@link flushRealmMountWriteBack}
 * diffs the current MEMFS state against this baseline to decide what
 * to write, create, or remove on the backend.
 */
export interface RealmMountSnapshot {
  path: string;
  kind: RealmMountPoint['kind'];
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

/**
 * Synchronously walk a Pyodide MEMFS subtree rooted at `root` and
 * collect every file's bytes plus every directory path. Used by the
 * write-back diff — Emscripten's `FS.readdir`/`stat`/`readFile` are
 * all sync so the walk is a tight loop with no RPC traffic.
 *
 * Per-entry failures (transient lookup errors, unreadable nodes) are
 * skipped silently so a single bad entry doesn't drop the rest of
 * the diff. The caller surfaces backend-side errors when it actually
 * tries to flush the result.
 */
function walkPyMemfsTree(
  pyodide: PyodideInterface,
  root: string
): { files: Map<string, Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const FS = pyodide.FS as unknown as {
    readdir: (path: string) => string[];
    stat: (path: string) => { mode: number };
    isDir: (mode: number) => boolean;
    isFile: (mode: number) => boolean;
    readFile: (path: string, opts: { encoding: 'binary' }) => Uint8Array;
  };
  function visit(path: string): void {
    let names: string[];
    try {
      names = FS.readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const child = path === '/' ? `/${name}` : `${path}/${name}`;
      let mode: number;
      try {
        mode = FS.stat(child).mode;
      } catch {
        continue;
      }
      if (FS.isDir(mode)) {
        dirs.add(child);
        visit(child);
      } else if (FS.isFile(mode)) {
        try {
          files.set(child, FS.readFile(child, { encoding: 'binary' }));
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  visit(root);
  return { files, dirs };
}

/** Byte-wise equality for two Uint8Arrays — distinguishes content changes from no-ops. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reduce a set of removed paths to just the top-level entries — any
 * path whose ancestor is also in the set is dropped, since `vfs.rm`
 * routes through `VirtualFS.rm` with `recursive:true` and would
 * cascade through the descendants anyway. Removes the duplicate
 * `rm` traffic and the spurious ENOENT warnings the descendants
 * would emit if issued after the parent.
 */
function topLevelRemovals(removed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const path of removed) {
    const parts = path.split('/').filter(Boolean);
    let hasAncestor = false;
    for (let i = 1; i < parts.length; i++) {
      const ancestor = '/' + parts.slice(0, i).join('/');
      if (removed.has(ancestor)) {
        hasAncestor = true;
        break;
      }
    }
    if (!hasAncestor) out.push(path);
  }
  return out;
}

/**
 * For each {@link RealmMountSnapshot}, walk the current MEMFS subtree,
 * diff it against the materialized baseline, and route the differences
 * back through the `vfs` RPC channel:
 *
 *   • file present now but absent (or with different bytes) in the
 *     snapshot → `vfs.writeFileBinary`
 *   • directory present now but absent in the snapshot → `vfs.mkdir`
 *   • file or directory in the snapshot but absent now → `vfs.rm`
 *     (top-level only — recursive rm cascades through descendants)
 *
 * `VirtualFS.writeFile` / `mkdir` / `rm` route mount-resident paths
 * through `MountBackend` so the source (local FS Access / S3 / DA)
 * receives the write. Per-entry backend rejections are surfaced as
 * stderr warnings via {@link pushWarning} and the diff continues —
 * one failed PUT must not strand other writes from the same run.
 */
async function tryVfsRpc(
  rpc: RealmRpcClient,
  op: 'writeFileBinary' | 'mkdir' | 'rm',
  args: unknown[],
  onError: (err: unknown) => void
): Promise<void> {
  try {
    await rpc.call('vfs', op, args);
  } catch (err) {
    onError(err);
  }
}

function collectRemovedPaths(
  snap: RealmMountSnapshot,
  current: { files: Map<string, Uint8Array>; dirs: Set<string> }
): Set<string> {
  const removed = new Set<string>();
  for (const path of snap.files.keys()) {
    if (!current.files.has(path)) removed.add(path);
  }
  for (const path of snap.dirs) {
    if (!current.dirs.has(path)) removed.add(path);
  }
  return removed;
}

async function flushOneMountWriteBack(
  pyodide: PyodideInterface,
  snap: RealmMountSnapshot,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  let current: { files: Map<string, Uint8Array>; dirs: Set<string> };
  try {
    current = walkPyMemfsTree(pyodide, snap.path);
  } catch (err) {
    pushWarning(`mount '${snap.path}': write-back walk failed: ${describeRealmError(err)}`);
    return;
  }

  // Writes: new or changed files.
  for (const [path, bytes] of current.files) {
    const orig = snap.files.get(path);
    if (orig && bytesEqual(orig, bytes)) continue;
    await tryVfsRpc(rpc, 'writeFileBinary', [path, bytes], (err) =>
      pushWarning(
        `mount '${snap.path}': write-back of '${path}' failed: ${describeRealmError(err)}`
      )
    );
  }

  // New directories: those in current MEMFS but not in snapshot.
  for (const path of current.dirs) {
    if (snap.dirs.has(path)) continue;
    await tryVfsRpc(rpc, 'mkdir', [path], (err) =>
      pushWarning(`mount '${snap.path}': mkdir of '${path}' failed: ${describeRealmError(err)}`)
    );
  }

  // Removals: in snapshot but no longer in MEMFS. Collapse to top-
  // level entries so recursive rm cascades through descendants.
  for (const path of topLevelRemovals(collectRemovedPaths(snap, current))) {
    await tryVfsRpc(rpc, 'rm', [path], (err) =>
      pushWarning(`mount '${snap.path}': remove of '${path}' failed: ${describeRealmError(err)}`)
    );
  }
}

export async function flushRealmMountWriteBack(
  pyodide: PyodideInterface,
  snapshots: readonly RealmMountSnapshot[],
  rpc: RealmRpcClient,
  pushWarning: WarningSink = () => {}
): Promise<void> {
  for (const snap of snapshots) {
    await flushOneMountWriteBack(pyodide, snap, rpc, pushWarning);
  }
}
