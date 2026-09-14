import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export interface TabDescriptor {
  id: string;

  title?: string;

  url?: string;

  screenshot?: string;

  active?: boolean;
}

export type TabOverlayCloseReason = 'close-button' | 'escape' | 'backdrop' | 'api';

const STYLE = `
:host { display: none; }
:host([open]) { display: block; }
.overlay {
  position: fixed; inset: 0; z-index: 120;
  display: flex; flex-direction: column; box-sizing: border-box;
  padding: 20px clamp(20px, 5vw, 64px);
  background: rgba(0,0,0,.55);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; transition: opacity .16s ease;
}
:host([open]) .overlay { opacity: 1; }
.bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
  padding: 4px 2px 16px; color: #fff; font-family: var(--ui);
}
.title { font-size: 16px; font-weight: 700; }
.count {
  font-size: 12px; font-weight: 600; color: rgba(255,255,255,.7);
  background: rgba(255,255,255,.12); border-radius: 999px; padding: 2px 9px;
}
.grow { flex: 1; }
/* Peek chip: the armed state has to be VISIBLE, or the next digit does
   something other than what the last one did with no warning. */
.peek {
  display: none; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: #fff;
  background: rgba(255,255,255,.2); border-radius: 999px; padding: 3px 10px;
}
:host([data-peek]) .peek { display: inline-flex; }
/* The positional number a digit key selects — drawn on the card so the
   numbering is something you read, not something you count. */
.num {
  position: absolute; top: 8px; left: 8px; z-index: 1;
  min-width: 20px; height: 20px; padding: 0 5px;
  display: grid; place-items: center; border-radius: 6px;
  font: 600 11px/1 var(--mono, ui-monospace, monospace);
  color: #fff; background: rgba(0,0,0,.55);
}
.close {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: none; background: rgba(255,255,255,.1); color: #fff;
  border-radius: 9px; cursor: pointer; transition: background .12s ease;
}
.close:hover { background: rgba(255,255,255,.2); }
.close svg { display: block; }
.grid {
  flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px; align-content: start;
  /* Implicit rows must be max-content, NOT the initial auto. Auto tracks shrink
     to their min-content contribution once they no longer fit the grid's
     definite height, so a long tab list silently squashed every card (220px
     down to ~66px, its 16/10 thumbnail cropped to an unreadable sliver) and the
     grid never overflowed — leaving the overflow property nothing to scroll.
     Pinning rows to content height makes a long list overflow and scroll. */
  grid-auto-rows: max-content;
}
.card {
  position: relative; display: flex; flex-direction: column;
  background: var(--canvas); border: 1px solid var(--line);
  border-radius: 12px; overflow: hidden; cursor: pointer; font-family: var(--ui);
  transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
}
.card:hover {
  border-color: color-mix(in srgb, var(--ctx) 40%, var(--line));
  box-shadow: var(--shadow-pane); transform: translateY(-2px);
}
.card:focus-visible { outline: 2px solid var(--ctx); outline-offset: 2px; }
.card.on {
  border-color: color-mix(in srgb, var(--ctx) 55%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ctx) 55%, transparent);
}
.shot {
  display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover;
  background: var(--ghost); color: var(--txt-3);
  /* The card is a column flex container: without this the thumbnail is a
     shrinkable flex item and any height pressure on the card deforms it. */
  flex: 0 0 auto;
}
.shot.ph { display: grid; place-items: center; }
.shot.ph svg { display: block; }
.meta { display: flex; align-items: center; gap: 8px; padding: 9px 10px; min-width: 0; }
.label { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name {
  font-size: 13px; font-weight: 600; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.url {
  font-size: 11px; color: var(--txt-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.x {
  flex: 0 0 auto; width: 24px; height: 24px; display: grid; place-items: center;
  border: none; background: transparent; color: var(--txt-3);
  border-radius: 7px; cursor: pointer; transition: background .12s ease, color .12s ease;
}
.x:hover { background: var(--ghost); color: var(--ink); }
.x svg { display: block; }
.empty {
  flex: 1; display: grid; place-items: center; text-align: center;
  color: rgba(255,255,255,.7); font-family: var(--ui); font-size: 14px;
}
@media (prefers-reduced-motion: reduce) { .overlay, .card { transition: none; } }
`;
const SHEET = sheet(STYLE);

function numberBadge(index: number, total: number): HTMLElement | null {
  const digit = index === total - 1 ? 9 : index < 8 ? index + 1 : null;
  return digit === null ? null : h('span', { class: 'num', part: 'number' }, String(digit));
}

const PENDING_DIGIT_MS = 3000;

const DEFAULT_HEADING = 'Open tabs';

export class SliccTabOverlay extends HTMLElement {
  static readonly observedAttributes = ['open', 'heading'];

  readonly #root: ShadowRoot;
  #tabs: TabDescriptor[] = [];
  #overlay: HTMLElement | null = null;
  #lastFocus: HTMLElement | null = null;

  #peek = false;

  #pendingDigit: number | null = null;
  #pendingTimer: ReturnType<typeof setTimeout> | null = null;

