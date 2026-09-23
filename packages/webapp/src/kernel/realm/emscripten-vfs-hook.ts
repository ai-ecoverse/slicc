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
 * mutations are flushed before the mount and before every write the tool
 * makes, and each tool write then invalidates that cache (even if it threw,
 * and even before the script's first sync `fs` call, so the boot snapshot
 * can't serve stale bytes), so a later `fs.readFileSync` in the same script
 * sees the tool's output.
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
 * Pending cache writes are flushed BEFORE the op — so the tool sees a pending
 * `mkdirSync`, and a pending `rmSync` can't later delete the tool's output —
 * and the cache is invalidated after it, in a `finally`: the bridge is
 * at-least-once, so a mutation that threw may still have landed. The
 * invalidate is unconditional: a never-used cache still holds the boot
 * snapshot, which the tool's write may have made stale.
 */
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

/** Every top-level VFS directory the module should see. */
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
