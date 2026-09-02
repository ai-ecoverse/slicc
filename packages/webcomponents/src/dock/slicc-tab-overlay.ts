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

/**
 * The digit that selects a card, as a badge — or `null` where none does.
 *
 * `1`-`8` are positional and `9` is the last card whatever the count, which
 * leaves the middle of a long list unreachable by digit. Those cards get no
 * badge rather than a misleading one: the step keys and Tab still reach them.
 */
function numberBadge(index: number, total: number): HTMLElement | null {
  const digit = index === total - 1 ? 9 : index < 8 ? index + 1 : null;
  return digit === null ? null : h('span', { class: 'num', part: 'number' }, String(digit));
}

/**
 * How long a digit pressed before the tabs arrive waits for them.
 *
 * The switcher opens on the keystroke that asks for it and fills in
 * asynchronously — a target list, then a screenshot per tab — so `b 3` typed
 * at speed can land on an empty grid. Swallowing it there would make the
 * shortcut work or not depending on how fast the CDP host answered, which is
 * the one thing a positional key must never do. Bounded, because a digit that
 * fires into a list the user never saw is worse than one that did nothing.
 */
const PENDING_DIGIT_MS = 3000;

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
 *   - the digits `1`-`9` → the same, by position (`9` is always the LAST tab)
 *   - `p` → arm PEEK: the next activation emits `tab-peek` instead, for a host
 *     that shows the tab and then comes back. The header chip says it is armed
 *     and closing the overlay disarms it.
 *   - a card's corner ✕ → `tab-close` (close just that tab)
 *   - the header ✕, the Escape key, or a backdrop click → `overlay-close`
 *
 * Self-contained shadow DOM; themed via inherited tokens. The component owns only
 * the shell + the three events — the host app applies them to the real CDP tabs.
 *
 * @attr open - reflected; whether the overlay is shown (drive via `show()`/`hide()`)
 * @attr no-peek - boolean; this float cannot show a tab and come back, so `p`
 *   is inert and `peeking` cannot be armed (a follower's tabs are the
 *   leader's — activating one copies it here for good)
 * @attr heading - the header label (defaults to `Open tabs`)
 * @csspart overlay - the full-screen scrim
 * @csspart bar - the header bar
 * @csspart close - the header ✕ button
 * @csspart grid - the scrollable card grid
 * @csspart card - a tab card
 * @csspart shot - a card's screenshot / placeholder
 * @csspart title - a card's title
 * @csspart card-close - a card's corner ✕ button
 * @prop {boolean} peeking - whether the next activation is a peek (`p` toggles it)
 * @csspart peek - the header chip shown while peek is armed
 * @fires tab-peek - `CustomEvent<{ id: string }>` when a card is activated with
 *   peek armed — the host shows that tab and returns
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
  /** Is the next activation a peek rather than a switch? */
  #peek = false;
  /** A digit pressed before the list arrived, waiting for it. */
  #pendingDigit: number | null = null;
  #pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The overlay's own keyboard, live only while it is open.
   *
   * It has one because it MUST: a modal owns the keyboard, and the shell's
   * keyboard mode suspends every command while one is up — so `b 3` cannot
   * reach a tab as a shell chord, and would race the async refresh even if it
   * could. Handled here the cards are already on screen and numbered, and the
   * digit means what the user can see.
   *
   * Every key it takes is stopped, so nothing lands twice.
   */
  #onKey = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.#close('escape');
      return;
    }
    // `code` first: the physical key is the stable reading of "the 3 key"
    // across layouts (the shell's `digitFor` does the same).
    // A modified key belongs to the browser or the OS — ⌘P prints, ⌘1 switches
    // a browser tab — and a modal is not a licence to take them. The shell's
    // keyboard mode passes the same combinations through for the same reason.
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

  /**
   * Act on a digit, or hold it until there is a list to act on.
   *
   * `9` is the LAST tab, whatever the count — the tab-strip convention the
   * shell's digits already follow (see `indexForDigit` there; the rule is
   * restated rather than imported, because a component may not depend on the
   * app).
   */
  #selectDigit(digit: number): void {
    if (this.#tabs.length === 0) {
      this.#holdDigit(digit);
      return;
    }
    const index = digit === 9 ? this.#tabs.length - 1 : digit - 1;
    const tab = index >= 0 ? this.#tabs[index] : undefined;
    if (tab) this.#activate(tab.id);
  }

  /** Remember a digit the list was not ready for; see {@link PENDING_DIGIT_MS}. */
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
    // The list the user was already reaching for: a digit pressed before the
    // refresh landed acts now, on the tabs it was asking about.
    const held = this.#pendingDigit;
    if (held !== null && this.#tabs.length > 0) {
      this.#clearPendingDigit();
      this.#selectDigit(held);
    }
  }

  /** Open the overlay (no-op if already open). */
  show(): void {
    if (!this.open) this.open = true;
  }

  /**
   * Whether the next activation PEEKS — shows the tab and comes back — rather
   * than switching to it for good. Reflected as `data-peek` so the chip in the
   * header shows it: an armed modifier nobody can see is a trap.
   *
   * Armed by the `p` key, and cleared whenever the overlay closes, so it can
   * never survive into a later visit.
   */
  get peeking(): boolean {
    return this.#peek;
  }

  set peeking(value: boolean) {
    // A float that cannot come back must not offer to: a follower's tabs
    // belong to the leader, and activating one copies it here for good.
    this.#peek = value && !this.hasAttribute('no-peek');
    this.toggleAttribute('data-peek', this.#peek);
  }

  /** Activate a tab the way the armed mode says: peek it, or switch to it. */
  #activate(id: string): void {
    this.#emit(this.#peek ? 'tab-peek' : 'tab-activate', id);
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
      // The key that selects this card, drawn on it: `9` is the last one, so
      // past the eighth the number is only worth showing for the end of the
      // list. Nothing is drawn for the unreachable middle.
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

  /** Rebuild the overlay shell + the current card grid (or the empty state). */
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
    // A press that both starts AND ends on the scrim (not a card) closes.
    this.#overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.#overlay) this.#close('backdrop');
    });
    this.#root.replaceChildren(this.#overlay);
  }

  /** Manage open-state focus + the document key listener. */
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

  /** Emit a composed, bubbling tab event carrying the tab id. */
  #emit(type: 'tab-activate' | 'tab-peek' | 'tab-close', id: string): void {
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
