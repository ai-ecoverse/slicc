import { define } from '../internal/define.js';

const FREEZER_ICE = '#3b6cb2';

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
/* In-flow mode, for when the rail is a docked panel rather than a viewport
   overlay. The default is \`position:fixed\` because the rail predates the panel
   system: it floated over the app column, which reserved space for it via a
   \`--rail-w\` padding. As a panel it must instead occupy real layout space, so
   the layout engine can size it and its expand/collapse pushes siblings rather
   than sliding over them. \`height:100%\` replaces the viewport-anchored
   \`top/bottom:0\`, and the z-index is dropped so it can't lift itself out of
   the panel host's stacking order. */
.slicc-freezer[docked] {
  position: relative;
  left: auto;
  top: auto;
  bottom: auto;
  height: 100%;
  z-index: auto;
  flex: 1 1 auto;
  min-height: 0;
}
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

function ensureFreezerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildToggleSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [
    ['width', '14'],
    ['height', '14'],
    ['viewBox', '0 0 16 16'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '1.6'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'],
  ]) {
    svg.setAttribute(k, v);
  }
  const rect = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of [
    ['x', '2.5'],
    ['y', '3.5'],
    ['width', '11'],
    ['height', '9'],
    ['rx', '1.5'],
  ]) {
    rect.setAttribute(k, v);
  }
  const line = document.createElementNS(SVG_NS, 'line');
  for (const [k, v] of [
    ['x1', '6'],
    ['y1', '3.5'],
    ['x2', '6'],
    ['y2', '12.5'],
  ]) {
    line.setAttribute(k, v);
  }
  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('points', '9,6.5 10.5,8 9,9.5');
  svg.append(rect, line, polyline);
  return svg;
}

export interface FreezerToggleDetail {
  open: boolean;
}

declare global {
  interface HTMLElementEventMap {
    'freezer-toggle': CustomEvent<FreezerToggleDetail>;
  }
}

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
    this.#syncChildExpanded();
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
    if (name === 'open') {
      this.#syncToggle();
      this.#syncChildExpanded();
    } else if (name === 'search-placeholder') {
      this.#search.placeholder = value ?? 'search past sessions';
    }
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  get ctx(): boolean {
    return this.hasAttribute('ctx');
  }

  set ctx(value: boolean) {
    this.toggleAttribute('ctx', value);
  }

  get searchPlaceholder(): string {
    return this.getAttribute('search-placeholder') ?? 'search past sessions';
  }

  set searchPlaceholder(value: string | null) {
    if (value == null) this.removeAttribute('search-placeholder');
    else this.setAttribute('search-placeholder', value);
  }

  get query(): string {
    return this.#built ? this.#search.value : '';
  }

  set query(value: string) {
    this.#build();
    this.#search.value = value;
    this.#applyFilter();
  }

  get rail(): HTMLElement {
    this.#build();
    return this.#rail;
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    if (next === this.open) {
      this.#syncToggle();
    }
    this.open = next;
    this.#syncToggle();

    this.#syncChildExpanded();
    this.dispatchEvent(
      new CustomEvent<FreezerToggleDetail>('freezer-toggle', {
        detail: { open: next },
        bubbles: true,
        composed: true,
      })
    );
  }

  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#rail.append(...nodes);

    this.#syncChildExpanded();
  }

  #build(): void {
    if (this.#built) return;

    const existingHeader = this.querySelector(':scope > .fzh');
    const existingRail = this.querySelector(':scope > .fzrail');
    if (existingHeader instanceof HTMLElement && existingRail instanceof HTMLElement) {
      this.#adopt(existingHeader, existingRail);
      return;
    }

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
    toggle.append(buildToggleSvg());

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

    this.replaceChildren(header, rail);

    this.#adopt(header, rail);
  }

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

  #syncToggle(): void {
    if (!this.#toggle) return;
    const open = this.open;
    this.#toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.#toggle.title = open ? 'Collapse freezer' : 'Expand freezer';
  }

  #syncChildExpanded(): void {
    if (!this.#built) return;
    const open = this.open;
    const items = this.#rail.querySelectorAll<HTMLElement>('slicc-freezer-card, slicc-freezer-new');
    for (const item of items) item.toggleAttribute('expanded', open);
  }

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
