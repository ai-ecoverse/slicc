import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

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
.label { white-space: nowrap; }
:host::before,
:host::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}
`;

/**
 * `<slicc-day-separator>` — the thread "day label" divider from the prototype
 * (`.daylabel`): a centered uppercase caption flanked by 1px hairlines that fill
 * each side. Used to mark the start of a day ("Today"), a scoop's isolated
 * thread ("researcher scoop"), or a thawed frozen session ("… · frozen").
 *
 * Self-contained shadow DOM; themes via inherited tokens (--txt-3, --line, --ui)
 * which flip automatically in dark mode. The label comes from the `label`
 * attribute, or — when absent — from slotted light-DOM content.
 *
 * @attr label - the caption text (e.g. "Today", "researcher scoop")
 * @slot - default slot for richer label content, used when `label` is unset
 * @csspart label - the centered caption node
 */
export class SliccDaySeparator extends HTMLElement {
  static readonly observedAttributes = ['label'];

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

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const label = this.label;
    const inner = label != null ? escapeHtml(label) : '<slot></slot>';
    this.#root.innerHTML = `<style>${STYLE}</style><span class="label" part="label">${inner}</span>`;
  }
}

define('slicc-day-separator', SliccDaySeparator);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-day-separator': SliccDaySeparator;
  }
}
