import { define } from '../internal/define.js';
// Renders these child custom elements internally — owns their registration.
import './slicc-tab.js';
import { h } from '../internal/dom.js';

/**
 * Scoped, document-level stylesheet for `<slicc-tab-bar>`. Light-DOM hosts cannot
 * carry an inline `<style>` in a shadow root, so the strip chrome is injected once
 * into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.tabstrip`):
 * the horizontal scrollable strip in the workbench header (`.wbhead`) that holds
 * the ordered content (sprinkle) `.tab` buttons. `min-width: 0` lets it shrink
 * under the header spacer instead of forcing the header wider, and
 * `overflow-x: auto` scrolls the tabs horizontally once they exceed the
 * available width.
 *
 * The strip itself carries no bar-level dark rule — active-tab tinting lives on
 * the `<slicc-tab>` children. Everything is var-driven so it tracks the inherited
 * theme automatically.
 */
const STYLE = `
slicc-tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  font-family: var(--ui);
}
slicc-tab-bar[hidden] {
  display: none;
}
`;

const STYLE_ID = 'slicc-tab-bar-style';

/** Inject the scoped tab-strip stylesheet into a document once (idempotent). */
function ensureTabBarStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Kinds a tab descriptor can carry: a plain `tool` tab or a defined `sprinkle`
 * chip. Per the project decision the bar NEVER renders `tool` tabs — the data
 * model still accepts them (so consumers can keep passing them), but only
 * `sprinkle` (content) tabs are displayed. See {@link SliccTabBar}.
 */
export type TabKind = 'tool' | 'sprinkle';

/**
 * Descriptor for one tab in the strip. `id` is the stable handle used by
 * `selectTab` / `removeTab` and echoed on the `tab-select` / `tab-close` events;
 * everything else mirrors the prototype `.tab` markup.
 */
export interface TabDescriptor {
  /** Stable tab id (the prototype `data-t`); the select/close handle. */
  id: string;
  /** Visible label text (escaped on render). */
  label: string;
  /** `tool` (plain) or `sprinkle` (defined chip with the ✦ glyph). */
  kind?: TabKind;
  /** Whether a close affordance is shown (sprinkle tabs are closable). */
  closable?: boolean;
  /** Sprinkle badge lucide icon name, kebab-case (sprinkle kind only). */
  badge?: string;
  /** Optional leading glyph for tool tabs (the prototype `.gl`), e.g. an icon. */
  glyph?: string;
}

/** Detail payload for the `tab-select` / `tab-close` events. */
export interface TabEventDetail {
  /** The id of the affected tab. */
  id: string;
}

/** Normalize an unknown kind to the `tool` | `sprinkle` union (defaults `tool`). */
function normalizeKind(kind: string | null | undefined): TabKind {
  return kind === 'sprinkle' ? 'sprinkle' : 'tool';
}

/**
 * `<slicc-tab-bar>` — the workbench tab strip from the prototype (`.tabstrip`).
 * A horizontal, scrollable flex row that hosts an ordered set of `<slicc-tab>`
 * children (composed BY TAG). The tab set is dynamic: `addTab` / `removeTab` /
 * `selectTab` mutate it and keep exactly one active tab in sync, and the `tabs`
 * array property declaratively replaces the whole set.
 *
 * Per the project decision the bar NEVER shows tools in the tab bar: `tool`-kind
 * descriptors are accepted by the data model (`tabs` / `addTab` keep them, so the
 * active selection and consumers are unaffected) but are filtered out of
 * rendering — only `sprinkle` (content) tabs are displayed.
 *
 * Light DOM (no shadow root): the strip renders its `<slicc-tab>` children into
 * its own light subtree so the host app can style them and so the children are
 * real, addressable elements.
 *
 * `<slicc-tab>` is a shadow-DOM element that publishes its own `select` (body
 * clicked) and `close` (X clicked) `CustomEvent`s — both `{ detail: { tabId } }`,
 * bubbling + composed so they cross its shadow boundary. The bar catches those on
 * the strip and re-emits them as its own canonical `tab-select` / `tab-close`
 * (carrying `{ id }`), keeping the active state in sync. A `close` removes the
 * tab; removing the active tab falls back to selecting the first remaining tab
 * (the prototype's `select('files')` fallback). As a robustness fallback for
 * light-DOM tabs, a delegated click on a `.x` / `[data-close]` hit also closes,
 * and a click elsewhere on a tab selects it.
 *
 * @attr active - the id of the currently selected tab (reflected; mirrors `.tab.on`)
 * @csspart tab - each rendered `<slicc-tab>` child
 * @fires tab-select - `{ detail: { id } }` when a tab becomes active (composed, bubbling)
 * @fires tab-close - `{ detail: { id } }` when a tab is closed (composed, bubbling)
 */
