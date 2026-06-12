import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-surface>`. Light-DOM hosts cannot
 * carry an inline `<style>` in a shadow root, so the chrome is injected once into
 * the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.surface`
 * / `.surface.on`, plus the mem/pal/browser variant rules): the switchable panels
 * that fill the workbench body (`.wbbody`). Every surface is stacked absolutely on
 * top of the others (`position:absolute; inset:0`) and hidden by default
 * (`display:none`); the active one is revealed by the host's `active` attribute
 * (the prototype's `.surface.on`). The reveal `display` follows the surface's
 * `layout`:
 *
 *   - `flex`   (default) → `display:flex`  — Files (tree + preview), Terminal,
 *                                            Hero studio (controls + stage).
 *   - `block`            → `display:block` — Memory / Palette scroll lists
 *                                            (`.surface.mem.on,.surface.pal.on`).
 *   - `column`          → `display:flex; flex-direction:column` and a `#fafafa`
 *                                            backdrop — the Browser/CDP surface
 *                                            (`.surface.browser.on`).
 *
 * Everything is var-driven where the prototype is (`--canvas` / `--line` / `--bg`
 * inherit through the theme scope); the Browser surface keeps the prototype's
 * literal `#fafafa` chrome and the Terminal surface stays dark by its own slotted
 * `.term` content (the surface container is theme-neutral). The container only
 * owns positioning + visibility; the slotted regions handle their own overflow.
 */
const STYLE = `
slicc-surface {
  position: absolute;
  inset: 0;
  display: none;
  box-sizing: border-box;
  font-family: var(--ui);
}
/* Active reveal — the prototype's \`.surface.on\`. Default (and \`layout="flex"\`)
   reveals as a flex row (Files / Terminal / Hero studio). */
slicc-surface[active] {
  display: flex;
}
/* \`.surface.mem.on,.surface.pal.on\` — the Memory / Palette scroll lists reveal as
   a plain block. */
slicc-surface[active][layout="block"] {
  display: block;
}
/* \`.surface.browser.on\` — the Browser/CDP surface stacks its bar over the compare
   grid and paints the prototype's literal paper backdrop. */
slicc-surface[active][layout="column"] {
  display: flex;
  flex-direction: column;
  background: #fafafa;
}
/* Browser-fullscreen (Fullscreen API): the surface normally inherits the pane's
   backdrop; standalone over the UA's black fullscreen backdrop it needs its own
   opaque canvas, and the absolute inset anchors to the viewport. */
slicc-surface:fullscreen {
  background: var(--canvas, #fff);
  position: fixed;
}
`;

const STYLE_ID = 'slicc-surface-style';

/** Inject the scoped surface stylesheet into a document once (idempotent). */
function ensureSurfaceStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The three reveal layouts; anything else normalizes to `flex`. */
type SurfaceLayout = 'flex' | 'block' | 'column';

function normalizeLayout(value: string | null): SurfaceLayout {
  return value === 'block' || value === 'column' ? value : 'flex';
}

/**
 * `<slicc-surface>` — a switchable workbench panel from the prototype (`.surface`
 * + `.surface.on`, with the mem/pal/browser variants). Each surface fills the
 * workbench body (`.wbbody`) absolutely (`inset:0`) and is hidden until it becomes
 * the active panel; only one surface in a body is active at a time (the host app
 * owns that exclusivity, exactly as the prototype's `select()` does by toggling
 * `.on` across all `.surface` nodes).
 *
 * Light DOM (no shadow root): the host renders nothing of its own — it is a pure
 * positioned container that slots whatever the surface holds (a `.tree` +
 * `.fileview`, a dark `.term`, a `.mem` list, the `.bbar` + `.bcompare` browser
 * comparison, the hero `.controls` + `.stage`, …), so the host app can style the
 * regions and the slotted content keeps its own overflow handling. The terminal
 * surface's dark canvas comes from its slotted `.term` content, not the container,
 * so it stays dark by design regardless of theme.
 *
 * @attr surface-id - identifier for this surface (mirrors the prototype's `data-s`); also reflected to `data-s` for parity
 * @attr active - boolean; reveals the surface (mirrors `.surface.on`). Setting it fires `surface-toggle`.
 * @attr layout - `flex` (default) | `block` | `column`; the reveal `display` mode (block = mem/pal list, column = browser)
 * @fires surface-toggle - composed + bubbling `CustomEvent<{ surfaceId, active, layout }>` when `active` changes
 * @slot - default; the surface's regions (tree/preview, terminal, memory list, browser compare, …), rendered in DOM order
 */
export class SliccSurface extends HTMLElement {
  static readonly observedAttributes = ['surface-id', 'active', 'layout'];

  connectedCallback(): void {
    ensureSurfaceStyle(this.ownerDocument);
    // Keep `data-s` in sync for prototype-parity selectors / queries.
    this.#syncDataset();
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (!this.isConnected) return;
    if (name === 'surface-id') {
      this.#syncDataset();
    } else if (name === 'active' && prev !== next) {
      // Visibility is driven entirely by CSS (`slicc-surface[active] …`); the
      // event is the only side effect, so host apps can react to selection.
      this.dispatchEvent(
        new CustomEvent('surface-toggle', {
          bubbles: true,
          composed: true,
          detail: { surfaceId: this.surfaceId, active: this.active, layout: this.layout },
        })
      );
    }
  }

  /** Identifier for this surface (mirrors the prototype's `data-s`). */
  get surfaceId(): string | null {
    return this.getAttribute('surface-id');
  }

  set surfaceId(value: string | null) {
    if (value == null) this.removeAttribute('surface-id');
    else this.setAttribute('surface-id', value);
  }

  /** Whether the surface is the visible/active panel (mirrors `.surface.on`). */
  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', value);
  }

  /** The reveal layout: `flex` (default) | `block` (mem/pal) | `column` (browser). */
  get layout(): SurfaceLayout {
    return normalizeLayout(this.getAttribute('layout'));
  }

  set layout(value: SurfaceLayout) {
    this.setAttribute('layout', normalizeLayout(value));
  }

  /** Mirror `surface-id` onto `data-s` so prototype-parity selectors keep working. */
  #syncDataset(): void {
    const id = this.surfaceId;
    if (id == null) delete this.dataset.s;
    else this.dataset.s = id;
  }
}

define('slicc-surface', SliccSurface);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-surface': SliccSurface;
  }
}
