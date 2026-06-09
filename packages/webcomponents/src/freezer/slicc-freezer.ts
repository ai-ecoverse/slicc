import { define } from '../internal/define.js';

/**
 * Ice-blue accent applied to the freezer chrome while a freezer (past-session)
 * context is active — lifted from the prototype's `_ctxAccent` for `freezer:`
 * contexts (`proto/StellarRubySwift.html`). Exposed as the `--fz-ctx` host token
 * so a host can override it; defaults to the prototype value.
 */
const FREEZER_ICE = '#3b6cb2';

/**
 * Scoped, document-level stylesheet for `<slicc-freezer>`. A light-DOM host can't
 * carry a shadow-root `<style>`, so the `.freezer` chrome is injected once into
 * the host document (idempotent). Every rule is scoped under the host class
 * `.slicc-freezer` (the prototype's bare `.freezer`, rebased so it can't leak)
 * and is otherwise lifted verbatim from the prototype
 * (`proto/StellarRubySwift.html` `.freezer` / `.fzh` / `.fztgl` / `.fzsearch` /
 * `.fzrail` rules, plus the `body.dark .freezer` shadow tweak rebased to the
 * inherited dark scopes).
 *
 * Everything is var-driven (`--ctx` / `--bg` / `--ghost` / `--ink` / `--line` /
 * `--txt-2` / `--txt-3` / `--canvas` / `--barh` / `--ui`) so dark mode flips
 * automatically — only the `box-shadow` gets a per-theme override, exactly as the
 * prototype does. The width animation (`44px ↔ 260px`, `.4s` cubic-bezier) and
 * the `z-index: 6` layering over the frost shader are preserved.
 *
 * The collapsed/open contract mirrors the prototype's `.freezer` / `.freezer.open`:
 * collapsed centers items and zeroes the card/new text width; `.open` stretches
 * the rail, reveals the search input, and fades the text in.
 */
const STYLE = `
.slicc-freezer {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 44px;
  z-index: 6;
  background: color-mix(in srgb, var(--ctx) 12%, var(--bg));
  border-right: 1px solid var(--line);
  transition: width .4s cubic-bezier(.4, 0, .2, 1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: rgba(10, 10, 10, .06) 1px 0 14px -4px;
  font-family: var(--ui);
}
.slicc-freezer[open] { width: 260px; }
.dark .slicc-freezer,
[data-theme="dark"] .slicc-freezer { box-shadow: rgba(0, 0, 0, .35) 1px 0 14px -4px; }

.slicc-freezer .fzh {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  min-height: var(--barh);
  border-bottom: 1px solid var(--line);
  background: transparent;
  flex: 0 0 auto;
}
.slicc-freezer .fztgl {
  font: inherit;
  font-size: 14px;
  line-height: 1;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--canvas);
  color: var(--txt-2);
  cursor: pointer;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.slicc-freezer .fztgl:hover { background: var(--ghost); color: var(--ink); }
.slicc-freezer .fztgl svg { display: block; transition: transform .25s cubic-bezier(.4, 0, .2, 1); }
.slicc-freezer .fztgl[aria-expanded="true"] svg { transform: scaleX(-1); }

.slicc-freezer .fzsearch {
  display: none;
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  color: var(--ink);
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 9px;
  outline: none;
}
.slicc-freezer .fzsearch::placeholder { color: var(--txt-3); }
.slicc-freezer .fzsearch:focus { border-color: var(--txt-3); background: var(--canvas); }
.slicc-freezer[open] .fzsearch { display: block; }

.slicc-freezer .fzrail {
  position: relative;
  z-index: 1;
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 0;
  align-items: center;
}
.slicc-freezer[open] .fzrail { align-items: stretch; padding: 11px 8px 16px; }

/* ice-blue accent while a freezer context is active (prototype _ctxAccent) —
   tints the toggle + the new-chat icon; cards keep their snow palette. */
.slicc-freezer[ctx] .fztgl { color: var(--fz-ctx, ${FREEZER_ICE}); border-color: color-mix(in srgb, var(--fz-ctx, ${FREEZER_ICE}) 40%, var(--line)); }
.slicc-freezer[ctx] ::part(new-icon),
.slicc-freezer[ctx] slicc-freezer-new::part(new-icon) {
  background: color-mix(in srgb, var(--fz-ctx, ${FREEZER_ICE}) 14%, var(--canvas));
  border-color: color-mix(in srgb, var(--fz-ctx, ${FREEZER_ICE}) 40%, var(--line));
  color: var(--fz-ctx, ${FREEZER_ICE});
}

/* match-hidden: search filtered a session row out (only meaningful when open,
   collapsed shows icons only). Works on both the composed card element and a raw
   prototype .fzcard row. */
.slicc-freezer[open] slicc-freezer-card.match-hidden,
.slicc-freezer[open] .fzcard.match-hidden { display: none; }
`;

