import { define } from '../internal/define.js';
// Renders these child custom elements internally — owns their registration.
import './slicc-palette-cell.js';

/**
 * Scoped, document-level stylesheet for `<slicc-palette-grid>`. A light-DOM
 * component can't carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the
 * prototype hooks.
 *
 * Lifted verbatim from the prototype's brand-palette panel
 * (`proto/StellarRubySwift.html` — `.pal` / `.pal h4` / `.palgrid`): a
 * scrollable padded panel with a small bold heading above an auto-fill grid of
 * swatch chips. The chips themselves are composed `<slicc-palette-cell>`
 * elements — a shadow-DOM sibling that owns its own bordered/rounded card,
 * 38px swatch band, label, and dark-mode dimming — so the grid stylesheet only
 * lays out the panel + grid and never restyles the cell internals.
 */
const STYLE = `
slicc-palette-grid {
  display: block;
  flex: 1;
  overflow: auto;
  padding: 18px;
  font-family: var(--ui);
  color: var(--ink);
}
slicc-palette-grid h4 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}
slicc-palette-grid .palgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
}
`;

const STYLE_ID = 'slicc-palette-grid-style';

/** Inject the scoped palette-grid stylesheet into a document once (idempotent). */
function ensurePaletteGridStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** A single palette token: a swatch `color` and its `label`. */
export interface PaletteToken {
  /** The token's display label (e.g. `canvas #faf6f1`). */
  label: string;
  /** The swatch color (any CSS color a `slicc-palette-cell` `color` accepts). */
  color: string;
}

/** The prototype's brand-palette tokens (canvas / cone / scoop×3 / ink). */
export const DEFAULT_TOKENS: readonly PaletteToken[] = [
  { label: 'canvas #faf6f1', color: '#faf6f1' },
  { label: 'cone #ef7000', color: '#ef7000' },
  { label: 'scoop #8b5cf6', color: '#8b5cf6' },
  { label: 'scoop #06b6d4', color: '#06b6d4' },
  { label: 'scoop #f43f5e', color: '#f43f5e' },
  { label: 'ink #0a0a0a', color: '#0a0a0a' },
];

const DEFAULT_HEADING = 'brand palette · tokens';

/**
 * `<slicc-palette-grid>` — the brand-palette panel from the prototype's right
 * rail (`.pal`). A scrollable padded panel with a small bold heading
 * (`brand palette · tokens`) above an auto-fill grid (`.palgrid`,
 * `repeat(auto-fill, minmax(96px, 1fr))`, `gap: 10px`) of swatch chips — one
 * `<slicc-palette-cell>` per token (canvas / cone / scoop×3 / ink). The grid
 * reflows by width and scrolls vertically; each cell owns its own light/dark
 * chip rendering (the dark swatch dimming + canvas rebasing live in the cell).
 *
 * Light DOM (no shadow root): the host renders its own `.palgrid` chrome into
 * itself so the host app can style and slot content. Caller-supplied children
 * present at connect time are relocated into the grid ahead of the token cells
 * (light DOM has no native slot). The scoped stylesheet (above) is injected once
 * into the host document.
 *
 * The chips are composed BY TAG: the grid creates `<slicc-palette-cell>`
 * elements and sets their `color` / `label` attributes; the cell renders its
 * own shadow-DOM chrome. The grid listens for the cell's bubbling
 * `palette-select` event and re-emits a grid-level `select` carrying
 * `{ label, color }`.
 *
 * Internal DOM (light DOM):
 *
 *     <slicc-palette-grid>
 *       <h4>brand palette · tokens</h4>
 *       <div class="palgrid">
 *         <slicc-palette-cell color="#faf6f1" label="canvas #faf6f1"></slicc-palette-cell>
 *         <slicc-palette-cell color="#ef7000" label="cone #ef7000"></slicc-palette-cell>
 *         …
 *       </div>
 *     </slicc-palette-grid>
 *
 * @attr heading - the panel heading (text); defaults to `brand palette · tokens`
 * @slot - extra chip content relocated into the `.palgrid` ahead of the `tokens`
 *   (light DOM has no native slot)
 * @fires select - a swatch cell was activated (relayed from the cell's
 *   `palette-select`); `detail` carries `{ label, color }`
 */
