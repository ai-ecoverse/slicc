import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

const STYLE = `
:host { display: inline-grid; }
:host([hidden]) { display: none; }
.iconbtn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  margin: 0;
  -webkit-appearance: none;
  appearance: none;
}
.iconbtn:hover { background: var(--ghost); color: var(--ink); }
.iconbtn:disabled {
  cursor: default;
  opacity: 0.45;
}
.iconbtn:disabled:hover { background: var(--canvas); color: var(--txt-2); }
`;

/**
 * `<slicc-icon-button>` — the prototype's `.iconbtn`: a generic 30×30 square
 * icon button (8px radius, 1px `--line` border, `--canvas` surface, `--txt-2`
 * glyph) that lights up to `--ghost`/`--ink` on hover. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --ghost, --ink,
 * --ui) which flip automatically in dark mode.
 *
 * Place the glyph (emoji, character, or inline SVG) in the default slot. The
 * inner `<button>` mirrors the host `disabled` attribute and carries the
 * accessible name from `label`; a native click on the button bubbles out of the
 * host as the usual composed `click` event.
 *
 * @attr disabled - when present, the button is non-interactive and dimmed
 * @attr label - accessible name applied as `aria-label` + `title`
 * @slot - the icon glyph rendered inside the button
 * @csspart button - the inner `<button>` element
 */
export class SliccIconButton extends HTMLElement {
  static readonly observedAttributes = ['disabled', 'label'];

  readonly #root: ShadowRoot;

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

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const label = this.label;
    const ariaAttr = label ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : '';
    const disabledAttr = this.disabled ? ' disabled' : '';
    this.#root.innerHTML = `<style>${STYLE}</style><button type="button" class="iconbtn" part="button"${ariaAttr}${disabledAttr}><slot></slot></button>`;
  }
}

define('slicc-icon-button', SliccIconButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-icon-button': SliccIconButton;
  }
}
