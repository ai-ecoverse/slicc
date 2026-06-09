import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';
import { iconSvg } from '../internal/icons.js';

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
.icon { display: grid; place-items: center; pointer-events: none; }
.icon svg { display: block; }
`;

/** Default lucide icon when no `icon` attribute is supplied. */
const DEFAULT_ICON = 'plus';
/** Rendered lucide glyph size (px) inside the 30×30 button. */
const ICON_SIZE = 16;

/**
 * `<slicc-icon-button>` — the prototype's `.iconbtn`: a generic 30×30 square
 * icon button (8px radius, 1px `--line` border, `--canvas` surface, `--txt-2`
 * glyph) that lights up to `--ghost`/`--ink` on hover. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --ghost, --ink,
 * --ui) which flip automatically in dark mode.
 *
 * The glyph is a **lucide** icon named by the kebab-case `icon` attribute
 * (default `plus`), rendered via the shared `iconSvg` helper — never emoji or
 * bespoke unicode symbols. The icon inherits the button's `currentColor`, so it
 * tracks the idle / hover / disabled palette automatically. Slotting a custom
 * `<svg>` into the default slot overrides the lucide glyph entirely.
 *
 * The inner `<button>` mirrors the host `disabled` attribute and carries the
 * accessible name from `label`; a native click on the button bubbles out of the
 * host as the usual composed `click` event.
 *
 * @attr icon - lucide icon name, kebab-case (default `plus`)
 * @attr disabled - when present, the button is non-interactive and dimmed
 * @attr label - accessible name applied as `aria-label` + `title`
 * @slot - custom glyph that overrides the lucide `icon` (e.g. a bespoke `<svg>`)
 * @csspart button - the inner `<button>` element
 * @csspart icon - the lucide `<svg>` glyph
 */
export class SliccIconButton extends HTMLElement {
  static readonly observedAttributes = ['icon', 'disabled', 'label'];

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

  /** The lucide icon name (kebab-case); falls back to `plus`. */
  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
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
    const glyph = iconSvg(this.icon, { size: ICON_SIZE, part: 'icon' });
    this.#root.innerHTML = `<style>${STYLE}</style><button type="button" class="iconbtn" part="button"${ariaAttr}${disabledAttr}><slot><span class="icon">${glyph}</span></slot></button>`;
  }
}

define('slicc-icon-button', SliccIconButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-icon-button': SliccIconButton;
  }
}
