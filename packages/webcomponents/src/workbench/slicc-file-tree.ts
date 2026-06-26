import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * A row in the file tree: a group header, a foldable directory, or a file.
 *
 * `group` rows render the prototype's `.grp` header (a dimmed directory label);
 * `dir` rows render a `.dir` row with a leading chevron and fold/expand their
 * `children` when clicked (toggling open/closed); `file` rows render a `.f` row
 * with a bullet, are clickable, and carry the id reported by the `file-select`
 * event. The optional `path` is the logical VFS path surfaced in the event
 * detail (defaults to the file's `label`). A `dir`'s `open` seeds its initial
 * expanded state (default collapsed).
 */
export type FileTreeItem =
  | { kind: 'group'; label: string }
  | { kind: 'dir'; id: string; label: string; open?: boolean; children: FileTreeItem[] }
  | { kind: 'file'; id: string; label: string; path?: string; size?: number };

/** Human-readable byte size (B / K / M / G). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

/**
 * Scoped, document-level stylesheet for `<slicc-file-tree>`. A light-DOM
 * component can't carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * tag + BEM-ish hooks below.
 *
 * Lifted verbatim from the prototype VFS sidebar
 * (`proto/StellarRubySwift.html` `.tree`/`.grp`/`.f`/`.f.on`): a fixed 190px,
 * non-shrinking column with a right divider that scrolls when long; group
 * headers in `--txt-3`; file rows with a 5×5 `::before` bullet; the active row
 * (`.f.on`) tinted violet. All colors/spacing come from inherited prototype
 * tokens.
 *
 * Dark mode: the active tint re-bases over `var(--canvas)` at 22% (vs 10% over
 * canvas in light, where `--canvas` is `#fff`). Mixing over the inherited
 * `var(--canvas)` lets a `.dark` / `[data-theme="dark"]` ancestor flip the tint
 * without `:host-context`.
 */
const STYLE = `
slicc-file-tree {
  width: 190px;
  flex: 0 0 auto;
  box-sizing: border-box;
  display: block;
  border-right: 1px solid var(--line);
  overflow: auto;
  padding: 6px 4px;
  font-family: var(--ui);
  font-size: 13px;
}
slicc-file-tree .grp {
  color: var(--txt-3);
  padding: 10px 8px 3px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
slicc-file-tree .grp:first-child {
  padding-top: 4px;
}
slicc-file-tree .f {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 5px;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.1s ease;
}
slicc-file-tree .f:hover {
  background: var(--ghost);
}
slicc-file-tree .f.on {
  background: color-mix(in srgb, var(--violet) 10%, var(--canvas));
  color: var(--violet);
  box-shadow: inset 2px 0 0 var(--violet);
}
slicc-file-tree .f .ficon {
  flex: 0 0 auto;
  color: var(--txt-3);
}
slicc-file-tree .f.on .ficon {
  color: var(--violet);
}
slicc-file-tree .dir {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 5px;
  color: var(--ink);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s ease;
}
slicc-file-tree .dir:hover {
  background: var(--ghost);
}
slicc-file-tree .dir .chev {
  flex: 0 0 auto;
  color: var(--txt-3);
  transition: transform 0.15s ease;
}
slicc-file-tree .dir.open .chev {
  transform: rotate(90deg);
}
slicc-file-tree .children {
  padding-left: 12px;
}
slicc-file-tree .children[hidden] {
  display: none;
}
slicc-file-tree .f .sz {
  margin-left: auto;
  color: var(--txt-3);
  font-size: 10px;
  flex-shrink: 0;
  opacity: 0.7;
  transition: opacity 0.1s ease;
}
slicc-file-tree .f:hover .sz {
  opacity: 0;
  pointer-events: none;
}
slicc-file-tree .actions {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s ease;
  background: linear-gradient(to right, transparent, var(--canvas, #fff) 8px);
  padding-left: 12px;
}
slicc-file-tree .f:hover .actions {
  opacity: 1;
}
slicc-file-tree .f.on .actions {
  background: linear-gradient(to right, transparent, color-mix(in srgb, var(--violet) 10%, var(--canvas)) 8px);
}
slicc-file-tree .actions button {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--txt-3);
  cursor: pointer;
  padding: 0;
}
slicc-file-tree .actions button:hover {
  color: var(--txt-1, var(--ink));
  background: var(--ghost);
}
slicc-file-tree .actions button:active {
  opacity: 0.6;
}

.dark slicc-file-tree .f.on,
[data-theme="dark"] slicc-file-tree .f.on {
  background: color-mix(in srgb, var(--violet) 22%, var(--canvas));
}
`;

const STYLE_ID = 'slicc-file-tree-style';

/** Inject the scoped file-tree stylesheet into a document once (idempotent). */
function ensureFileTreeStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Build the row elements for the given items (no innerHTML), recursing into
 * `dir` children. A `dir` renders a `.dir` toggle row (chevron + label) followed
 * by a `.children` wrapper holding its (possibly nested) rows; the wrapper is
 * `hidden` unless the dir id is in `openDirs`, so collapsing keeps the children
 * in the DOM (selection survives) but visually hidden.
 */
function buildNodes(items: readonly FileTreeItem[], openDirs: ReadonlySet<string>): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const item of items) {
    if (item.kind === 'group') {
      rows.push(h('div', { class: 'grp' }, item.label));
    } else if (item.kind === 'dir') {
      const open = openDirs.has(item.id);
      rows.push(
        h(
          'div',
          {
            class: open ? 'dir open' : 'dir',
            'data-dir-id': item.id,
            'aria-expanded': open ? 'true' : 'false',
          },
          iconEl('chevron-right', { size: 14, class: 'chev' }),
          item.label
        )
      );
      const wrap = h('div', { class: 'children', hidden: open ? undefined : true });
      append(wrap, buildNodes(item.children ?? [], openDirs));
      rows.push(wrap);
    } else {
      const actions = h(
        'div',
        { class: 'actions' },
        h('button', { 'data-action': 'preview', type: 'button' }, iconEl('eye', { size: 14 })),
        h(
          'button',
          { 'data-action': 'reference', type: 'button' },
          iconEl('at-sign', { size: 14 })
        ),
        h(
          'button',
          { 'data-action': 'download', type: 'button' },
          iconEl('arrow-down-to-line', { size: 14 })
        ),
        h('button', { 'data-action': 'overflow', type: 'button' }, iconEl('ellipsis', { size: 14 }))
      );
      const row = h(
        'div',
        { class: 'f', 'data-id': item.id },
        iconEl('file-text', { size: 12, class: 'ficon' }),
        item.label,
        actions
      );
      if (item.size != null) row.appendChild(h('span', { class: 'sz' }, formatSize(item.size)));
      rows.push(row);
    }
  }
  return rows;
}

