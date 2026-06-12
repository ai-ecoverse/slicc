import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const STYLE = `
:host { display: inline-flex; align-items: center; height: var(--ctl-h, 30px); font-family: var(--ui); line-height: 1; }
.logo { font-weight: 600; font-size: 14px; letter-spacing: -0.02em; color: var(--ink); }
.b {
  font-weight: 500; font-size: 12px; margin-left: 7px;
  background: var(--rainbow); -webkit-background-clip: text; background-clip: text; color: transparent;
}
/* Narrow / extension-sidebar: drop the gradient suffix badge to save width. */
@media (max-width: 560px) { .b { display: none; } }
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-logo>` — the "sliccy" wordmark from the prototype nav (`.logo`), with
 * an optional rainbow-gradient suffix badge (`.b`). Self-contained shadow DOM;
 * themes via inherited tokens (--ink, --rainbow, --ui).
 *
 * @attr badge - optional gradient suffix text (e.g. "beta")
 * @csspart logo - the wordmark span
 * @csspart badge - the gradient suffix span
 */
export class SliccLogo extends HTMLElement {
  static readonly observedAttributes = ['badge'];

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

  get badge(): string | null {
    return this.getAttribute('badge');
  }

  set badge(value: string | null) {
    if (value == null) this.removeAttribute('badge');
    else this.setAttribute('badge', value);
  }

  #render(): void {
    const logo = h('span', { class: 'logo', part: 'logo' }, 'sliccy');
    if (this.badge) logo.append(h('span', { class: 'b', part: 'badge' }, this.badge));
    this.#root.replaceChildren(logo);
  }
}

define('slicc-logo', SliccLogo);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-logo': SliccLogo;
  }
}
