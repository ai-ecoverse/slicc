import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

const STYLE = `
:host { display: inline-flex; align-items: center; height: var(--ctl-h, 30px); font-family: var(--ui); line-height: 1; }
.logo { font-weight: 600; font-size: 14px; letter-spacing: -0.02em; color: var(--ink); }
.b {
  font-weight: 500; font-size: 12px; margin-left: 7px;
  background: var(--rainbow); -webkit-background-clip: text; background-clip: text; color: transparent;
}
`;

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
    const badge = this.badge;
    const badgeHtml = badge ? `<span class="b" part="badge">${escapeHtml(badge)}</span>` : '';
    this.#root.innerHTML = `<style>${STYLE}</style><span class="logo" part="logo">sliccy${badgeHtml}</span>`;
  }
}

define('slicc-logo', SliccLogo);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-logo': SliccLogo;
  }
}