export class SliccPaletteGrid extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['heading'];
  }

  #initialized = false;
  #heading: HTMLHeadingElement | null = null;
  #grid: HTMLDivElement | null = null;
  /** Caller-supplied children relocated into the grid before the token cells. */
  #slotted: Node[] = [];
  /** Backing store for the `tokens` property; `null` means "use the default set". */
  #tokens: PaletteToken[] | null = null;
  #onSelect: ((e: Event) => void) | null = null;

  connectedCallback(): void {
    ensurePaletteGridStyle(this.ownerDocument);
    if (!this.#initialized) this.#initialize();
    this.#sync();
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (!this.#initialized) return;
    this.#sync();
  }

  /** The panel heading; defaults to `brand palette · tokens`. */
  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  /**
   * The palette tokens rendered as swatch cells. Defaults to {@link DEFAULT_TOKENS}
   * (canvas / cone / scoop×3 / ink) until assigned. Assigning re-renders the grid;
   * the getter returns a defensive copy.
   */
  get tokens(): PaletteToken[] {
    const source = this.#tokens ?? DEFAULT_TOKENS;
    return source.map((t) => ({ ...t }));
  }

  set tokens(value: PaletteToken[] | null) {
    this.#tokens = Array.isArray(value)
      ? value.map((t) => ({ label: String(t.label ?? ''), color: String(t.color ?? '') }))
      : null;
    if (this.#initialized) this.#renderCells();
  }

  #initialize(): void {
    this.#initialized = true;

    // Relocate any pre-existing host children (extra chips / static markup) so
    // the caller can slot content; light DOM has no native slot.
    this.#slotted = [];
    while (this.firstChild) {
      this.#slotted.push(this.firstChild);
      this.removeChild(this.firstChild);
    }

    const heading = this.ownerDocument.createElement('h4');
    const grid = this.ownerDocument.createElement('div');
    grid.className = 'palgrid';

    this.append(heading, grid);
    this.#heading = heading;
    this.#grid = grid;

    this.#renderCells();
  }

  /** Push current attribute state into the rendered chrome. */
  #sync(): void {
    if (this.#heading) this.#heading.textContent = this.heading;
  }

  /**
   * Rebuild the grid: the relocated slotted children first, then one composed
   * `<slicc-palette-cell>` per token. Idempotent — clears the grid each time.
   */
  #renderCells(): void {
    const grid = this.#grid;
    if (!grid) return;

    grid.replaceChildren();

    // Preserve caller-supplied chips ahead of the token cells.
    for (const node of this.#slotted) grid.appendChild(node);

    for (const token of this.tokens) {
      const cell = this.ownerDocument.createElement('slicc-palette-cell');
      cell.setAttribute('color', token.color);
      cell.setAttribute('label', token.label);
      grid.appendChild(cell);
    }
  }

  #bind(): void {
    if (this.#onSelect) return;
    // Relay the cell's bubbling `palette-select` up as a grid-level `select`,
    // composing the sibling through its documented public event surface.
    this.#onSelect = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      this.dispatchEvent(
        new CustomEvent('select', {
          bubbles: true,
          composed: true,
          detail: { label: detail.label ?? '', color: detail.color ?? '', sourceEvent: e },
        })
      );
    };
    this.addEventListener('palette-select', this.#onSelect);
  }

  #unbind(): void {
    if (this.#onSelect) {
      this.removeEventListener('palette-select', this.#onSelect);
      this.#onSelect = null;
    }
  }
}

define('slicc-palette-grid', SliccPaletteGrid);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-palette-grid': SliccPaletteGrid;
  }
}
