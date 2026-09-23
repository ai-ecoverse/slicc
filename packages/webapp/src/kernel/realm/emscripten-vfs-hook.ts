/**
 * `globalThis.__slicc_mountVfs(FS, { cwd })` — mount the live kernel VFS into
 * an Emscripten module running in the JS realm.
 *
 * A wasm tool (clang, wasm-ld, make, …) built with a classic Emscripten `FS`
 * calls this once its runtime is initialized, before `callMain`. Every
 * top-level VFS directory is mounted through `SLICC_LIVE_FS`
 * (`live-vfs-fs.ts`) at the same path, and the module's cwd follows the
 * realm's, so the tool reads and writes the same files the shell sees —
 * mounts included, with the realm's path ACLs.
 *
 * Coherence with the realm's own sync `fs` cache: pending `fs.writeFileSync`
 * mutations are flushed before the mount, and every write the tool makes
 * flushes-then-invalidates that cache (only when the script used it), so a
 * later `fs.readFileSync` in the same script sees the tool's output.
 */

import {
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveMountFsApi,
  mountLiveVfsDirs,
} from './live-vfs-fs.js';
import { flushBeforeSyncExec } from './sync-exec-xhr-bridge.js';
import type { SyncFsCache } from './sync-fs-cache.js';
import type { SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';

/** Top-level names left to the module's own filesystem. */
const MODULE_OWNED_DIRS = new Set(['dev', 'proc']);

/** An Emscripten `FS` the hook can mount into. */
export interface EmscriptenFsForHook extends LiveMountFsApi {
  chdir(path: string): void;
}

export interface EmscriptenVfsHandle {
  /** Mountpoints that mounted. */
  mounted: string[];
  /** Write back the tool's open dirty buffers (before spawning a child). */
  flush(): void;
  /** Drop cached VFS state (after a child ran). */
  invalidate(): void;
}

export interface EmscriptenVfsHookDeps {
  bridge: SyncFsPosixBridge;
  syncFs: SyncFsCache;
  /** Realm cwd, used when the caller passes none. */
  cwd: string;
  warn: (message: string) => void;
}

/** The bridge ops that change the VFS; each is followed by a cache resync. */
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

/**
 * Wrap `bridge` so each mutation keeps the realm's sync `fs` cache coherent.
 * The flush comes first: `invalidate` drops pending cache writes, so they
 * must reach the VFS before it runs.
 */
function coherentBridge(bridge: SyncFsPosixBridge, syncFs: SyncFsCache): SyncFsPosixBridge {
  const wrapped: SyncFsPosixBridge = { ...bridge };
  for (const name of MUTATING) {
    const op = bridge[name] as (...args: unknown[]) => void;
    (wrapped[name] as (...args: unknown[]) => void) = (...args: unknown[]) => {
      op.apply(bridge, args);
      if (!syncFs.wasUsed()) return;
      flushBeforeSyncExec(syncFs, bridge);
      syncFs.invalidate();
    };
  }
  return wrapped;
}

/** Every top-level VFS directory the module should see. */
function topLevelDirs(bridge: SyncFsPosixBridge): string[] {
  const dirs: string[] = [];
  for (const name of bridge.readdir('/')) {
    if (!name || name.includes('/') || MODULE_OWNED_DIRS.has(name)) continue;
    try {
      if (bridge.stat(`/${name}`).isDirectory) dirs.push(`/${name}`);
    } catch {
      /* vanished or not readable — skip */
    }
  }
  return dirs;
}

/** Mount the live VFS into `Fs`; the body of `__slicc_mountVfs`. */
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
    topLevelDirs(bridge),
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
