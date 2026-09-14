import { define } from '../internal/define.js';
import { append, h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ThinkingMeta {
  readonly label: string;
  readonly gloss: string;
  readonly tint: string;
}

export const THINKING_META: Readonly<Record<ThinkingLevel, ThinkingMeta>> = {
  off: {
    label: 'Secco',
    gloss: 'bone dry — not a drop (ask any prosecco)',
    tint: 'var(--txt-3)',
  },
  low: {
    label: 'Goccia',
    gloss: 'one drop — bar-speak: «macchiato, solo una goccia»',
    tint: 'color-mix(in srgb, var(--violet) 20%, var(--txt-3))',
  },
  medium: {
    label: 'Bagnato',
    gloss: 'properly wet',
    tint: 'color-mix(in srgb, var(--violet) 40%, var(--txt-3))',
  },
  high: {
    label: 'Affogato',
    gloss: 'drowned — the menu item itself',
    tint: 'color-mix(in srgb, var(--violet) 60%, var(--txt-3))',
  },
  xhigh: {
    label: 'Inzuppato',
    gloss: 'soaked through, biscotto-style',
    tint: 'color-mix(in srgb, var(--violet) 80%, var(--txt-3))',
  },
  max: {
    label: 'Sprofondato',
    gloss: 'sunk to the bottom',
    tint: 'var(--violet)',
  },
};

const ACCENTED_LEVEL: ThinkingLevel = 'max';

const DEFAULT_MODEL = 'Opus 4.8';

export interface ModelOption {
  name: string;

  provider?: string;

  id?: string;
}

const DEFAULT_MODELS: readonly ModelOption[] = [
  { name: 'Opus 4.8', provider: 'Anthropic', id: 'claude-opus-4-8' },
  { name: 'Sonnet 4.6', provider: 'Anthropic', id: 'claude-sonnet-4-6' },
  { name: 'Haiku 4.5', provider: 'Anthropic', id: 'claude-haiku-4-5' },
];

const SEARCH_THRESHOLD = 8;

function normalizeModel(
  m: string | ModelOption
): Required<Pick<ModelOption, 'name' | 'id'>> & ModelOption {
  const o = typeof m === 'string' ? { name: m } : m;
  return { ...o, name: o.name, id: o.id ?? o.name };
}

const DEFAULT_THINKING: ThinkingLevel = 'max';

const PILL_ICON_SIZE = 13;

function sparklesIcon(): SVGSVGElement {
  return iconEl('sparkles', { size: PILL_ICON_SIZE, class: 'ic', part: 'model-icon' });
}

function brainIcon(): SVGSVGElement {
  return iconEl('brain', { size: PILL_ICON_SIZE, class: 'brain', part: 'brain' });
}

function caretIcon(): SVGSVGElement {
  return iconEl('chevron-down', { size: 11, part: 'caret' });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function rainbowDefs(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', 'meta-rainbow');
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1');
  grad.setAttribute('y2', '0');

  const stops: ReadonlyArray<[string, string]> = [
    ['0%', '#f43f5e'],
    ['28%', '#f59e0b'],
    ['64%', '#06b6d4'],
    ['100%', '#8b5cf6'],
  ];
  for (const [offset, color] of stops) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  return svg;
}

const STYLE = `
  :host{display:block;}
  *{box-sizing:border-box;}
  .meta{display:flex;align-items:center;gap:8px;max-width:680px;margin:11px auto 0;font-family:var(--ui);}
  .ctl{height:var(--ctl-h,30px);border:1px solid var(--line);border-radius:8px;background:var(--canvas);color:var(--ink);font:inherit;font-size:12.5px;font-weight:500;padding:0 9px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;flex:0 0 auto;}
  .ctl:hover{background:var(--ghost);}
  .ctl .ic{display:block;vertical-align:-2px;flex:0 0 auto;stroke:url(#meta-rainbow);}
  .ctl .cx{color:var(--txt-3);font-size:10px;display:inline-flex;align-items:center;}
  .ctl .cx svg{display:block;}
  /* The thinking pill ramps as a whole with the effort intensity: its text,
     border, caret and a background wash are all derived from the per-level
     accent (--tw, set inline) — from a muted grey (Secco) up to full violet
     (Sprofondato). */
  .ctl.tsel{color:var(--tw,var(--ink));
    border-color:color-mix(in srgb,var(--tw,var(--line)) 40%,var(--line));
    background:color-mix(in srgb,var(--tw,transparent) 8%,var(--canvas));}
  .ctl.tsel:hover{background:color-mix(in srgb,var(--tw,transparent) 16%,var(--canvas));}
  .ctl.tsel .cx{color:inherit;opacity:.7;}
  .ctl.tsel.x{border-color:color-mix(in srgb,var(--tw) 55%,var(--line));
    background:color-mix(in srgb,var(--tw) 14%,var(--canvas));}
  .ctl.tsel.x:hover{background:color-mix(in srgb,var(--tw) 20%,var(--canvas));}
  .brain{color:var(--violet);display:block;vertical-align:-2px;flex:0 0 auto;}
  /* Model dropdown — anchored to the model pill and opening UPWARD (the meta row
     sits at the very bottom of the composer, so a downward menu would clip). */
  .mwrap,.twrap{position:relative;flex:0 0 auto;display:inline-flex;}
  .ctl .cx svg{transition:transform .15s ease;}
  .mwrap.open .ctl .cx svg,.twrap.open .ctl .cx svg{transform:rotate(180deg);}
  .menu{position:absolute;bottom:calc(100% + 6px);left:0;min-width:170px;
    background:var(--canvas);border:1px solid var(--line);border-radius:10px;
    box-shadow:0 -10px 28px -10px rgba(10,10,10,.22),0 -2px 8px -4px rgba(10,10,10,.12);
    padding:5px;opacity:0;transform:translateY(4px);pointer-events:none;
    transition:opacity .12s ease,transform .12s ease;z-index:20;}
  .mwrap.open .menu,.twrap.open .menu{opacity:1;transform:none;pointer-events:auto;}
  /* type-ahead search (shown when the list is long) */
  .msearch{width:100%;box-sizing:border-box;margin:0 0 5px;padding:6px 9px;border:1px solid var(--line);
    border-radius:7px;background:var(--ghost);color:var(--ink);font:inherit;font-size:12.5px;outline:none;}
  .msearch:focus{border-color:var(--accent,#3b63fb);}
  .mlist{display:flex;flex-direction:column;max-height:240px;overflow-y:auto;}
  .mitem{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:none;
    background:transparent;color:var(--ink);font:inherit;font-size:12.5px;border-radius:7px;
    cursor:pointer;text-align:left;white-space:nowrap;}
  .mitem:hover,.mitem:focus-visible{background:var(--ghost);outline:none;}
  .mitem .mname{min-width:0;overflow:hidden;text-overflow:ellipsis;}
  .mitem .mprov{margin-left:6px;color:var(--txt-3);font-size:11px;}
  .mitem .tick{margin-left:auto;display:inline-flex;color:var(--violet);visibility:hidden;}
  .mitem[aria-selected="true"] .tick{visibility:visible;}
  .mempty{padding:10px;color:var(--txt-3);font-size:12px;text-align:center;}
  .titem .mname{min-width:unset;overflow:visible;text-overflow:unset;}
  @media (prefers-reduced-motion: reduce){.menu,.ctl .cx svg{transition:none;}}
  .mspacer{flex:1;}
  .hint{font-size:11px;color:var(--txt-3);display:inline-flex;align-items:center;gap:7px;}
  .hint .kbd{font-family:var(--ui);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--txt-2);}
  .hint .sep{width:3px;height:3px;border-radius:50%;background:var(--line);}
  :host([narrow]) .hint{display:none;}
  /* Narrow / extension-sidebar: the ⏎ / ⇧⏎ keyboard hints don't fit (and touch
     users have no keyboard) — drop them regardless of the narrow-chat attribute. */
  @media (max-width: 560px){ .hint{display:none;} }
`;
const SHEET = sheet(STYLE);

export class SliccComposerMeta extends HTMLElement {
  static readonly observedAttributes = ['model', 'thinking', 'narrow', 'no-thinking'];

  readonly #root: ShadowRoot;
  #onModelClick: ((e: Event) => void) | null = null;
  #onThinkingClick: (() => void) | null = null;
  #modelEl: HTMLButtonElement | null = null;
  #thinkingEl: HTMLButtonElement | null = null;
  #mwrapEl: HTMLElement | null = null;
  #twrapEl: HTMLElement | null = null;
  #listEl: HTMLElement | null = null;
  #models: (string | ModelOption)[] | null = null;

  #selectedId: string | null = null;
  #menuOpen = false;
  #thinkingMenuOpen = false;
  #query = '';

  #onDocDown = (e: MouseEvent): void => {
    const path = e.composedPath();
    if (this.#menuOpen && !path.includes(this)) this.#closeMenu();
    if (this.#thinkingMenuOpen && !path.includes(this)) this.#closeThinkingMenu();
  };
  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.#menuOpen) {
        e.stopPropagation();
        this.#closeMenu();
        this.#modelEl?.focus();
      }
      if (this.#thinkingMenuOpen) {
        e.stopPropagation();
        this.#closeThinkingMenu();
        this.#thinkingEl?.focus();
      }
    }
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbind();
    document.removeEventListener('mousedown', this.#onDocDown);
    document.removeEventListener('keydown', this.#onKey, true);
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  get model(): string {
    return this.getAttribute('model') ?? DEFAULT_MODEL;
  }

  set model(value: string | null) {
    if (value == null) this.removeAttribute('model');
    else this.setAttribute('model', value);
  }

  get selectedModelId(): string | null {
    return this.#selectedId;
  }

  set selectedModelId(value: string | null | undefined) {
    this.#selectedId = value ?? null;
  }

  get models(): (string | ModelOption)[] {
    return (this.#models ?? [...DEFAULT_MODELS]).map((m) => (typeof m === 'string' ? m : { ...m }));
  }

  set models(value: (string | ModelOption)[]) {
    this.#models = Array.isArray(value) ? value.slice() : null;
    if (this.isConnected) this.#render();
  }

  get #normModels(): ReturnType<typeof normalizeModel>[] {
    return (this.#models ?? DEFAULT_MODELS).map(normalizeModel);
  }

  get #noModels(): boolean {
    return this.#models !== null && this.#models.length === 0;
  }

  get thinking(): ThinkingLevel {
    const t = this.getAttribute('thinking');
    return (THINKING_LEVELS as readonly string[]).includes(t ?? '')
      ? (t as ThinkingLevel)
      : DEFAULT_THINKING;
  }

  set thinking(value: ThinkingLevel) {
    this.setAttribute('thinking', value);
  }

  get narrow(): boolean {
    return this.hasAttribute('narrow');
  }

  set narrow(value: boolean) {
    this.toggleAttribute('narrow', value);
  }

  get noThinking(): boolean {
    return this.hasAttribute('no-thinking');
  }

  set noThinking(value: boolean) {
    this.toggleAttribute('no-thinking', value);
  }

  get accented(): boolean {
    return this.thinking === ACCENTED_LEVEL;
  }

  #render(): void {
    this.#unbind();

    const model = this.model;
    const thinking = this.thinking;
    const levelMeta = THINKING_META[thinking];
    const accented = thinking === ACCENTED_LEVEL;

    const noModels = this.#noModels;
    const modelBtn = noModels
      ? h(
          'button',
          { type: 'button', class: 'ctl msel', part: 'model' },
          sparklesIcon(),
          ' ',
          'Add AI'
        )
      : h(
          'button',
          {
            type: 'button',
            class: 'ctl msel',
            part: 'model',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
          },
          sparklesIcon(),
          ' ',
          model,
          ' ',
          h('span', { class: 'cx' }, caretIcon())
        );
    const menu = h('div', { class: 'menu', part: 'model-menu', role: 'menu' });

    if (this.#normModels.length > SEARCH_THRESHOLD) {
      const search = h('input', {
        class: 'msearch',
        part: 'model-search',
        type: 'text',
        placeholder: 'Search models…',
        'aria-label': 'Search models',
      }) as HTMLInputElement;
      search.value = this.#query;
      search.addEventListener('input', () => {
        this.#query = search.value;
        this.#renderModelList();
      });

      search.addEventListener('click', (e) => e.stopPropagation());
      menu.append(search);
    }
    this.#listEl = h('div', { class: 'mlist', role: 'none' });
    menu.append(this.#listEl);
    const mwrap = h('div', { class: 'mwrap' }, modelBtn, menu);

    const showThinking = !this.noThinking && !noModels;
    let thinkingWrap: HTMLElement | null = null;
    if (showThinking) {
      const brain = brainIcon();
      brain.style.color = levelMeta.tint;
      const thinkingBtn = h(
        'button',
        {
          type: 'button',
          class: `ctl tsel${accented ? ' x' : ''}`,
          part: 'thinking',
          title: levelMeta.gloss,
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
        },
        brain,
        ' ',
        h('span', { class: 'tlabel' }, levelMeta.label),
        ' ',
        h('span', { class: 'cx' }, caretIcon())
      );
      thinkingBtn.style.setProperty('--tw', levelMeta.tint);

      const tmenu = h('div', { class: 'menu tmenu', part: 'thinking-menu', role: 'menu' });
      const tlist = h('div', { class: 'mlist', role: 'none' });
      for (const level of THINKING_LEVELS) {
        const meta = THINKING_META[level];
        const selected = level === thinking;
        const row = h(
          'button',
          {
            type: 'button',
            class: 'mitem titem',
            role: 'menuitemradio',
            'data-level': level,
            'aria-selected': selected ? 'true' : 'false',
            title: meta.gloss,
          },
          h('span', { class: 'mname' }, meta.label),
          h('span', { class: 'tick' }, iconEl('check', { size: 14 }))
        );
        row.addEventListener('click', () => this.#selectThinking(level));
        tlist.append(row);
      }
      tmenu.append(tlist);
      thinkingWrap = h('div', { class: 'twrap' }, thinkingBtn, tmenu);
    }

    const hintSlot = h('slot', { name: 'hint' });
    append(hintSlot, [
      h('span', { class: 'kbd' }, '⏎'),
      ' send ',
      h('span', { class: 'sep' }),
      ' ',
      h('span', { class: 'kbd' }, '⇧⏎'),
      ' newline',
    ]);

    const meta = h(
      'div',
      { class: 'meta', part: 'meta' },
      mwrap,
      thinkingWrap ?? false,
      h('div', { class: 'mspacer' }),
      h('span', { class: 'hint', part: 'hint' }, hintSlot)
    );

    this.#root.replaceChildren(rainbowDefs(), meta);

    this.#mwrapEl = mwrap;
    this.#twrapEl = this.#root.querySelector('.twrap');
    this.#modelEl = this.#root.querySelector('.msel');
    this.#thinkingEl = this.#root.querySelector('.tsel');
    this.#renderModelList();

    this.#reflectMenu();
    this.#reflectThinkingMenu();
    this.#bind();
  }

  #renderModelList(): void {
    const list = this.#listEl;
    if (!list) return;
    const q = this.#query.trim().toLowerCase();
    const match = (m: ModelOption) =>
      !q || `${m.name} ${m.provider ?? ''}`.toLowerCase().includes(q);
    const rows = this.#normModels.filter(match);
    const current = this.model;
    const nodes: HTMLElement[] = [];
    for (const m of rows) {
      const selected = this.#selectedId ? m.id === this.#selectedId : m.name === current;
      const row = h(
        'button',
        {
          type: 'button',
          class: 'mitem',
          role: 'menuitemradio',
          'data-id': m.id,
          'aria-selected': selected ? 'true' : 'false',
        },
        h('span', { class: 'mname' }, m.name),
        m.provider ? h('span', { class: 'mprov' }, m.provider) : false,
        h('span', { class: 'tick' }, iconEl('check', { size: 14 }))
      );
      row.addEventListener('click', () => this.#selectModel(m.id));
      nodes.push(row);
    }
    list.replaceChildren(
      ...(nodes.length ? nodes : [h('div', { class: 'mempty' }, 'No models match.')])
    );
  }

  #bind(): void {
    if (this.#modelEl) {
      this.#onModelClick = (e: Event) => {
        e.stopPropagation();
        if (this.#noModels) {
          this.dispatchEvent(new CustomEvent('add-ai', { bubbles: true, composed: true }));
          return;
        }
        this.#toggleMenu();
      };
      this.#modelEl.addEventListener('click', this.#onModelClick);
    }
    if (this.#thinkingEl) {
      this.#onThinkingClick = () => this.#toggleThinkingMenu();
      this.#thinkingEl.addEventListener('click', this.#onThinkingClick);
    }
  }

  #unbind(): void {
    if (this.#modelEl && this.#onModelClick) {
      this.#modelEl.removeEventListener('click', this.#onModelClick);
    }
    if (this.#thinkingEl && this.#onThinkingClick) {
      this.#thinkingEl.removeEventListener('click', this.#onThinkingClick);
    }
    this.#onModelClick = null;
    this.#onThinkingClick = null;
    this.#modelEl = null;
    this.#thinkingEl = null;
    this.#mwrapEl = null;
    this.#twrapEl = null;
    this.#listEl = null;
  }

  get menuOpen(): boolean {
    return this.#menuOpen;
  }

  openMenu(): void {
    if (this.#noModels) return;
    this.#openMenu();
  }

  cycleModel(): void {
    if (this.#noModels) return;
    const models = this.#normModels;
    if (models.length === 0) return;
    let index = this.#selectedId ? models.findIndex((m) => m.id === this.#selectedId) : -1;
    if (index < 0) {
      index = models.findIndex((m) => m.name === this.model);
    }
    const next = models[(index + 1) % models.length];
    if (next) this.#selectModel(next.id);
  }

  cycleThinking(): void {
    if (this.noThinking) return;
    const index = THINKING_LEVELS.indexOf(this.thinking);
    const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
    if (next) this.#selectThinking(next);
  }

  #toggleMenu(): void {
    this.#menuOpen ? this.#closeMenu() : this.#openMenu();
  }

  #openMenu(): void {
    if (this.#menuOpen) return;
    this.#closeThinkingMenu();
    this.#menuOpen = true;

    this.#query = '';
    this.#renderModelList();
    this.#reflectMenu();
    const search = this.#root.querySelector<HTMLInputElement>('.msearch');
    if (search) {
      search.value = '';
      requestAnimationFrame(() => search.focus());
    }
    document.addEventListener('mousedown', this.#onDocDown);
    document.addEventListener('keydown', this.#onKey, true);
  }

  #closeMenu(): void {
    if (!this.#menuOpen) return;
    this.#menuOpen = false;
    this.#reflectMenu();
    if (!this.#thinkingMenuOpen) {
      document.removeEventListener('mousedown', this.#onDocDown);
      document.removeEventListener('keydown', this.#onKey, true);
    }
  }

  #reflectMenu(): void {
    this.#mwrapEl?.classList.toggle('open', this.#menuOpen);
    this.#modelEl?.setAttribute('aria-expanded', this.#menuOpen ? 'true' : 'false');
  }

  #selectModel(id: string): void {
    const picked = this.#normModels.find((m) => m.id === id) ?? {
      name: id,
      id,
      provider: undefined,
    };
    this.#selectedId = picked.id;
    this.#closeMenu();
    if (picked.name !== this.model) this.model = picked.name;
    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { model: picked.name, provider: picked.provider, id: picked.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  #toggleThinkingMenu(): void {
    this.#thinkingMenuOpen ? this.#closeThinkingMenu() : this.#openThinkingMenu();
  }

  #openThinkingMenu(): void {
    if (this.#thinkingMenuOpen) return;
    this.#closeMenu();
    this.#thinkingMenuOpen = true;
    this.#reflectThinkingMenu();
    document.addEventListener('mousedown', this.#onDocDown);
    document.addEventListener('keydown', this.#onKey, true);
  }

  #closeThinkingMenu(): void {
    if (!this.#thinkingMenuOpen) return;
    this.#thinkingMenuOpen = false;
    this.#reflectThinkingMenu();
    if (!this.#menuOpen) {
      document.removeEventListener('mousedown', this.#onDocDown);
      document.removeEventListener('keydown', this.#onKey, true);
    }
  }

  #reflectThinkingMenu(): void {
    this.#twrapEl?.classList.toggle('open', this.#thinkingMenuOpen);
    this.#thinkingEl?.setAttribute('aria-expanded', this.#thinkingMenuOpen ? 'true' : 'false');
  }

  #selectThinking(level: ThinkingLevel): void {
    this.#closeThinkingMenu();
    this.thinking = level;
    this.dispatchEvent(
      new CustomEvent('thinking-change', {
        detail: {
          thinking: level,
          label: THINKING_META[level].label,
          accented: level === ACCENTED_LEVEL,
        },
        bubbles: true,
        composed: true,
      })
    );
  }
}

define('slicc-composer-meta', SliccComposerMeta);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer-meta': SliccComposerMeta;
  }
}
