import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-chat-thread>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.thread`
 * / `.inner`): a scrollable `.thread` wrapper holding a centered, max-width
 * reading column (`.inner`) that carries the per-context frosted shader. The
 * column is tinted with `--ctx` over a translucent `--shaderbg`, blurred, and
 * feathered on both axes so the fade lives entirely in the padding gutter and
 * never eats into the readable text. The `open` host attribute mirrors the
 * prototype's `.shell.open .inner`: the column shrinks and the feather tightens
 * (24px / 32px) to match the narrower chat pane.
 *
 * Everything is var-driven (`--ctx` / `--shaderbg` / `--line` / `--ui`) so dark
 * mode flips automatically via the inherited theme scope — `--shaderbg` darkens
 * in `body.dark` and `--ctx` is recomputed per context, so the frosted tint
 * recomputes with no explicit dark override.
 */
const STYLE = `
slicc-chat-thread {
  flex: 1 1 auto;
  display: block;
  overflow-y: auto;
  min-height: 0;
  /* Always reserve the scrollbar gutter so the reading column's width — and
     therefore its aspect ratio — stays fixed when a context swap changes the
     content length (a long, overflowing context shows a scrollbar; a short one
     does not, which would otherwise shift the centered column on every swap). */
  scrollbar-gutter: stable;
}
slicc-chat-thread[hidden] {
  display: none;
}
slicc-chat-thread > .slicc-thread__inner {
  box-sizing: border-box;
  max-width: 776px;
  margin: 0 auto;
  padding: 56px 72px;
  font-family: var(--ui);
  /* Primary text color for the reading column. Without this the message prose
     inherits the UA default (black), which is invisible on the dark frosted
     surface in dark mode. --ink flips light/dark with the theme. */
  color: var(--ink);
  background: color-mix(in srgb, var(--ctx) 14%, color-mix(in srgb, var(--shaderbg) 80%, transparent));
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border-radius: 14px;
  -webkit-mask-image:
    linear-gradient(to right, transparent 0, #000 72px, #000 calc(100% - 72px), transparent 100%),
    linear-gradient(to bottom, transparent 0, #000 56px, #000 calc(100% - 56px), transparent 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(to right, transparent 0, #000 72px, #000 calc(100% - 72px), transparent 100%),
    linear-gradient(to bottom, transparent 0, #000 56px, #000 calc(100% - 56px), transparent 100%);
  mask-composite: intersect;
}
slicc-chat-thread[open] > .slicc-thread__inner {
  padding: 24px 32px;
  -webkit-mask-image:
    linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%),
    linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
  mask-image:
    linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%),
    linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
}
/* Narrow / extension-sidebar: the reading column fills the full width — no
   centered 776px cap and no horizontal edge feather, so the frosted surface
   reaches both edges instead of leaving bare shader showing on the sides. */
@media (max-width: 560px) {
  slicc-chat-thread > .slicc-thread__inner,
  slicc-chat-thread[open] > .slicc-thread__inner {
    max-width: none;
    margin: 0;
    padding: 16px 14px;
    border-radius: 0;
    -webkit-mask-image: none;
    mask-image: none;
  }
}
`;

const STYLE_ID = 'slicc-chat-thread-style';

/** Inject the scoped thread stylesheet into a document once (idempotent). */
function ensureThreadStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-chat-thread>` — the prototype's scrollable chat column (`.thread` +
 * `.inner`). A scroll wrapper hosting a centered, 776px-max reading column that
 * carries the per-context frosted shader (a `--ctx`-tinted, blurred surface with
 * a two-axis edge feather) and composes message / day-label / card children in
 * DOM order.
 *
 * Light DOM (no shadow root): the host renders its own `.slicc-thread__inner`
 * column and relocates any light children into it, so the host app can style the
 * thread and slot arbitrary message elements (e.g. `<slicc-day-separator>` and
 * message/card siblings, composed by tag). Children are scrolled into view after
 * each append.
 *
 * The per-context shader is driven by the inherited `--ctx` token. `switchContext`
 * snapshots the current column's markup, swaps in another context's saved markup
 * (or clears for a fresh context), updates the `context` reflection and the local
 * `--ctx` accent, and scrolls to the bottom — mirroring the prototype's
 * `switchContext()`. Clicks inside the column are re-emitted as a single
 * delegated `slicc-thread-action` event so hosts need not bind every child.
 *
 * @attr open - boolean; narrow-chat variant (tighter padding + feather), mirrors `.shell.open .inner`
 * @attr context - the active context id (e.g. `cone`, `researcher`, `freezer:abc`); reflected
 * @attr accent - optional CSS color forced onto the local `--ctx` shader tint (wins over the inherited token)
 * @csspart inner - the centered, frosted reading column
 * @slot - default; message / day-label / card children, rendered in DOM order
 * @fires slicc-context-change - composed + bubbling; `detail.context` / `detail.previous` on `switchContext`
 * @fires slicc-thread-action - composed + bubbling; delegated child click, `detail.target` is the clicked element
 */
