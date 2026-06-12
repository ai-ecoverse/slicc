import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/**
 * Shared constructable stylesheet, lifted verbatim from the prototype dip palette
 * (`proto/StellarRubySwift.html` — `.dip .pcell`, `.ch`, `.cl`, `.sel`). The
 * cell is a bordered, rounded clickable card over a semi-transparent
 * canvas-mix surface holding a 38px color chip and a 10px `--ui` label.
 * Selection draws the violet double-ring; hover lifts the card. Colors,
 * spacing and the label font all come from the inherited prototype tokens
 * (`--line`, `--violet`, `--canvas`, `--txt-2`, `--ui`) — none are redeclared.
 */
const STYLE = `
:host {
  display: block;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  cursor: pointer;
  background: color-mix(in srgb, var(--canvas) 86%, transparent);
  transition: .12s;
  -webkit-user-select: none;
  user-select: none;
}
:host(:hover) { transform: translateY(-1px); }
:host([selected]) { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--violet); }
:host(:focus-visible) { outline: none; box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--violet); }
.ch { height: 38px; }
.cl {
  font-family: var(--ui);
  font-size: 10px;
  color: var(--txt-2);
  padding: 5px 7px;
  background: var(--canvas);
}
/* palette chips carry inline-style light backgrounds — tone them down for dark mode */
:host-context(.dark) .ch,
:host-context([data-theme="dark"]) .ch { filter: brightness(.55) saturate(.85); }
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-palette-cell>` — the palette-picker swatch cell from the prototype
 * Hero-studio dip (`.pcell` / `.ch` / `.cl`). A bordered rounded card holding a
 * 38px color chip (`color` attribute, inline chip background) above a small
 * label (`label` attribute). Clicking selects the cell and emits a composed,
 * bubbling `palette-select` event carrying the cell's `color`, `label`, and
 * `group`. Cells sharing a `group` are single-select: selecting one clears the
 * `selected` state on its same-group siblings within the surrounding host (the
 * nearest shadow root or the document), mirroring the prototype's
 * `pgrid → .pcell.sel` per-group exclusivity.
 *
 * Self-contained shadow DOM; themes via inherited tokens. The selection ring's
 * inner `#fff` band is fixed in both light and dark to keep the violet ring
 * legible over the canvas-mix surface.
 *
 * @attr color - chip color (hex/CSS color); painted as the `.ch` chip background
 * @attr label - the cell caption text (escaped)
 * @attr group - selection group name; same-group cells are mutually exclusive
 * @attr selected - boolean; draws the violet double-ring
 * @csspart cell - the host card surface (also styleable via the element itself)
 * @csspart chip - the 38px color chip
 * @csspart label - the caption row
 * @slot - optional label content, used when the `label` attribute is absent
 * @fires palette-select - `{ color, label, group }` when the cell is activated
 */
export class SliccPaletteCell extends HTMLElement {
  static readonly observedAttributes = ['color', 'label', 'group', 'selected'];

  readonly #root: ShadowRoot;
  #onClick: (() => void) | null = null;
  #onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this.setAttribute('role', 'button');
    this.#render();
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Chip color (hex/CSS color); painted as the `.ch` chip background. */
  get color(): string | null {
    return this.getAttribute('color');
  }

  set color(value: string | null) {
    if (value == null) this.removeAttribute('color');
    else this.setAttribute('color', value);
  }

  /** Cell caption text. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Selection-group name; same-group cells are mutually exclusive. */
  get group(): string | null {
    return this.getAttribute('group');
  }

  set group(value: string | null) {
    if (value == null) this.removeAttribute('group');
    else this.setAttribute('group', value);
  }

  /** Whether this cell is selected (draws the violet double-ring). */
  get selected(): boolean {
    return this.hasAttribute('selected');
  }

  set selected(value: boolean) {
    this.toggleAttribute('selected', value);
  }

  /**
   * Select this cell, clearing the `selected` state of same-group siblings in
   * the surrounding host, then emit `palette-select`. Idempotent re-selection
   * still re-emits (mirrors the prototype's click-to-confirm).
   */
  select(): void {
    this.#clearGroup();
    this.selected = true;
    this.dispatchEvent(
      new CustomEvent('palette-select', {
        bubbles: true,
        composed: true,
        detail: { color: this.color, label: this.label, group: this.group },
      })
    );
  }

  /** Deselect same-group siblings within the nearest host (shadow root or document). */
  #clearGroup(): void {
    const group = this.group;
    if (!group) return;
    const host = this.getRootNode() as Document | ShadowRoot;
    const siblings = host.querySelectorAll<SliccPaletteCell>(
      `slicc-palette-cell[group="${CSS.escape(group)}"][selected]`
    );
    for (const cell of siblings) {
      if (cell !== this) cell.selected = false;
    }
  }

  #bind(): void {
    if (this.#onClick) return;
    this.#onClick = () => this.select();
    this.#onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.select();
      }
    };
    this.addEventListener('click', this.#onClick);
    this.addEventListener('keydown', this.#onKey);
  }

  #unbind(): void {
    if (this.#onClick) this.removeEventListener('click', this.#onClick);
    if (this.#onKey) this.removeEventListener('keydown', this.#onKey);
    this.#onClick = null;
    this.#onKey = null;
  }

  #render(): void {
    this.setAttribute('aria-pressed', this.selected ? 'true' : 'false');
    const color = this.color ?? 'transparent';
    const label = this.label;
    const chip = h('div', { class: 'ch', part: 'chip', style: `background:${color}` });
    const caption = h('div', { class: 'cl', part: 'label' }, label != null ? label : h('slot'));
    this.#root.replaceChildren(chip, caption);
  }
}

define('slicc-palette-cell', SliccPaletteCell);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-palette-cell': SliccPaletteCell;
  }
}
