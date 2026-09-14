import {
  FileTree,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  type GitStatusEntry,
  prepareFileTreeInput,
} from '@pierre/trees';
import { define } from '../internal/define.js';

export type FileTreeItem =
  | { kind: 'group'; label: string }
  | {
      kind: 'dir';
      id: string;
      label: string;
      path?: string;
      open?: boolean;
      children: FileTreeItem[];
    }
  | { kind: 'file'; id: string; label: string; path?: string; size?: number };

interface PathMeta {
  id: string;

  size?: number;

  path: string;
  kind: 'directory' | 'file';
}

const TREE_CSS = `
:host {
  --file-tree-font-family: var(--ui, system-ui, sans-serif);
  --file-tree-font-size: 12.5px;
  --file-tree-color: var(--ink, #131313);
  --file-tree-muted-color: var(--txt-3, #717171);
  --file-tree-background: transparent;
  --file-tree-row-hover-background: var(--ghost, rgba(0,0,0,.05));
  --file-tree-row-selected-background: color-mix(in srgb, var(--ctx, #7c5cff) 16%, transparent);
  --file-tree-row-selected-color: var(--ink, #131313);
  --file-tree-focus-ring-color: var(--ctx, #7c5cff);
  --file-tree-git-modified-color: var(--amber, #b26b00);
  --file-tree-git-added-color: #1a7f37;
  --file-tree-git-deleted-color: var(--rose, #d1242f);
  --file-tree-git-untracked-color: var(--txt-3, #717171);
}
`;

const HOST_STYLE = `
slicc-file-tree {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  font-family: var(--ui);
  font-size: 13px;
}
`;

const STYLE_ID = 'slicc-file-tree-style';

function ensureFileTreeStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HOST_STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function asDirectory(
  handle: FileTreeItemHandle | null | undefined
): FileTreeDirectoryHandle | null {
  return handle?.isDirectory() ? (handle as FileTreeDirectoryHandle) : null;
}