const STYLE_ID = 'slicc-freezer-style';

/** Inject the scoped freezer stylesheet into a document once (idempotent). */
function ensureFreezerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * The collapse/expand toggle glyph — the prototype's distinct panel-toggle SVG
 * (a bordered rect with a rail divider + a chevron), NOT the snowflake the cards
 * use. It mirrors (`scaleX(-1)`) when expanded via the `[aria-expanded]` rule.
 */
const TOGGLE_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>' +
  '<line x1="6" y1="3.5" x2="6" y2="12.5"/>' +
  '<polyline points="9,6.5 10.5,8 9,9.5"/></svg>';

/** The `freezer-toggle` event detail — the freezer's new open state. */
export interface FreezerToggleDetail {
  /** `true` when the rail is now open (260px), `false` when collapsed (44px). */
  open: boolean;
}

declare global {
  interface HTMLElementEventMap {
    'freezer-toggle': CustomEvent<FreezerToggleDetail>;
  }
}

/**
 * `<slicc-freezer>` — the collapsible past-sessions rail ("freezer") from the
 * left edge of the prototype (`proto/StellarRubySwift.html` `.freezer`). A fixed
 * `<aside>` over the frost-shader background, collapsed to a `44px` icon-only
 * column by default and expanding to a `260px` rail on toggle. The header band
 * (`.fzh`) carries the collapse/expand toggle (`.fztgl`, a rect+chevron that
 * mirrors when open) and a search input (`.fzsearch`, hidden until open); the
 * scrollable rail (`.fzrail`) holds a New-chat affordance plus a stack of session
 * rows.
 *
 * Light DOM (no shadow root): the host owns its own `.fzh` header + `.fzrail`
 * rail and relocates slotted children — the New-chat affordance
 * (`<slicc-freezer-new>`, composed by tag) and the session rows
 * (`<slicc-freezer-card>` or raw prototype `.fzcard` rows) — into the rail at
 * connect time, so the host app can style the surface and slot content. A frost
 * shader (`<slicc-frost-shader>`, Wave 7) may be composed by tag as the
 * background behind it.
 *
 * The `open` boolean attribute drives the width animation purely in CSS
 * (`.slicc-freezer[open]`); the toggle button reflects it and emits
 * `freezer-toggle`. The search input live-filters the session rows by `textContent`
 * substring, hiding non-matches with the `match-hidden` class. The `ctx` boolean
 * paints the chrome with an ice-blue accent while a freezer context is active.
 *
 * @attr open - boolean; expands the rail (260px) vs. collapsed (44px). Reflected.
 * @attr ctx - boolean; ice-blue accent while a freezer context is active.
 * @attr search-placeholder - placeholder text for the search input.
 * @csspart freezer - the host aside (carries `part="freezer"`)
 * @csspart header - the `.fzh` header band
 * @csspart toggle - the `.fztgl` collapse/expand button
 * @csspart search - the `.fzsearch` input
 * @csspart rail - the `.fzrail` scroll region
 * @slot - default; the New-chat affordance + session rows, relocated into the rail
 * @fires freezer-toggle - the rail was toggled; `detail` is {@link FreezerToggleDetail}
 */
export class SliccFreezer extends HTMLElement {
  static readonly observedAttributes = ['open', 'ctx', 'search-placeholder'];

  #header!: HTMLElement;
  #toggle!: HTMLButtonElement;
  #search!: HTMLInputElement;
  #rail!: HTMLElement;
  #built = false;
  #onToggle: (() => void) | null = null;
  #onSearch: (() => void) | null = null;

  connectedCallback(): void {
    ensureFreezerStyle(this.ownerDocument);
    this.classList.add('slicc-freezer');
    this.setAttribute('part', 'freezer');
    if (!this.hasAttribute('aria-label')) {
      this.setAttribute('aria-label', 'Past sessions (freezer)');
    }
    this.#build();
    this.#syncToggle();
  }

