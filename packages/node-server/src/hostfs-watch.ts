/**
 * Watch configured hostfs mount roots and broadcast `hostfs_invalidate`
 * over `/licks-ws` so the webapp can drop RemoteMountCache keys when the
 * OS changes a file outside SLICC (Finder, another editor, git on the host).
 *
 * Uses `fs.watch({ recursive: true })` (Node ≥ 19.1 on Linux; long-supported
 * on macOS/Windows). Events are debounced per mount and coalesced into one
 * broadcast; a storm larger than {@link MAX_PATHS_PER_EVENT} clears the whole
 * mount cache instead of shipping a huge path list.
 */

import { type FSWatcher, watch } from 'fs';
import { relative, sep } from 'path';

import type { HostMountRoot } from './hostfs.js';

/** Coalesce bursty FSEvents into one WS message. */
export const HOSTFS_WATCH_DEBOUNCE_MS = 75;

/**
 * Above this many distinct relative paths in one debounce window, broadcast
 * an empty `paths` list (= clear the whole mount cache).
 */
export const MAX_PATHS_PER_EVENT = 64;

export interface HostfsInvalidateBroadcast {
  type: 'hostfs_invalidate';
  mount: string;
  paths: string[];
  timestamp: string;
}

export interface HostFsWatchHandle {
  /** Stop every watcher. Idempotent. */
  stop(): void;
}

export interface StartHostFsWatchersOptions {
  debounceMs?: number;
  maxPathsPerEvent?: number;
  /** Injectable for tests. */
  watchFn?: typeof watch;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Map an `fs.watch` filename (relative to the watched root, or absolute on
 * some platforms) onto a mount-relative POSIX path. Empty string asks the
 * client to clear the mount when the event cannot be attributed safely.
 */
export function toMountRelativePath(
  root: string,
  filename: string | null | undefined
): string | null {
  if (filename == null || filename.length === 0) return '';
  const abs = filename.startsWith(root) ? filename : `${root}${sep}${filename}`;
  let rel = relative(root, abs);
  if (rel === '') return '';
  // `..data` is a valid child name; only a whole `..` segment escapes.
  // Clear on a true escape rather than dropping the invalidation.
  if (rel === '..' || rel.startsWith(`..${sep}`)) return '';
  // Watchers may report Windows separators; the VFS / cache keys are POSIX.
  rel = rel.split(sep).join('/');
  return rel;
}

export function buildHostfsInvalidateEvent(
  mount: string,
  paths: Iterable<string>,
  maxPaths: number = MAX_PATHS_PER_EVENT
): HostfsInvalidateBroadcast {
  const unique = [...new Set(paths)];
  // Empty string in the set means "unknown / whole root" — clear the mount.
  if (unique.includes('') || unique.length > maxPaths) {
    return {
      type: 'hostfs_invalidate',
      mount,
      paths: [],
      timestamp: new Date().toISOString(),
    };
  }
  return {
    type: 'hostfs_invalidate',
    mount,
    paths: unique,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Start one recursive watcher per mount root. Failures to open a watcher
 * are logged and skipped — a missing watch must not take the /api surface down.
 */
export function startHostFsWatchers(
  roots: readonly HostMountRoot[],
  broadcast: (event: HostfsInvalidateBroadcast) => void,
  opts: StartHostFsWatchersOptions = {}
): HostFsWatchHandle {
  const debounceMs = opts.debounceMs ?? HOSTFS_WATCH_DEBOUNCE_MS;
  const maxPaths = opts.maxPathsPerEvent ?? MAX_PATHS_PER_EVENT;
  const watchFn = opts.watchFn ?? watch;
  const setTimer = opts.setTimeoutFn ?? setTimeout;
  const clearTimer = opts.clearTimeoutFn ?? clearTimeout;

  const watchers: FSWatcher[] = [];
  const pending = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flush = (mount: string): void => {
    timers.delete(mount);
    const paths = pending.get(mount);
    pending.delete(mount);
    if (!paths || paths.size === 0) return;
    broadcast(buildHostfsInvalidateEvent(mount, paths, maxPaths));
  };

  const note = (mount: string, rel: string | null): void => {
    if (rel === null) return;
    let set = pending.get(mount);
    if (!set) {
      set = new Set();
      pending.set(mount, set);
    }
    set.add(rel);
    const existing = timers.get(mount);
    if (existing) clearTimer(existing);
    timers.set(
      mount,
      setTimer(() => flush(mount), debounceMs)
    );
  };

  for (const { path: mount, root } of roots) {
    try {
      const watcher = watchFn(root, { recursive: true }, (_event, filename) => {
        note(mount, toMountRelativePath(root, filename));
      });
      watcher.on('error', (err) => {
        console.warn(`[hostfs-watch] watcher error for ${mount}:`, err);
      });
      watchers.push(watcher);
      console.log(`[hostfs-watch] watching ${root} → ${mount}`);
    } catch (err) {
      console.warn(
        `[hostfs-watch] failed to watch ${root} (${mount}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    stop(): void {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      pending.clear();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      watchers.length = 0;
    },
  };
}
