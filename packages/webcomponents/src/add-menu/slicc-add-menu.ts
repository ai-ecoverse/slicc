import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

// ---------------------------------------------------------------------------
// Lifted from proto/StellarRubySwift.html (ADD_STYLE ~L756, class SliccAddMenu
// ~L801). Public contract preserved EXACTLY: the +/× trigger (`part="trigger"`),
// the slide-in search box, the absolutely-positioned results panel that pops
// upward out of the footer band (`part="wrap"` / `part="results"`), the
// `data-open` / `data-dropping` host states, and the bubbling+composed
// `slicc-add` CustomEvent emitted on selection / upload / drop.
//
// Theming change vs. the prototype: the prototype declared a self-contained
// palette (`--bg`, `--fg`, `--accent`, …) on `:host`. Those names collide with
// the library's inherited token vocabulary, so this lift maps every surface onto
// the inherited tokens where they exist (`--canvas`, `--ink`, `--txt-2`,
// `--txt-3`, `--line`) and introduces only `--am-*`-prefixed locals for the few
// the library lacks (accent, hover, sunken, accent-subtle). Dark therefore flips
// automatically via the library's `.dark` / `[data-theme="dark"]` / `body.dark`
// scopes; the `theme="light|dark"` attribute is still honored as a per-element
// override, exactly as in the prototype.
// ---------------------------------------------------------------------------

/** Lucide-style 24×24 glyph path data, lifted verbatim from the prototype. */
const ICON: Record<string, string> = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

function svgIcon(name: string, size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;
}

const STYLE = `
:host{display:block;width:100%;
  --am-accent:var(--accent,#3b63fb);
  --am-accent-subtle:color-mix(in oklab,var(--am-accent) 12%,var(--canvas,#fff));
  --am-sunken:var(--bg,#f3f3f3);
  --am-hover:rgba(0,0,0,0.05);
  font:400 13px var(--ui,"adobe-clean","Inter",system-ui,sans-serif);}
/* Dark flips via the library's outer scopes (.dark / [data-theme="dark"] / body.dark);
   :host-context reaches the light-DOM ancestor from inside the shadow root. The
   theme attribute is the per-element override. */
:host-context(.dark),:host-context([data-theme="dark"]),:host([theme="dark"]){
  --am-accent-subtle:color-mix(in oklab,var(--am-accent) 22%,transparent);
  --am-hover:rgba(255,255,255,0.06);
  --am-sunken:var(--bg,#141414);}
:host([theme="light"]){--am-accent-subtle:color-mix(in oklab,var(--am-accent) 12%,#fff);--am-hover:rgba(0,0,0,0.05);--am-sunken:#f3f3f3;}
*{box-sizing:border-box;}
/* .wrap is the positioning anchor; .row stays in flow (toolbar height unchanged),
   .results pops OUT absolutely so the footer band's height never grows when the
   menu opens. */
.wrap{display:flex;flex-direction:column;position:relative;}
.row{display:flex;align-items:center;gap:8px;}
.trigger{flex:0 0 auto;width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:var(--ink,#131313);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .13s ease,color .13s ease,transform .16s ease;}
.trigger:hover{background:var(--am-hover);}
.trigger[aria-expanded="true"]{background:var(--am-accent-subtle);color:var(--am-accent);transform:rotate(45deg);}
/* the search field slides in beside the +/× — collapsed until open */
.searchbox{flex:1;min-width:0;position:relative;display:none;}
:host([data-open]) .searchbox{display:block;}
.searchbox .si{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--txt-3,#717171);display:flex;pointer-events:none;}
.searchbox input{width:100%;border:1px solid var(--line,#e1e1e1);background:var(--am-sunken);color:var(--ink,#131313);border-radius:9px;padding:7px 10px 7px 32px;font:inherit;outline:none;}
.searchbox input:focus{border-color:var(--am-accent);}
/* results panel pops upward OUT of the footer band, overlaying the chat thread
   above. Absolute positioning keeps the toolbar/inputcard/composer heights
   constant so the chat layout never reflows when the menu opens. */
.results{position:absolute;left:-4px;right:-4px;bottom:calc(100% + 6px);
  max-height:0;overflow:hidden;opacity:0;pointer-events:none;
  background:var(--canvas,#fff);border:1px solid var(--line,#e1e1e1);border-radius:12px;
  box-shadow:0 -10px 28px -10px rgba(10,10,10,.20),0 -2px 6px -2px rgba(10,10,10,.08);
  transition:max-height .18s ease,opacity .14s ease;z-index:5;}
:host([data-open]) .results{max-height:300px;overflow-y:auto;opacity:1;pointer-events:auto;padding:6px;}
.sec{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--txt-3,#717171);font-weight:650;margin:8px 6px 4px;}
.item{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border-radius:9px;cursor:pointer;text-align:left;color:var(--ink,#131313);}
.item .ic{flex:0 0 auto;color:var(--txt-2,#505050);display:flex;} .item.quick .ic{color:var(--am-accent);}
.item .tx{min-width:0;} .item .lb{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;} .item .sb{font-size:11px;color:var(--txt-3,#717171);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.item.active,.item:hover{background:var(--am-accent-subtle);}
.empty{padding:18px 10px;text-align:center;color:var(--txt-3,#717171);font-size:12px;}
.sep{height:1px;background:var(--line,#e1e1e1);margin:6px 4px;}
.drop{position:absolute;inset:0;border-radius:10px;display:none;align-items:center;justify-content:center;text-align:center;background:var(--am-accent-subtle);border:2px dashed var(--am-accent);color:var(--am-accent);font-size:13px;font-weight:600;pointer-events:none;}
:host([data-dropping]) .drop{display:flex;}
`;

