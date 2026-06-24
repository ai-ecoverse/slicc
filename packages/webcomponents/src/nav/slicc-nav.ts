import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-nav>`. A light-DOM host can't
 * carry a shadow-root `<style>`, so the `.nav` chrome is injected once into the
 * host document (idempotent) and selected by the host class `.slicc-nav` so it
 * can't leak.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.nav` /
 * `.nav .spacer`): the top header shell. A flex row of fixed bar height
 * (`--barh`, 44px) with `0 24px` padding and a `14px` gap, carrying — in order —
 * the logo, the scoop switcher (+ its overflow more-button sibling), a flexible
 * `.spacer`, the runtime floatbar, the theme toggle, and the user avatar.
 *
 * Frosted glass: the background is the per-context `--ctx` accent at 12% mixed
 * over a translucent `--canvas` (68%), with `backdrop-filter: blur(18px)
 * saturate(1.4)` and a 1px `--line` bottom border. `z-index: 4` keeps the bar —
 * and the switcher's overflow popup, which escapes the bar — above the chat
 * shell below it. Every control shares the `--ctl-h` (30px) height.
 *
 * Everything is var-driven (`--ctx` / `--canvas` / `--line` / `--ui` / `--barh`
 * / `--ctl-h`) so dark mode flips automatically via the inherited theme scope:
 * `--canvas` / `--line` darken and `--ctx` is recomputed per context, so the
 * frosted tint and `color-mix` background recompute with no explicit dark
 * override. There is intentionally NO `.dark` rule here.
 */
const STYLE = `
.slicc-nav {
  display: flex;
  align-items: center;
  gap: 14px;
  box-sizing: border-box;
  padding: 0 9px 0 24px;
  height: var(--barh, 44px);
  min-height: var(--barh, 44px);
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
/* Narrow / extension-sidebar: tighten the bar's padding + gap so the logo,
   the (overflowing) switcher, and the right-side controls all still fit. */
@media (max-width: 560px) {
  .slicc-nav { gap: 8px; padding: 0 10px; }
}
`;

const STYLE_ID = 'slicc-nav-style';

/** Inject the scoped nav stylesheet into a document once (idempotent). */
function ensureNavStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-nav>` — the top navigation bar from the prototype (`.nav`). A frosted,
 * context-tinted header shell that lays out the leader's chrome in a single flex
 * row: the `<slicc-logo>` wordmark, the `<slicc-scoop-switcher>` chip row (whose
 * own `<slicc-scoop-overflow>` more-button rides along as a sibling), a flexible
 * `.spacer`, then the `<slicc-floatbar>`, `<slicc-theme-toggle>`, and
 * `<slicc-avatar>` pinned to the right edge. It composes those elements BY TAG —
 * it never imports or reaches into them — so the host app slots whichever
 * controls it wants and the nav is a pure layout container.
 *
 * Light DOM (no shadow root): the host renders into itself so the host app can
 * style the bar and slot content; the scoped stylesheet is injected once into the
 * host document and scoped by the `.slicc-nav` host class. Light DOM has no native
 * `<slot>`, so any children declared before the element is upgraded are kept in
 * place (DOM order is the layout order); a flexible `.spacer` is auto-inserted
 * before the first right-aligned control (`slicc-floatbar` / `slicc-theme-toggle`
 * / `slicc-avatar`) when the author did not supply one, so the trailing controls
 * sit at the right edge even in a minimal markup.
 *
 * The `accent` attribute sets the `--ctx` context hue inline on the host, which
 * the frosted `color-mix` background reacts to — this is how the bar is
 * "context-tinted". Clearing `accent` removes the override so the bar falls back
 * to the inherited `--ctx`. Dark mode needs no rule of its own: the bar is built
 * entirely from `--canvas` / `--line` / `--ctx`, which flip with the theme scope.
 *
 * @attr accent - context hue; sets `--ctx` inline on the host (the frosted tint reacts)
 * @csspart bar - the header row (the host element itself carries `part="bar"`)
 * @csspart spacer - the flexible gap that pushes the right-aligned controls to the edge
 * @slot - default; the bar's children, laid out in DOM order (logo, switcher,
 *   `.spacer`, floatbar, theme toggle, avatar), composed by tag
 * @fires slicc-nav-accent-change - `CustomEvent<{ accent: string | null }>`,
 *   composed + bubbling, dispatched whenever the `accent` (→ `--ctx`) changes
 */
export class SliccNav extends HTMLElement {
  static readonly observedAttributes = ['accent'];

  #built = false;

  connectedCallback(): void {
    ensureNavStyle(this.ownerDocument);
    this.classList.add('slicc-nav');
    this.setAttribute('part', 'bar');
    this.#build();
    this.#applyAccent(this.getAttribute('accent'));
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

  /**
   * The context accent hue, mapped onto the `--ctx` custom property inline on the
   * host so the frosted background `color-mix` tints to it. `null` clears the
   * override (the bar falls back to the inherited `--ctx`).
   */
  get accent(): string | null {
    return this.getAttribute('accent');
  }

  set accent(value: string | null) {
    if (value == null) this.removeAttribute('accent');
    else this.setAttribute('accent', value);
  }

  /** The flexible `.spacer` that pushes the right-aligned controls to the edge. */
  get spacer(): HTMLElement {
    this.#build();
    return this.querySelector(':scope > .slicc-nav__spacer, :scope > .spacer') as HTMLElement;
  }

  /**
   * Ensure the bar has a flexible spacer separating the left cluster (logo +
   * switcher) from the right-aligned controls. Idempotent — runs once and is a
   * no-op if the author already supplied a `.spacer`. The spacer is inserted
   * immediately before the first right-aligned control (the floatbar, theme
   * toggle, or avatar); failing those it goes at the end of the row.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    // Respect an author-supplied spacer (either canonical class).
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

  /** Reflect the `accent` attribute onto the `--ctx` custom property (or clear it). */
  #applyAccent(value: string | null): void {
    if (value == null || value.trim() === '') this.style.removeProperty('--ctx');
    else this.style.setProperty('--ctx', value);
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
