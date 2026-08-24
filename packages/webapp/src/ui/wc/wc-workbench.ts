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
    entries = await fs.readDir(dir);
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

  // Stat all files in parallel; failures degrade gracefully to no size.
  const filePaths = capped.filter((e) => e.type === 'file').map((e) => `${dir}/${e.name}`);
  const stats = await Promise.allSettled(filePaths.map((p) => fs.stat(p)));
  const sizeMap = new Map<string, number>();
  filePaths.forEach((p, i) => {
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
   * root that owns the current selection (#2271). Read per refresh, so
   * switching cones re-points the tree on the next poll.
   */
  getWorkspace(): WorkUnitWorkspace;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Per-panel lifecycle handle returned by {@link createWorkbenchActivator}. */
export interface WorkbenchActivator {
  /** Open (or re-open) a panel — starts its poller / mounts its content. */
  activate(surfaceId: string): void;
  /** Panel left the tree (closed/removed) — stops its poller, if any. */
  deactivate(surfaceId: string): void;
  /**
   * Re-read the memory panel because the SELECTION moved (#2271). The panel's
   * rows come from the cone that owns the selection, and — unlike the file
   * tree, which its 3 s poller re-points on its own — memory reads once per
   * activation, so an open panel would otherwise keep showing the previous
   * cone's memory indefinitely. No-op while the panel is closed.
   */
  refreshMemory(): void;
}

/**
 * Independent workbench panel lifecycle: since every tool panel is now its
 * own permanently-mounted, independently open/closeable dock-tree leaf (no
 * more show-one swapping), each panel's poller runs only while THAT panel is
 * open — activating one panel never stops another's. The file tree
 * auto-refreshes every 3 s and the monitor every 5 s while open; the terminal
 * mounts once on first `term` activation and is never torn down (matches the
 * old show-one behavior — the worker-shell session persists regardless of
 * panel visibility). Memory has no poller: it refreshes once per activation
 * and once per selection change (`refreshMemory`), which is every moment its
 * content can actually differ.
 */
export function createWorkbenchActivator(deps: WcWorkbenchDeps): WorkbenchActivator {
  let terminalMounted = false;
  let memoryOpen = false;
  let memorySeq = 0;
  let filesRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let monitorRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Sparkline history for the vitals tiles. Fed by the refresh below, so it
  // only accumulates while the panel is open — `windowLabel()` reports the
  // span it actually covers rather than claiming more.
  const monitorHistory = new MonitorHistory();
  let filesRefreshPending = false;
  let fileActionsWired = false;

  const refreshFileTree = (): void => {
    void deps
      .openFs()
      .then(async (fs) => {
        deps.fileTree.items = await buildVfsTreeItems(fs, deps.getWorkspace().root);
        if (!fileActionsWired) {
          fileActionsWired = true;
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

  const stopFilesRefresh = (): void => {
    filesRefreshPending = false;
    if (filesRefreshTimer != null) {
      clearInterval(filesRefreshTimer);
      filesRefreshTimer = null;
    }
  };

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
    // panel showing A indefinitely (no poller corrects it).
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
        stopFilesRefresh();
        filesRefreshPending = true;
        deps.onKernelReady(() => {
          if (!filesRefreshPending) return;
          filesRefreshPending = false;
          refreshFileTree();
          filesRefreshTimer = setInterval(refreshFileTree, 3000);
        });
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
        deps.mountTerminal(deps.termSurface).catch((err) => {
          terminalMounted = false;
          deps.log.error('WC terminal mount failed', err);
        });
      }
    },
    deactivate(surfaceId: string): void {
      if (surfaceId === 'files') stopFilesRefresh();
      else if (surfaceId === 'monitor') stopMonitorRefresh();
      else if (surfaceId === 'memory') memoryOpen = false;
    },
    refreshMemory(): void {
      if (memoryOpen) refreshMemory();
    },
  };
}
