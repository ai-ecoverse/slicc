/**
 * `<slicc-file-tree>` — the workbench file browser.
 *
 * The rendering, virtualization, keyboard model, search, rename and git lanes
 * come from `@pierre/trees` (trees.software). This module is the adapter: it
 * keeps SLICC's public contract — the `FileTreeItem` shape, the `items`
 * accessor, the `selected` attribute, and the six `file-*` / `dir-toggle`
 * events — and translates between that and the library's flat-path model.
 *
 * ## Why an adapter instead of exposing the library directly
 *
 * Four call sites already speak the old contract (`wc-workbench` builds
 * `FileTreeItem[]`, `file-actions` listens for the events, plus stories and
 * tests). Keeping the contract means the swap is contained here rather than
 * spreading through the workbench, and it leaves room to change libraries again
 * without another migration.
 *
 * ## What moved
 *
 * The old tree drew four hover buttons on every file row (preview, reference,
 * download, overflow). `@pierre/trees` renders row decorations as text or an
 * icon only — arbitrary interactive elements are not part of that contract — so
 * those actions now live in the row's context menu, which the library triggers
 * and SLICC populates via the existing `file-overflow` event. The events
 * themselves are unchanged; only what the user clicks to reach them moved.
 * `file-preview` additionally fires on Enter or a double-click, which the old
 * tree had no equivalent for.
 *
 * ## What arrived
 *
 * Type-to-search, inline rename, drag-and-drop, virtualization for large
 * directories, and per-row git status — all from the library, none of it code
 * this file has to own.
 */

import {
  FileTree,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  type GitStatusEntry,
  prepareFileTreeInput,
} from '@pierre/trees';
import { define } from '../internal/define.js';

/**
 * A row in the file tree: a group header, a foldable directory, or a file.
 *
 * Unchanged from the hand-rolled tree so existing producers keep working.
 * `group` rows have no equivalent in a path-based model and are flattened away
 * (see `flattenItems`); `dir` and `file` rows become paths.
 */
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

/**
 * Per-row metadata the library does not model, keyed by the library's path.
 *
 * The library's path is NOT the VFS path — see `toTreePath` — so the original
 * id is carried here to report back in events.
 */
interface PathMeta {
  /** The VFS id this row came from, as callers know it. */
  id: string;
  /** File size in bytes, when known — rendered as the row decoration. */
  size?: number;
  /** The logical VFS path reported in events (defaults to the tree path). */
  path: string;
  kind: 'directory' | 'file';
}

/**
 * SLICC theming for the library's shadow DOM.
 *
 * The tree renders in its own shadow root, so the app's cascade cannot reach it
 * — the variables have to be handed across explicitly. Mapping onto SLICC's
 * tokens (rather than hardcoding colors) is what keeps the tree flipping with
 * the rest of the UI when the theme changes.
 */
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

/**
 * Narrow an item handle to the directory half of the union.
 *
 * The library discriminates with `isDirectory(): true | false`, which TypeScript
 * will not narrow on its own from a method call, so the guard is explicit.
 */
function asDirectory(
  handle: FileTreeItemHandle | null | undefined
): FileTreeDirectoryHandle | null {
  return handle?.isDirectory() ? (handle as FileTreeDirectoryHandle) : null;
}

/**
 * Convert a VFS path into the form `@pierre/trees` expects.
 *
 * The library splits paths on `/` and treats the result as a segment list, so a
 * LEADING slash produces an empty first segment. That empty root is not merely
 * cosmetic: a tree of `['/a.ts', '/b.ts']` renders a single blank row and no
 * files at all (verified against 1.0.0-beta.6). Stripping the slash on the way
 * in and restoring it on the way out keeps SLICC's absolute VFS paths intact at
 * the component's boundary while giving the library the relative form it can
 * actually render.
 */
function toTreePath(path: string): string {
  return path.replace(/^\/+/, '');
}

/** Format a byte count the way the old tree's `.sz` span did. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * Turn the nested `FileTreeItem` model into the flat path list the library
 * takes, collecting per-path metadata on the way.
 *
 * `group` rows are dropped rather than represented: they are a purely visual
 * header with no path, and the library builds its hierarchy from paths alone.
 * Their children are hoisted, which is what the group looked like anyway.
 */
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
        // A directory only exists in a path model through its descendants, so
        // an empty one is emitted as a bare path to keep it visible.
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

/**
 * The payload of the tree's outgoing events.
 *
 * Every consumer keys off `id` and `path`; the rest are per-event extras. Typed
 * as a union of optional fields rather than a string-keyed bag so a renamed
 * field breaks at compile time in `file-actions.ts` instead of silently
 * arriving as `undefined`.
 */
interface FileTreeEventDetail {
  /** The VFS id of the row, as callers supplied it in `FileTreeItem`. */
  id?: string;
  /** The logical VFS path for the row. */
  path?: string;
  /** `dir-toggle` only: whether the directory is now expanded. */
  open?: boolean;
  /** `file-overflow` only: the element the menu should anchor to. */
  anchor?: HTMLElement;
  /** `file-overflow` only: what kind of row was acted on. */
  kind?: 'directory' | 'file';
}

export class SliccFileTree extends HTMLElement {
  #items: FileTreeItem[] = [];
  #meta = new Map<string, PathMeta>();
  #tree: FileTree | null = null;
  #mount: HTMLElement | null = null;
  #gitStatus: GitStatusEntry[] = [];
  #selected: string | null = null;
  /**
   * Set while the component is driving the library's selection itself.
   *
   * `selectFile()` reflects to the `selected` attribute, whose observer tells
   * the library to select the row, which calls back through
   * `onSelectionChange` — emitting a second `file-select` for one user action.
   * The flag makes that echo recognizable so only the originating call emits.
   */
  #selecting = false;
  /** Expanded paths survive a refresh, so a background poll can't re-open dirs. */
  #expanded: string[] | null = null;