  #onKey = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.#close('escape');
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const digit = /^Digit([1-9])$/.exec(e.code ?? '')?.[1] ?? /^[1-9]$/.exec(e.key)?.[0];
    if (digit) {
      e.stopPropagation();
      e.preventDefault();
      this.#selectDigit(Number(digit));
      return;
    }
    if ((e.key === 'p' || e.key === 'P') && !this.hasAttribute('no-peek')) {
      e.stopPropagation();
      e.preventDefault();
      this.peeking = !this.#peek;
    }
  };

  #selectDigit(digit: number): void {
    if (this.#tabs.length === 0) {
      this.#holdDigit(digit);
      return;
    }
    const index = digit === 9 ? this.#tabs.length - 1 : digit - 1;
    const tab = index >= 0 ? this.#tabs[index] : undefined;
    if (tab) this.#activate(tab.id);
  }

  #holdDigit(digit: number): void {
    this.#clearPendingDigit();
    this.#pendingDigit = digit;
    this.#pendingTimer = setTimeout(() => this.#clearPendingDigit(), PENDING_DIGIT_MS);
  }

  #clearPendingDigit(): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer);
    this.#pendingTimer = null;
    this.#pendingDigit = null;
  }

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    this.#sync();
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.#onKey, true);
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === 'open') this.#sync();
    else this.#render();
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', !!value);
  }

  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }
  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  get tabs(): TabDescriptor[] {
    return this.#tabs.map((t) => ({ ...t }));
  }
  set tabs(value: TabDescriptor[]) {
    this.#tabs = Array.isArray(value) ? value.map((t) => ({ ...t })) : [];
    if (this.isConnected) this.#render();

    const held = this.#pendingDigit;
    if (held !== null && this.#tabs.length > 0) {
      this.#clearPendingDigit();
      this.#selectDigit(held);
    }
  }

  show(): void {
    if (!this.open) this.open = true;
  }

  get peeking(): boolean {
    return this.#peek;
  }

  set peeking(value: boolean) {
    this.#peek = value && !this.hasAttribute('no-peek');
    this.toggleAttribute('data-peek', this.#peek);
  }

  #activate(id: string): void {
    this.#emit(this.#peek ? 'tab-peek' : 'tab-activate', id);
  }

  hide(): void {
    if (this.open) this.#close('api');
  }

  #closeButton(): HTMLButtonElement {
    const btn = h(
      'button',
      { class: 'close', part: 'close', type: 'button', 'aria-label': 'Close tabs overlay' },
      iconEl('x', { size: 18 })
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => this.#close('close-button'));
    return btn;
  }

  #cardEl(tab: TabDescriptor, index: number): HTMLElement {
    const title = tab.title ?? tab.id;
    const shot = tab.screenshot
      ? h('img', { class: 'shot', part: 'shot', src: tab.screenshot, alt: title, loading: 'lazy' })
      : h('div', { class: 'shot ph', part: 'shot' }, iconEl('globe', { size: 28 }));

    const close = h(
      'button',
      { class: 'x', part: 'card-close', type: 'button', 'aria-label': `Close ${title}` },
      iconEl('x', { size: 14 })
    ) as HTMLButtonElement;
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#emit('tab-close', tab.id);
    });

    const label = h(
      'div',
      { class: 'label' },
      h('span', { class: 'name', part: 'title' }, title),
      tab.url ? h('span', { class: 'url' }, tab.url) : null
    );

    const card = h(
      'div',
      {
        class: tab.active ? 'card on' : 'card',
        part: 'card',
        role: 'button',
        tabindex: '0',
        'data-tab-id': tab.id,
        'aria-label': title,
        'aria-current': tab.active ? 'true' : false,
      },

      numberBadge(index, this.#tabs.length),
      shot,
      h('div', { class: 'meta' }, label, close)
    );
    card.addEventListener('click', () => this.#activate(tab.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.#activate(tab.id);
      }
    });
    return card;
  }

  #render(): void {
    const bar = h(
      'div',
      { class: 'bar', part: 'bar' },
      h('span', { class: 'title' }, this.heading),
      h('span', { class: 'count' }, String(this.#tabs.length)),
      h('span', { class: 'peek' }, 'Peek · comes back'),
      h('span', { class: 'grow' }),
      this.#closeButton()
    );

    let grid: HTMLElement;
    if (this.#tabs.length === 0) {
      grid = h('div', { class: 'empty' }, 'No open tabs.');
    } else {
      grid = h('div', { class: 'grid', part: 'grid', role: 'list' });
      this.#tabs.forEach((tab, index) => {
        grid.appendChild(this.#cardEl(tab, index));
      });
    }

    this.#overlay = h('div', { class: 'overlay', part: 'overlay' }, bar, grid);

    this.#overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.#overlay) this.#close('backdrop');
    });
    this.#root.replaceChildren(this.#overlay);
  }

  #sync(): void {
    if (!this.open) {
      this.peeking = false;
      this.#clearPendingDigit();
    }
    if (this.open) {
      this.#lastFocus = (this.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement;
      document.addEventListener('keydown', this.#onKey, true);
      requestAnimationFrame(() => this.#overlay?.querySelector<HTMLElement>('.close')?.focus());
    } else {
      document.removeEventListener('keydown', this.#onKey, true);
      this.#lastFocus?.focus?.();
      this.#lastFocus = null;
    }
  }

  #emit(type: 'tab-activate' | 'tab-peek' | 'tab-close', id: string): void {
    this.dispatchEvent(
      new CustomEvent<{ id: string }>(type, { detail: { id }, bubbles: true, composed: true })
    );
  }

  #close(reason: TabOverlayCloseReason): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent<{ reason: TabOverlayCloseReason }>('overlay-close', {
        detail: { reason },
        bubbles: true,
        composed: true,
      })
    );
  }
}

define('slicc-tab-overlay', SliccTabOverlay);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tab-overlay': SliccTabOverlay;
  }
  interface HTMLElementEventMap {
    'tab-activate': CustomEvent<{ id: string }>;
    'tab-close': CustomEvent<{ id: string }>;
    'overlay-close': CustomEvent<{ reason: TabOverlayCloseReason }>;
  }
}
