import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
// The popup renders <slicc-pill> clones, so it owns the registration.
import '../pill/slicc-pill.js';

// ---------------------------------------------------------------------------
// Lifted from proto/StellarRubySwift.html: the switcher overflow popup
// (.switcher-more / .morebtn / .pop / .has-overflow / .open, CSS ~L68-76, the
// reflow IIFE ~L937-1007). The prototype's reflow logic measures the live
// header and moves chips that don't fit into a "⋯" dropdown that stacks them
// column-wise; this lift keeps the *popup* half of that contract — the trigger
// button + the dropdown of full-width <slicc-pill> clones — and exposes the set
// of overflowed scoops as a declarative `items` property. Geometry measurement
// stays the host's job (the header switcher owns layout); the host feeds the
// hidden chips in via `items` and listens for `slicc-scoop-select`.
//
// Surfaces map onto the inherited library tokens exactly as the prototype did:
// the trigger uses --txt-2 / --line / --ghost / --ink / --ctl-h, and the popup
// uses --canvas / --line / --shadow-pane. Dark therefore flips automatically via
// the library's .dark / [data-theme="dark"] / body.dark scopes. Cloned pills
// carry their own theme tokens (each <slicc-pill> manages its own palette).
// ---------------------------------------------------------------------------

const STYLE = `
:host{display:inline-block;}
.switcher-more{position:relative;}
.morebtn{display:none;font:inherit;font-size:13px;font-weight:600;color:var(--txt-2);background:transparent;border:1px solid var(--line);border-radius:9999px;height:var(--ctl-h,30px);padding:0 11px;cursor:pointer;line-height:1;align-items:center;}
.morebtn:hover{background:var(--ghost);color:var(--ink);}
:host([count]:not([count="0"])) .morebtn,.switcher-more.has-overflow .morebtn{display:inline-flex;}
.pop{display:none;position:absolute;top:calc(100% + 6px);left:0;min-width:180px;background:var(--canvas);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-pane);padding:6px;z-index:20;flex-direction:column;gap:4px;}
.switcher-more.open .pop{display:flex;}
.pop slicc-pill{display:block;width:100%;--pill-w:100%;}
`;
const SHEET = sheet(STYLE);

/**
 * A descriptor for one overflowed scoop chip rendered as a `<slicc-pill>` clone
 * inside the popup. Mirrors the attributes the prototype copies off the hidden
 * header chip (`type` / `color` / `eyes` / `label`) plus the stable `id`
 * (`data-k`) used to identify the scoop in the emitted event.
 */
export interface SliccScoopOverflowItem {
  /** Stable scoop identity (the prototype's `data-k`); forwarded in the event. */
  id: string;
  /** Pill label text. Falls back to `id` when omitted. */
  label?: string;
  /** Glyph type forwarded to the pill (`cone` | `scoop`, default `scoop`). */
  type?: 'cone' | 'scoop';
  /** Accent color hex forwarded to the pill. */
  color?: string;
  /** Eye state forwarded to the pill (`open` | `none` | `dead`, default `none`). */
  eyes?: 'open' | 'none' | 'dead';
}

/** The `detail` payload of the `slicc-scoop-select` event. */
export interface SliccScoopSelectDetail {
  /** The selected scoop's stable id (the descriptor's `id`). */
  id: string;
  /** The selected scoop's label (or `id` when no label was supplied). */
  label: string;
}

/**
 * `<slicc-scoop-overflow>` — the prototype's switcher overflow popup
 * (`.switcher-more`). A pill-shaped "⋯" trigger (`.morebtn`) that stays hidden
 * until there is overflow, plus an absolutely-positioned dropdown (`.pop`) that
 * stacks the overflowed scoop chips column-wise as full-width `<slicc-pill>`
 * clones. Clicking the trigger toggles the popup (and `aria-expanded`); a click
 * anywhere outside closes it; clicking a chip emits `slicc-scoop-select` and
 * closes.
 *
 * Self-contained shadow DOM. The trigger and popup map onto inherited library
 * tokens (`--txt-2`, `--line`, `--ghost`, `--ink`, `--ctl-h`, `--canvas`,
 * `--shadow-pane`) so dark flips automatically via `.dark` /
 * `[data-theme="dark"]` / `body.dark`. The cloned `<slicc-pill>` chips manage
 * their own theme.
 *
 * Overflow detection (which chips don't fit) stays the host's responsibility —
 * the header switcher owns layout. The host feeds the overflowed chips in via
 * the `items` property; the `count` attribute and the `.has-overflow` class are
 * reflected from `items.length`, which is what reveals the trigger.
 *
 * @attr open - boolean; reflects whether the popup is shown
 * @attr count - reflected number of overflow items (the trigger shows when > 0)
 * @csspart more - the "⋯" trigger button
 * @csspart pop - the dropdown popup panel
 * @csspart pill - each cloned overflow `<slicc-pill>` chip
 * @slot more - replaces the default "⋯" trigger glyph
 * @slot empty - shown inside the popup when there are no items
 * @fires slicc-scoop-select - composed + bubbling
 *   `CustomEvent<SliccScoopSelectDetail>` emitted when an overflow chip is clicked
 */