function toTreePath(path: string): string {
  return path.replace(/^\/+/, '');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function flattenItems(items: readonly FileTreeItem[]): {
  paths: string[];
  meta: Map<string, PathMeta>;
  initiallyOpen: string[];
} {
  const paths: string[] = [];
  const meta = new Map<string, PathMeta>();
  const initiallyOpen: string[] = [];

  const walk = (list: readonly FileTreeItem[]): void => {
    for (const item of list) {
      if (item.kind === 'group') continue;
      const treePath = toTreePath(item.id);
      if (item.kind === 'dir') {
        meta.set(treePath, { id: item.id, path: item.path ?? item.id, kind: 'directory' });
        if (item.open) initiallyOpen.push(treePath);

        if (item.children.length === 0) paths.push(treePath);
        else walk(item.children);
        continue;
      }
      paths.push(treePath);
      meta.set(treePath, {
        id: item.id,
        path: item.path ?? item.label,
        kind: 'file',
        ...(item.size !== undefined ? { size: item.size } : {}),
      });
    }
  };

  walk(items);
  return { paths, meta, initiallyOpen };
}

interface FileTreeEventDetail {
  id?: string;

  path?: string;

  open?: boolean;

  anchor?: HTMLElement;

  kind?: 'directory' | 'file';
}

export class SliccFileTree extends HTMLElement {
  #items: FileTreeItem[] = [];
  #meta = new Map<string, PathMeta>();
  #tree: FileTree | null = null;
  #mount: HTMLElement | null = null;
  #gitStatus: GitStatusEntry[] = [];
  #selected: string | null = null;

  #selecting = false;

  #expanded: string[] | null = null;

  #wiredContainer: HTMLElement | null = null;

  static get observedAttributes(): string[] {
    return ['selected'];
  }

  connectedCallback(): void {
    ensureFileTreeStyle(this.ownerDocument);
    if (!this.#mount) {
      this.#mount = document.createElement('div');
      this.#mount.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';
      this.appendChild(this.#mount);
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#tree?.unmount();
    this.#tree = null;
    this.#wiredContainer = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'selected' && value !== this.#selected) {
      this.#selected = value;
      this.#applySelection();
    }
  }

  get items(): FileTreeItem[] {
    return this.#items.slice();
  }

  set items(value: FileTreeItem[]) {
    this.#items = Array.isArray(value) ? value.slice() : [];
    this.#render();
  }

  get gitStatus(): GitStatusEntry[] {
    return this.#gitStatus.slice();
  }

  set gitStatus(value: GitStatusEntry[]) {
    this.#gitStatus = Array.isArray(value) ? value.slice() : [];
    this.#render();
  }

  get selected(): string | null {
    return this.#selected;
  }

  set selected(value: string | null) {
    if (value === null) this.removeAttribute('selected');
    else this.setAttribute('selected', value);
  }

  selectFile(id: string): void {
    const meta = this.#meta.get(toTreePath(id));
    if (!meta) return;
    this.#selecting = true;
    try {
      this.selected = id;
    } finally {
      this.#selecting = false;
    }
    this.#applySelection();
    this.#emit('file-select', { id, path: meta.path });
  }

  visibleIds(): string[] {
    const tree = this.#tree;
    if (!tree) return [];
    const count = tree.getVisibleCount();
    if (count === 0) return [];
    return tree
      .getVisibleRows(0, count)

      .map((row) => this.#meta.get(row.path.replace(/\/$/, ''))?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  toggleDir(id: string): void {
    const handle = asDirectory(this.#tree?.getItem(toTreePath(id)));
    if (!handle) return;
    handle.toggle();
    this.#emit('dir-toggle', { id, open: handle.isExpanded() });
  }

  isDirOpen(id: string): boolean {
    return asDirectory(this.#tree?.getItem(toTreePath(id)))?.isExpanded() === true;
  }

  previewFile(id: string): void {
    const meta = this.#meta.get(toTreePath(id));
    if (meta?.kind !== 'file') return;
    this.#emit('file-preview', { id, path: meta.path });
  }

  #emit(type: string, detail: FileTreeEventDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #captureExpansion(): void {
    const tree = this.#tree;
    if (!tree) return;
    const count = tree.getVisibleCount();

    if (count === 0) return;
    const rows = tree.getVisibleRows(0, count);

    this.#expanded = rows.filter((row) => row.isExpanded).map((row) => row.path);
  }

  #applySelection(): void {
    const path = this.#selected;
    if (!path || !this.#tree) return;
    this.#selecting = true;
    try {
      this.#tree.getItem(toTreePath(path))?.select();
    } finally {
      this.#selecting = false;
    }
  }

  #render(): void {
    if (!this.isConnected || !this.#mount) return;

    const { paths, meta, initiallyOpen } = flattenItems(this.#items);
    this.#meta = meta;

    this.#captureExpansion();
    const expanded = this.#expanded ?? initiallyOpen;

    if (this.#tree && paths.length > 0) {
      this.#tree.resetPaths({
        preparedInput: prepareFileTreeInput(paths),
        initialExpandedPaths: expanded,
      });

      this.#tree.setGitStatus(this.#gitStatus);
      this.#wireActivation();
      return;
    }

    this.#tree?.unmount();
    this.#mount.replaceChildren();
    this.#wiredContainer = null;

    if (paths.length === 0) {
      this.#tree = null;
      return;
    }

    const tree = new FileTree({
      preparedInput: prepareFileTreeInput(paths),
      gitStatus: this.#gitStatus,
      search: true,

      initialVisibleRowCount: 40,
      renaming: false,
      dragAndDrop: false,
      unsafeCSS: TREE_CSS,
      initialExpandedPaths: expanded,
      ...(this.#selected ? { initialSelectedPaths: [toTreePath(this.#selected)] } : {}),
      onSelectionChange: (selection: readonly string[]) => {
        if (this.#selecting) return;
        const path = selection[0];
        if (path === undefined) return;
        const entry = this.#meta.get(path);
        if (!entry) return;
        this.#selected = entry.id;
        this.setAttribute('selected', entry.id);
        this.#emit('file-select', { id: entry.id, path: entry.path });
      },

      renderRowDecoration: ({ row }) => {
        const entry = this.#meta.get(row.path);
        if (!entry || entry.size === undefined) return null;
        return { text: formatSize(entry.size) };
      },
      composition: {
        contextMenu: {
          enabled: true,
          triggerMode: 'both',

          buttonVisibility: 'when-needed',

          onOpen: (item, context) => {
            const entry = this.#meta.get(item.path);
            context.close({ restoreFocus: false });
            this.#emit('file-overflow', {
              id: entry?.id ?? item.path,
              path: entry?.path ?? item.path,
              anchor: context.anchorElement,
              kind: item.kind,
            });
          },
        },
      },
    });

    tree.render({ containerWrapper: this.#mount });
    this.#tree = tree;

    this.#wireActivation();
  }

  #wireActivation(): void {
    const container = this.#tree?.getFileTreeContainer();
    if (!container || container === this.#wiredContainer) return;
    this.#wiredContainer = container;

    const activateFocused = (): void => {
      const target = this.#tree?.getFocusedPath() ?? this.#tree?.getSelectedPaths()[0];
      const entry = target === null || target === undefined ? null : this.#meta.get(target);
      if (entry) this.previewFile(entry.id);
    };
    container.addEventListener('dblclick', activateFocused);
    container.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') activateFocused();
    });
  }
}

define('slicc-file-tree', SliccFileTree);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-file-tree': SliccFileTree;
  }
}
