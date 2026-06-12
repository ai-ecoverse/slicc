import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-pane>`. Light-DOM components
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host class.
 *
 * Faithful to the prototype `.pane` (proto/StellarRubySwift.html): the floating
 * rounded card that is the base of `.workbench` and that every other card echoes.
 * The `elevated` variant lifts to the prototype's two-layer `.workbench` shadow.
 * Everything is var-driven (--canvas / --line / --shadow-pane) so dark mode flips
 * automatically via the inherited theme scope.
 */
const STYLE = `
slicc-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
slicc-pane > .slicc-pane__surface {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-pane);
  overflow: hidden;
}
slicc-pane[elevated] > .slicc-pane__surface {
  box-shadow:
    rgba(10, 10, 10, 0.1) 0 14px 36px -12px,
    rgba(10, 10, 10, 0.05) 0 4px 10px -4px;
}
.dark slicc-pane[elevated] > .slicc-pane__surface,
[data-theme="dark"] slicc-pane[elevated] > .slicc-pane__surface {
  box-shadow:
    rgba(0, 0, 0, 0.45) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.3) 0 4px 10px -4px;
}
slicc-pane .slicc-pane__header {
  flex: 0 0 auto;
}
slicc-pane .slicc-pane__header:empty {
  display: none;
}
slicc-pane .slicc-pane__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
`;

const STYLE_ID = 'slicc-pane-style';

/** Inject the scoped pane stylesheet into a document once (idempotent). */
function ensurePaneStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-pane>` — the prototype's reusable rounded-card chrome (`.pane`): a
 * `var(--canvas)` surface with a 1px `var(--line)` border, 14px radius,
 * `var(--shadow-pane)` shadow, clipped overflow, and a flex-column body that
 * hosts scrollable content at any height. It is the base of `.workbench` and the
 * surface other cards echo.
 *
 * Light DOM (no shadow root): the host renders its own `surface` wrapper and
 * relocates light children into named regions so the host app can style it and
 * compose other cards inside it. Children with `slot="header"` land in the
 * header region; everything else (including `slot="body"`) lands in the
 * scrollable body.
 *
 * @attr elevated - boolean; switches to the heavier two-layer `.workbench` shadow
 * @csspart surface - the rounded-card chrome wrapper
 * @csspart header - the non-scrolling header region (hidden when empty)
 * @csspart body - the scrollable body region
 * @slot header - chrome that pins above the scroll region
 * @slot body - default scrollable content (also the unnamed/default slot)
 * @fires slicc-pane-change - composed + bubbling; `detail.elevated` on variant change
 */
export class SliccPane extends HTMLElement {
  static readonly observedAttributes = ['elevated'];

  #header!: HTMLElement;
  #body!: HTMLElement;
  #built = false;

  connectedCallback(): void {
    ensurePaneStyle(this.ownerDocument);
    this.#build();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'elevated' && oldValue !== newValue && this.isConnected) {
      this.dispatchEvent(
        new CustomEvent('slicc-pane-change', {
          bubbles: true,
          composed: true,
          detail: { elevated: newValue !== null },
        })
      );
    }
  }

  /** Whether the heavier two-layer shadow variant is active. */
  get elevated(): boolean {
    return this.hasAttribute('elevated');
  }

  set elevated(value: boolean) {
    if (value) this.setAttribute('elevated', '');
    else this.removeAttribute('elevated');
  }

  /**
   * Build the surface scaffold once and relocate any pre-existing light children
   * into the header/body regions. Idempotent — safe across re-connects.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes).filter(
      (n) => !(n instanceof HTMLElement && n.classList.contains('slicc-pane__surface'))
    );

    const surface = this.ownerDocument.createElement('div');
    surface.className = 'slicc-pane__surface';
    surface.setAttribute('part', 'surface');

    this.#header = this.ownerDocument.createElement('div');
    this.#header.className = 'slicc-pane__header';
    this.#header.setAttribute('part', 'header');

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'slicc-pane__body';
    this.#body.setAttribute('part', 'body');

    surface.append(this.#header, this.#body);

    for (const node of incoming) {
      if (node instanceof HTMLElement && node.getAttribute('slot') === 'header') {
        this.#header.appendChild(node);
      } else {
        this.#body.appendChild(node);
      }
    }

    this.appendChild(surface);
  }
}

define('slicc-pane', SliccPane);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-pane': SliccPane;
  }
}
