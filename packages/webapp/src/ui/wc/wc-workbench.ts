/**
 * Workbench wiring for the live WC shell: the VFS-backed file tree and the
 * panel terminal. The terminal reuses `RemoteTerminalView` — the same
 * worker-shell xterm the legacy layout mounts — inside the workbench's
 * `term` surface; `<slicc-terminal>` replaces it once the library terminal
 * learns session attachment.
 */

import type { SliccFileTree, SliccMonitor } from '@slicc/webcomponents';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { toPreviewUrl } from '../../shell/supplemental-commands/shared.js';
import { PRIMARY_WORKSPACE } from '../../work-unit/descriptor.js';
import type { WorkUnitWorkspace } from '../../work-unit/types.js';
import { wireFileActions } from './file-actions.js';
import { MonitorHistory } from './monitor-history.js';
import { buildMemoryRows } from './wc-memory.js';
import { fetchMonitorData, type MonitorDeps } from './wc-monitor.js';

type FileTreeItem = NonNullable<SliccFileTree['items']>[number];

/** Directory shared by every unit, always shown beside the selected root. */
const SHARED_TREE_ROOT = '/shared';
const MAX_DEPTH = 3;
const MAX_ENTRIES_PER_DIR = 200;

async function dirChildren(
  fs: LocalVfsClient,
  dir: string,
  depth: number
): Promise<FileTreeItem[]> {
  let entries: Awaited<ReturnType<LocalVfsClient['readDir']>>;
  try {
    // Always ask for listing stats: every file entry is sized immediately
    // below, and on an FSA mount that is one getFile per file rather than a
    // listing plus a follow-up getFileHandle+getFile (#2765).
    entries = await fs.readDir(dir, { includeStats: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.type === 'directory')
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.type === 'file')
    .sort((a, b) => a.name.localeCompare(b.name));

  const capped = [...dirs, ...files].slice(0, MAX_ENTRIES_PER_DIR);

  // Sizes come from the listing when the backend reported them there
  // (#2716) — over a hostfs mount, stat'ing what we just listed is one
  // bridge round trip per file. Only the entries a listing left unknown
  // are stat'd, in parallel; failures degrade gracefully to no size.
  const sizeMap = new Map<string, number>();
  const unsized: string[] = [];
  for (const entry of capped) {
    if (entry.type !== 'file') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.size !== undefined) sizeMap.set(path, entry.size);
    else unsized.push(path);
  }
  const stats = await Promise.allSettled(unsized.map((p) => fs.stat(p)));
  unsized.forEach((p, i) => {
    const r = stats[i];
    if (r?.status === 'fulfilled') sizeMap.set(p, r.value.size);
  });

  const items: FileTreeItem[] = [];
  for (const entry of capped) {
    const path = `${dir}/${entry.name}`;
    if (entry.type === 'directory') {
      items.push({
        kind: 'dir',
        id: path,
        // The chevron already says "folder" — a trailing slash is noise.
        label: entry.name,
        children: depth < MAX_DEPTH ? await dirChildren(fs, path, depth + 1) : [],
      });
    } else {
      const size = sizeMap.get(path);
      items.push({ kind: 'file', id: path, label: entry.name, path, size });
    }
  }
  return items;
}

/**
 * Build `<slicc-file-tree>` items for the VFS workbench roots — the SELECTED
 * cone's workspace plus `/shared` (#2271) — each rendered as an expanded `dir`
 * item so it looks and behaves like any other folder (chevron, collapsible,
 * consistent icon).
 */
export async function buildVfsTreeItems(
  fs: LocalVfsClient,
  workspaceRoot: string = PRIMARY_WORKSPACE.root
): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = [];
  for (const root of [workspaceRoot, SHARED_TREE_ROOT]) {
    items.push({
      kind: 'dir',
      id: root,
      // `workspace` / `shared` for the primary cone; an extra cone's root is
      // `/cones/<folder>/workspace`, where the folder is what identifies it.
      label: root.replace(/^\/(cones\/)?/, ''),
      open: true,
      children: await dirChildren(fs, root, 1),
    });
  }
  return items;
}

