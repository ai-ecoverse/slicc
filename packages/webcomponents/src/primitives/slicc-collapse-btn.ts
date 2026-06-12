import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
:host { display: inline-flex; flex: 0 0 auto; }
:host([hidden]) { display: none; }
.col {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  background: var(--canvas);
  border-radius: 8px;
  height: 28px;
  padding: 0 9px;
  cursor: pointer;
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
.col:hover { background: var(--ghost); color: var(--ink); }
.icon { display: inline-flex; place-items: center; pointer-events: none; }
.icon svg { display: block; }
`;
const SHEET = sheet(STYLE);

/**
 * Default lucide icon — `panel-right-close` reads as "collapse the workbench"
 * (the workbench is the right-hand shell panel; this glyph depicts that side
 * panel folding shut). The icon inherits the button's `currentColor`, so it
 * tracks the idle (`--txt-2`) / hover (`--ink`) palette automatically.
 */
const DEFAULT_ICON = 'panel-right-close';
const DEFAULT_LABEL = 'Collapse';
/** Rendered lucide glyph size (px) inside the 28px-tall button. */
const ICON_SIZE = 16;

/**
 * `<slicc-collapse-btn>` — the icon button at the right of the workbench header
 * (`.wbhead .col`) in the prototype. A 28px-tall canvas-backed button whose
 * glyph is a **lucide** `panel-right-close` icon (rendered via the shared
 * `iconEl` helper — never emoji or bespoke unicode symbols) that hovers to
 * `--ghost` / `--ink`. Self-contained shadow DOM; themes via inherited tokens
 * (--canvas, --line, --txt-2, --ghost, --ink, --ui) so it flips with
 * light/dark automatically.
 *
 * Emits a composed, bubbling `collapse` `CustomEvent` on click.
 *
 * @attr label - accessible label / title for the button (default "Collapse")
 * @attr icon - lucide icon name, kebab-case (default `panel-right-close`)
 * @slot - default slot overrides the icon entirely with custom content
 * @csspart button - the inner `<button>` element
 * @csspart icon - the lucide `<svg>` glyph
 * @fires collapse - when the button is activated
 */
export class SliccCollapseBtn extends HTMLElement {
  static readonly observedAttributes = ['label', 'icon'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Accessible label / title (reflected to the `label` attribute). */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** The lucide icon name (kebab-case); falls back to `panel-right-close`. */
  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  #render(): void {
    const label = this.label;
    const glyph = iconEl(this.icon, { size: ICON_SIZE, part: 'icon' });
    const button = h(
      'button',
      { class: 'col', part: 'button', type: 'button', 'aria-label': label, title: label },
      h('slot', null, h('span', { class: 'icon' }, glyph))
    ) as HTMLButtonElement;
    button.addEventListener('click', this.#onClick);
    this.#button = button;
    this.#root.replaceChildren(button);
  }

  readonly #onClick = (): void => {
    this.dispatchEvent(new CustomEvent('collapse', { bubbles: true, composed: true }));
  };
}

define('slicc-collapse-btn', SliccCollapseBtn);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-collapse-btn': SliccCollapseBtn;
  }
}
