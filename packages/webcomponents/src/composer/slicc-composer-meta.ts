import { define } from '../internal/define.js';
import { append, h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Thinking-effort levels, in cycle order, lifted verbatim from the prototype's
 * "gelateria sizing" (`levels=['bambino','piccolo','grande','bombastica']`).
 * The selector cycles forward through these on each click.
 */
export const THINKING_LEVELS = ['bambino', 'piccolo', 'grande', 'bombastica'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The non-default effort that paints the thinking pill's violet border (the
 * prototype toggles `.x` on when the label is `bombastica`). Anything else is
 * the plain (default) border.
 */
const ACCENTED_LEVEL: ThinkingLevel = 'bombastica';

/** The default model label shown in the model pill when no `model` is set. */
const DEFAULT_MODEL = 'Opus 4.8';

/** Default model options offered in the dropdown when `models` is not supplied. */
const DEFAULT_MODELS: readonly string[] = ['Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5'];

/** The default thinking level (prototype starts at index 3 = `bombastica`). */
const DEFAULT_THINKING: ThinkingLevel = 'bombastica';

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
  .ctl.tsel.x{border-color:color-mix(in srgb,var(--violet) 35%,var(--line));}
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
  .mitem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;
    background:transparent;color:var(--ink);font:inherit;font-size:12.5px;border-radius:7px;
    cursor:pointer;text-align:left;white-space:nowrap;}
  .mitem:hover,.mitem:focus-visible{background:var(--ghost);outline:none;}
  .mitem .tick{margin-left:auto;display:inline-flex;color:var(--violet);visibility:hidden;}
  .mitem[aria-selected="true"] .tick{visibility:visible;}
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
 * Clicking the model pill emits a composed `model-change`; clicking the
 * thinking pill cycles forward through the gelateria effort levels
 * (`bambino → piccolo → grande → bombastica → …`), swaps the label, toggles the
 * violet border for the accented (`bombastica`) level, and emits a composed
 * `thinking-change`. Set `narrow` to hide the hint for a tight chat column
 * (the prototype's `.shell.open .meta .hint{display:none}`).
 *
 * Self-contained shadow DOM; themes via inherited tokens (no token is
 * re-declared here).
 *
 * @attr model - model label shown in the model pill (default "Opus 4.8")
 * @attr thinking - thinking effort level; one of `bambino|piccolo|grande|bombastica` (default `bombastica`)
 * @attr narrow - boolean; hides the keyboard hint for a narrow chat column
 * @fires model-change - `{detail:{model}}` when the model pill is clicked
 * @fires thinking-change - `{detail:{thinking,accented}}` when the thinking pill cycles
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
  #models: string[] | null = null;
  #menuOpen = false;

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
   * The model options offered in the dropdown. Defaults to a built-in list
   * (Opus / Sonnet / Haiku) when not set. Assigning replaces the list and, if the
   * menu is open, re-renders it.
   */
  get models(): string[] {
    return (this.#models ?? [...DEFAULT_MODELS]).slice();
  }

  set models(value: string[]) {
    this.#models = Array.isArray(value) ? value.slice() : null;
    if (this.isConnected) this.#render();
  }

  /**
   * Thinking effort level. Only the four gelateria levels are accepted; any
   * other value normalizes to the default (`bombastica`).
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
    const accented = thinking === ACCENTED_LEVEL;

    const modelBtn = h(
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
    for (const m of this.models) {
      const selected = m === model;
      const item = h(
        'button',
        {
          type: 'button',
          class: 'mitem',
          role: 'menuitemradio',
          'data-model': m,
          'aria-selected': selected ? 'true' : 'false',
        },
        m,
        h('span', { class: 'tick' }, iconEl('check', { size: 14 }))
      );
      menu.append(item);
    }
    const mwrap = h('div', { class: 'mwrap' }, modelBtn, menu);

    const thinkingBtn = h(
      'button',
      { type: 'button', class: `ctl tsel${accented ? ' x' : ''}`, part: 'thinking' },
      brainIcon(),
      ' ',
      h('span', { class: 'tlabel' }, thinking),
      ' ',
      h('span', { class: 'cx' }, caretIcon())
    );

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
    // A re-render (e.g. an attribute change) preserves the open menu state.
    this.#reflectMenu();
    this.#bind();
  }

  #bind(): void {
    if (this.#modelEl) {
      // The model pill opens (toggles) the dropdown; selecting a row commits.
      this.#onModelClick = (e: Event) => {
        e.stopPropagation();
        this.#toggleMenu();
      };
      this.#modelEl.addEventListener('click', this.#onModelClick);
    }
    for (const item of this.#root.querySelectorAll<HTMLButtonElement>('.mitem')) {
      item.addEventListener('click', () => this.#selectModel(item.dataset.model ?? this.model));
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
    this.#reflectMenu();
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

  /** Commit a model choice: set `model`, close the menu, and emit `model-change`. */
  #selectModel(model: string): void {
    this.#closeMenu();
    if (model !== this.model) this.model = model; // re-renders via attributeChangedCallback
    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { model },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Advance to the next gelateria effort level (wrapping), swap the label,
   * toggle the violet border, and emit `thinking-change`.
   */
  #cycleThinking(): void {
    const idx = THINKING_LEVELS.indexOf(this.thinking);
    const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
    this.thinking = next; // re-renders via attributeChangedCallback
    this.dispatchEvent(
      new CustomEvent('thinking-change', {
        detail: { thinking: next, accented: next === ACCENTED_LEVEL },
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
