import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

// ---------------------------------------------------------------------------
// Lifted from proto/StellarRubySwift.html (ADD_STYLE ~L756, class SliccAddMenu
// ~L801). Public contract preserved EXACTLY: the +/× trigger (`part="trigger"`),
// the slide-in search box, the absolutely-positioned results panel that pops
// upward out of the footer band (`part="wrap"` / `part="results"`), the
// `data-open` / `data-dropping` host states, and the bubbling+composed
// `slicc-add` CustomEvent emitted on selection / upload / drop.
//
// Icons: every glyph is a lucide `<svg>` rendered via the shared `iconEl`
// helper (`../internal/icons.js`) — NOT emoji or hand-rolled path data. The
// trigger swaps between the lucide `plus` (closed) and `x` (open) glyphs, and
// the same 45° rotate/transition from the prototype rides on top of the swap.
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

/** Glyph size (px) for the +/× trigger. */
const TRIGGER_ICON_SIZE = 20;
/** Glyph size (px) for the search-box leading icon. */
const SEARCH_ICON_SIZE = 16;
/** Glyph size (px) for the result-row and quick-action icons. */
const ROW_ICON_SIZE = 18;

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
.trigger{flex:0 0 auto;width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:var(--ink,#131313);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .13s ease,color .13s ease;}
.trigger:hover{background:var(--am-hover);}
.trigger[aria-expanded="true"]{background:var(--am-accent-subtle);color:var(--am-accent);}
/* The glyph itself swaps plus -> x; the quarter-turn rides on the swap so the
   open state spins in. The lucide x glyph is symmetric under a 90deg rotation,
   so the rotation is purely motion -- it never corrupts the rendered glyph. */
.trigger .ti{display:flex;transition:transform .16s ease;}
.trigger[aria-expanded="true"] .ti{transform:rotate(90deg);}
.trigger .ti svg{display:block;}
/* Respect prefers-reduced-motion: hold the static end state, no spin. */
@media (prefers-reduced-motion: reduce){.trigger .ti{transition:none;}}
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
const SHEET = sheet(STYLE);

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
  /** Lucide icon name (kebab-case, e.g. `file` / `sparkles` / `message-square`). */
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
  // `file` carries the real picked/dropped File so hosts can read its
  // content; it is absent only for the synthetic quick-action row itself.
  | { kind: 'upload'; name: string; size: number; file?: File }
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
    icon: 'message-square',
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
  { kind: 'capture', mode: 'photo', icon: 'image', label: 'Take a photo', quick: true },
  { kind: 'capture', mode: 'screenshot', icon: 'monitor', label: 'Take a screenshot', quick: true },
];

/**
 * `<slicc-add-menu>` — the prototype's composer "add to prompt" menu. A trigger
 * whose glyph swaps between the lucide `plus` (closed) and `x` (open) — with the
 * prototype's quarter-turn rotate riding on the swap — slides in a search box;
 * the matching results pop upward out of the footer band into an
 * absolutely-positioned panel so the surrounding layout never reflows. Quick
 * actions (upload / photo / screenshot, rendered with the lucide `upload` /
 * `image` / `monitor` glyphs) sit above Files / Skills / Conversations sections,
 * all keyboard navigable. Files can also be added by drag-and-drop onto the wrap.
 *
 * All glyphs are lucide `<svg>`s via the shared `iconEl` helper — never emoji
 * or bespoke unicode symbols. The trigger spin holds a static end state under
 * `prefers-reduced-motion: reduce`.
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
 * @attr global-drop - OPT-IN: when present, the component also registers
 *   document-level file drag/drop listeners (drag-counter guarded) so a file
 *   dragged anywhere on the owning document opens the menu, activates the drop
 *   zone, and lands its drop as `slicc-add` upload events. Absent (the default),
 *   only the wrap-scoped drop zone is active and no document listeners exist.
 * @attr data-open - reflected host state while the panel is open (do not set)
 * @attr data-dropping - reflected host state during a file drag-over (do not set)
 * @csspart wrap - the positioning anchor wrapping the panel + the trigger row
 * @csspart trigger - the +/× toggle button
 * @csspart results - the pop-up results listbox panel
 * @fires slicc-add - composed + bubbling `CustomEvent<SliccAddDetail>` emitted on
 *   selection of a row, a capture quick-action, or a file upload / drop
 */
export class SliccAddMenu extends HTMLElement {
  static readonly observedAttributes = ['theme', 'global-drop'];

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
  /** The +/× glyph wrapper inside the trigger (swaps plus -> x on open). */
  #triggerIcon!: HTMLSpanElement;
  #wrap!: HTMLDivElement;
  #search!: HTMLInputElement;
  #bodyEl!: HTMLDivElement;
  #file!: HTMLInputElement;

  #onDoc = (e: MouseEvent): void => {
    if (this.#open && !this.contains(e.target as Node)) this.close();
  };

  // ----- Document-level drop (opt-in via the `global-drop` attribute) --------

  /** Whether the document-level drag listeners are currently registered. */
  #globalDropBound = false;
  /** Drag-counter so nested dragenter/dragleave don't flicker the drop state. */
  #docDragDepth = 0;
  /** Whether the in-flight document drag auto-opened the menu (restore on leave). */
  #autoOpened = false;

  /** True only for an OS/file drag (carries `Files`), not a text/element drag. */
  #isFileDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  /** Open (remembering it was auto-opened) + light up the drop zone. */
  #activateDrop(): void {
    if (!this.#open) {
      this.#autoOpened = true;
      this.open();
    }
    this.setAttribute('data-dropping', '');
  }

  /** Drag left the window (counter back to 0): clear state, restore if auto-opened. */
  #resetDrop(): void {
    this.#docDragDepth = 0;
    this.removeAttribute('data-dropping');
    if (this.#autoOpened) {
      this.#autoOpened = false;
      this.close();
    }
  }

  #onDocDragEnter = (e: DragEvent): void => {
    if (!this.#isFileDrag(e)) return;
    e.preventDefault();
    this.#docDragDepth++;
    // Over the wrap, the wrap-scoped handlers own the visual state; keep the
    // counter balanced but don't double-activate.
    if (e.composedPath().includes(this.#wrap)) return;
    this.#activateDrop();
  };

  #onDocDragOver = (e: DragEvent): void => {
    // preventDefault on dragover is what makes the whole document a drop target.
    if (this.#isFileDrag(e)) e.preventDefault();
  };

  #onDocDragLeave = (e: DragEvent): void => {
    if (!this.#isFileDrag(e)) return;
    this.#docDragDepth = Math.max(0, this.#docDragDepth - 1);
    if (this.#docDragDepth === 0) this.#resetDrop();
  };

  #onDocDrop = (e: DragEvent): void => {
    if (!this.#isFileDrag(e)) return;
    // Stop the browser from navigating to the dropped file, even off-menu.
    e.preventDefault();
    this.#docDragDepth = 0;
    // A drop on the wrap is already emitted + closed by the wrap-scoped handler;
    // only reset our auto-open bookkeeping so we don't double-emit / double-close.
    if (e.composedPath().includes(this.#wrap)) {
      this.#autoOpened = false;
      return;
    }
    this.removeAttribute('data-dropping');
    this.#autoOpened = false;
    const files = e.dataTransfer?.files;
    if (files?.length) {
      for (const f of Array.from(files))
        this.#emit({ kind: 'upload', name: f.name, size: f.size, file: f });
    }
    this.close();
  };

  /** Attach/detach the document listeners to match the `global-drop` attribute. */
  #syncGlobalDrop(): void {
    if (this.isConnected && this.hasAttribute('global-drop')) this.#bindGlobalDrop();
    else this.#unbindGlobalDrop();
  }

  #bindGlobalDrop(): void {
    if (this.#globalDropBound) return;
    this.#globalDropBound = true;
    const doc = this.ownerDocument;
    doc.addEventListener('dragenter', this.#onDocDragEnter);
    doc.addEventListener('dragover', this.#onDocDragOver);
    doc.addEventListener('dragleave', this.#onDocDragLeave);
    doc.addEventListener('drop', this.#onDocDrop);
  }

  #unbindGlobalDrop(): void {
    if (!this.#globalDropBound) return;
    this.#globalDropBound = false;
    const doc = this.ownerDocument;
    doc.removeEventListener('dragenter', this.#onDocDragEnter);
    doc.removeEventListener('dragover', this.#onDocDragOver);
    doc.removeEventListener('dragleave', this.#onDocDragLeave);
    doc.removeEventListener('drop', this.#onDocDrop);
    this.#docDragDepth = 0;
    this.#autoOpened = false;
  }

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    this.#syncGlobalDrop();
  }

  disconnectedCallback(): void {
    document.removeEventListener('mousedown', this.#onDoc);
    this.#unbindGlobalDrop();
  }

  attributeChangedCallback(name: string): void {
    // `theme` only flips CSS custom-property scopes; no re-render required.
    // `global-drop` toggles the document-level drop listeners on/off.
    if (name === 'global-drop') this.#syncGlobalDrop();
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
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      hidden: true,
    }) as HTMLInputElement;

    const bodyEl = h('div', { class: 'body' }) as HTMLDivElement;
    const results = h(
      'div',
      { class: 'results', part: 'results', role: 'listbox' },
      bodyEl,
      h('div', { class: 'drop' }, 'Drop files to add')
    );

    const triggerIcon = h(
      'span',
      { class: 'ti' },
      iconEl('plus', { size: TRIGGER_ICON_SIZE })
    ) as HTMLSpanElement;
    const trigger = h(
      'button',
      {
        class: 'trigger',
        part: 'trigger',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        title: 'Add to prompt',
      },
      triggerIcon
    ) as HTMLButtonElement;

    const search = h('input', {
      type: 'text',
      placeholder: 'Search files, skills, conversations…',
    }) as HTMLInputElement;
    const searchbox = h(
      'div',
      { class: 'searchbox' },
      h('span', { class: 'si' }, iconEl('search', { size: SEARCH_ICON_SIZE })),
      search
    );

    const wrap = h(
      'div',
      { class: 'wrap', part: 'wrap' },
      results,
      h('div', { class: 'row' }, trigger, searchbox)
    ) as HTMLDivElement;

    this.#root.replaceChildren(fileInput, wrap);

    this.#trigger = trigger;
    this.#triggerIcon = triggerIcon;
    this.#wrap = wrap;
    this.#search = search;
    this.#bodyEl = bodyEl;
    this.#file = fileInput;
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
        this.#emit({ kind: 'upload', name: f.name, size: f.size, file: f });
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
          this.#emit({ kind: 'upload', name: f.name, size: f.size, file: f });
        this.close();
      }
    });
  }

  // ----- Open / close -------------------------------------------------------

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /** Swap the trigger glyph to the lucide `plus` (closed) or `x` (open). */
  #setTriggerGlyph(open: boolean): void {
    this.#triggerIcon.replaceChildren(iconEl(open ? 'x' : 'plus', { size: TRIGGER_ICON_SIZE }));
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.setAttribute('data-open', '');
    this.#trigger.setAttribute('aria-expanded', 'true');
    this.#setTriggerGlyph(true);
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
    this.#setTriggerGlyph(false);
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
    const nodes: HTMLElement[] = [];
    let prevQuick = false;

    for (const it of list) {
      if (it.type === 'sec') {
        if (prevQuick) nodes.push(h('div', { class: 'sep' }));
        nodes.push(h('div', { class: 'sec' }, it.label));
        prevQuick = false;
      } else if (it.type === 'quick') {
        const i = this.#items.length;
        this.#items.push(
          it.data.kind === 'upload'
            ? { kind: 'upload', name: '', size: 0 }
            : { kind: 'capture', mode: it.data.mode ?? 'photo', label: it.data.label }
        );
        const tx = h('span', { class: 'tx' }, h('div', { class: 'lb' }, it.data.label));
        if (it.data.sub) tx.append(h('div', { class: 'sb' }, it.data.sub));
        nodes.push(
          h(
            'div',
            { class: 'item quick', 'data-i': i },
            h('span', { class: 'ic' }, iconEl(it.data.icon, { size: ROW_ICON_SIZE })),
            tx
          )
        );
        prevQuick = true;
      } else {
        const i = this.#items.length;
        this.#items.push({ kind: it.section.kind, id: it.data.id, label: it.data.label });
        nodes.push(
          h(
            'div',
            { class: 'item', 'data-i': i },
            h('span', { class: 'ic' }, iconEl(it.section.icon, { size: ROW_ICON_SIZE })),
            h(
              'span',
              { class: 'tx' },
              h('div', { class: 'lb' }, it.data.label),
              h('div', { class: 'sb' }, it.data.sub ?? '')
            )
          )
        );
      }
    }

    if (nodes.length) {
      this.#bodyEl.replaceChildren(...nodes);
    } else {
      // Empty state — the prototype framed the query in typographic quotes (“ ”).
      this.#bodyEl.replaceChildren(
        h('div', { class: 'empty' }, `No matches for “${this.#query}”.`)
      );
    }

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