export class SliccScoopOverflow extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;

  /** The overflowed scoop descriptors (property, not an attribute). */
  #items: SliccScoopOverflowItem[] = [];

  // Element refs, populated by #render.
  #wrap!: HTMLDivElement;
  #moreBtn!: HTMLButtonElement;
  #pop!: HTMLDivElement;

  /** Document-level outside-click closer; bound once, attached only while open. */
  readonly #onDoc = (e: MouseEvent): void => {
    if (this.open && !this.contains(e.target as Node)) this.close();
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    // #render() → #syncOpen() attaches the outside-click closer when `open`.
    this.#render();
  }

  disconnectedCallback(): void {
    document.removeEventListener('click', this.#onDoc);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'open' && this.#wrap) this.#syncOpen();
  }

  // ----- Public API ---------------------------------------------------------

  /**
   * The overflowed scoop descriptors. Setting this re-renders the popup chips
   * and reflects `count` / `.has-overflow` (which reveals the "⋯" trigger). An
   * empty array hides the trigger and shows the `empty` slot inside the popup.
   */
  get items(): SliccScoopOverflowItem[] {
    return this.#items;
  }

  set items(value: SliccScoopOverflowItem[]) {
    this.#items = Array.isArray(value) ? value : [];
    if (this.isConnected) this.#renderPop();
  }

  /** Number of overflow items (mirrors the reflected `count` attribute). */
  get count(): number {
    return this.#items.length;
  }

  /** Whether there is at least one overflow item (drives the trigger visibility). */
  get hasOverflow(): boolean {
    return this.#items.length > 0;
  }

  /** Whether the popup is currently open. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  /** Open the popup. */
  show(): void {
    if (this.open) return;
    this.open = true;
  }

  /** Close the popup. */
  close(): void {
    if (!this.open) return;
    this.open = false;
  }

  /** Toggle the popup open/closed. */
  toggle(): void {
    this.open = !this.open;
  }

  // ----- Render --------------------------------------------------------------

  #render(): void {
    const moreSlot = h('slot', { name: 'more' }, '⋯');
    this.#moreBtn = h(
      'button',
      {
        class: 'morebtn',
        part: 'more',
        type: 'button',
        title: 'More scoops',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      },
      moreSlot
    ) as HTMLButtonElement;
    this.#pop = h('div', { class: 'pop', part: 'pop' }) as HTMLDivElement;
    this.#wrap = h(
      'div',
      { class: 'switcher-more', part: 'wrap' },
      this.#moreBtn,
      this.#pop
    ) as HTMLDivElement;

    this.#moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.#root.replaceChildren(this.#wrap);

    this.#renderPop();
    this.#syncOpen();
  }

  /** Rebuild the popup's cloned pills + reflect `count` / `.has-overflow`. */
  #renderPop(): void {
    const n = this.#items.length;
    // Reflect the overflow count (mirrors the prototype's `.has-overflow`).
    if (n > 0) this.setAttribute('count', String(n));
    else this.removeAttribute('count');
    this.#wrap.classList.toggle('has-overflow', n > 0);
    this.#moreBtn.setAttribute('aria-haspopup', 'true');

    if (n === 0) {
      // No chips left — surface an optional `empty` slot and force the popup shut.
      this.#pop.replaceChildren(h('slot', { name: 'empty' }));
      if (this.open) this.close();
      return;
    }

    const pills: HTMLElement[] = [];
    for (const item of this.#items) {
      const id = item.id;
      const label = item.label ?? item.id;
      const type = item.type === 'cone' ? 'cone' : 'scoop';
      const eyes = item.eyes === 'open' || item.eyes === 'dead' ? item.eyes : 'none';
      const pill = h('slicc-pill', {
        class: 'scoop',
        part: 'pill',
        'data-k': id,
        type,
        eyes,
        color: item.color ?? false,
        label,
      });
      pill.addEventListener('click', () => {
        const k = pill.dataset.k ?? '';
        const found = this.#items.find((it) => it.id === k);
        this.#select(k, found?.label ?? k);
      });
      pills.push(pill);
    }
    this.#pop.replaceChildren(...pills);
  }

  /** Reflect the `open` attribute onto the wrap class + `aria-expanded`. */
  #syncOpen(): void {
    const open = this.open;
    this.#wrap.classList.toggle('open', open);
    this.#moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Outside-click closer is attached only while open (cheap + leak-free).
    document.removeEventListener('click', this.#onDoc);
    if (open) document.addEventListener('click', this.#onDoc);
  }

  /** Emit `slicc-scoop-select` for the chosen chip and close the popup. */
  #select(id: string, label: string): void {
    this.dispatchEvent(
      new CustomEvent<SliccScoopSelectDetail>('slicc-scoop-select', {
        detail: { id, label },
        bubbles: true,
        composed: true,
      })
    );
    this.close();
  }
}

define('slicc-scoop-overflow', SliccScoopOverflow);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-scoop-overflow': SliccScoopOverflow;
  }
  interface HTMLElementEventMap {
    'slicc-scoop-select': CustomEvent<SliccScoopSelectDetail>;
  }
}