export interface WcWorkbenchDeps {
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  /** Container the memory rows render into. */
  memoryHost: HTMLElement & { setRows?(rows: readonly HTMLElement[]): void };
  /** The `<slicc-monitor>` component. */
  monitor: SliccMonitor;
  /** Lazily resolved page-side VFS reader (routed through the worker's VfsRpcHost). */
  openFs(): Promise<LocalVfsClient>;
  /** Lazily resolved page-side VFS writer (routed through the worker's VfsRpcHost). */
  openWriter(): Promise<WritableVfsClient>;
  getMonitorDeps(): MonitorDeps;
  /** Mounts the worker-shell terminal into the surface; resolves on attach. */
  mountTerminal(container: HTMLElement): Promise<void>;
  /**
   * Fires `fn` once the kernel's VfsRpcHost is attached (immediately if it
   * already is). Used to avoid sending VFS RPCs before the worker is ready,
   * which would cause them to hang until the timer rescues them.
   */
  onKernelReady(fn: () => void): void;
  /** Injects @/path/to/file mention token into ChatPanel input. */
  insertReference(path: string): void;
  /**
   * Filesystem coordinates of the cone whose files the workbench shows — the
   * root that owns the current selection (#2271). Read per refresh; switching
   * cones re-points the tree via `refreshFiles()`, which also re-aims the
   * change subscription at the new roots.
   */
  getWorkspace(): WorkUnitWorkspace;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Per-panel lifecycle handle returned by {@link createWorkbenchActivator}. */
export interface WorkbenchActivator {
  /** Open (or re-open) a panel — starts its subscription / poller / content. */
  activate(surfaceId: string): void;
  /** Panel left the tree (closed/removed) — stops its subscription / poller. */
  deactivate(surfaceId: string): void;
  /**
   * Re-read the memory panel because the SELECTION moved (#2271). The panel's
   * rows come from the cone that owns the selection and memory reads once per
   * activation, so an open panel would otherwise keep showing the previous
   * cone's memory indefinitely. No-op while the panel is closed.
   */
  refreshMemory(): void;
  /**
   * Re-point the file tree because the SELECTION moved (#2271). Rebuilds from
   * the newly selected cone's roots and re-aims the change subscription at
   * them — a selection change is not a filesystem change, so no event will
   * announce it. No-op while the panel is closed.
   */
  refreshFiles(): void;
}

/**
 * Coalescing window for filesystem change events (ms).
 *
 * A single `upskill` install or `git checkout` produces hundreds of change
 * events; each one alone would rebuild the whole tree. Trailing-edge debounce
 * turns a burst into one rebuild, and 200 ms is below the threshold where a
 * panel stops reading as live.
 */
const FILES_DEBOUNCE_MS = 200;

/**
 * Hard ceiling on how long the debounce may defer a rebuild (ms).
 *
 * A write loop that keeps ticking faster than {@link FILES_DEBOUNCE_MS} would
 * otherwise reset the timer forever and the tree would never repaint while the
 * agent is busy — which is exactly when the user is watching it.
 */
const FILES_DEBOUNCE_MAX_WAIT_MS = 1000;

/** Fallback poll interval for a reader that cannot watch (ms). */
const FILES_FALLBACK_POLL_MS = 3000;

/**
 * How long the lazy `term` mount may run before the latch is re-armed.
 *
 * Well clear of a cold kernel boot (the mount waits on `onClientReady`), so
 * only a genuinely wedged attempt trips it.
 */
const TERMINAL_MOUNT_STALL_MS = 45_000;

/** File-tree panel lifecycle, owned by {@link createFileTreeController}. */
interface FileTreeController {
  /** Panel opened: build once, then subscribe to the roots it renders. */
  open(): void;
  /** Panel closed: drop the subscription (and any fallback poller). */
  close(): void;
  /** Selection moved: rebuild from the new roots and re-aim the watch. */
  repoint(): void;
}

/**
 * The file tree's refresh lifecycle — EVENT-DRIVEN (#2409).
 *
 * SLICC owns the filesystem and every `VirtualFS` mutation notifies the
 * kernel's `FsWatcher`, so the panel subscribes to the roots it renders and
 * rebuilds on a debounced change instead of re-reading an unchanged tree
 * every 3 s. An idle filesystem costs nothing and touches no DOM, which is
 * also what stops the periodic rebuild from resetting scroll and expansion
 * state (#2408). The 3 s poll survives only as the fallback for a reader that
 * cannot watch (no `FsWatcher` behind it) — without it such a panel would go
 * permanently stale.
 *
 * There is deliberately NO slow reconciliation sweep behind the subscription:
 * a path that can change without reaching `watcher.notify` is a gap in the
 * NOTIFICATION, and the fix belongs there. `mkdir -p` and `refreshMount` were
 * two such gaps and now emit events; a future one should be fixed the same
 * way rather than papered over by re-reading the tree on a timer.
 */
function createFileTreeController(deps: WcWorkbenchDeps): FileTreeController {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let kernelReadyPending = false;
  let actionsWired = false;
  let open = false;
  /** Bumped on every open/close, so a late subscribe from a closed panel dies. */
  let watchSeq = 0;
  /** Same guard for rebuilds — an older tree must never repaint over a newer. */
  let buildSeq = 0;
  let unwatch: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the currently deferred burst started, for the max-wait ceiling. */
  let debounceStartedAt = 0;

  const rebuild = (): void => {
    const seq = ++buildSeq;
    void deps
      .openFs()
      .then(async (fs) => {
        const items = await buildVfsTreeItems(fs, deps.getWorkspace().root);
        // Two rebuilds can overlap (a change landing mid-read); the later one
        // owns the tree regardless of which read finishes first.
        if (seq !== buildSeq) return;
        deps.fileTree.items = items;
        if (!actionsWired) {
          actionsWired = true;
          wireFileActions({
            fileTree: deps.fileTree,
            openFs: deps.openFs,
            openWriter: deps.openWriter,
            insertReference: deps.insertReference,
            toPreviewUrl,
            log: deps.log,
          });
        }
      })
      .catch((err) => deps.log.error('WC file tree refresh failed', err));
  };

  /** Debounced rebuild — the only thing a change event triggers. */
  const scheduleRebuild = (): void => {
    if (!open) return;
    const now = Date.now();
    if (debounceTimer == null) debounceStartedAt = now;
    else if (now - debounceStartedAt >= FILES_DEBOUNCE_MAX_WAIT_MS) {
      // The burst has outrun the ceiling — repaint now and start a new window
      // rather than deferring again behind a write loop that may not stop.
      clearTimeout(debounceTimer);
      debounceTimer = null;
      rebuild();
      return;
    }
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuild();
    }, FILES_DEBOUNCE_MS);
  };

  /** Last resort for a reader with no watcher behind it (see above). */
  const startPoll = (): void => {
    if (pollTimer != null) return;
    pollTimer = setInterval(rebuild, FILES_FALLBACK_POLL_MS);
  };

  /**
   * Subscribe to the roots the tree currently renders. Re-callable: an
   * existing subscription is dropped first, which is how a cone switch
   * re-aims the watch without leaking the previous cone's registration.
   */
  const startWatch = (): void => {
    const seq = ++watchSeq;
    unwatch?.();
    unwatch = null;
    const roots = [deps.getWorkspace().root, SHARED_TREE_ROOT];
    void deps
      .openFs()
      .then(async (fs) => {
        if (!fs.watch) {
          if (seq === watchSeq && open) startPoll();
          return;
        }
        const off = await fs.watch(roots, scheduleRebuild);
        // The panel may have closed (or re-pointed) while the ack was in
        // flight — drop the subscription we just took rather than keep a
        // registration nobody reads.
        if (seq !== watchSeq || !open) {
          off();
          return;
        }
        unwatch = off;
      })
      .catch((err) => {
        deps.log.error('WC file tree watch failed — falling back to polling', err);
        if (seq === watchSeq && open) startPoll();
      });
  };

  const close = (): void => {
    kernelReadyPending = false;
    open = false;
    watchSeq++;
    unwatch?.();
    unwatch = null;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  return {
    open(): void {
      close();
      open = true;
      kernelReadyPending = true;
      // VFS reads are worker RPCs — nothing may go out before the kernel is up.
      deps.onKernelReady(() => {
        if (!kernelReadyPending) return;
        kernelReadyPending = false;
        rebuild();
        startWatch();
      });
    },
    close,
    repoint(): void {
      // Still waiting on the kernel: the pending first build will read the new
      // roots itself, and rebuilding now would only race it.
      if (!open || kernelReadyPending) return;
      rebuild();
      startWatch();
    },
  };
}

