import { define } from '../internal/define.js';
// Renders these child custom elements internally — owns their registration.
import './slicc-dock-item.js';
import { append, h } from '../internal/dom.js';

/**
 * One dock-rail entry descriptor. The dock renders one `<slicc-dock-item>` per
 * entry (composed BY TAG). Lifted from the prototype's right-rail markup
 * (`proto/StellarRubySwift.html` `.dock .di` buttons): a glyph, a tooltip label,
 * and a stable `id` that is the prototype's `data-t` — it becomes the dock-item's
 * `item-id`, is forwarded in the dock's select/collapse events, and is used by
 * {@link SliccDock.selectItem}.
 */
export interface DockItemDescriptor {
  /** Stable id (the prototype's `data-t`); becomes the item's `item-id`. */
  id: string;
  /** Lucide icon name shown in the rail (e.g. `sparkles`, `plus`, `globe`, `folder`). */
  icon?: string;
  /** Tooltip / accessible label (e.g. `Hero studio`, `Browser · CDP`). */
  label?: string;
  /** `sprinkle` (top, with the accent status dot) or `tool` (pinned at the bottom). */
  kind?: 'sprinkle' | 'tool';
  /** Accent hue for a sprinkle's status dot (e.g. `var(--violet)`) — sets the item `--h`. */
  hue?: string;
}

/**
 * The `slicc-dock-select` detail. `id` is the prototype's `data-t`; `kind` lets
 * a consumer distinguish a sprinkle launch from a pinned system-tool toggle.
 */
export interface DockSelectDetail {
  /** The selected item's id (the prototype's `data-t`). */
  id: string;
  /** Whether the selected item is a `sprinkle` or a pinned `tool`. */
  kind: 'sprinkle' | 'tool';
}

/** The `slicc-dock-collapse` detail — the id of the item that was toggled shut. */
export interface DockCollapseDetail {
  /** The id of the active item that was collapsed (its panel closed). */
  id: string;
}

/** The pinned system tools anchored at the rail bottom, in prototype order. */
const SYSTEM_TOOLS: readonly DockItemDescriptor[] = [
  { id: 'browser', icon: 'globe', label: 'Browser · CDP', kind: 'tool' },
  { id: 'files', icon: 'folder', label: 'Files · VFS', kind: 'tool' },
  { id: 'term', icon: 'square-terminal', label: 'Terminal', kind: 'tool' },
  { id: 'memory', icon: 'brain', label: 'Memory', kind: 'tool' },
] as const;

/** The always-present `New +` sprinkle launcher (prototype "New sprinkle"). */
const NEW_ITEM: DockItemDescriptor = {
  id: 'new',
  icon: 'plus',
  label: 'New sprinkle',
  kind: 'sprinkle',
};

/**
 * Scoped, document-level stylesheet for `<slicc-dock>`. A light-DOM host can't
 * carry a shadow-root `<style>`, so the `.dock` rail chrome is injected once into
 * the host document (idempotent), lifted verbatim from the prototype
 * (`proto/StellarRubySwift.html` `.dock` / `.div` / `.grow` rules). The host
 * class `.slicc-dock` scopes every rule so it can't leak.
 *
 * The rail bg is `color-mix(--ctx 12%, --bg)` so it flips automatically in dark
 * mode (`--bg` / `--line` flip in the token sheet). The per-item appearance
 * (`.di` hover / on / lit, the sprinkle status dot, the tooltip) lives on
 * `<slicc-dock-item>` (shadow DOM); the rail only owns the column geometry, the
 * `.div` divider, and the `.grow` spacer.
 */
const STYLE = `
.slicc-dock {
  flex: 0 0 48px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: color-mix(in srgb, var(--ctx) 12%, var(--bg));
  border-left: 1px solid var(--line);
  padding: 10px 0;
  position: relative;
  z-index: 2;
}
.slicc-dock .div {
  width: 22px;
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}
.slicc-dock .grow { flex: 1; }
`;