/**
 * `<slicc-file-tree>` — the VFS sidebar from the prototype (`.tree`). A fixed
 * 190px, non-shrinking column of directory group headers (`.grp`), foldable
 * directories (`.dir`, a chevron toggle), and clickable file rows (`.f`), each
 * with a small bullet. Single-selection: the active file (`.f.on`) is tinted
 * violet, and clicking a file row (or calling {@link SliccFileTree.selectFile})
 * selects it and emits `file-select`. Clicking a `.dir` row (or calling
 * {@link SliccFileTree.toggleDir}) folds/expands its nested children and emits
 * `dir-toggle`.
 *
 * Light DOM (no shadow root): the host renders its rows directly into itself so
 * the host app can style/slot it. The scoped stylesheet is injected once into
 * the host document, selected by the `slicc-file-tree` host tag. Slotted file
 * children supplied as plain markup (light DOM has no native `<slot>`) are
 * relocated and normalized into `.f` rows at connect time.
 *
 * Internal DOM (light DOM):
 *
 *     <slicc-file-tree>
 *       <div class="grp">workspace/</div>
 *       <div class="dir open" data-dir-id="components" aria-expanded="true">…</div>
 *       <div class="children"><div class="f" data-id="hero.tsx">hero.tsx</div></div>
 *       <div class="f on" data-id="hero.css">hero.css</div>
 *       …
 *     </slicc-file-tree>
 *
 * @attr selected - id of the active file (reflected to {@link selected})
 * @slot - file rows supplied as light-DOM markup when `items` is not set; a
 *   plain text/`<div>` child becomes a `.f` row, `data-group` children become
 *   `.grp` headers, and the child's `id`/`data-id` becomes its file id
 * @fires file-select - a file was selected; `detail` carries `{ id, path }`
 * @fires dir-toggle - a directory was folded/expanded; `detail` carries
 *   `{ id, open }`
 */
