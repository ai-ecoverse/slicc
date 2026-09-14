import { define } from '../internal/define.js';
import { iconEl } from '../internal/icons.js';
import { readUrlState, writeUrlState } from '../internal/url-state.js';

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
   Frosted glass pill with entrance animation. */
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
@keyframes slicc-follow-in {
  from { opacity: 0; translate: 0 6px; }
  to   { opacity: 1; translate: 0 0; }
}
slicc-chat-thread > .slicc-thread__follow button {
  pointer-events: auto;
  transform: translateY(-100%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 500 12px/1 var(--ui);
  color: var(--ink);
  background: color-mix(in srgb, var(--canvas) 72%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 999px;
  padding: 16px 16px 16px 18px;
  cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: background .15s, box-shadow .15s, border-color .15s;
  animation: slicc-follow-in .2s ease-out;
}
slicc-chat-thread > .slicc-thread__follow button:hover {
  background: color-mix(in srgb, var(--canvas) 88%, transparent);
  box-shadow: 0 3px 12px color-mix(in srgb, var(--ink) 12%, transparent);
  border-color: color-mix(in srgb, var(--ink) 16%, transparent);
}
slicc-chat-thread > .slicc-thread__follow button:active {
  scale: .97;
}
slicc-chat-thread > .slicc-thread__follow button svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
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
const SCROLL_PERSIST_INTERVAL_MS = 120;

function ensureThreadStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export class SliccChatThread extends HTMLElement {
  static readonly observedAttributes = ['open', 'context', 'accent', 'url-state'];

  #inner!: HTMLElement;
  #built = false;
  #onClick: ((e: MouseEvent) => void) | null = null;

  #pendingScrollRestore: string | null = null;

  #bootCtx: string | null = null;

  #following = false;

  #writingScroll = false;
  #scrollWriteTarget = 0;
  #scrollWriteFrame: number | null = null;
  #scrollGuardTimer: ReturnType<typeof setTimeout> | null = null;

  #growthObserver: ResizeObserver | null = null;
  #scrollWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #lastScrollWriteAt: number | null = null;
  #persistScrollPosition = (): void => {
    this.#scrollWriteTimer = null;
    this.#lastScrollWriteAt = performance.now();
    writeUrlState('at', String(Math.round(this.scrollTop)));
  };
  #onScrollPersist = (): void => {
    if (!this.urlState) return;
    const elapsed =
      this.#lastScrollWriteAt == null
        ? SCROLL_PERSIST_INTERVAL_MS
        : performance.now() - this.#lastScrollWriteAt;
    if (elapsed >= SCROLL_PERSIST_INTERVAL_MS) {
      if (this.#scrollWriteTimer != null) clearTimeout(this.#scrollWriteTimer);
      this.#persistScrollPosition();
      return;
    }
    if (this.#scrollWriteTimer == null) {
      this.#scrollWriteTimer = setTimeout(
        this.#persistScrollPosition,
        SCROLL_PERSIST_INTERVAL_MS - elapsed
      );
    }
  };
  #onPopState = (): void => {
    if (!this.urlState) return;
    const ctx = readUrlState('ctx');
    if (ctx && ctx !== this.context) {
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

  #follow: HTMLElement | null = null;

  readonly #snapshots = new Map<string, DocumentFragment>();

  connectedCallback(): void {
    ensureThreadStyle(this.ownerDocument);
    this.#build();
    this.#applyAccent();
    this.#startGrowthObserver();
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
    this.#lastScrollWriteAt = null;
    this.#growthObserver?.disconnect();
    this.#growthObserver = null;
    this.#clearScrollWriteGuard();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'accent' && this.#built) this.#applyAccent();
    if (name === 'open' && this.#built && this.isConnected) this.#followColumnResize();

    if (name === 'context' && this.urlState && newValue != null && this.isConnected) {
      if (newValue !== this.#bootCtx) this.#pendingScrollRestore = null;
      writeUrlState('ctx', newValue, { push: true });
    }
  }

  get urlState(): boolean {
    return this.hasAttribute('url-state');
  }

  set urlState(value: boolean) {
    this.toggleAttribute('url-state', value);
  }

  get urlContext(): string | null {
    return this.urlState ? readUrlState('ctx') : null;
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  get context(): string | null {
    return this.getAttribute('context');
  }

  set context(value: string | null) {
    if (value == null) this.removeAttribute('context');
    else this.setAttribute('context', value);
  }

  get accent(): string | null {
    return this.getAttribute('accent');
  }

  set accent(value: string | null) {
    if (value == null) this.removeAttribute('accent');
    else this.setAttribute('accent', value);
  }

  get inner(): HTMLElement {
    this.#build();
    return this.#inner;
  }

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

  append(...nodes: (Node | string)[]): void {
    this.#build();

    if (nodes.length > 0) this.#pendingScrollRestore = null;
    this.#inner.append(...nodes);
    this.requestFollow();
  }

  static readonly FOLLOW_SLACK = 80;

  #nearBottom(): boolean {
    return this.scrollHeight - this.scrollTop - this.clientHeight <= SliccChatThread.FOLLOW_SLACK;
  }

  requestFollow(): void {
    this.#build();
    if (this.#following) {
      this.#writeScrollTop(this.scrollHeight);
      this.removeAttribute('has-new');
    } else {
      this.setAttribute('has-new', '');
    }
  }

  #onFollowScroll = (): void => {
    if (this.#writingScroll && Math.abs(this.scrollTop - this.#scrollWriteTarget) <= 1) {
      this.#clearScrollWriteGuard();
      return;
    }
    this.#clearScrollWriteGuard();
    this.#following = this.#nearBottom();
    if (this.#following) this.removeAttribute('has-new');
  };

  replaceContent(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.replaceChildren(...nodes);
    this.removeAttribute('has-new');
    this.scrollToBottom();

    const restore = this.#pendingScrollRestore;
    if (restore != null && nodes.length > 0) {
      requestAnimationFrame(() => {
        if (this.#pendingScrollRestore !== restore) return;
        this.#following = false;
        this.#writeScrollTop(Number.parseInt(restore, 10) || 0);
        this.#following = this.#nearBottom();
      });
    }
  }

  scrollToBottom(): void {
    this.#following = true;
    this.removeAttribute('has-new');
    this.#writeScrollTop(this.scrollHeight);
  }

  #startGrowthObserver(): void {
    this.#growthObserver?.disconnect();
    if (typeof ResizeObserver !== 'function') return;
    this.#growthObserver = new ResizeObserver(() => this.#followColumnResize());
    this.#growthObserver.observe(this.#inner);
  }

  #followColumnResize(): void {
    if (!this.#following) return;
    const pendingUpwardScroll = this.#scrollWriteTarget - this.scrollTop;
    if (this.#writingScroll && pendingUpwardScroll > SliccChatThread.FOLLOW_SLACK) return;
    this.#writeScrollTop(this.scrollHeight);
  }

  #writeScrollTop(value: number): void {
    this.#writingScroll = true;
    this.scrollTop = value;
    this.#scrollWriteTarget = this.scrollTop;
    if (this.#scrollWriteFrame != null) cancelAnimationFrame(this.#scrollWriteFrame);
    if (this.#scrollGuardTimer != null) clearTimeout(this.#scrollGuardTimer);
    const supportsScrollEnd = 'onscrollend' in HTMLElement.prototype;
    if (supportsScrollEnd) {
      this.#scrollGuardTimer = setTimeout(() => this.#clearScrollWriteGuard(), 100);
    } else {
      this.#scrollWriteFrame = requestAnimationFrame(() => this.#clearScrollWriteGuard());
    }
  }

  #clearScrollWriteGuard(): void {
    this.#writingScroll = false;
    if (this.#scrollWriteFrame != null) cancelAnimationFrame(this.#scrollWriteFrame);
    this.#scrollWriteFrame = null;
    if (this.#scrollGuardTimer != null) clearTimeout(this.#scrollGuardTimer);
    this.#scrollGuardTimer = null;
  }

  #snapshot(): DocumentFragment {
    const frag = this.ownerDocument.createDocumentFragment();
    for (const node of Array.from(this.#inner.childNodes)) frag.appendChild(node.cloneNode(true));
    return frag;
  }

  #applyAccent(): void {
    const accent = this.accent;
    if (accent) this.style.setProperty('--ctx', accent);
    else this.style.removeProperty('--ctx');
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-thread__inner');
    if (existing instanceof HTMLElement) {
      this.#inner = existing;
    } else {
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
    const chevron = iconEl('chevron-down', { size: 14, strokeWidth: 2 });
    followBtn.append('New messages', chevron);
    followBtn.addEventListener('click', () => {
      this.scrollToBottom();
    });
    this.#follow.append(followBtn);
    this.appendChild(this.#follow);
    this.addEventListener('scroll', this.#onFollowScroll, { passive: true });
    this.addEventListener('scrollend', () => this.#clearScrollWriteGuard(), { passive: true });

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