const STYLE_ID = 'slicc-dock-style';

/** Inject the scoped dock stylesheet into a document once (idempotent). */
function ensureDockStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Normalize a kind value to the dock's accepted set (`tool` falls back). */
function normalizeKind(value: string | null | undefined): 'sprinkle' | 'tool' {
  return value === 'sprinkle' ? 'sprinkle' : 'tool';
}

/**
 * `<slicc-dock>` — the right launcher rail from the prototype shell (`.dock`,
 * `#dock`). An always-visible 48px-wide vertical icon rail: sprinkle launchers at
 * the top, a `New +`, a `.grow` spacer, a `.div` divider, then the pinned system
 * tools (Browser / Files / Terminal / Memory) anchored at the bottom. It composes
 * one `<slicc-dock-item>` per entry (composed BY TAG), tracks the active item, and
 * stays in lockstep with the tab bar.
 *
 * Light DOM (no shadow root): the host renders the items into itself so the host
 * app can style/slot them; the scoped stylesheet is injected once into the host
 * document. Slotted `slicc-dock-item` children present at connect time are adopted
 * into the `items` list, then the declarative `items` property takes over.
 *
 * Toggle behaviour mirrors the prototype rail (`select` / `collapse`): each
 * `<slicc-dock-item>` already emits its own `select` (idle click) or `collapse`
 * (active click) event; the dock listens for those, updates the `active` item,
 * and re-emits the canonical `slicc-dock-select` / `slicc-dock-collapse` so the
 * shell + tab bar stay in lockstep. The rail bg flips with the theme (`--ctx`
 * over `--bg`); the per-item lit/active dark tweaks live on the dock-item.
 *
 * @attr active - the id of the active item (reflected to/from the `active` property)
 * @attr system-tools - boolean; appends the pinned Browser/Files/Terminal/Memory
 *   tools (after the `.grow` spacer + `.div` divider). Reflected to the property.
 * @csspart rail - the rail column (the host element itself carries `part="rail"`)
 * @slot - pre-existing `slicc-dock-item` children, adopted into `items` at connect
 * @fires slicc-dock-select - an item was selected; `detail` is {@link DockSelectDetail}
 * @fires slicc-dock-collapse - the active item was toggled shut; `detail` is
 *   {@link DockCollapseDetail}
 * @fires slicc-dock-longpress - an item was click-held (or modifier-clicked);
 *   `detail` is {@link DockSelectDetail}. The host's secondary action — e.g.
 *   opening the surface in browser fullscreen.
 */