/** A single selectable entry within a results section. */
export interface SliccAddEntry {
  /** Stable identity (file path, skill name, conversation id, …). */
  id: string;
  /** Primary label shown in the row. */
  label: string;
  /** Optional secondary line (path, description, timestamp). */
  sub?: string;
}

/** One section of the results panel (Files / Skills / Conversations …). */
export interface SliccAddSection {
  /** Discriminator forwarded onto the emitted event detail (`detail.kind`). */
  kind: string;
  /** Section heading. */
  label: string;
  /** Glyph name from the built-in icon set (`file` / `sparkles` / `message` / …). */
  icon: string;
  /** Rows belonging to this section. */
  entries: SliccAddEntry[];
}

/**
 * A results provider: given the current (already lower-cased, trimmed) query,
 * return the sections to render. Sync or async. When it returns `null` /
 * `undefined`, the component falls back to its default demo dataset.
 */
export type SliccAddProvider = (
  query: string
) => SliccAddSection[] | null | undefined | Promise<SliccAddSection[] | null | undefined>;

/** The `detail` payload of the `slicc-add` event. */
export type SliccAddDetail =
  | { kind: 'upload'; name: string; size: number }
  | { kind: 'capture'; mode: 'photo' | 'screenshot'; label: string }
  | { kind: string; id: string; label: string };

/** Quick-action rows (always synthesized, never supplied by the data source). */
interface QuickAction {
  kind: 'upload' | 'capture';
  mode?: 'photo' | 'screenshot';
  icon: string;
  label: string;
  sub?: string;
  quick: true;
}

/** Flattened, render-ready list items derived from sections + quick actions. */
type ListItem =
  | { type: 'sec'; label: string }
  | { type: 'quick'; data: QuickAction }
  | { type: 'row'; section: SliccAddSection; data: SliccAddEntry };

/** Default demo dataset — lifted verbatim from the prototype's `DEMO`. */
const DEMO_SECTIONS: SliccAddSection[] = [
  {
    kind: 'file',
    label: 'Files',
    icon: 'file',
    entries: [
      { id: '/workspace/README.md', label: 'README.md', sub: '/workspace' },
      { id: '/workspace/src/main.ts', label: 'main.ts', sub: '/workspace/src' },
      { id: '/workspace/src/orchestrator.ts', label: 'orchestrator.ts', sub: '/workspace/src' },
      { id: '/workspace/notes/launch-plan.md', label: 'launch-plan.md', sub: '/workspace/notes' },
      { id: '/shared/CLAUDE.md', label: 'CLAUDE.md', sub: '/shared' },
      { id: '/tmp/screenshot-3.png', label: 'screenshot-3.png', sub: '/tmp' },
    ],
  },
  {
    kind: 'skill',
    label: 'Skills',
    icon: 'sparkles',
    entries: [
      {
        id: 'slicc-handoff',
        label: 'slicc-handoff',
        sub: 'Continue work in the SLICC browser agent',
      },
      { id: 'playwright-cli', label: 'playwright-cli', sub: 'Automate browser interactions' },
      { id: 'mixtape', label: 'mixtape', sub: 'Curate themed music playlists' },
      { id: 'wavespeed', label: 'wavespeed', sub: 'Generate images, video and speech' },
      { id: 'save-the-cat', label: 'save-the-cat', sub: 'Screenwriting beat sheets' },
    ],
  },
  {
    kind: 'conversation',
    label: 'Conversations',
    icon: 'message',
    entries: [
      { id: 'c1', label: 'Dark mode toggle', sub: 'Frozen · 2h ago' },
      { id: 'c2', label: 'Refactor the mount backend', sub: 'Frozen · yesterday' },
      { id: 'c3', label: 'Add slash menu (declined)', sub: 'Frozen · 3 days ago' },
      { id: 'c4', label: 'WebGL shader walkthrough', sub: 'Frozen · last week' },
    ],
  },
];