export class SliccChatThread extends HTMLElement {
  static readonly observedAttributes = ['open', 'context', 'accent'];

  #inner!: HTMLElement;
  #built = false;
  #onClick: ((e: MouseEvent) => void) | null = null;

  /**
   * Per-context snapshots of the inner column content, keyed by context id.
   * Each snapshot is a detached fragment of cloned child nodes (no HTML string);
   * restoring re-clones it so the swapped-in nodes are fresh and inert — the
   * same "rebuilt from a snapshot, listeners not carried" semantics the old
   * HTML-string round-trip had, minus the markup-string surface.
   */
  readonly #snapshots = new Map<string, DocumentFragment>();

  connectedCallback(): void {
    ensureThreadStyle(this.ownerDocument);
    this.#build();
    this.#applyAccent();
    this.scrollToBottom();
  }

  disconnectedCallback(): void {
    if (this.#onClick) {
      this.#inner?.removeEventListener('click', this.#onClick);
      this.#onClick = null;
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'accent' && this.#built) this.#applyAccent();
  }

  /** Whether the narrow-chat variant (tighter padding + feather) is active. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  /** The active context id (reflected). */
  get context(): string | null {
    return this.getAttribute('context');
  }

  set context(value: string | null) {
    if (value == null) this.removeAttribute('context');
    else this.setAttribute('context', value);
  }

  /** Optional forced shader accent color (sets the local `--ctx`). */
  get accent(): string | null {
    return this.getAttribute('accent');
  }

  set accent(value: string | null) {
    if (value == null) this.removeAttribute('accent');
    else this.setAttribute('accent', value);
  }

  /** The centered, frosted reading column (`part="inner"`). */
  get inner(): HTMLElement {
    this.#build();
    return this.#inner;
  }

  /**
   * Snapshot the current column, then swap to another context's saved markup
   * (restoring it verbatim) or, when unseen, clear the column for fresh content.
   * Reflects `context`, retints the shader, emits `slicc-context-change`, and
   * scrolls to the bottom. Mirrors the prototype's `switchContext()`.
   */
  switchContext(id: string): void {
    this.#build();
    const previous = this.context;
    if (id === previous) return;
    if (previous != null) this.#snapshots.set(previous, this.#snapshot());

    const saved = this.#snapshots.get(id);
    this.#inner.replaceChildren(...(saved ? Array.from(saved.cloneNode(true).childNodes) : []));

    this.context = id;
    this.dispatchEvent(
      new CustomEvent('slicc-context-change', {
        bubbles: true,
        composed: true,
        detail: { context: id, previous },
      })
    );
    this.scrollToBottom();
  }

  /** Append a child node into the reading column and scroll it into view. */
  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.append(...nodes);
    this.scrollToBottom();
  }

  /** Scroll the thread wrapper to the bottom (latest message). */
  scrollToBottom(): void {
    this.scrollTop = this.scrollHeight;
  }

  /**
   * Capture the current inner column as a detached fragment of cloned child
   * nodes — the HTML-string-free snapshot used by {@link switchContext}. Cloning
   * (rather than moving) keeps the live column intact for the duration of the
   * swap and yields a fresh, inert tree to restore later.
   */
  #snapshot(): DocumentFragment {
    const frag = this.ownerDocument.createDocumentFragment();
    for (const node of Array.from(this.#inner.childNodes)) frag.appendChild(node.cloneNode(true));
    return frag;
  }

  /** Mirror the inherited (or forced) accent onto the local `--ctx` token. */
  #applyAccent(): void {
    const accent = this.accent;
    if (accent) this.style.setProperty('--ctx', accent);
    else this.style.removeProperty('--ctx');
  }

  /**
   * Build the inner column once and relocate any pre-existing light children
   * into it. Idempotent — safe across re-connects. Installs the delegated click
   * listener so child clicks surface as a single `slicc-thread-action`.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-thread__inner');
    if (existing instanceof HTMLElement) {
      this.#inner = existing;
    } else {
      // Collect children that existed before we owned the subtree.
      const incoming = Array.from(this.childNodes);

      this.#inner = this.ownerDocument.createElement('div');
      this.#inner.className = 'slicc-thread__inner';
      this.#inner.setAttribute('part', 'inner');

      for (const node of incoming) this.#inner.appendChild(node);
      this.appendChild(this.#inner);
    }

    this.#onClick = (ev: MouseEvent) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      this.dispatchEvent(
        new CustomEvent('slicc-thread-action', {
          bubbles: true,
          composed: true,
          detail: { target },
        })
      );
    };
    this.#inner.addEventListener('click', this.#onClick);
  }
}

define('slicc-chat-thread', SliccChatThread);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-chat-thread': SliccChatThread;
  }
}
