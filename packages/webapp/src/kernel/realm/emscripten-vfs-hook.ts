import {
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveMountFsApi,
  mountLiveVfsDirs,
} from './live-vfs-fs.js';
import { flushBeforeSyncExec } from './sync-exec-xhr-bridge.js';
import type { SyncFsCache } from './sync-fs-cache.js';
import type { SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';

const MODULE_OWNED_DIRS = new Set(['dev', 'proc']);

export interface EmscriptenFsForHook extends LiveMountFsApi {
  chdir(path: string): void;
}

export interface EmscriptenVfsHandle {
  mounted: string[];

  flush(): void;

  invalidate(): void;
}

export interface EmscriptenVfsHookDeps {
  bridge: SyncFsPosixBridge;
  syncFs: SyncFsCache;

  cwd: string;
  warn: (message: string) => void;
}

const MUTATING = [
  'writeFile',
  'mkdir',
  'rm',
  'rename',
  'unlink',
  'rmdir',
  'symlink',
  'chmod',
  'utimes',
] as const;

function coherentBridge(bridge: SyncFsPosixBridge, syncFs: SyncFsCache): SyncFsPosixBridge {
  const wrapped: SyncFsPosixBridge = { ...bridge };
  for (const name of MUTATING) {
    const op = bridge[name] as (...args: unknown[]) => void;
    (wrapped[name] as (...args: unknown[]) => void) = (...args: unknown[]) => {
      if (syncFs.wasUsed()) flushBeforeSyncExec(syncFs, bridge);
      try {
        op.apply(bridge, args);
      } finally {
        syncFs.invalidate();
      }
    };
  }
  return wrapped;
}

function topLevelDirs(bridge: SyncFsPosixBridge, warn: (message: string) => void): string[] {
  let names: string[];
  try {
    names = bridge.readdir('/');
  } catch (err) {
    warn(`cannot list the VFS root, nothing mounted: ${String(err)}`);
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (!name || name.includes('/') || MODULE_OWNED_DIRS.has(name)) continue;
    try {
      if (bridge.stat(`/${name}`).isDirectory) dirs.push(`/${name}`);
    } catch {}
  }
  return dirs;
}

export function mountVfsIntoEmscripten(
  Fs: EmscriptenFsForHook,
  deps: EmscriptenVfsHookDeps,
  opts: { cwd?: string } = {}
): EmscriptenVfsHandle {
  const { bridge, syncFs, warn } = deps;
  if (syncFs.wasUsed()) flushBeforeSyncExec(syncFs, bridge);
  const { plugin, mounted } = mountLiveVfsDirs(
    Fs,
    coherentBridge(bridge, syncFs),
    topLevelDirs(bridge, warn),
    warn
  );
  try {
    Fs.chdir(opts.cwd ?? deps.cwd);
  } catch (err) {
    warn(`cannot chdir to ${opts.cwd ?? deps.cwd}: ${String(err)}`);
  }
  return {
    mounted,
    flush: () => flushLiveVfs(Fs, plugin),
    invalidate: () => invalidateLiveVfs(Fs, plugin),
  };
}
