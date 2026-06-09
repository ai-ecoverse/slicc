import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-workbench-header>`. Light-DOM
 * hosts cannot carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.wbhead`
 * / `.wbhead .spacer`): the workbench header strip above the workbench body. A
 * flex row (gap 6px, padding 8px 12px) with a bottom `--line` border that flips
 * with the inherited theme, and `overflow: hidden` so the inner tab bar scrolls
 * rather than widening the strip. `flex: 0 0 auto` mirrors the prototype so the
 * header keeps its intrinsic height inside the column.
 *
 * The `.spacer` is the prototype's `flex: 1` pusher: it absorbs free space so
 * the kind badge (`<slicc-pane-tag>`) and collapse button (`<slicc-collapse-btn>`)
 * stay pinned to the right while the tab bar takes the left. Both the badge and
 * the button are `flex: 0 0 auto` so they never shrink. The tab bar (composed by
 * tag — `slicc-tab-bar`) carries its own `min-width: 0` + `overflow-x: auto`, so
 * it scrolls inside the hidden-overflow strip.
 *
 * Everything is var-driven (`--line`), so dark mode flips the border
 * automatically via the inherited theme scope — the composed children carry
 * their own dark rules.
 */
const STYLE = `
slicc-workbench-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  overflow: hidden;
  box-sizing: border-box;
  font-family: var(--ui);
}
slicc-workbench-header[hidden] {
  display: none;
}
slicc-workbench-header > .slicc-wbhead__spacer {
  flex: 1;
}
/* Composed right-rail items never shrink — they push left as the spacer grows. */
slicc-workbench-header > slicc-pane-tag,
slicc-workbench-header > slicc-collapse-btn {
  flex: 0 0 auto;
}
/* The slotted tab bar may shrink and scroll inside the hidden-overflow strip. */
slicc-workbench-header > slicc-tab-bar {
  min-width: 0;
}
`;

const STYLE_ID = 'slicc-workbench-header-style';

/** Inject the scoped workbench-header stylesheet into a document once (idempotent). */
function ensureHeaderStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-workbench-header>` — the workbench header strip from the prototype
 * (`.wbhead`). A flex row that holds, left-to-right: a tab bar (composed by tag,
 * `<slicc-tab-bar>`), a `.spacer` that absorbs free space, the violet "kind"
 * badge (`<slicc-pane-tag>`), and the collapse button (`<slicc-collapse-btn>`).
 * The strip has a bottom `--line` border (flips with the theme) and clips its
 * overflow so the tab bar scrolls instead of widening the header.
 *
 * Light DOM (no shadow root): the host renders its own `.spacer` pusher and
 * relocates any pre-existing light children around it, so the host app can style
 * the header and slot arbitrary content — a tab bar, a `<slicc-pane-tag>` badge,
 * and a `<slicc-collapse-btn>`, composed by tag. The component is a composition
 * container: its `kind` attribute drives the composed `<slicc-pane-tag>`, and it
 * re-emits the composed `<slicc-collapse-btn>`'s `collapse` event as its own
 * `collapse` `CustomEvent`.
 *
 * @attr kind - `"tool"` | `"sprinkle"`; forwarded to the composed `<slicc-pane-tag>` (other/absent hides the badge)
 * @csspart spacer - the `flex: 1` pusher between the tab bar and the right rail
 * @slot - default; tab bar / badge / collapse button, rendered in DOM order around the spacer
 * @fires collapse - re-emitted (composed + bubbling) when the composed collapse button fires
 */
export class SliccWorkbenchHeader extends HTMLElement {
  static readonly observedAttributes = ['kind'];

  #spacer!: HTMLElement;
  #built = false;

  connectedCallback(): void {
    ensureHeaderStyle(this.ownerDocument);
    this.#build();
    this.#syncKind();
    this.addEventListener('collapse', this.#onChildCollapse);
  }

  disconnectedCallback(): void {
    this.removeEventListener('collapse', this.#onChildCollapse);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'kind' && this.isConnected) this.#syncKind();
  }

  /**
   * The pane kind (`"tool"` | `"sprinkle"`), forwarded to the composed
   * `<slicc-pane-tag>` badge. `null` when unset/unrecognized (badge hidden).
   */
  get kind(): 'tool' | 'sprinkle' | null {
    const value = this.getAttribute('kind');
    return value === 'tool' || value === 'sprinkle' ? value : null;
  }

  set kind(value: 'tool' | 'sprinkle' | string | null) {
    if (value == null) this.removeAttribute('kind');
    else this.setAttribute('kind', value);
  }

  /** The `flex: 1` pusher between the tab bar and the right rail (`part="spacer"`). */
  get spacer(): HTMLElement {
    this.#build();
    return this.#spacer;
  }

  /**
   * Build the spacer once and order the light children: pre-existing children
   * before the spacer (the tab bar), then the spacer, then the right-rail items
   * (`<slicc-pane-tag>` / `<slicc-collapse-btn>`) pulled to the end. Idempotent —
   * safe across re-connects (light DOM survives a move, so the already-built
   * spacer is reused rather than rebuilt).
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-wbhead__spacer');
    if (existing instanceof HTMLElement) {
      this.#spacer = existing;
      return;
    }

    this.#spacer = this.ownerDocument.createElement('div');
    this.#spacer.className = 'slicc-wbhead__spacer';
    this.#spacer.setAttribute('part', 'spacer');

    // Right-rail items: keep the kind badge then the collapse button pinned to
    // the end, after the spacer. Everything else (the tab bar) stays on the left.
    const tag = this.querySelector(':scope > slicc-pane-tag');
    const collapse = this.querySelector(':scope > slicc-collapse-btn');

    this.appendChild(this.#spacer);
    if (tag) this.appendChild(tag);
    if (collapse) this.appendChild(collapse);
  }

  /** Push the host `kind` down to the composed `<slicc-pane-tag>` badge, if present. */
  #syncKind(): void {
    const tag = this.querySelector(':scope > slicc-pane-tag');
    if (!tag) return;
    const kind = this.kind;
    if (kind == null) tag.removeAttribute('kind');
    else tag.setAttribute('kind', kind);
  }

  /**
   * Re-emit a composed child `collapse` (from `<slicc-collapse-btn>`) as the
   * header's own `collapse` event. The original already bubbles to the host; we
   * stop it there and fire a fresh event so consumers can listen on the header
   * without seeing two events.
   */
  readonly #onChildCollapse = (e: Event): void => {
    if (e.target === this) return; // our own re-emitted event — ignore
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('collapse', { bubbles: true, composed: true }));
  };
}

define('slicc-workbench-header', SliccWorkbenchHeader);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-workbench-header': SliccWorkbenchHeader;
  }
}
