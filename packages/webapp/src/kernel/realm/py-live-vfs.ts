import type { PyodideInterface } from 'pyodide';
import {
  createLiveVfsPlugin,
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveFsApi,
  type LiveVfsPlugin,
} from './live-vfs-fs.js';
import { installPySubprocess } from './py-subprocess.js';
import type { RealmPortLike } from './realm-rpc.js';
import { resolveSyncFsBridge, resolveSyncSabTransport } from './realm-sync-transport.js';
import type { RealmInitMsg } from './realm-types.js';
import { createSyncExecXhrBridge } from './sync-exec-xhr-bridge.js';
import { createSyncExecSabTransport } from './sync-sab-bridge.js';

export const PY_FS_ENV = 'SLICC_PY_FS';

interface PyodideFsForLive extends LiveFsApi {
  filesystems: { SLICC_LIVE_FS?: LiveVfsPlugin };
  mkdirTree(path: string): void;
  mount(type: LiveVfsPlugin, opts: unknown, mountpoint: string): unknown;
}

export interface PyLiveVfs {
  plugin: LiveVfsPlugin;

  flush(): void;

  mounted: string[];
}

function outermostDirs(dirs: readonly string[]): string[] {
  const norm = [...new Set(dirs.map((d) => d.replace(/\/+$/, '') || '/'))].sort();
  return norm.filter((d) => !norm.some((o) => o !== d && (o === '/' || d.startsWith(`${o}/`))));
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

  const FS = pyodide.FS as unknown as PyodideFsForLive;
  const plugin = FS.filesystems.SLICC_LIVE_FS ?? createLiveVfsPlugin(FS);
  FS.filesystems.SLICC_LIVE_FS = plugin;

  const mounted: string[] = [];
  for (const dir of outermostDirs(init.pyodideMountDirs ?? [init.cwd, '/tmp'])) {
    if (dir === '/') continue;
    try {
      FS.mkdirTree(dir);
      FS.mount(plugin, { root: dir, bridge }, dir);
      mounted.push(dir);
    } catch (err) {
      warn(`live VFS mount of ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