/**
 * Independent workbench panel lifecycle: since every tool panel is now its
 * own permanently-mounted, independently open/closeable dock-tree leaf (no
 * more show-one swapping), each panel's refresh runs only while THAT panel is
 * open — activating one panel never stops another's.
 *
 * The file tree refreshes on VFS change events (see
 * {@link createFileTreeController}). The monitor genuinely polls (5 s): it
 * samples "right now" metrics with no event source. The terminal mounts once
 * on first `term` activation and is never torn down (matches the old show-one
 * behavior — the worker-shell session persists regardless of panel
 * visibility). Memory refreshes once per activation and once per selection
 * change (`refreshMemory`), which is every moment its content can actually
 * differ.
 */
export function createWorkbenchActivator(deps: WcWorkbenchDeps): WorkbenchActivator {
  let terminalMounted = false;
  let stallRearmUsed = false;
  let memoryOpen = false;
  let memorySeq = 0;
  let monitorRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Sparkline history for the vitals tiles. Fed by the refresh below, so it
  // only accumulates while the panel is open — `windowLabel()` reports the
  // span it actually covers rather than claiming more.
  const monitorHistory = new MonitorHistory();
  const fileTree = createFileTreeController(deps);

  const stopMonitorRefresh = (): void => {
    if (monitorRefreshTimer != null) {
      clearInterval(monitorRefreshTimer);
      monitorRefreshTimer = null;
    }
  };

  const refreshMemory = (): void => {
    // Last-write-wins by SEQUENCE, not by completion order: switching cones
    // while a read is in flight starts a second one, and the two files differ
    // in size, so cone A's slower read could land after cone B's and leave the
    // panel showing A indefinitely (nothing else corrects it).
    const seq = ++memorySeq;
    void deps
      .openFs()
      .then(async (fs) => {
        const rows = await buildMemoryRows(fs, deps.getWorkspace().memoryPath);
        if (seq !== memorySeq) return;
        if (deps.memoryHost.setRows) deps.memoryHost.setRows(rows);
        else deps.memoryHost.replaceChildren(...rows);
      })
      .catch((err) => deps.log.error('WC memory refresh failed', err));
  };

  const refreshMonitor = (): void => {
    void (async () => {
      try {
        deps.monitor.model = await fetchMonitorData(deps.getMonitorDeps(), monitorHistory);
      } catch (err) {
        deps.log.error('WC monitor refresh failed', err);
      }
    })();
  };
  deps.monitor.addEventListener('slicc-monitor-refresh', refreshMonitor);

  return {
    activate(surfaceId: string): void {
      if (surfaceId === 'files') {
        fileTree.open();
        return;
      }
      if (surfaceId === 'memory') {
        memoryOpen = true;
        refreshMemory();
        return;
      }
      if (surfaceId === 'monitor') {
        stopMonitorRefresh();
        refreshMonitor();
        monitorRefreshTimer = setInterval(refreshMonitor, 5000);
        return;
      }
      if (surfaceId === 'term' && !terminalMounted) {
        terminalMounted = true;
        let settled = false;
        // A HANG has to release the latch too, not just a rejection. The mount
        // awaits network- and worker-bound work, so it can stall without ever
        // rejecting; the latch would then stay set for the life of the page and
        // every later `activate('term')` would no-op against a terminal that
        // never arrived — a dead Term panel recoverable only by reloading.
        //
        // Re-arming is deliberately ONE-SHOT. The abandoned attempt cannot be
        // cancelled, so if it does eventually resolve after a retry started,
        // the surface ends up with two views; bounding it at a single retry
        // keeps that at "two" instead of one per activation, and a visible
        // terminal beats a permanently dead panel either way.
        const stall = stallRearmUsed
          ? null
          : setTimeout(() => {
              if (settled) return;
              stallRearmUsed = true;
              terminalMounted = false;
              deps.log.error(
                `WC terminal mount did not settle within ${TERMINAL_MOUNT_STALL_MS}ms; ` +
                  're-arming so the next term activation retries'
              );
            }, TERMINAL_MOUNT_STALL_MS);
        deps
          .mountTerminal(deps.termSurface)
          .catch((err) => {
            terminalMounted = false;
            deps.log.error('WC terminal mount failed', err);
          })
          .finally(() => {
            settled = true;
            if (stall) clearTimeout(stall);
          });
      }
    },
    deactivate(surfaceId: string): void {
      if (surfaceId === 'files') fileTree.close();
      else if (surfaceId === 'monitor') stopMonitorRefresh();
      else if (surfaceId === 'memory') memoryOpen = false;
    },
    refreshMemory(): void {
      if (memoryOpen) refreshMemory();
    },
    refreshFiles(): void {
      fileTree.repoint();
    },
  };
}