const QUICK_ACTIONS: QuickAction[] = [
  {
    kind: 'upload',
    icon: 'upload',
    label: 'Upload from this computer',
    sub: 'Drag & drop or click to browse',
    quick: true,
  },
  { kind: 'capture', mode: 'photo', icon: 'camera', label: 'Take a photo', quick: true },
  { kind: 'capture', mode: 'screenshot', icon: 'monitor', label: 'Take a screenshot', quick: true },
];

/**
 * `<slicc-add-menu>` — the prototype's composer "add to prompt" menu. A `+`
 * trigger that rotates into an `×` and slides in a search box; the matching
 * results pop upward out of the footer band into an absolutely-positioned panel
 * so the surrounding layout never reflows. Quick actions (upload / photo /
 * screenshot) sit above Files / Skills / Conversations sections, all keyboard
 * navigable. Files can also be added by drag-and-drop onto the wrap.
 *
 * Self-contained shadow DOM. Surfaces map onto inherited library tokens
 * (`--canvas`, `--ink`, `--txt-2`, `--txt-3`, `--line`, `--ui`) so dark flips
 * automatically via `.dark` / `[data-theme="dark"]` / `body.dark`; `--am-accent`
 * (and friends) are component-local locals. The `theme` attribute is a
 * per-element override.
 *
 * Data is injectable. By default the menu shows the built-in demo dataset; a
 * host supplies its own via the `results` property (static sections) and/or the
 * `provider` callback (dynamic / async, called with the current query). Both are
 * properties (not attributes); `provider` takes precedence over `results`, which
 * takes precedence over the demo dataset.
 *
 * @attr theme - `light` | `dark` per-element override of the inherited theme
 * @attr data-open - reflected host state while the panel is open (do not set)
 * @attr data-dropping - reflected host state during a file drag-over (do not set)
 * @csspart wrap - the positioning anchor wrapping the panel + the trigger row
 * @csspart trigger - the +/× toggle button
 * @csspart results - the pop-up results listbox panel
 * @fires slicc-add - composed + bubbling `CustomEvent<SliccAddDetail>` emitted on
 *   selection of a row, a capture quick-action, or a file upload / drop
 */
export class SliccAddMenu extends HTMLElement {
  static readonly observedAttributes = ['theme'];

  #root: ShadowRoot;

  // Public injectable state (properties, not attributes).
  #sections: SliccAddSection[] | null = null;
  #provider: SliccAddProvider | null = null;

  // Internal runtime state.
  #open = false;
  #query = '';
  #active = 0;
  /** Flattened, selectable items for the currently rendered body (1:1 with rows). */
  #items: SliccAddDetail[] = [];
  /** Monotonic token guarding against out-of-order async provider renders. */
  #renderToken = 0;

  // Element refs (populated by #render).
  #trigger!: HTMLButtonElement;
  #wrap!: HTMLDivElement;
  #search!: HTMLInputElement;
  #bodyEl!: HTMLDivElement;
  #file!: HTMLInputElement;