export class SliccDock extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['active', 'system-tools'];
  }

  #items: DockItemDescriptor[] = [];
  #onSelect: ((e: Event) => void) | null = null;
  #onCollapse: ((e: Event) => void) | null = null;
  #onLongpress: ((e: Event) => void) | null = null;
  #initialized = false;

  connectedCallback(): void {
    ensureDockStyle(this.ownerDocument);
    this.classList.add('slicc-dock');
    this.setAttribute('part', 'rail');
    this.setAttribute('role', 'toolbar');
    this.setAttribute('aria-orientation', 'vertical');
    if (!this.#initialized) {
      this.#adoptSlotted();
      this.#initialized = true;
    }
    if (!this.#onSelect) {
      // The child dock-items emit their own `select` / `collapse` / `longpress`;
      // the dock listens (capturing the bubbling child events) and re-emits
      // canonically.
      this.#onSelect = (e: Event) => this.#handleChildSelect(e);
      this.#onCollapse = (e: Event) => this.#handleChildCollapse(e);
      this.#onLongpress = (e: Event) => this.#handleChildLongpress(e);
      this.addEventListener('select', this.#onSelect);
      this.addEventListener('collapse', this.#onCollapse);
      this.addEventListener('longpress', this.#onLongpress);
    }
    this.#render();
  }

  disconnectedCallback(): void {
    if (this.#onSelect) {
      this.removeEventListener('select', this.#onSelect);
      this.#onSelect = null;
    }
    if (this.#onCollapse) {
      this.removeEventListener('collapse', this.#onCollapse);
      this.#onCollapse = null;
    }
    if (this.#onLongpress) {
      this.removeEventListener('longpress', this.#onLongpress);
      this.#onLongpress = null;
    }
  }

  attributeChangedCallback(name: string): void {
    if (!this.#initialized) return;
    if (name === 'active') this.#syncActive();
    else if (name === 'system-tools') this.#render();
  }

  /**
   * The sprinkle item list (top of the rail). Pinned system tools are appended
   * separately via the `system-tools` attribute, not stored here. Returns a copy.
   */
  get items(): DockItemDescriptor[] {
    return this.#items.map((i) => ({ ...i }));
  }

  set items(value: DockItemDescriptor[]) {
    this.#items = Array.isArray(value) ? value.map((i) => ({ ...i })) : [];
    if (this.#initialized && this.isConnected) this.#render();
  }

  /** The active item id (reflected to the `active` attribute). */
  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  /** Whether the pinned system tools are shown at the rail bottom. */
  get systemTools(): boolean {
    return this.hasAttribute('system-tools');
  }

  set systemTools(value: boolean) {
    this.toggleAttribute('system-tools', !!value);
  }

  /**
   * Programmatic selection: set the active item and emit `slicc-dock-select`.
   * Mirrors the prototype `select(t)` — does NOT toggle/collapse (use a click on
   * an already-active item, or {@link collapse}, for the collapse behaviour).
   */
  selectItem(id: string): void {
    this.active = id;
    this.dispatchEvent(
      new CustomEvent<DockSelectDetail>('slicc-dock-select', {
        detail: { id, kind: this.#kindFor(id) },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Clear the active item WITHOUT emitting `slicc-dock-collapse` — the
   * event-less variant the shell uses when it already owns the collapse
   * (e.g. `slicc-shell.collapse()`, URL popstate restores).
   */
  clearActive(): void {
    this.active = null;
  }

  /**
   * Collapse the active item (clear `active`) and emit `slicc-dock-collapse`.
   * Mirrors the prototype `collapse()`. No-op (event-wise) when nothing is active.
   */
  collapse(): void {
    const id = this.active;
    this.active = null;
    if (id == null) return;
    this.dispatchEvent(
      new CustomEvent<DockCollapseDetail>('slicc-dock-collapse', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Adopt any slotted `slicc-dock-item` children into the `items` list (light DOM
   *  has no native `<slot>`, so we read them once at connect time, then rebuild
   *  them canonically via `#render`). System-tool items are dropped here in favour
   *  of the declarative `system-tools` attribute; the synthetic `new` launcher too. */
  #adoptSlotted(): void {
    const els = [...this.querySelectorAll<HTMLElement>('slicc-dock-item')];
    if (els.length === 0) return;
    const adopted: DockItemDescriptor[] = [];
    for (const el of els) {
      const kind = normalizeKind(el.getAttribute('kind'));
      const id = el.getAttribute('item-id') ?? el.dataset.t ?? el.getAttribute('tip') ?? '';
      if (kind === 'tool' || id === 'new' || id === '') continue;
      adopted.push({
        id,
        icon: el.getAttribute('icon') ?? undefined,
        label: el.getAttribute('tip') ?? undefined,
        kind: 'sprinkle',
        hue: el.getAttribute('hue') ?? undefined,
      });
    }
    for (const el of els) el.remove();
    if (this.#items.length === 0) this.#items = adopted;
  }

  /** Resolve the kind of an id: a known system tool is a `tool`, else the kind
   *  from `items`, falling back to `sprinkle` for the `new` launcher / `tool`. */
  #kindFor(id: string): 'sprinkle' | 'tool' {
    if (SYSTEM_TOOLS.some((t) => t.id === id)) return 'tool';
    if (id === NEW_ITEM.id) return 'sprinkle';
    return this.#items.find((i) => i.id === id)?.kind ?? 'tool';
  }

  /** Build one `<slicc-dock-item>` from a descriptor (composed BY TAG). The
   *  active item carries `active` so the child's own click resolves to `collapse`.
   *  Attributes are set via `h()` (the DOM escapes their values — no string
   *  interpolation), and absent `icon`/`hue`/`active` are omitted by `h()`. */
  #itemEl(item: DockItemDescriptor, active: string | null): HTMLElement {
    const id = item.id;
    const kind = normalizeKind(item.kind);
    const icon = item.icon ?? '';
    const label = item.label ?? id;
    const isActive = active != null && active === id;
    const hue = item.hue;
    return h('slicc-dock-item', {
      'data-t': id,
      'item-id': id,
      kind,
      icon: icon || false,
      tip: label,
      hue: hue || false,
      active: isActive,
    });
  }

  /** Rebuild the rail: sprinkles (top) → `New +` → `.grow` → `.div` → tools. */
  #render(): void {
    const active = this.active;
    const nodes: Node[] = [];
    for (const item of this.#items) {
      if (normalizeKind(item.kind) === 'sprinkle') nodes.push(this.#itemEl(item, active));
    }
    nodes.push(this.#itemEl(NEW_ITEM, active));
    nodes.push(h('div', { class: 'grow' }));
    if (this.systemTools) {
      nodes.push(h('div', { class: 'div' }));
      for (const tool of SYSTEM_TOOLS) nodes.push(this.#itemEl(tool, active));
    }
    this.replaceChildren();
    append(this, nodes);
  }

  /** Toggle the active attribute on items to match the `active` property without a
   *  full rebuild (keeps each dock-item's own shadow listeners/state intact). */
  #syncActive(): void {
    const active = this.active;
    for (const el of this.querySelectorAll<HTMLElement>('slicc-dock-item')) {
      el.toggleAttribute('active', el.dataset.t === active);
    }
  }

  /** A child dock-item fired `select` (an idle item was clicked). Adopt it as the
   *  active item and re-emit the canonical `slicc-dock-select`. */
  #handleChildSelect(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();
    this.selectItem(id);
  }

  /** A child dock-item fired `collapse` (the active item was clicked). Clear the
   *  active item and re-emit the canonical `slicc-dock-collapse`. */
  #handleChildCollapse(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();
    // Keep the active item in sync even if the child id drifted from our state.
    if (this.active !== id) this.active = id;
    this.collapse();
  }

  /** A child dock-item was click-held: select it (so its surface opens) and
   *  re-emit the canonical `slicc-dock-longpress` for the host's secondary
   *  action (e.g. browser fullscreen). */
  #handleChildLongpress(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();
    if (this.active !== id) this.selectItem(id);
    this.dispatchEvent(
      new CustomEvent<DockSelectDetail>('slicc-dock-longpress', {
        detail: { id, kind: this.#kindFor(id) },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Resolve the originating dock-item id from a child select/collapse event,
   *  preferring the event detail and falling back to the element's `data-t`. */
  #idFromChildEvent(e: Event): string | null {
    const detail = (e as CustomEvent<{ id: string | null }>).detail;
    if (detail && typeof detail.id === 'string') return detail.id;
    const item = (e.target as HTMLElement | null)?.closest<HTMLElement>('slicc-dock-item');
    if (item && this.contains(item)) return item.dataset.t ?? null;
    return null;
  }
}

define('slicc-dock', SliccDock);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dock': SliccDock;
  }
  interface HTMLElementEventMap {
    'slicc-dock-select': CustomEvent<DockSelectDetail>;
    'slicc-dock-collapse': CustomEvent<DockCollapseDetail>;
    'slicc-dock-longpress': CustomEvent<DockSelectDetail>;
  }
}