export class SliccFileTree extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['selected'];
  }

  #items: FileTreeItem[] | null = null;
  #paths = new Map<string, string>();
  #openDirs = new Set<string>();
  #initialized = false;
  #onClick: ((e: MouseEvent) => void) | null = null;

  connectedCallback(): void {
    ensureFileTreeStyle(this.ownerDocument);
    if (!this.#initialized) {
      // First connect: if no `items` were assigned programmatically, adopt any
      // light-DOM markup the caller slotted in as the initial item set.
      if (this.#items == null) {
        this.#items = this.#harvestSlotted();
        this.#seedOpenDirs();
      }
      this.#initialized = true;
    }
    this.#render();
    this.#bindClick();
  }

  disconnectedCallback(): void {
    if (this.#onClick) {
      this.removeEventListener('click', this.#onClick);
      this.#onClick = null;
    }
  }

  attributeChangedCallback(name: string): void {
    if (name === 'selected' && this.#initialized && this.isConnected) {
      this.#applySelection();
    }
  }

  /** The tree's rows (groups, dirs, files). Setting it re-renders the tree. */
  get items(): FileTreeItem[] {
    return this.#items ? this.#items.slice() : [];
  }

  set items(value: FileTreeItem[]) {
    const first = !this.#initialized;
    this.#items = Array.isArray(value) ? value.slice() : [];
    this.#initialized = true;
    // Only seed open dirs from item.open flags on the very first assignment.
    // Subsequent refreshes must not touch #openDirs — doing so would re-open
    // any dir the user manually collapsed (the roots always carry open:true).
    if (first) this.#seedOpenDirs();
    if (this.isConnected) {
      this.#render();
      this.#bindClick();
    }
  }

  /**
   * Toggle the open/closed state of the directory with the given id (showing or
   * hiding its children), re-render, and emit `dir-toggle` with `{ id, open }`.
   * A no-op (no event) if no `.dir` row carries that id.
   */
  toggleDir(id: string): void {
    if (!this.#hasDir(id, this.#items ?? [])) return;
    const open = !this.#openDirs.has(id);
    if (open) this.#openDirs.add(id);
    else this.#openDirs.delete(id);
    this.#render();
    this.dispatchEvent(
      new CustomEvent('dir-toggle', {
        bubbles: true,
        composed: true,
        detail: { id, open },
      })
    );
  }

  /** Whether the directory with the given id is currently expanded. */
  isDirOpen(id: string): boolean {
    return this.#openDirs.has(id);
  }

  /** Id of the currently-selected file (reflected to the `selected` attribute). */
  get selected(): string | null {
    return this.getAttribute('selected');
  }

  set selected(value: string | null) {
    if (value == null) this.removeAttribute('selected');
    else this.setAttribute('selected', value);
  }

  /**
   * Select the file with the given id (single-selection): tint it `.on`, clear
   * any previous selection, reflect `selected`, and emit `file-select` with the
   * file's `{ id, path }`. A no-op (no event) if no `.f` row carries that id.
   */
  selectFile(id: string): void {
    const target = this.querySelector<HTMLElement>(`.f[data-id="${cssEscape(id)}"]`);
    if (!target) return;
    if (this.getAttribute('selected') !== id) this.setAttribute('selected', id);
    this.#applySelection();
    const path = this.#paths.get(id) ?? id;
    this.dispatchEvent(
      new CustomEvent('file-select', {
        bubbles: true,
        composed: true,
        detail: { id, path },
      })
    );
  }

  /** Read the active selection into the live rows (toggling `.on`). */
  #applySelection(): void {
    const sel = this.getAttribute('selected');
    for (const row of this.querySelectorAll<HTMLElement>('.f')) {
      row.classList.toggle('on', row.dataset.id === sel);
    }
  }

  /** Adopt any caller-supplied light-DOM children as the initial item set. */
  #harvestSlotted(): FileTreeItem[] {
    const items: FileTreeItem[] = [];
    for (const node of Array.from(this.children)) {
      if (!(node instanceof HTMLElement)) continue;
      const label = (node.textContent ?? '').trim();
      if (!label) continue;
      const isGroup =
        node.classList.contains('grp') ||
        node.hasAttribute('data-group') ||
        node.dataset.group != null;
      if (isGroup) {
        items.push({ kind: 'group', label });
      } else {
        const id = node.dataset.id ?? node.id ?? label;
        items.push({ kind: 'file', id, label });
      }
    }
    return items;
  }

  #render(): void {
    const items = this.#items ?? [];
    this.#paths.clear();
    this.#collectPaths(items);
    this.replaceChildren(...buildNodes(items, this.#openDirs));
    this.#applySelection();
  }

  /** Map every file id (at any depth) to its logical path for `file-select`. */
  #collectPaths(items: readonly FileTreeItem[]): void {
    for (const item of items) {
      if (item.kind === 'file') this.#paths.set(item.id, item.path ?? item.label);
      else if (item.kind === 'dir') this.#collectPaths(item.children ?? []);
    }
  }

  /** Seed the open-dir set from the items' `open` flags (first assignment only). */
  #seedOpenDirs(): void {
    this.#openDirs.clear();
    const walk = (items: readonly FileTreeItem[]): void => {
      for (const item of items) {
        if (item.kind !== 'dir') continue;
        if (item.open) this.#openDirs.add(item.id);
        walk(item.children ?? []);
      }
    };
    walk(this.#items ?? []);
  }

  /** Whether a `dir` with the given id exists anywhere in the item tree. */
  #hasDir(id: string, items: readonly FileTreeItem[]): boolean {
    for (const item of items) {
      if (item.kind !== 'dir') continue;
      if (item.id === id) return true;
      if (this.#hasDir(id, item.children ?? [])) return true;
    }
    return false;
  }

  /** Handle action button clicks (preview, reference, download, overflow). */
  #handleActionClick(actionBtn: HTMLElement): boolean {
    const action = actionBtn.dataset.action;
    const row = actionBtn.closest<HTMLElement>('.f');
    if (!row) return false;
    const id = row.dataset.id;
    if (id == null) return false;
    const path = this.#paths.get(id) ?? id;

    // Emit the corresponding event based on the action
    if (action === 'preview') {
      this.dispatchEvent(
        new CustomEvent('file-preview', {
          bubbles: true,
          composed: true,
          detail: { id, path },
        })
      );
    } else if (action === 'reference') {
      this.dispatchEvent(
        new CustomEvent('file-reference', {
          bubbles: true,
          composed: true,
          detail: { id, path },
        })
      );
    } else if (action === 'download') {
      this.dispatchEvent(
        new CustomEvent('file-download', {
          bubbles: true,
          composed: true,
          detail: { id, path },
        })
      );
    } else if (action === 'overflow') {
      this.dispatchEvent(
        new CustomEvent('file-overflow', {
          bubbles: true,
          composed: true,
          detail: { id, path, anchor: actionBtn },
        })
      );
    }
    return true;
  }

  #bindClick(): void {
    if (this.#onClick) return;
    this.#onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;

      // Check if an action button was clicked
      const actionBtn = target?.closest<HTMLElement>('[data-action]');
      if (actionBtn && this.contains(actionBtn)) {
        if (this.#handleActionClick(actionBtn)) return;
      }

      const dirRow = target?.closest<HTMLElement>('.dir');
      if (dirRow && this.contains(dirRow)) {
        const dirId = dirRow.dataset.dirId;
        if (dirId != null) this.toggleDir(dirId);
        return;
      }
      const row = target?.closest<HTMLElement>('.f');
      if (!row || !this.contains(row)) return;
      const id = row.dataset.id;
      if (id != null) this.selectFile(id);
    };
    this.addEventListener('click', this.#onClick);
  }
}

/**
 * Escape an id for use inside an attribute-selector quoted string. `CSS.escape`
 * is for identifiers, not quoted attribute values, so escape the two characters
 * that can break out of a double-quoted selector string.
 */
function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

define('slicc-file-tree', SliccFileTree);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-file-tree': SliccFileTree;
  }
}
