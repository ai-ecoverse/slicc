import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-workbench-pane>`. Light-DOM
 * layout hosts cannot carry an inline `<style>` in a shadow root, so the chrome
 * is injected once into the host document (idempotent) and selected by the host
 * tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html`
 * `.pane.workbench` + `.shell.open .workbench`): the one floating rounded
 * container of the shell. The rounded-card chrome itself — `var(--canvas)`
 * surface, `1px var(--line)` border, `14px` radius, `var(--shadow-pane)`,
 * clipped overflow, flex-column body — comes from the composed
 * `<slicc-pane elevated>` (the prototype's `.pane` base + its heavier two-layer
 * `.workbench` shadow). This host owns only the prototype's `.workbench`
 * collapse/expand layer:
 *
 *   - collapsed (default): `width: 0; margin: 0; opacity: 0; overflow: hidden`,
 *   - expanded (`open`):   `width: calc(66% - 72px); margin: 12px; opacity: 1`,
 *
 * animated over `.38s cubic-bezier(.4,0,.2,1)` (width/margin) + `.28s ease`
 * (opacity). `flex: 0 0 auto` and `min-height: 0` let it sit beside the chat
 * pane in the shell and let its body scroll. The `66% - 72px` width reserves the
 * 48px dock plus the 12px margins, exactly as the prototype's
 * `.shell.open .workbench` does.
 *
 * Everything is var-driven (`--canvas` / `--line` / `--shadow-pane` via the
 * composed `<slicc-pane>`), so dark mode flips automatically through the
 * inherited theme scope — `--shadow-pane` is redefined under `.dark` /
 * `[data-theme="dark"]`, and the elevated two-layer shadow has its own dark
 * override inside `<slicc-pane>`.
 */
const STYLE = `
slicc-workbench-pane {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  box-sizing: border-box;
  min-height: 0;
  width: 0;
  margin: 0;
  opacity: 0;
  overflow: hidden;
  font-family: var(--ui);
  transition:
    width 0.38s cubic-bezier(0.4, 0, 0.2, 1),
    margin 0.38s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.28s ease;
}
slicc-workbench-pane[open] {
  width: calc(66% - 72px);
  margin: 12px;
  opacity: 1;
}
slicc-workbench-pane[hidden] {
  display: none;
}
/* The composed pane chrome fills the collapsing host and carries the scroll. */
slicc-workbench-pane > slicc-pane {
  flex: 1 1 auto;
  min-height: 0;
}
`;

const STYLE_ID = 'slicc-workbench-pane-style';

/** Inject the scoped workbench-pane stylesheet into a document once (idempotent). */
function ensureWorkbenchPaneStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-workbench-pane>` — the prototype's one floating rounded container
 * (`.pane.workbench`): the right-hand workbench that collapses to nothing and
 * expands beside the chat column. A pure layout container that composes the
 * elevated pane chrome plus a workbench header + body **by tag**:
 *
 * ```html
 * <slicc-workbench-pane open>
 *   <slicc-workbench-header slot="header">…tabs / collapse…</slicc-workbench-header>
 *   <slicc-workbench-body>…the active surface…</slicc-workbench-body>
 * </slicc-workbench-pane>
 * ```
 *
 * Light DOM (no shadow root): on connect the host builds a single
 * `<slicc-pane elevated>` wrapper and relocates its light children into it.
 * `<slicc-workbench-header>` (or anything carrying `slot="header"`) is pinned in
 * the pane header region; `<slicc-workbench-body>` and everything else lands in
 * the scrollable pane body. The rounded-card chrome, two-layer lifted shadow,
 * and overflow clipping all come from `<slicc-pane>`; this host adds only the
 * `.workbench` collapse/expand animation, gated by the `open` attribute.
 *
 * `open` is the prototype's `.shell.open` gate hoisted onto the component:
 * absent → collapsed (`width: 0; opacity: 0`), present → expanded
 * (`width: calc(66% - 72px); margin: 12px; opacity: 1`). Toggling it fires a
 * composed, bubbling `slicc-workbench-pane-toggle` event carrying `detail.open`,
 * so a parent shell can mirror the state without reaching into internals.
 *
 * @attr open - boolean; expands the pane (mirrors the prototype's `.shell.open .workbench`)
 * @csspart pane - the composed `<slicc-pane>` chrome wrapper
 * @slot header - chrome pinned above the scroll region (typically `<slicc-workbench-header>`)
 * @slot - default scrollable content (typically `<slicc-workbench-body>`)
 * @fires slicc-workbench-pane-toggle - composed + bubbling; `detail.open` on expand/collapse
 */
export class SliccWorkbenchPane extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #pane!: HTMLElement;
  #built = false;

  connectedCallback(): void {
    ensureWorkbenchPaneStyle(this.ownerDocument);
    this.#build();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'open' && oldValue !== newValue && this.isConnected) {
      this.dispatchEvent(
        new CustomEvent('slicc-workbench-pane-toggle', {
          bubbles: true,
          composed: true,
          detail: { open: newValue !== null },
        })
      );
    }
  }

  /**
   * Whether the workbench is expanded. Mirrors the prototype's `.shell.open`:
   * absent → collapsed (width 0, opacity 0), present → expanded.
   */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  /** The composed `<slicc-pane>` chrome wrapper (`part="pane"`). */
  get pane(): HTMLElement {
    this.#build();
    return this.#pane;
  }

  /**
   * Build the composed pane wrapper once and relocate any pre-existing light
   * children into it: `slot="header"` nodes are forwarded to the pane header,
   * everything else to the pane body. Idempotent — safe across re-connects
   * (light DOM survives a move, so the already-built `<slicc-pane>` is reused).
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > slicc-pane');
    if (existing instanceof HTMLElement) {
      this.#pane = existing;
      return;
    }

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes);

    // Compose the elevated pane chrome BY TAG (registered by an earlier wave).
    this.#pane = this.ownerDocument.createElement('slicc-pane');
    this.#pane.setAttribute('elevated', '');
    this.#pane.setAttribute('part', 'pane');

    for (const node of incoming) this.#pane.appendChild(node);
    this.appendChild(this.#pane);
  }
}

define('slicc-workbench-pane', SliccWorkbenchPane);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-workbench-pane': SliccWorkbenchPane;
  }
}
