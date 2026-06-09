import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

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
`;

const DEFAULT_GLYPH = '⤡'; // ⤡ north-west / south-east arrow (collapse)
const DEFAULT_LABEL = 'Collapse';

/**
 * `<slicc-collapse-btn>` — the icon button at the right of the workbench header
 * (`.wbhead .col`) in the prototype. A 28px-tall canvas-backed button with a
 * `⤡` collapse glyph that hovers to `--ghost` / `--ink`. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --ghost, --ink,
 * --ui) so it flips with light/dark automatically.
 *
 * Emits a composed, bubbling `collapse` `CustomEvent` on click.
 *
 * @attr label - accessible label / title for the button (default "Collapse")
 * @attr glyph - override the button glyph (default ⤡)
 * @slot - default slot overrides the glyph entirely with custom content
 * @csspart button - the inner `<button>` element
 * @fires collapse - when the button is activated
 */
export class SliccCollapseBtn extends HTMLElement {
  static readonly observedAttributes = ['label', 'glyph'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
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

  /** The button glyph (reflected to the `glyph` attribute). */
  get glyph(): string {
    return this.getAttribute('glyph') ?? DEFAULT_GLYPH;
  }

  set glyph(value: string | null) {
    if (value == null) this.removeAttribute('glyph');
    else this.setAttribute('glyph', value);
  }

  #render(): void {
    const label = this.label;
    this.#root.innerHTML = `<style>${STYLE}</style><button class="col" part="button" type="button" aria-label="${escapeHtml(
      label
    )}" title="${escapeHtml(label)}"><slot>${escapeHtml(this.glyph)}</slot></button>`;
    this.#button = this.#root.querySelector('button');
    this.#button?.addEventListener('click', this.#onClick);
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
