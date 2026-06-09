import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-composer>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.composer`
 * / `.composer-inner`): the footer band of the chat column. A frosted-glass band
 * tinted by the per-context `--ctx` accent over a translucent `--bg`, with a top
 * `--line` border and `position: relative; z-index: 2` so the add-menu results
 * panel that pops up out of the band overlays the chat thread (which sits at the
 * default stacking level) instead of growing the footer height. The inner column
 * is a constant `680px`-max centered band, so — like the thread above it — it
 * slides left with the chat pane as the workbench opens rather than re-centering.
 *
 * The `open` host attribute mirrors the prototype's `.shell.open`: in the
 * narrow-chat layout the meta row's keyboard `.hint` is hidden, keeping just the
 * model + thinking controls (the prototype's `.shell.open .meta .hint`).
 *
 * Everything is var-driven (`--ctx` / `--bg` / `--line` / `--ui`) so dark mode
 * flips automatically via the inherited theme scope — `--bg` darkens and `--ctx`
 * is recomputed per context, so the frosted tint and `color-mix` background
 * recompute with no explicit dark override. `backdrop-filter` blurs + saturates
 * whatever (chat thread / shader / sprinkles) sits behind the glass.
 */
const STYLE = `
slicc-composer {
  flex: 0 0 auto;
  display: block;
  box-sizing: border-box;
  font-family: var(--ui);
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--ctx) 12%, color-mix(in srgb, var(--bg) 68%, transparent));
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  padding: 14px 16px 14px;
  position: relative;
  z-index: 2;
}
slicc-composer[hidden] {
  display: none;
}
slicc-composer > .slicc-composer__inner {
  box-sizing: border-box;
  max-width: 680px;
  margin: 0 auto;
}
/* narrow-chat (.shell.open): keep just model + thinking — drop the keyboard hint. */
slicc-composer[open] .slicc-composer__hint,
slicc-composer[open] [data-composer-hint] {
  display: none;
}
`;

const STYLE_ID = 'slicc-composer-style';

/** Inject the scoped composer stylesheet into a document once (idempotent). */
function ensureComposerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-composer>` — the chat footer band from the prototype (`.composer` +
 * `.composer-inner`). A frosted-glass footer container that slots the input card
 * + meta row of the composer and centers them in a constant `680px`-max column,
 * so the band slides left with the chat pane (like the thread above it) instead
 * of re-centering as the workbench opens.
 *
 * Light DOM (no shadow root): the host renders its own `.slicc-composer__inner`
 * column and relocates any light children into it, so the host app can style the
 * footer and slot arbitrary content — e.g. an `.inputcard` (with the
 * `<slicc-add-menu>` toolbar + `<slicc-send-button>`) and a `.meta` row,
 * composed by tag. The component is a pure container: no events of its own; its
 * job is the frosted band + `z-index: 2` layering that lets the add-menu results
 * panel pop up out of the footer and overlay the thread.
 *
 * The `open` host attribute mirrors the prototype's `.shell.open`: in the
 * narrow-chat layout the meta row's keyboard hint is hidden (anything carrying
 * the `data-composer-hint` attribute or the `.slicc-composer__hint` class),
 * keeping just the model + thinking controls.
 *
 * @attr open - boolean; narrow-chat variant (hides the meta keyboard hint), mirrors `.shell.open`
 * @csspart inner - the centered, `680px`-max `.composer-inner` band
 * @slot - default; the input card + meta row, rendered in DOM order
 */
export class SliccComposer extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #inner!: HTMLElement;
  #built = false;

  connectedCallback(): void {
    ensureComposerStyle(this.ownerDocument);
    this.#build();
  }

  attributeChangedCallback(): void {
    // `open` is reflected to the host attribute and driven entirely by CSS
    // (`slicc-composer[open] …`), so nothing to re-render here — but keep the
    // callback so the attribute participates in the observed lifecycle.
  }

  /**
   * Whether the narrow-chat variant is active (hides the meta keyboard hint).
   * Mirrors the prototype's `.shell.open`.
   */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  /** The centered, `680px`-max `.composer-inner` band (`part="inner"`). */
  get inner(): HTMLElement {
    this.#build();
    return this.#inner;
  }

  /** Append a child node into the inner band, preserving DOM order. */
  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.append(...nodes);
  }

  /**
   * Build the inner band once and relocate any pre-existing light children into
   * it. Idempotent — safe across re-connects (light DOM survives a move, so the
   * already-built `.slicc-composer__inner` is reused rather than rebuilt).
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-composer__inner');
    if (existing instanceof HTMLElement) {
      this.#inner = existing;
      return;
    }

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes);

    this.#inner = this.ownerDocument.createElement('div');
    this.#inner.className = 'slicc-composer__inner';
    this.#inner.setAttribute('part', 'inner');

    for (const node of incoming) this.#inner.appendChild(node);
    this.appendChild(this.#inner);
  }
}

define('slicc-composer', SliccComposer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer': SliccComposer;
  }
}
