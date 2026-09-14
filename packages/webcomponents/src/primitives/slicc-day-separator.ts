import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const STYLE = `
:host {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0 16px;
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-3);
  text-transform: uppercase;
  letter-spacing: .08em;
}
:host([hidden]) { display: none; }
/* The label sits centred between the hairlines and never absorbs their space. */
.label { white-space: nowrap; flex: 0 0 auto; min-width: 0; }
/*
 * The flanking 1px hairlines. Each pseudo-element MUST carry content + a
 * non-zero height + a visible background, and the host MUST be flex, or the
 * line collapses to nothing. The --line fallback keeps the hairline visible
 * even if the design token failed to inherit.
 */
:host::before,
:host::after {
  content: "";
  flex: 1 1 0;
  height: 1px;
  min-width: 0;
  background: var(--line, #e5e5e5);
}
`;
const SHEET = sheet(STYLE);

export class SliccDaySeparator extends HTMLElement {
  static readonly observedAttributes = ['label'];

  readonly #root: ShadowRoot;

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

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const label = this.label;
    const inner = label != null ? label : h('slot');
    this.#root.replaceChildren(h('span', { class: 'label', part: 'label' }, inner));
  }
}

define('slicc-day-separator', SliccDaySeparator);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-day-separator': SliccDaySeparator;
  }
}
