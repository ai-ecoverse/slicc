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

export const PY_FS_ENV = 'SLICC_PY_FS';

export interface PyLiveVfs {
  plugin: LiveVfsPlugin;

  flush(): void;

  mounted: string[];
}

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
    ...(sab ? { transport: createSyncExecSabTransport(sab) } : {}),
  });
  installPySubprocess(pyodide, {
    exec,
    beforeExec: () => flushLiveVfs(FS, plugin),
    afterExec: () => invalidateLiveVfs(FS, plugin),
  });
  return { plugin, mounted, flush: () => flushLiveVfs(FS, plugin) };
}
