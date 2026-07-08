import { define } from '../internal/define.js';
import { readUrlState, writeUrlState } from '../internal/url-state.js';

/**
 * Scoped, document-level stylesheet for `<slicc-chat-thread>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted from the prototype (`proto/StellarRubySwift.html` `.thread` /
 * `.inner`): a scrollable `.thread` wrapper holding a centered, max-width
 * reading column (`.inner`). The prototype's frosted reading card (tinted,
 * blurred, edge-feathered background) was deliberately dropped — the column
 * sits directly on the shader field, and text contrast comes from the shader
 * rendering low-contrast instead. The `open` host attribute mirrors the
 * prototype's `.shell.open .inner`: the column padding tightens (24px / 32px)
 * to match the narrower chat pane.
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
/* New-content chip: shown when content arrives while the viewer is scrolled
   away (requestFollow). Sticky at the scrollport bottom, zero layout height.
   --accent re-declared per the custom-property gotcha (tracks local --ctx). */
slicc-chat-thread {
  --accent: color-mix(in srgb, var(--ctx) 55%, var(--ink));
}
slicc-chat-thread > .slicc-thread__follow {
  position: sticky;
  bottom: 18px;
  height: 0;
  display: none;
  justify-content: center;
  overflow: visible;
  pointer-events: none;
  z-index: 3;
}
slicc-chat-thread[has-new] > .slicc-thread__follow {
  display: flex;
}
slicc-chat-thread > .slicc-thread__follow button {
  pointer-events: auto;
  transform: translateY(-100%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 12px var(--ui);
  color: var(--canvas);
  background: var(--accent);
  border: none;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  box-shadow: var(--shadow-pane);
}
slicc-chat-thread > .slicc-thread__inner {
  box-sizing: border-box;
  max-width: 776px;
  margin: 0 auto;
  padding: 56px 72px;
  font-family: var(--ui);
  /* Primary text color for the reading column. Without this the message prose
     inherits the UA default (black). --ink flips light/dark with the theme. */
  color: var(--ink);
  /* NO background / blur / feather here: the reading column sits directly on
     the shader field. Text contrast comes from the shader itself rendering
     low-contrast (its strokes stay close to the base color) — the old frosted
     card muted the shader everywhere instead. */
}
slicc-chat-thread[open] > .slicc-thread__inner {
  padding: 24px 32px;
}
/* Narrow / extension-sidebar: the reading column fills the full width — no
   centered 776px cap. */
@media (max-width: 560px) {
  slicc-chat-thread > .slicc-thread__inner,
  slicc-chat-thread[open] > .slicc-thread__inner {
    max-width: none;
    margin: 0;
    padding: 16px 14px;
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
 * `.inner`). A scroll wrapper hosting a centered, 776px-max reading column
 * (background-free — it sits directly on the shader field) that composes
 * message / day-label / card children in DOM order.
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
 * @attr url-state - boolean; the thread persists its own URL params — `ctx`
 *   (context, pushed as a history entry) and `at` (scroll position, replaced,
 *   debounced). On `popstate` it re-applies `at` itself and asks the host to
 *   route `ctx` via `slicc-url-context` (selection is app state).
 * @fires slicc-url-context - composed + bubbling; `detail.context` when a
 *   popstate carries a different context than the current one
 * @fires slicc-context-change - composed + bubbling; `detail.context` / `detail.previous` on `switchContext`
 * @fires slicc-thread-action - composed + bubbling; delegated child click, `detail.target` is the clicked element
 */
export class SliccChatThread extends HTMLElement {
  static readonly observedAttributes = ['open', 'context', 'accent', 'url-state'];

  #inner!: HTMLElement;
  #built = false;
  #onClick: ((e: MouseEvent) => void) | null = null;
  /**
   * URL `at` value captured at connect. Boot replays load content more than
   * once (optimistic hydration, then the canonical replay), so the restore
   * re-applies on every {@link replaceContent} until it goes stale: a context
   * switch away from the boot context, or live content arriving via append.
   */
  #pendingScrollRestore: string | null = null;
  /** URL `ctx` value captured at connect — the context the restore belongs to. */
  #bootCtx: string | null = null;
  #scrollWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #onScrollPersist = (): void => {
    if (!this.urlState) return;
    if (this.#scrollWriteTimer != null) clearTimeout(this.#scrollWriteTimer);
    this.#scrollWriteTimer = setTimeout(() => {
      this.#scrollWriteTimer = null;
      writeUrlState('at', String(Math.round(this.scrollTop)));
    }, 300);
  };
  #onPopState = (): void => {
    if (!this.urlState) return;
    const ctx = readUrlState('ctx');
    if (ctx && ctx !== this.context) {
      // Selection is app state — the host routes it (scoop lookup, thaw).
      this.dispatchEvent(
        new CustomEvent('slicc-url-context', {
          bubbles: true,
          composed: true,
          detail: { context: ctx },
        })
      );
    } else {
      const at = readUrlState('at');
      if (at != null) this.scrollTop = Number.parseInt(at, 10) || 0;
    }
  };

  /** Sticky "new messages" chip wrapper (built once, after the column). */
  #follow: HTMLElement | null = null;

  /**
   * Re-anchor state for the rail (`open`) toggle. Opening / closing the
   * workbench rail animates the chat pane's width over ~380ms (see the shell's
   * transition), which reflows the reading column and moves its bottom. A
   * viewer pinned to the bottom before the toggle is kept pinned across the
   * whole animation; a viewer scrolled up keeps their position untouched.
   */
  #reanchorObserver: ResizeObserver | null = null;
  #reanchorTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.urlState) {
      this.#pendingScrollRestore = readUrlState('at');
      this.#bootCtx = readUrlState('ctx');
      this.addEventListener('scroll', this.#onScrollPersist, { passive: true });
      window.addEventListener('popstate', this.#onPopState);
    }
  }

  disconnectedCallback(): void {
    if (this.#onClick) {
      this.#inner?.removeEventListener('click', this.#onClick);
      this.#onClick = null;
    }
    this.removeEventListener('scroll', this.#onScrollPersist);
    window.removeEventListener('popstate', this.#onPopState);
    if (this.#scrollWriteTimer != null) {
      clearTimeout(this.#scrollWriteTimer);
      this.#scrollWriteTimer = null;
    }
    this.#stopReanchor();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'accent' && this.#built) this.#applyAccent();
    // Toggling the rail (`open`) tightens/loosens the column padding instantly
    // AND animates the parent pane's width — both reflow the column and move its
    // bottom. Keep a bottom-pinned viewer pinned across the transition. Guarded
    // to connected + built so pre-mount setup sets don't trip the observer.
    if (name === 'open' && this.#built && this.isConnected) this.#reanchorOnRailToggle();
    // The thread owns the `ctx` URL param: context switches are user-level
    // navigations, so they PUSH (back button walks contexts). The helper
    // skips no-op writes, so applying a URL-restored context never re-pushes.
    // Pre-connect sets are mount setup, not navigation — a default context
    // must not clobber a deep-linked URL before boot routing reads it.
    if (name === 'context' && this.urlState && newValue != null && this.isConnected) {
      // Switching away from the boot context makes the restored scroll
      // position stale — the boot route TO that context keeps it pending.
      if (newValue !== this.#bootCtx) this.#pendingScrollRestore = null;
      writeUrlState('ctx', newValue, { push: true });
    }
  }

  /** Whether this thread persists `ctx`/`at` in the page URL. */
  get urlState(): boolean {
    return this.hasAttribute('url-state');
  }

  set urlState(value: boolean) {
    this.toggleAttribute('url-state', value);
  }

  /**
   * The URL-restored context (the `ctx` param), when url-state is enabled.
   * Hosts route it at boot (scoop lookup / freezer thaw) — the param itself
   * stays component-managed.
   */
  get urlContext(): string | null {
    return this.urlState ? readUrlState('ctx') : null;
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
    this.removeAttribute('has-new');
    this.dispatchEvent(
      new CustomEvent('slicc-context-change', {
        bubbles: true,
        composed: true,
        detail: { context: id, previous },
      })
    );
    this.scrollToBottom();
  }

  /**
   * Append a child node into the reading column. Follows to the bottom only
   * when the viewer is already there; otherwise the new-content chip shows
   * (scrolling someone away from what they're reading is worse than a chip).
   */
  append(...nodes: (Node | string)[]): void {
    this.#build();
    // Live content arriving makes a URL-restored scroll position stale.
    if (nodes.length > 0) this.#pendingScrollRestore = null;
    this.#inner.append(...nodes);
    this.requestFollow();
  }

  /** Pixels from the bottom within which the view still counts as following. */
  static readonly FOLLOW_SLACK = 80;

  #nearBottom(): boolean {
    return this.scrollHeight - this.scrollTop - this.clientHeight <= SliccChatThread.FOLLOW_SLACK;
  }

  /**
   * Follow new content politely: scroll to the bottom when the viewer is
   * already (near) there, otherwise surface the sticky "new messages" chip —
   * clicking it (or scrolling down manually) jumps/clears.
   */
  requestFollow(): void {
    this.#build();
    if (this.#nearBottom()) {
      this.scrollToBottom();
      this.removeAttribute('has-new');
    } else {
      this.setAttribute('has-new', '');
    }
  }

  /** Hide the chip once the viewer is back at the bottom. */
  #onFollowScroll = (): void => {
    if (this.hasAttribute('has-new') && this.#nearBottom()) this.removeAttribute('has-new');
  };

  /**
   * Replace the reading column's content wholesale (e.g. a history reload
   * when switching scoops). Unlike the inherited `replaceChildren` — which
   * would destroy the component's inner column wrapper — this swaps only the
   * column's children and keeps the thread chrome intact.
   */
  replaceContent(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.replaceChildren(...nodes);
    this.removeAttribute('has-new');
    this.scrollToBottom();
    // Content (re)loads while the boot context is live: a URL-restored scroll
    // position WINS over the scroll-to-bottom default (re-applied on a frame
    // so late layout doesn't clobber it). Boot loads twice — optimistic
    // hydration, then the canonical replay — so the restore stays pending
    // until a context switch or live appended content marks it stale.
    const restore = this.#pendingScrollRestore;
    if (restore != null && nodes.length > 0) {
      requestAnimationFrame(() => {
        if (this.#pendingScrollRestore !== restore) return;
        this.scrollTop = Number.parseInt(restore, 10) || 0;
      });
    }
  }

  /** Scroll the thread wrapper to the bottom (latest message). */
  scrollToBottom(): void {
    this.scrollTop = this.scrollHeight;
  }

  /**
   * Keep a bottom-pinned viewer pinned while the rail toggle reflows the
   * reading column. Snapshots "was the viewer near the bottom?" from the
   * pre-reflow layout; only then re-pins — instantly for the synchronous
   * padding change, then on every reflow frame (a `ResizeObserver` on the
   * column) while the parent pane's width animates, torn down once the ~380ms
   * transition settles. A viewer who had scrolled up installs no observer, so
   * their position is left alone.
   */
  #reanchorOnRailToggle(): void {
    const wasNearBottom = this.#nearBottom();
    this.#stopReanchor();
    if (!wasNearBottom) return;
    this.scrollToBottom();
    if (typeof ResizeObserver !== 'function') return;
    this.#reanchorObserver = new ResizeObserver(() => this.scrollToBottom());
    this.#reanchorObserver.observe(this.#inner);
    this.#reanchorTimer = setTimeout(() => this.#stopReanchor(), 450);
  }

  /** Stop any in-flight rail-toggle re-anchor (observer + timer). */
  #stopReanchor(): void {
    if (this.#reanchorObserver) {
      this.#reanchorObserver.disconnect();
      this.#reanchorObserver = null;
    }
    if (this.#reanchorTimer != null) {
      clearTimeout(this.#reanchorTimer);
      this.#reanchorTimer = null;
    }
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

    this.#follow = this.ownerDocument.createElement('div');
    this.#follow.className = 'slicc-thread__follow';
    const followBtn = this.ownerDocument.createElement('button');
    followBtn.type = 'button';
    followBtn.append('New messages ↓');
    followBtn.addEventListener('click', () => {
      this.scrollToBottom();
      this.removeAttribute('has-new');
    });
    this.#follow.append(followBtn);
    this.appendChild(this.#follow);
    this.addEventListener('scroll', this.#onFollowScroll, { passive: true });

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