  static get observedAttributes(): string[] {
    return ['selected'];
  }

  connectedCallback(): void {
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
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'selected' && value !== this.#selected) {
      this.#selected = value;
      this.#applySelection();
    }
  }

  /** The tree's rows (groups, dirs, files). Setting it re-renders the tree. */
  get items(): FileTreeItem[] {
    return this.#items.slice();
  }

  set items(value: FileTreeItem[]) {
    this.#items = Array.isArray(value) ? value.slice() : [];
    this.#render();
  }

  /**
   * Per-path git status, painting the library's git lanes.
   *
   * New capability — the hand-rolled tree had no notion of git. Paths with no
   * entry render unchanged.
   */
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

  /** Select the row with `id` and emit `file-select`. No-op for an unknown id. */
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

  /**
   * Toggle the directory with the given id and emit `dir-toggle { id, open }`.
   * A no-op (no event) if no directory carries that id.
   */
  toggleDir(id: string): void {
    const handle = asDirectory(this.#tree?.getItem(toTreePath(id)));
    if (!handle) return;
    handle.toggle();
    this.#emit('dir-toggle', { id, open: handle.isExpanded() });
  }

  /** Whether the directory with the given id is currently expanded. */
  isDirOpen(id: string): boolean {
    return asDirectory(this.#tree?.getItem(toTreePath(id)))?.isExpanded() === true;
  }

  /** Open the previewer for `id`. No-op for an unknown id or a directory. */
  previewFile(id: string): void {
    const meta = this.#meta.get(toTreePath(id));
    if (meta?.kind !== 'file') return;
    this.#emit('file-preview', { id, path: meta.path });
  }

  #emit(type: string, detail: FileTreeEventDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Snapshot which directories are open, so the workbench's periodic refresh
   * cannot collapse what the user just expanded.
   *
   * Read at re-render time rather than from a `subscribe` listener: the library
   * notifies on view changes including SCROLL, and walking every row on each
   * scroll tick would make a large tree pay an O(rows) cost per frame for state
   * only ever consumed here.
   *
   * The library exposes no `getExpandedPaths()`, so expansion is derived from
   * the visible rows — which is exactly the set that matters for restoring.
   */
  #captureExpansion(): void {
    const tree = this.#tree;
    if (!tree) return;
    const count = tree.getVisibleCount();
    // A tree that has not painted yet reports nothing, and recording that would
    // read as "the user collapsed everything". Only a painted tree is evidence.
    if (count === 0) return;
    const rows = tree.getVisibleRows(0, count);
    // Assigned even when empty: collapsing the last open directory IS the state
    // to remember, and must not fall back to the items' `open` seeds.
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

    // Keep whatever the user has expanded across a refresh; only the first
    // build honours the `open` flags from the items themselves.
    this.#captureExpansion();
    const expanded = this.#expanded ?? initiallyOpen;

    this.#tree?.unmount();
    this.#mount.replaceChildren();

    if (paths.length === 0) {
      this.#tree = null;
      return;
    }

    const tree = new FileTree({
      preparedInput: prepareFileTreeInput(paths),
      gitStatus: this.#gitStatus,
      search: true,
      // Without a seed the virtualizer paints nothing until its ResizeObserver
      // has measured the container, so a freshly mounted tree flashes empty.
      initialVisibleRowCount: 40,
      renaming: false,
      dragAndDrop: false,
      unsafeCSS: TREE_CSS,
      initialExpandedPaths: expanded,
      ...(this.#selected ? { initialSelectedPaths: [toTreePath(this.#selected)] } : {}),
      onSelectionChange: (selection: readonly string[]) => {
        if (this.#selecting) return; // echo of our own reflection, not a user pick
        const path = selection[0];
        if (path === undefined) return;
        const entry = this.#meta.get(path);
        if (!entry) return;
        this.#selected = entry.id;
        this.setAttribute('selected', entry.id);
        this.#emit('file-select', { id: entry.id, path: entry.path });
      },
      // Size lives where the old tree's `.sz` span did — right-aligned on the
      // row — so the layout reads the same even though the renderer changed.
      renderRowDecoration: ({ row }) => {
        const entry = this.#meta.get(row.path);
        if (!entry || entry.size === undefined) return null;
        return { text: formatSize(entry.size) };
      },
      composition: {
        contextMenu: {
          enabled: true,
          triggerMode: 'both',
          // `when-needed` shows the trigger on hover/focus rather than pinning
          // one to every row — the same restraint the old hover-only action
          // strip had.
          buttonVisibility: 'when-needed',
          // SLICC renders the menu itself (`SliccOverflowMenu`, wired in
          // `file-actions.ts`), so the library only has to tell us where it was
          // opened. That keeps one menu implementation across the whole app.
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

    // Track which directories are open so the workbench's periodic refresh
    // cannot collapse what the user just expanded. The library exposes no
    // `getExpandedPaths()`, so the state is read off the visible rows — which
    // is exactly the set that matters for restoring the view.
    this.#wireActivation();
  }

  /**
   * Enter and double-click open the previewer.
   *
   * The old tree had no such affordance — preview was a hover button — so this
   * is added rather than preserved. It is wired on the container the library
   * created, which is replaced on every render, hence re-wiring here.
   */
  #wireActivation(): void {
    const container = this.#tree?.getFileTreeContainer();
    if (!container) return;

    const activateFocused = (): void => {
      // Keyboard activation acts on the focused row; a double-click acts on the
      // row the first click just selected, which does not always take focus.
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
