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

export async function buildVfsTreeItems(
  fs: LocalVfsClient,
  workspaceRoot: string = PRIMARY_WORKSPACE.root
): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = [];
  for (const root of [workspaceRoot, SHARED_TREE_ROOT]) {
    items.push({
      kind: 'dir',
      id: root,

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

  memoryHost: HTMLElement & { setRows?(rows: readonly HTMLElement[]): void };

  monitor: SliccMonitor;

  openFs(): Promise<LocalVfsClient>;

  openWriter(): Promise<WritableVfsClient>;
  getMonitorDeps(): MonitorDeps;

  mountTerminal(container: HTMLElement): Promise<void>;

  onKernelReady(fn: () => void): void;

  insertReference(path: string): void;

  getWorkspace(): WorkUnitWorkspace;
  log: { error(message: string, ...data: unknown[]): void };
}

export interface WorkbenchActivator {
  activate(surfaceId: string): void;

  deactivate(surfaceId: string): void;

  refreshMemory(): void;

  refreshFiles(): void;
}

const FILES_DEBOUNCE_MS = 200;

const FILES_DEBOUNCE_MAX_WAIT_MS = 1000;

const FILES_FALLBACK_POLL_MS = 3000;

const TERMINAL_MOUNT_STALL_MS = 45_000;

interface FileTreeController {
  open(): void;

  close(): void;

  repoint(): void;
}

function createFileTreeController(deps: WcWorkbenchDeps): FileTreeController {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let kernelReadyPending = false;
  let actionsWired = false;
  let open = false;

  let watchSeq = 0;

  let buildSeq = 0;
  let unwatch: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let debounceStartedAt = 0;

  const rebuild = (): void => {
    const seq = ++buildSeq;
    void deps
      .openFs()
      .then(async (fs) => {
        const items = await buildVfsTreeItems(fs, deps.getWorkspace().root);

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

  const scheduleRebuild = (): void => {
    if (!open) return;
    const now = Date.now();
    if (debounceTimer == null) debounceStartedAt = now;
    else if (now - debounceStartedAt >= FILES_DEBOUNCE_MAX_WAIT_MS) {
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

  const startPoll = (): void => {
    if (pollTimer != null) return;
    pollTimer = setInterval(rebuild, FILES_FALLBACK_POLL_MS);
  };

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

      deps.onKernelReady(() => {
        if (!kernelReadyPending) return;
        kernelReadyPending = false;
        rebuild();
        startWatch();
      });
    },
    close,
    repoint(): void {
      if (!open || kernelReadyPending) return;
      rebuild();
      startWatch();
    },
  };
}

export function createWorkbenchActivator(deps: WcWorkbenchDeps): WorkbenchActivator {
  let terminalMounted = false;
  let stallRearmUsed = false;
  let memoryOpen = false;
  let memorySeq = 0;
  let monitorRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const monitorHistory = new MonitorHistory();
  const fileTree = createFileTreeController(deps);

  const stopMonitorRefresh = (): void => {
    if (monitorRefreshTimer != null) {
      clearInterval(monitorRefreshTimer);
      monitorRefreshTimer = null;
    }
  };

  const refreshMemory = (): void => {
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