export class SliccTabBar extends HTMLElement {
  static readonly observedAttributes = ['active'];

  #tabs: TabDescriptor[] = [];
  #built = false;
  #onClick: ((e: Event) => void) | null = null;
  #onChildSelect: ((e: Event) => void) | null = null;
  #onChildClose: ((e: Event) => void) | null = null;

  connectedCallback(): void {
    ensureTabBarStyle(this.ownerDocument);
    this.#bind();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbind();
    // Mark the rendered strip stale so a re-attach rebuilds the tabs from the
    // data model. Light-DOM children can be dropped while detached (reflow /
    // navigation rebuilds), and the tab set must survive detach + re-attach
    // without loss or duplication — replaceChildren on re-render guarantees both.
    this.#built = false;
  }

  attributeChangedCallback(name: string): void {
    if (name === 'active' && this.isConnected) this.#syncActive();
  }

  /** The id of the currently active tab (reflected to the `active` attribute). */
  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  /**
   * The ordered tab set. Assigning replaces the whole set and re-renders; the
   * getter returns a defensive copy so external mutation cannot desync the DOM.
   */
  get tabs(): TabDescriptor[] {
    return this.#tabs.map((t) => ({ ...t }));
  }

  set tabs(value: TabDescriptor[]) {
    this.#tabs = (value ?? []).map((t) => ({ ...t }));
    if (this.active != null && !this.#tabs.some((t) => t.id === this.active)) {
      // Dropped active tab — fall back to the first remaining (or none).
      this.#setActiveSilently(this.#tabs[0]?.id ?? null);
    }
    this.#built = false;
    if (this.isConnected) this.#render();
  }

  /**
   * Add a tab to the end of the strip (or update it in place if the id already
   * exists) and select it. Fires `tab-select`. Returns the descriptor used.
   */
  addTab(tab: TabDescriptor): TabDescriptor {
    const next: TabDescriptor = { ...tab, kind: normalizeKind(tab.kind) };
    const existing = this.#tabs.findIndex((t) => t.id === next.id);
    if (existing >= 0) this.#tabs[existing] = next;
    else this.#tabs.push(next);
    this.#built = false;
    if (this.isConnected) this.#render();
    this.selectTab(next.id);
    return next;
  }

