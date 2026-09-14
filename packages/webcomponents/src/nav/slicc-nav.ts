import { define } from '../internal/define.js';

const STYLE = `
.slicc-nav {
  display: flex;
  align-items: center;
  container: slicc-nav / inline-size;
  gap: 14px;
  box-sizing: border-box;
  padding: 0 9px 0 24px;
  height: var(--barh, 36px);
  min-height: var(--barh, 36px);
  font-family: var(--ui);
  background: color-mix(in srgb, var(--ctx) 12%, color-mix(in srgb, var(--canvas) 68%, transparent));
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  z-index: 4;
}
.slicc-nav[hidden] { display: none; }
/* The flexible gap that pushes the floatbar / theme toggle / avatar to the
   right edge (prototype .nav .spacer{flex:1}). */
.slicc-nav > .slicc-nav__spacer,
.slicc-nav > .spacer { flex: 1; }
/* The tabs yield before the fixed controls, but never below the focused avatar
   + gap + 39px overflow trigger footprint. */
.slicc-nav > slicc-agent-tabs { flex: 1 1 auto; min-width: 73px; }
/* Narrow / extension-sidebar: key layout tightening to the nav's available
   width, not the viewport, so embedded and Storybook frames behave like the
   real sidebar. */
.slicc-nav[data-narrow] { gap: 8px; padding: 0 10px; }
`;

const STYLE_ID = 'slicc-nav-style';

function ensureNavStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export class SliccNav extends HTMLElement {
  static readonly observedAttributes = ['accent'];

  #built = false;
  #resizeObserver: ResizeObserver | null = null;

  connectedCallback(): void {
    ensureNavStyle(this.ownerDocument);
    this.classList.add('slicc-nav');
    this.setAttribute('part', 'bar');
    this.#build();
    this.#applyAccent(this.getAttribute('accent'));
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#syncNarrow());
      this.#resizeObserver.observe(this);
    }
    this.#syncNarrow();
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'accent' || oldValue === newValue) return;
    if (!this.isConnected) return;
    this.#applyAccent(newValue);
    this.dispatchEvent(
      new CustomEvent<{ accent: string | null }>('slicc-nav-accent-change', {
        detail: { accent: newValue },
        bubbles: true,
        composed: true,
      })
    );
  }

  get accent(): string | null {
    return this.getAttribute('accent');
  }

  set accent(value: string | null) {
    if (value == null) this.removeAttribute('accent');
    else this.setAttribute('accent', value);
  }

  get spacer(): HTMLElement {
    this.#build();
    return this.querySelector(':scope > .slicc-nav__spacer, :scope > .spacer') as HTMLElement;
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    if (this.querySelector(':scope > .slicc-nav__spacer, :scope > .spacer')) return;

    const spacer = this.ownerDocument.createElement('div');
    spacer.className = 'slicc-nav__spacer';
    spacer.setAttribute('part', 'spacer');
    spacer.setAttribute('aria-hidden', 'true');

    const anchor = this.querySelector(
      ':scope > slicc-floatbar, :scope > slicc-theme-toggle, :scope > slicc-avatar'
    );
    if (anchor) this.insertBefore(spacer, anchor);
    else this.appendChild(spacer);
  }

  #applyAccent(value: string | null): void {
    if (value == null || value.trim() === '') this.style.removeProperty('--ctx');
    else this.style.setProperty('--ctx', value);
  }

  #syncNarrow(): void {
    this.toggleAttribute('data-narrow', this.getBoundingClientRect().width <= 560);
  }
}

define('slicc-nav', SliccNav);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-nav': SliccNav;
  }
  interface HTMLElementEventMap {
    'slicc-nav-accent-change': CustomEvent<{ accent: string | null }>;
  }
}
