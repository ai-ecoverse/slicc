/**
 * Workbench wiring for the live WC shell: the VFS-backed file tree and the
 * panel terminal. The terminal reuses `RemoteTerminalView` — the same
 * worker-shell xterm the legacy layout mounts — inside the workbench's
 * `term` surface; `<slicc-terminal>` replaces it once the library terminal
 * learns session attachment.
 */

import type { SliccFileTree } from '@slicc/webcomponents';

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { buildMemoryRows } from './wc-memory.js';

type FileTreeItem = NonNullable<SliccFileTree['items']>[number];

/** Directories surfaced in the workbench file tree. */
const TREE_ROOTS = ['/workspace', '/shared'] as const;
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
 * Build `<slicc-file-tree>` items for the VFS workbench roots: each root is
 * rendered as an expanded `dir` item so it looks and behaves like any other
 * folder (chevron, collapsible, consistent icon).
 */
export async function buildVfsTreeItems(fs: LocalVfsClient): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = [];
  for (const root of TREE_ROOTS) {
    items.push({
      kind: 'dir',
      id: root,
      label: root.slice(1), // 'workspace' | 'shared'
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
  memoryHost: HTMLElement;
  /** Lazily resolved page-side VFS reader (routed through the worker's VfsRpcHost). */
  openFs(): Promise<LocalVfsClient>;
  /** Mounts the worker-shell terminal into the surface; resolves on attach. */
  mountTerminal(container: HTMLElement): Promise<void>;
  /**
   * Fires `fn` once the kernel's VfsRpcHost is attached (immediately if it
   * already is). Used to avoid sending VFS RPCs before the worker is ready,
   * which would cause them to hang until the timer rescues them.
   */
  onKernelReady(fn: () => void): void;
  log: { error(message: string, ...data: unknown[]): void };
}

/**
 * Lazy workbench activation: the file tree and memory rows populate on
 * (re-)activation of their surfaces; the terminal mounts once on first
 * `term` activation. The file tree also auto-refreshes every 3 s while
 * its surface is active. Returns the activation handler so callers wire it to
 * dock/tab selection.
 */
export function createWorkbenchActivator(deps: WcWorkbenchDeps): (surfaceId: string) => void {
  let terminalMounted = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  // Tracks whether a kernel-ready callback is still pending for the files surface.
  // Cleared by stopRefresh so that switching away cancels a pre-ready activation.
  let refreshPending = false;

  const refreshFileTree = (): void => {
    void deps
      .openFs()
      .then(async (fs) => {
        deps.fileTree.items = await buildVfsTreeItems(fs);
      })
      .catch((err) => deps.log.error('WC file tree refresh failed', err));
  };

  const stopRefresh = (): void => {
    refreshPending = false;
    if (refreshTimer != null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  return (surfaceId: string): void => {
    if (surfaceId === 'files') {
      stopRefresh();
      refreshPending = true;
      deps.onKernelReady(() => {
        if (!refreshPending) return; // surface was deactivated before kernel ready
        refreshPending = false;
        refreshFileTree();
        refreshTimer = setInterval(refreshFileTree, 3000);
      });
      return;
    }
    stopRefresh();
    if (surfaceId === 'memory') {
      void deps
        .openFs()
        .then(async (fs) => {
          deps.memoryHost.replaceChildren(...(await buildMemoryRows(fs)));
        })
        .catch((err) => deps.log.error('WC memory refresh failed', err));
      return;
    }
    if (surfaceId === 'term' && !terminalMounted) {
      terminalMounted = true;
      deps.mountTerminal(deps.termSurface).catch((err) => {
        terminalMounted = false;
        deps.log.error('WC terminal mount failed', err);
      });
    }
  };
}