  /**
   * Remove the tab with `id`. If it was active, fall back to selecting the first
   * remaining tab (mirrors the prototype `select('files')`). Fires `tab-close`,
   * and `tab-select` for any fallback selection. No-op for an unknown id.
   */
  removeTab(id: string): void {
    const idx = this.#tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = this.active === id;
    this.#tabs.splice(idx, 1);
    this.#built = false;
    if (this.isConnected) this.#render();

    this.dispatchEvent(
      new CustomEvent<TabEventDetail>('tab-close', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );

    if (wasActive) {
      const fallback = this.#tabs[0]?.id ?? null;
      if (fallback != null) this.selectTab(fallback);
      else this.#setActiveSilently(null);
    }
  }

  /**
   * Select the tab with `id`, keeping the active state in sync and firing
   * `tab-select`. No-op for an unknown id or a re-select of the active tab.
   */
  selectTab(id: string): void {
    if (!this.#tabs.some((t) => t.id === id)) return;
    if (this.active === id) return;
    this.#setActiveSilently(id);
    this.dispatchEvent(
      new CustomEvent<TabEventDetail>('tab-select', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Set the active id + attribute + active state WITHOUT firing `tab-select`. */
  #setActiveSilently(id: string | null): void {
    if (id == null) {
      this.removeAttribute('active');
    } else {
      this.setAttribute('active', id);
    }
    this.#syncActive();
  }

  /** Reflect the active id onto the rendered `<slicc-tab>` children. */
  #syncActive(): void {
    const active = this.active;
    for (const el of this.querySelectorAll(':scope > slicc-tab')) {
      const id = el.getAttribute('tab-id');
      el.toggleAttribute('active', id != null && id === active);
    }
  }

  /** Resolve the bar tab id a DOM target belongs to (the `<slicc-tab>` child). */
  #tabIdFor(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const tab = target.closest('slicc-tab');
    if (!tab || tab.parentElement !== this) return null;
    return tab.getAttribute('tab-id');
  }

  /** Wire the strip listeners (once): child `select`/`close` + a click fallback. */
  #bind(): void {
    if (this.#onChildSelect) return;
    // `<slicc-tab>` is shadow-DOM; its `.x` is unreachable by light-DOM
    // delegation, so the primary path is its bubbling+composed `select`/`close`
    // events, which the bar re-emits as its own canonical `tab-select`/`tab-close`.
    this.#onChildSelect = (e: Event) => this.#handleChildSelect(e);
    this.#onChildClose = (e: Event) => this.#handleChildClose(e);
    this.addEventListener('select', this.#onChildSelect as EventListener);
    this.addEventListener('close', this.#onChildClose as EventListener);
    // Fallback for plain light-DOM tabs (no shadow `select`/`close`): a click
    // selects, unless it lands on a `.x` / `[data-close]` hit, which closes.
    this.#onClick = (e: Event) => this.#handleClick(e);
    this.addEventListener('click', this.#onClick);
  }

  #unbind(): void {
    if (this.#onChildSelect)
      this.removeEventListener('select', this.#onChildSelect as EventListener);
    if (this.#onChildClose) this.removeEventListener('close', this.#onChildClose as EventListener);
    if (this.#onClick) this.removeEventListener('click', this.#onClick);
    this.#onChildSelect = null;
    this.#onChildClose = null;
    this.#onClick = null;
  }

  /** A child `<slicc-tab>` reported a body click (`select`) — select that tab. */
  #handleChildSelect(e: Event): void {
    if (e.target === this) return;
    const id = this.#tabIdFor(e.target);
    if (id == null) return;
    e.stopPropagation();
    this.selectTab(id);
  }

  /** A child `<slicc-tab>` reported a close click (`close`) — remove that tab. */
  #handleChildClose(e: Event): void {
    if (e.target === this) return;
    const id = this.#tabIdFor(e.target);
    if (id == null) return;
    e.stopPropagation();
    this.removeTab(id);
  }

  /**
   * Delegated click fallback for light-DOM tabs (a shadow `<slicc-tab>` already
   * routed via `select`/`close`, so its hits never reach here through the shadow
   * boundary). A click selects the tab it lands on, unless it landed on a close
   * affordance (`.x` / `[data-close]`), in which case the tab closes.
   */
  #handleClick(e: Event): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest('slicc-tab');
    if (!tab || tab.parentElement !== this) return;
    const id = tab.getAttribute('tab-id');
    if (id == null) return;

    const closeHit = target.closest('.x, [data-close]');
    if (closeHit && tab.contains(closeHit)) {
      e.stopPropagation();
      this.removeTab(id);
      return;
    }
    this.selectTab(id);
  }

  /**
   * Build the `<slicc-tab>` children. `tool`-kind descriptors are never rendered
   * (the project decision: no tools in the tab bar) — only `sprinkle` (content)
   * tabs paint, while the data model keeps the full set.
   */
  #render(): void {
    if (this.#built) return;
    this.#built = true;

    const active = this.active;
    const nodes: Node[] = [];

    for (const t of this.#tabs) {
      const kind = normalizeKind(t.kind);
      if (kind === 'tool') continue;
      nodes.push(
        h('slicc-tab', {
          'tab-id': t.id,
          kind,
          label: t.label,
          part: 'tab',
          closable: t.closable ? true : undefined,
          badge: t.badge || undefined,
          glyph: t.glyph || undefined,
          active: active != null && active === t.id ? true : undefined,
        })
      );
    }

    this.replaceChildren(...nodes);
  }
}

define('slicc-tab-bar', SliccTabBar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tab-bar': SliccTabBar;
  }
}