  #onDoc = (e: MouseEvent): void => {
    if (this.#open && !this.contains(e.target as Node)) this.close();
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    document.removeEventListener('mousedown', this.#onDoc);
  }

  attributeChangedCallback(): void {
    // `theme` only flips CSS custom-property scopes; no re-render required.
  }

  // ----- Public injectable API ---------------------------------------------

  /**
   * Static result sections. Replaces the built-in demo dataset. Setting `null`
   * (or never setting it) restores the demo dataset. When a `provider` is also
   * set, the provider wins.
   */
  get results(): SliccAddSection[] | null {
    return this.#sections;
  }

  set results(value: SliccAddSection[] | null) {
    this.#sections = value;
    if (this.#open) void this.#renderBody();
  }

  /**
   * Dynamic results callback, invoked with the current (lower-cased, trimmed)
   * query on every keystroke and on open. Sync or async. Returning a falsy
   * value falls back to `results` / the demo dataset. Takes precedence over
   * `results`.
   */
  get provider(): SliccAddProvider | null {
    return this.#provider;
  }

  set provider(value: SliccAddProvider | null) {
    this.#provider = value;
    if (this.#open) void this.#renderBody();
  }

  /** Whether the panel is currently open (read-only; drive via `open()`/`close()`). */
  get isOpen(): boolean {
    return this.#open;
  }

  // ----- Render -------------------------------------------------------------

  #render(): void {
    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      `<input type="file" multiple hidden />` +
      `<div class="wrap" part="wrap">` +
      `<div class="results" part="results" role="listbox"><div class="body"></div>` +
      `<div class="drop">Drop files to add</div></div>` +
      `<div class="row">` +
      `<button class="trigger" part="trigger" aria-haspopup="true" aria-expanded="false" title="Add to prompt">${svgIcon('plus', 20)}</button>` +
      `<div class="searchbox"><span class="si">${svgIcon('search', 16)}</span>` +
      `<input type="text" placeholder="Search files, skills, conversations…" /></div>` +
      `</div></div>`;

    this.#trigger = this.#root.querySelector('.trigger') as HTMLButtonElement;
    this.#wrap = this.#root.querySelector('.wrap') as HTMLDivElement;
    this.#search = this.#root.querySelector('.searchbox input') as HTMLInputElement;
    this.#bodyEl = this.#root.querySelector('.results .body') as HTMLDivElement;
    this.#file = this.#root.querySelector('input[type=file]') as HTMLInputElement;
    this.#bind();
    void this.#renderBody();
  }

  #bind(): void {
    this.#trigger.addEventListener('click', () => this.toggle());
    this.#search.addEventListener('input', () => {
      this.#query = this.#search.value;
      this.#active = 0;
      void this.#renderBody();
    });
    this.#search.addEventListener('keydown', (e) => this.#onKey(e));
    this.#file.addEventListener('change', () => {
      for (const f of Array.from(this.#file.files ?? [])) {
        this.#emit({ kind: 'upload', name: f.name, size: f.size });
      }
      this.#file.value = '';
      this.close();
    });
    for (const t of ['dragenter', 'dragover'] as const) {
      this.#wrap.addEventListener(t, (e) => {
        e.preventDefault();
        if (!this.#open) this.open();
        this.setAttribute('data-dropping', '');
      });
    }
    for (const t of ['dragleave', 'drop'] as const) {
      this.#wrap.addEventListener(t, (e) => {
        e.preventDefault();
        const drag = e as DragEvent;
        if (t === 'dragleave' && this.#wrap.contains(drag.relatedTarget as Node)) return;
        this.removeAttribute('data-dropping');
      });
    }
    this.#wrap.addEventListener('drop', (e) => {
      const files = (e as DragEvent).dataTransfer?.files;
      if (files?.length) {
        for (const f of Array.from(files))
          this.#emit({ kind: 'upload', name: f.name, size: f.size });
        this.close();
      }
    });
  }

  // ----- Open / close -------------------------------------------------------

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.setAttribute('data-open', '');
    this.#trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', this.#onDoc);
    this.#query = '';
    this.#search.value = '';
    this.#active = 0;
    void this.#renderBody();
    requestAnimationFrame(() => this.#search.focus());
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.removeAttribute('data-open');
    this.removeAttribute('data-dropping');
    this.#trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this.#onDoc);
  }

  // ----- Data resolution + flattening --------------------------------------

  /** Resolve the active section source (provider › results › demo). */
  async #resolveSections(query: string): Promise<SliccAddSection[]> {
    if (this.#provider) {
      const out = await this.#provider(query);
      if (out) return out;
    }
    return this.#sections ?? DEMO_SECTIONS;
  }

  /** Build the flat, render-ready item list for the current query. */
  #collect(sections: SliccAddSection[]): ListItem[] {
    const q = this.#query.trim().toLowerCase();
    const match = (e: SliccAddEntry): boolean =>
      !q || `${e.label} ${e.sub ?? ''}`.toLowerCase().includes(q);
    const items: ListItem[] = [];

    if (!q) {
      for (const a of QUICK_ACTIONS) items.push({ type: 'quick', data: a });
    } else if ('upload take a photo screenshot'.includes(q)) {
      for (const a of QUICK_ACTIONS) {
        if (a.label.toLowerCase().includes(q)) items.push({ type: 'quick', data: a });
      }
    }

    for (const section of sections) {
      const hits = section.entries.filter(match).slice(0, q ? 8 : 4);
      if (hits.length) {
        items.push({ type: 'sec', label: section.label });
        for (const h of hits) items.push({ type: 'row', section, data: h });
      }
    }
    return items;
  }

  async #renderBody(): Promise<void> {
    const token = ++this.#renderToken;
    const sections = await this.#resolveSections(this.#query.trim().toLowerCase());
    // A newer render (later keystroke / source swap) superseded this one.
    if (token !== this.#renderToken) return;

    const list = this.#collect(sections);
    this.#items = [];
    let html = '';
    let prevQuick = false;

    for (const it of list) {
      if (it.type === 'sec') {
        if (prevQuick) html += `<div class="sep"></div>`;
        html += `<div class="sec">${escapeHtml(it.label)}</div>`;
        prevQuick = false;
      } else if (it.type === 'quick') {
        const i = this.#items.length;
        this.#items.push(
          it.data.kind === 'upload'
            ? { kind: 'upload', name: '', size: 0 }
            : { kind: 'capture', mode: it.data.mode ?? 'photo', label: it.data.label }
        );
        const subHtml = it.data.sub ? `<div class="sb">${escapeHtml(it.data.sub)}</div>` : '';
        html +=
          `<div class="item quick" data-i="${i}"><span class="ic">${svgIcon(it.data.icon)}</span>` +
          `<span class="tx"><div class="lb">${escapeHtml(it.data.label)}</div>${subHtml}</span></div>`;
        prevQuick = true;
      } else {
        const i = this.#items.length;
        this.#items.push({ kind: it.section.kind, id: it.data.id, label: it.data.label });
        html +=
          `<div class="item" data-i="${i}"><span class="ic">${svgIcon(it.section.icon)}</span>` +
          `<span class="tx"><div class="lb">${escapeHtml(it.data.label)}</div>` +
          `<div class="sb">${escapeHtml(it.data.sub ?? '')}</div></span></div>`;
      }
    }

    this.#bodyEl.innerHTML =
      html || `<div class="empty">No matches for &ldquo;${escapeHtml(this.#query)}&rdquo;.</div>`;

    for (const el of Array.from(this.#bodyEl.querySelectorAll<HTMLElement>('.item'))) {
      const i = Number(el.dataset.i);
      el.addEventListener('mouseenter', () => this.#setActive(i));
      el.addEventListener('click', () => this.#select(i));
    }
    if (this.#active >= this.#items.length) this.#active = 0;
    this.#paint();
  }

  // ----- Active-row tracking + keyboard nav --------------------------------

  #paint(): void {
    for (const el of Array.from(this.#bodyEl.querySelectorAll<HTMLElement>('.item'))) {
      el.classList.toggle('active', Number(el.dataset.i) === this.#active);
    }
  }

  #setActive(i: number): void {
    this.#active = i;
    this.#paint();
  }

  #move(d: number): void {
    if (!this.#items.length) return;
    this.#active = (this.#active + d + this.#items.length) % this.#items.length;
    this.#paint();
    const el = this.#bodyEl.querySelector<HTMLElement>(`.item[data-i="${this.#active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  #onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.#move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.#move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#select(this.#active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      this.#trigger.focus();
    }
  }

  // ----- Selection / emit ---------------------------------------------------

  #select(i: number): void {
    const it = this.#items[i];
    if (!it) return;
    // The upload quick-action opens the native picker; the real emit happens on
    // the file <input>'s change event (one event per chosen file).
    if (it.kind === 'upload') {
      this.#file.click();
      return;
    }
    this.#emit(it);
    this.close();
  }

  #emit(detail: SliccAddDetail): void {
    this.dispatchEvent(new CustomEvent('slicc-add', { detail, bubbles: true, composed: true }));
  }
}

define('slicc-add-menu', SliccAddMenu);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-add-menu': SliccAddMenu;
  }
  interface HTMLElementEventMap {
    'slicc-add': CustomEvent<SliccAddDetail>;
  }
}
