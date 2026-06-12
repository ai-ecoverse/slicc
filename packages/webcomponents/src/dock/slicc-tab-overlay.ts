import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * One open browser tab rendered as a card in the overlay. Lifted to fit the
 * dock's `Browser · CDP` launcher: clicking the dock globe opens this full-screen
 * grid of the live CDP tabs, each with its screenshot + title.
 */
export interface TabDescriptor {
  /** Stable tab id — echoed in `tab-activate` / `tab-close` event details. */
  id: string;
  /** Tab title shown under the screenshot (falls back to the id). */
  title?: string;
  /** Optional URL / subtitle shown muted under the title. */
  url?: string;
  /** Screenshot image source (data URL or URL); a globe placeholder shows when absent. */
  screenshot?: string;
  /** Whether this tab is the currently foregrounded one (gets the `--ctx` ring). */
  active?: boolean;
}

/** Why the overlay closed — forwarded on `overlay-close`. */
export type TabOverlayCloseReason = 'close-button' | 'escape' | 'backdrop' | 'api';

/**
 * Self-contained shadow-DOM stylesheet for the tab overlay. The full-screen
 * `.overlay` is a blurred dark scrim (like `slicc-dialog`) holding a header bar
 * (`#fff` on the scrim) and a scrollable responsive `.grid` of `.card`s. Card
 * chrome (canvas surface, line border, ctx hover/active ring) uses inherited
 * tokens so it flips with the theme; the scrim + header read on the dark wash in
 * both themes, matching the prototype's overlay treatment.
 */
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
}
.card {
  display: flex; flex-direction: column;
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

/** Default header label when no `heading` attribute is set. */
const DEFAULT_HEADING = 'Open tabs';

/**
 * `<slicc-tab-overlay>` — the full-screen open-tabs switcher launched by the
 * dock's `Browser · CDP` globe. A blurred dark scrim covers the viewport with a
 * header (heading + live tab count + ✕) and a scrollable responsive grid of tab
 * cards, each showing the tab's screenshot (or a globe placeholder) and title.
 *
 * Interaction mirrors the reviewer's brief:
 *   - click (or Enter/Space on) a card → `tab-activate` (bring that tab to front)
 *   - a card's corner ✕ → `tab-close` (close just that tab)
 *   - the header ✕, the Escape key, or a backdrop click → `overlay-close`
 *
 * Self-contained shadow DOM; themed via inherited tokens. The component owns only
 * the shell + the three events — the host app applies them to the real CDP tabs.
 *
 * @attr open - reflected; whether the overlay is shown (drive via `show()`/`hide()`)
 * @attr heading - the header label (defaults to `Open tabs`)
 * @csspart overlay - the full-screen scrim
 * @csspart bar - the header bar
 * @csspart close - the header ✕ button
 * @csspart grid - the scrollable card grid
 * @csspart card - a tab card
 * @csspart shot - a card's screenshot / placeholder
 * @csspart title - a card's title
 * @csspart card-close - a card's corner ✕ button
 * @fires tab-activate - `CustomEvent<{ id: string }>` when a card is activated
 * @fires tab-close - `CustomEvent<{ id: string }>` when a card's ✕ is clicked
 * @fires overlay-close - `CustomEvent<{ reason: TabOverlayCloseReason }>` on dismiss
 */
export class SliccTabOverlay extends HTMLElement {
  static readonly observedAttributes = ['open', 'heading'];

  readonly #root: ShadowRoot;
  #tabs: TabDescriptor[] = [];
  #overlay: HTMLElement | null = null;
  #lastFocus: HTMLElement | null = null;

  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.stopPropagation();
      this.#close('escape');
    }
  };

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

  /** Whether the overlay is shown. */
  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', !!value);
  }

  /** The header label (defaults to `Open tabs`). */
  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }
  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  /** The open tabs shown as cards. Returns a defensive copy. */
  get tabs(): TabDescriptor[] {
    return this.#tabs.map((t) => ({ ...t }));
  }
  set tabs(value: TabDescriptor[]) {
    this.#tabs = Array.isArray(value) ? value.map((t) => ({ ...t })) : [];
    if (this.isConnected) this.#render();
  }

  /** Open the overlay (no-op if already open). */
  show(): void {
    if (!this.open) this.open = true;
  }

  /** Close the overlay via the API (emits `overlay-close` with reason `api`). */
  hide(): void {
    if (this.open) this.#close('api');
  }

  /** Build the header ✕ button (closes the whole overlay). */
  #closeButton(): HTMLButtonElement {
    const btn = h(
      'button',
      { class: 'close', part: 'close', type: 'button', 'aria-label': 'Close tabs overlay' },
      iconEl('x', { size: 18 })
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => this.#close('close-button'));
    return btn;
  }

  /** Build one tab card (composed via `h()` — attribute values are DOM-escaped). */
  #cardEl(tab: TabDescriptor): HTMLElement {
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
      shot,
      h('div', { class: 'meta' }, label, close)
    );
    card.addEventListener('click', () => this.#emit('tab-activate', tab.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.#emit('tab-activate', tab.id);
      }
    });
    return card;
  }

  /** Rebuild the overlay shell + the current card grid (or the empty state). */
  #render(): void {
    const bar = h(
      'div',
      { class: 'bar', part: 'bar' },
      h('span', { class: 'title' }, this.heading),
      h('span', { class: 'count' }, String(this.#tabs.length)),
      h('span', { class: 'grow' }),
      this.#closeButton()
    );

    let grid: HTMLElement;
    if (this.#tabs.length === 0) {
      grid = h('div', { class: 'empty' }, 'No open tabs.');
    } else {
      grid = h('div', { class: 'grid', part: 'grid', role: 'list' });
      for (const tab of this.#tabs) grid.appendChild(this.#cardEl(tab));
    }

    this.#overlay = h('div', { class: 'overlay', part: 'overlay' }, bar, grid);
    // A press that both starts AND ends on the scrim (not a card) closes.
    this.#overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.#overlay) this.#close('backdrop');
    });
    this.#root.replaceChildren(this.#overlay);
  }

  /** Manage open-state focus + the document Escape listener. */
  #sync(): void {
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

  /** Emit a composed, bubbling tab event carrying the tab id. */
  #emit(type: 'tab-activate' | 'tab-close', id: string): void {
    this.dispatchEvent(
      new CustomEvent<{ id: string }>(type, { detail: { id }, bubbles: true, composed: true })
    );
  }

  /** Close the overlay and emit `overlay-close` with the dismissal reason. */
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
