/**
 * Wires the live-VFS filesystem (`live-vfs-fs.ts`) and the `subprocess` shim
 * (`py-subprocess.ts`) into a Pyodide realm.
 *
 * Active whenever the realm has a synchronous bridge (SAB on an isolated
 * leader, else the SW route). Without one — or with `SLICC_PY_FS=opfs` in the
 * environment — the realm keeps the `OPFS_SYNC_FS` preload path and no
 * `subprocess`, since a child could not see Python's buffered writes there.
 */

import type { PyodideInterface } from 'pyodide';
import {
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveMountFsApi,
  type LiveVfsPlugin,
  mountLiveVfsDirs,
} from './live-vfs-fs.js';
import { installPySubprocess } from './py-subprocess.js';
import type { RealmPortLike } from './realm-rpc.js';
import { resolveSyncFsBridge, resolveSyncSabTransport } from './realm-sync-transport.js';
import type { RealmInitMsg } from './realm-types.js';
import { createSyncExecXhrBridge } from './sync-exec-xhr-bridge.js';
import { createSyncExecSabTransport } from './sync-sab-bridge.js';

/** Escape hatch back to the OPFS preload path. */
export const PY_FS_ENV = 'SLICC_PY_FS';

export interface PyLiveVfs {
  plugin: LiveVfsPlugin;
  /** Write back dirty buffers (a file Python left open at exit). */
  flush(): void;
  /** Mountpoints that mounted. */
  mounted: string[];
}

/**
 * Mount the live VFS over `init.pyodideMountDirs` (default `[cwd, /tmp]`) and
 * install `subprocess`. Returns `undefined` when the realm should fall back
 * to the OPFS path.
 */
export function mountPyLiveVfs(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  port: RealmPortLike,
  warn: (message: string) => void
): PyLiveVfs | undefined {
  if (init.env?.[PY_FS_ENV] === 'opfs') return undefined;
  const sab = resolveSyncSabTransport(init, port);
  const bridge = resolveSyncFsBridge(init, sab);
  if (!bridge || !init.syncFsToken) return undefined;

  const FS = pyodide.FS as unknown as LiveMountFsApi;
  const { plugin, mounted } = mountLiveVfsDirs(
    FS,
    bridge,
    init.pyodideMountDirs ?? [init.cwd, '/tmp'],
    warn
  );
  if (mounted.length === 0) return undefined;

  const exec = createSyncExecXhrBridge(init.syncFsToken, {
    ...(sab ? { transport: createSyncExecSabTransport(sab), noDefaultDeadline: true } : {}),
  });
  installPySubprocess(pyodide, {
    exec,
    beforeExec: () => flushLiveVfs(FS, plugin),
    afterExec: () => invalidateLiveVfs(FS, plugin),
  });
  return { plugin, mounted, flush: () => flushLiveVfs(FS, plugin) };
}
