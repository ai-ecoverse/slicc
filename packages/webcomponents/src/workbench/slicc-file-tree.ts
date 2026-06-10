import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';

/**
 * A row in the file tree: either a group header or a selectable file.
 *
 * `group` rows render the prototype's `.grp` header (a dimmed directory label);
 * `file` rows render a `.f` row with a bullet, are clickable, and carry the id
 * reported by the `file-select` event. The optional `path` is the logical VFS
 * path surfaced in the event detail (defaults to the file's `label`).
 */
export type FileTreeItem =
  | { kind: 'group'; label: string }
  | { kind: 'file'; id: string; label: string; path?: string };

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
  padding: 10px 8px;
  font-family: var(--ui);
  font-size: 12px;
}
slicc-file-tree .grp {
  color: var(--txt-3);
  padding: 5px 8px 3px;
}
slicc-file-tree .grp + .grp {
  margin-top: 8px;
}
slicc-file-tree .f {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-radius: 7px;
  color: var(--ink);
  cursor: pointer;
}
slicc-file-tree .f:hover {
  background: var(--ghost);
}
slicc-file-tree .f.on {
  background: color-mix(in srgb, var(--violet) 10%, var(--canvas));
  color: var(--violet);
}
slicc-file-tree .f::before {
  content: "";
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 1px;
  background: var(--txt-3);
}
slicc-file-tree .f.on::before {
  background: var(--violet);
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

/** Build the row elements for the given items (no innerHTML). */
function buildRows(items: readonly FileTreeItem[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const item of items) {
    if (item.kind === 'group') {
      rows.push(h('div', { class: 'grp' }, item.label));
    } else {
      rows.push(h('div', { class: 'f', 'data-id': item.id }, item.label));
    }
  }
  return rows;
}

/**
 * `<slicc-file-tree>` — the VFS sidebar from the prototype (`.tree`). A fixed
 * 190px, non-shrinking column of directory group headers (`.grp`) and clickable
 * file rows (`.f`), each with a small bullet. Single-selection: the active file
 * (`.f.on`) is tinted violet, and clicking a row (or calling
 * {@link SliccFileTree.selectFile}) selects it and emits `file-select`.
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
 *       <div class="f" data-id="hero.tsx">hero.tsx</div>
 *       <div class="f on" data-id="hero.css">hero.css</div>
 *       …
 *     </slicc-file-tree>
 *
 * @attr selected - id of the active file (reflected to {@link selected})
 * @slot - file rows supplied as light-DOM markup when `items` is not set; a
 *   plain text/`<div>` child becomes a `.f` row, `data-group` children become
 *   `.grp` headers, and the child's `id`/`data-id` becomes its file id
 * @fires file-select - a file was selected; `detail` carries `{ id, path }`
 */
export class SliccFileTree extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['selected'];
  }

  #items: FileTreeItem[] | null = null;
  #paths = new Map<string, string>();
  #initialized = false;
  #onClick: ((e: MouseEvent) => void) | null = null;

  connectedCallback(): void {
    ensureFileTreeStyle(this.ownerDocument);
    if (!this.#initialized) {
      // First connect: if no `items` were assigned programmatically, adopt any
      // light-DOM markup the caller slotted in as the initial item set.
      if (this.#items == null) this.#items = this.#harvestSlotted();
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

  /** The tree's rows (groups + files). Setting it re-renders the tree. */
  get items(): FileTreeItem[] {
    return this.#items ? this.#items.slice() : [];
  }

  set items(value: FileTreeItem[]) {
    this.#items = Array.isArray(value) ? value.slice() : [];
    this.#initialized = true;
    if (this.isConnected) {
      this.#render();
      this.#bindClick();
    }
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
    for (const item of items) {
      if (item.kind === 'file') this.#paths.set(item.id, item.path ?? item.label);
    }
    this.replaceChildren(...buildRows(items));
    this.#applySelection();
  }

  #bindClick(): void {
    if (this.#onClick) return;
    this.#onClick = (e: MouseEvent) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.f');
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
