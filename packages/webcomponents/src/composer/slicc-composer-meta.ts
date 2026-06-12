import { define } from '../internal/define.js';
import { append, h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Thinking-effort levels, in cycle order. The prototype's gelateria sizing
 * (`bambino → piccolo → grande → bombastica`) is replaced by a six-stop
 * "wetness" scale (`Secco → Sprofondato`): bone-dry up to sunk-to-the-bottom.
 * The selector cycles forward through these on each click.
 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Per-level metadata: the Italian "wetness" `label`, a `gloss` (shown as the
 * pill's `title` tooltip), and the brain-glyph `tint`. The tint scales the
 * violet token from bone-dry (muted `--txt-3` at `off`) toward full `--violet`
 * (at `max`) so the brain icon's colour tracks the thinking intensity.
 */
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

/**
 * The effort that paints the thinking pill's violet border. The deepest level
 * (`max` / `Sprofondato`) gets the accented border; everything else is plain.
 */
const ACCENTED_LEVEL: ThinkingLevel = 'max';

/** The default model label shown in the model pill when no `model` is set. */
const DEFAULT_MODEL = 'Opus 4.8';

/**
 * A model option in the dropdown. A bare string is shorthand for `{ name }`;
 * the object form adds the provider label (shown as the row's secondary line,
 * mirroring the webapp's `chat__model-btn-provider`) and a stable `id`.
 */
export interface ModelOption {
  /** Model display name — the pill label + the row's primary text. */
  name: string;
  /** Provider label, e.g. "Anthropic" / "OpenAI" — the row's secondary line. */
  provider?: string;
  /** Stable model id, forwarded on `model-change` (defaults to `name`). */
  id?: string;
}

/** Default model options offered in the dropdown when `models` is not supplied. */
const DEFAULT_MODELS: readonly ModelOption[] = [
  { name: 'Opus 4.8', provider: 'Anthropic', id: 'claude-opus-4-8' },
  { name: 'Sonnet 4.6', provider: 'Anthropic', id: 'claude-sonnet-4-6' },
  { name: 'Haiku 4.5', provider: 'Anthropic', id: 'claude-haiku-4-5' },
];

/** Show the type-ahead search box once the option list grows past this many rows. */
const SEARCH_THRESHOLD = 8;

/** Normalize a string|ModelOption into a full ModelOption (id falls back to name). */
function normalizeModel(
  m: string | ModelOption
): Required<Pick<ModelOption, 'name' | 'id'>> & ModelOption {
  const o = typeof m === 'string' ? { name: m } : m;
  return { ...o, name: o.name, id: o.id ?? o.name };
}

/** The default thinking level (deepest — `max` / `Sprofondato`). */
const DEFAULT_THINKING: ThinkingLevel = 'max';

/** Rendered glyph size (px) for the model/thinking pill lucide icons. */
const PILL_ICON_SIZE = 13;

/**
 * The model-pill glyph — lucide `sparkles`, rendered via the shared `iconEl`
 * helper (NEVER the ✦ emoji glyph the prototype used) as a live `<svg>` element.
 * It carries the `.ic` class so the `stroke:url(#meta-rainbow)` rule paints it
 * with the rainbow gradient, and the `model-icon` ::part hook. A factory because
 * a live element can live in only one place — re-renders need a fresh node.
 */
function sparklesIcon(): SVGSVGElement {
  return iconEl('sparkles', { size: PILL_ICON_SIZE, class: 'ic', part: 'model-icon' });
}

/**
 * The thinking-pill glyph — lucide `brain`, rendered via the shared `iconEl`
 * helper (NEVER a hand-rolled inline `<svg>`) as a live `<svg>` element. It
 * carries the `.brain` class so the violet tint applies, and the `brain` ::part
 * hook is preserved.
 */
function brainIcon(): SVGSVGElement {
  return iconEl('brain', { size: PILL_ICON_SIZE, class: 'brain', part: 'brain' });
}

/**
 * The dropdown caret inside both pills — lucide `chevron-down` (NEVER the ▾
 * unicode glyph the prototype used). Rendered at the `.cx` muted size. A factory
 * because a live element can live in only one place — both pills need their own.
 */
function caretIcon(): SVGSVGElement {
  return iconEl('chevron-down', { size: 11, part: 'caret' });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A hidden `<svg>` carrying the rainbow `<linearGradient>` referenced by the
 * sparkles icon's `stroke:url(#meta-rainbow)`. The stops mirror the prototype's
 * `--rainbow` token (rose → amber → cyan → violet) so the model-pill glyph keeps
 * its signature rainbow stroke now that it is a real lucide `<svg>`, not the
 * gradient-clipped ✦ text the prototype shipped. Built via the SVG namespace
 * (no innerHTML / string parsing).
 */
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

/**
 * Shared constructable stylesheet, lifted faithfully from the prototype `.meta` /
 * `.ctl` / `.brain` / `.hint` rules. All colors/spacing/fonts reference the
 * inherited design tokens (`--canvas`, `--line`, `--ink`, `--txt-2/3`,
 * `--violet`, `--rainbow`, `--ui`, `--ctl-h`) — none are re-declared here.
 */
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
  .mwrap{position:relative;flex:0 0 auto;display:inline-flex;}
  .ctl .cx svg{transition:transform .15s ease;}
  .mwrap.open .ctl .cx svg{transform:rotate(180deg);}
  .menu{position:absolute;bottom:calc(100% + 6px);left:0;min-width:170px;
    background:var(--canvas);border:1px solid var(--line);border-radius:10px;
    box-shadow:0 -10px 28px -10px rgba(10,10,10,.22),0 -2px 8px -4px rgba(10,10,10,.12);
    padding:5px;opacity:0;transform:translateY(4px);pointer-events:none;
    transition:opacity .12s ease,transform .12s ease;z-index:20;}
  .mwrap.open .menu{opacity:1;transform:none;pointer-events:auto;}
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

/**
 * `<slicc-composer-meta>` — the "Steep-style" meta row that sits below the
 * composer input card in the prototype (`.meta`). It carries a model-select
 * pill (`.ctl.msel` — a lucide `sparkles` icon with a rainbow stroke + label +
 * a lucide `chevron-down` caret), a thinking-effort pill (`.ctl.tsel` — a lucide
 * `brain` glyph + level label + caret), a flex spacer (`.mspacer`), and a
 * keyboard hint (`.hint` — `⏎` send / `⇧⏎` newline / "review before shipping").
 * The row is centered with a 680px max width. Every pill glyph is a real lucide
 * `<svg>` rendered through the shared `iconEl` helper — never an emoji or a
 * bespoke unicode-symbol glyph.
 *
 * Clicking the model pill opens a dropdown (popping UP, since the row sits at the
 * composer's bottom edge) of `models` — each row a model name + provider label
 * (mirroring the webapp), with the current one ticked; a list longer than eight
 * grows a type-ahead search (filter by name + provider, like the add-menu).
 * Choosing a row sets `model` and emits a composed `model-change`
 * (`{ model, provider, id }`). Clicking the thinking pill cycles forward through
 * the wetness effort levels (`off → low → medium → high → xhigh → max → …`,
 * labelled `Secco → Goccia → Bagnato → Affogato → Inzuppato → Sprofondato`),
 * swaps the label, and ramps the WHOLE pill — text, border, caret and a
 * background wash — to track the intensity (a muted grey `--txt-3` at `Secco` up
 * to full `--violet` at `Sprofondato`), emitting a composed `thinking-change`.
 * The accented (`max`) level adds a heavier border/wash. Set `narrow` to hide the
 * hint for a tight chat column
 * (the prototype's `.shell.open .meta .hint{display:none}`).
 *
 * Self-contained shadow DOM; themes via inherited tokens (no token is
 * re-declared here).
 *
 * @attr model - model label shown in the model pill (default "Opus 4.8")
 * @attr thinking - thinking effort level; one of `off|low|medium|high|xhigh|max` (default `max`)
 * @attr narrow - boolean; hides the keyboard hint for a narrow chat column
 * @prop {Array<string|ModelOption>} models - the dropdown options (name + provider + id)
 * @fires model-change - `{detail:{model,provider,id}}` when a model row is chosen
 * @fires add-ai - composed + bubbling; the pill was clicked while `models` is an
 *   EXPLICIT empty list (no accounts) — the host opens its account settings.
 *   The pill reads "Add AI" in that state instead of offering phantom models.
 * @csspart model-menu - the model dropdown panel
 * @csspart model-search - the type-ahead search input (shown for long lists)
 * @fires thinking-change - `{detail:{thinking,label,accented}}` when the thinking pill cycles
 * @csspart meta - the row container
 * @csspart model - the model-select pill button
 * @csspart thinking - the thinking-effort pill button
 * @csspart model-icon - the lucide `sparkles` glyph inside the model pill
 * @csspart brain - the lucide `brain` glyph inside the thinking pill
 * @csspart caret - the lucide `chevron-down` caret inside each pill
 * @csspart hint - the keyboard-hint span
 * @slot hint - overrides the default keyboard-hint content
 */
export class SliccComposerMeta extends HTMLElement {
  static readonly observedAttributes = ['model', 'thinking', 'narrow'];

  readonly #root: ShadowRoot;
  #onModelClick: ((e: Event) => void) | null = null;
  #onThinkingClick: (() => void) | null = null;
  #modelEl: HTMLButtonElement | null = null;
  #thinkingEl: HTMLButtonElement | null = null;
  #mwrapEl: HTMLElement | null = null;
  #listEl: HTMLElement | null = null;
  #models: (string | ModelOption)[] | null = null;
  #menuOpen = false;
  #query = '';

  #onDocDown = (e: MouseEvent): void => {
    if (this.#menuOpen && !e.composedPath().includes(this)) this.#closeMenu();
  };
  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.#menuOpen) {
      e.stopPropagation();
      this.#closeMenu();
      this.#modelEl?.focus();
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

  /** Model label shown in the model pill (falls back to "Opus 4.8"). */
  get model(): string {
    return this.getAttribute('model') ?? DEFAULT_MODEL;
  }

  set model(value: string | null) {
    if (value == null) this.removeAttribute('model');
    else this.setAttribute('model', value);
  }

  /**
   * The model options offered in the dropdown — bare names or `{ name, provider,
   * id }` objects. Defaults to a built-in Anthropic list when not set. Assigning
   * replaces the list and re-renders. A list longer than {@link SEARCH_THRESHOLD}
   * grows a type-ahead search box (filtering by model name + provider).
   */
  get models(): (string | ModelOption)[] {
    return (this.#models ?? [...DEFAULT_MODELS]).map((m) => (typeof m === 'string' ? m : { ...m }));
  }

  set models(value: (string | ModelOption)[]) {
    this.#models = Array.isArray(value) ? value.slice() : null;
    if (this.isConnected) this.#render();
  }

  /** The normalized, fully-resolved model options (id always present). */
  get #normModels(): ReturnType<typeof normalizeModel>[] {
    return (this.#models ?? DEFAULT_MODELS).map(normalizeModel);
  }

  /**
   * An EXPLICITLY empty model list means "no accounts connected" — the host
   * assigned `[]`. (`null` — never assigned — keeps the showcase defaults.)
   */
  get #noModels(): boolean {
    return this.#models !== null && this.#models.length === 0;
  }

  /**
   * Thinking effort level. Only the six wetness levels are accepted; any
   * other value normalizes to the default (`max` / `Sprofondato`).
   */
  get thinking(): ThinkingLevel {
    const t = this.getAttribute('thinking');
    return (THINKING_LEVELS as readonly string[]).includes(t ?? '')
      ? (t as ThinkingLevel)
      : DEFAULT_THINKING;
  }

  set thinking(value: ThinkingLevel) {
    this.setAttribute('thinking', value);
  }

  /** Whether the keyboard hint is hidden (narrow chat column). */
  get narrow(): boolean {
    return this.hasAttribute('narrow');
  }

  set narrow(value: boolean) {
    this.toggleAttribute('narrow', value);
  }

  /** Whether the current effort paints the violet (non-default) border. */
  get accented(): boolean {
    return this.thinking === ACCENTED_LEVEL;
  }

  #render(): void {
    this.#unbind();

    const model = this.model;
    const thinking = this.thinking;
    const levelMeta = THINKING_META[thinking];
    const accented = thinking === ACCENTED_LEVEL;

    // With no connected accounts the pill is an "Add AI" call-to-action, not
    // a picker — no caret, no menu, click emits `add-ai`.
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
    // A long option list grows a type-ahead search box (mirrors the composer
    // add-menu's filter), filtering rows by model name + provider as you type.
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
      // Don't let a click inside the field bubble to the pill's toggle handler.
      search.addEventListener('click', (e) => e.stopPropagation());
      menu.append(search);
    }
    this.#listEl = h('div', { class: 'mlist', role: 'none' });
    menu.append(this.#listEl);
    const mwrap = h('div', { class: 'mwrap' }, modelBtn, menu);

    const brain = brainIcon();
    // The brain tint tracks the thinking intensity (dry → violet), overriding
    // the `.brain` rule's fallback colour with the per-level token blend.
    brain.style.color = levelMeta.tint;
    const thinkingBtn = h(
      'button',
      {
        type: 'button',
        class: `ctl tsel${accented ? ' x' : ''}`,
        part: 'thinking',
        title: levelMeta.gloss,
      },
      brain,
      ' ',
      h('span', { class: 'tlabel' }, levelMeta.label),
      ' ',
      h('span', { class: 'cx' }, caretIcon())
    );
    // The whole pill ramps with intensity: feed the per-level accent to the
    // `--tw`-driven text/border/background-wash rules above.
    thinkingBtn.style.setProperty('--tw', levelMeta.tint);

    const hintSlot = h('slot', { name: 'hint' });
    append(hintSlot, [
      h('span', { class: 'kbd' }, '⏎'),
      ' send ',
      h('span', { class: 'sep' }),
      ' ',
      h('span', { class: 'kbd' }, '⇧⏎'),
      ' newline ',
      h('span', { class: 'sep' }),
      ' review before shipping',
    ]);

    const meta = h(
      'div',
      { class: 'meta', part: 'meta' },
      mwrap,
      thinkingBtn,
      h('div', { class: 'mspacer' }),
      h('span', { class: 'hint', part: 'hint' }, hintSlot)
    );

    this.#root.replaceChildren(rainbowDefs(), meta);

    this.#mwrapEl = mwrap;
    this.#modelEl = this.#root.querySelector('.msel');
    this.#thinkingEl = this.#root.querySelector('.tsel');
    this.#renderModelList();
    // A re-render (e.g. an attribute change) preserves the open menu state.
    this.#reflectMenu();
    this.#bind();
  }

  /** (Re)build the filtered option rows into `.mlist` (keeps the search field's
   *  focus intact — only the list is rebuilt, not the input). */
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
      const selected = m.name === current;
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
      // The model pill opens (toggles) the dropdown; selecting a row commits.
      // With no models there is nothing to pick — the click asks the host to
      // open its account settings instead.
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
      this.#onThinkingClick = () => this.#cycleThinking();
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
    this.#listEl = null;
  }

  /** Whether the model dropdown is open. */
  get menuOpen(): boolean {
    return this.#menuOpen;
  }

  #toggleMenu(): void {
    this.#menuOpen ? this.#closeMenu() : this.#openMenu();
  }

  #openMenu(): void {
    if (this.#menuOpen) return;
    this.#menuOpen = true;
    // Start each open with a cleared filter, then focus the search box (if shown).
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
    document.removeEventListener('mousedown', this.#onDocDown);
    document.removeEventListener('keydown', this.#onKey, true);
  }

  /** Mirror `#menuOpen` onto the DOM (the open class + the pill's aria-expanded). */
  #reflectMenu(): void {
    this.#mwrapEl?.classList.toggle('open', this.#menuOpen);
    this.#modelEl?.setAttribute('aria-expanded', this.#menuOpen ? 'true' : 'false');
  }

  /** Commit a model choice (by id): set `model` to its name, close the menu, and
   *  emit `model-change` with `{ model, provider, id }`. */
  #selectModel(id: string): void {
    const picked = this.#normModels.find((m) => m.id === id) ?? {
      name: id,
      id,
      provider: undefined,
    };
    this.#closeMenu();
    if (picked.name !== this.model) this.model = picked.name; // re-renders via attributeChangedCallback
    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { model: picked.name, provider: picked.provider, id: picked.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Advance to the next wetness effort level (wrapping), swap the label, retint
   * the brain glyph, toggle the violet border, and emit `thinking-change`.
   */
  #cycleThinking(): void {
    const idx = THINKING_LEVELS.indexOf(this.thinking);
    const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
    this.thinking = next; // re-renders via attributeChangedCallback
    this.dispatchEvent(
      new CustomEvent('thinking-change', {
        detail: {
          thinking: next,
          label: THINKING_META[next].label,
          accented: next === ACCENTED_LEVEL,
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
