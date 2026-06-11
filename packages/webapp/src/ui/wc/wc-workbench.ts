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
  const items: FileTreeItem[] = [];
  for (const entry of [...dirs, ...files].slice(0, MAX_ENTRIES_PER_DIR)) {
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
      items.push({ kind: 'file', id: path, label: entry.name, path });
    }
  }
  return items;
}

/**
 * Build `<slicc-file-tree>` items for the VFS workbench roots: one group per
 * root with its (depth-capped) directory tree underneath.
 */
export async function buildVfsTreeItems(fs: LocalVfsClient): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = [];
  for (const root of TREE_ROOTS) {
    items.push({ kind: 'group', label: `${root.slice(1)}/` });
    items.push(...(await dirChildren(fs, root, 1)));
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
  log: { error(message: string, ...data: unknown[]): void };
}

/**
 * Lazy workbench activation: the file tree and memory rows populate on
 * (re-)activation of their surfaces; the terminal mounts once on first
 * `term` activation. Returns the activation handler so callers wire it to
 * dock/tab selection.
 */
export function createWorkbenchActivator(deps: WcWorkbenchDeps): (surfaceId: string) => void {
  let terminalMounted = false;
  return (surfaceId: string): void => {
    if (surfaceId === 'files') {
      void deps
        .openFs()
        .then(async (fs) => {
          deps.fileTree.items = await buildVfsTreeItems(fs);
        })
        .catch((err) => deps.log.error('WC file tree refresh failed', err));
      return;
    }
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