  disconnectedCallback(): void {
    if (this.#onToggle && this.#toggle) {
      this.#toggle.removeEventListener('click', this.#onToggle);
      this.#onToggle = null;
    }
    if (this.#onSearch && this.#search) {
      this.#search.removeEventListener('input', this.#onSearch);
      this.#onSearch = null;
    }
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (!this.#built) return;
    if (name === 'open') this.#syncToggle();
    else if (name === 'search-placeholder') {
      this.#search.placeholder = value ?? 'search past sessions';
    }
    // `ctx` is driven entirely by the `[ctx]` CSS rule; nothing to do here.
  }

  /** Whether the rail is expanded (260px) vs. collapsed (44px). Reflected. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  /** Whether a freezer context is active (ice-blue accent). Reflected. */
  get ctx(): boolean {
    return this.hasAttribute('ctx');
  }

  set ctx(value: boolean) {
    this.toggleAttribute('ctx', value);
  }

  /** The search input's placeholder text. */
  get searchPlaceholder(): string {
    return this.getAttribute('search-placeholder') ?? 'search past sessions';
  }

  set searchPlaceholder(value: string | null) {
    if (value == null) this.removeAttribute('search-placeholder');
    else this.setAttribute('search-placeholder', value);
  }

  /** The current search query (the live filter input value). */
  get query(): string {
    return this.#built ? this.#search.value : '';
  }

  set query(value: string) {
    this.#build();
    this.#search.value = value;
    this.#applyFilter();
  }

  /** The scrollable rail (`part="rail"`) — where session rows live. */
  get rail(): HTMLElement {
    this.#build();
    return this.#rail;
  }

  /** Toggle (or set) the open state and emit `freezer-toggle`. */
  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    if (next === this.open) {
      // Still resync chrome (e.g. first toggle from a host setting `open` directly).
      this.#syncToggle();
    }
    this.open = next;
    this.#syncToggle();
    this.dispatchEvent(
      new CustomEvent<FreezerToggleDetail>('freezer-toggle', {
        detail: { open: next },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Append a session row (or any node) into the rail, preserving DOM order. */
  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#rail.append(...nodes);
  }

  /**
   * Build the header + rail once and relocate any pre-existing light children
   * into the rail. Idempotent across re-connects (light DOM survives a move, so
   * the already-built chrome is reused rather than rebuilt).
   */
  #build(): void {
    if (this.#built) return;

    const existingHeader = this.querySelector(':scope > .fzh');
    const existingRail = this.querySelector(':scope > .fzrail');
    if (existingHeader instanceof HTMLElement && existingRail instanceof HTMLElement) {
      this.#adopt(existingHeader, existingRail);
      return;
    }

    // Collect children that existed before we owned the subtree (the slotted
    // New-chat affordance + session rows). Skip any stray header/rail leftovers.
    const incoming = Array.from(this.childNodes).filter(
      (n) =>
        !(
          n instanceof HTMLElement &&
          (n.classList.contains('fzh') || n.classList.contains('fzrail'))
        )
    );

    const doc = this.ownerDocument;

    const header = doc.createElement('div');
    header.className = 'fzh';
    header.setAttribute('part', 'header');

    const toggle = doc.createElement('button');
    toggle.className = 'fztgl';
    toggle.type = 'button';
    toggle.setAttribute('part', 'toggle');
    toggle.setAttribute('aria-label', 'Toggle freezer');
    toggle.innerHTML = TOGGLE_SVG;

    const search = doc.createElement('input');
    search.className = 'fzsearch';
    search.type = 'text';
    search.setAttribute('part', 'search');
    search.placeholder = this.searchPlaceholder;
    search.setAttribute('aria-label', 'Search past sessions');

    header.append(toggle, search);

    const rail = doc.createElement('div');
    rail.className = 'fzrail';
    rail.setAttribute('part', 'rail');
    for (const node of incoming) rail.appendChild(node);

    // Header first, then the rail, then anything else we displaced earlier.
    this.replaceChildren(header, rail);

    this.#adopt(header, rail);
  }

  /** Wire references + listeners onto the (built or pre-existing) chrome. */
  #adopt(header: HTMLElement, rail: HTMLElement): void {
    this.#built = true;
    this.#header = header;
    this.#rail = rail;
    const toggle = header.querySelector<HTMLButtonElement>('.fztgl');
    const search = header.querySelector<HTMLInputElement>('.fzsearch');
    if (toggle) this.#toggle = toggle;
    if (search) this.#search = search;

    if (this.#toggle && !this.#onToggle) {
      this.#onToggle = () => this.toggle();
      this.#toggle.addEventListener('click', this.#onToggle);
    }
    if (this.#search && !this.#onSearch) {
      this.#onSearch = () => this.#applyFilter();
      this.#search.addEventListener('input', this.#onSearch);
    }
  }

  /** Keep the toggle's `aria-expanded` + `title` in sync with the open state. */
  #syncToggle(): void {
    if (!this.#toggle) return;
    const open = this.open;
    this.#toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.#toggle.title = open ? 'Collapse freezer' : 'Expand freezer';
  }

  /**
   * Live search filter (prototype `fzSearch` input handler): toggle `match-hidden`
   * on each session row whose `textContent` does not contain the query substring.
   * An empty query clears every filter. Matches both the composed
   * `<slicc-freezer-card>` element and raw prototype `.fzcard` rows.
   */
  #applyFilter(): void {
    const q = this.#search.value.trim().toLowerCase();
    const rows = this.#rail.querySelectorAll<HTMLElement>('slicc-freezer-card, .fzcard');
    for (const row of rows) {
      const text = (row.textContent ?? '').toLowerCase();
      row.classList.toggle('match-hidden', q.length > 0 && !text.includes(q));
    }
  }
}

define('slicc-freezer', SliccFreezer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-freezer': SliccFreezer;
  }
}
