import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/** Which side of the trigger the tip sits on. */
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

const PLACEMENTS = new Set<TooltipPlacement>(['top', 'bottom', 'left', 'right']);

const STYLE = `
:host { position: relative; display: inline-flex; }
:host([hidden]) { display: none; }
.tip {
  position: absolute; z-index: 60;
  background: var(--ink); color: var(--canvas, #fff);
  font: 500 11px var(--ui, ui-sans-serif, system-ui, sans-serif);
  white-space: nowrap; padding: 3px 8px; border-radius: 6px;
  box-shadow: 0 4px 12px -4px rgba(10,10,10,.3);
  opacity: 0; pointer-events: none;
  transition: opacity .12s ease, transform .12s ease;
}
/* placement: the tip is centered on the cross axis and offset on the main axis,
   with a small slide-in from the trigger that settles on reveal. */
.tip[data-p="top"]    { bottom: calc(100% + 6px); left: 50%; transform: translate(-50%, 3px); }
.tip[data-p="bottom"] { top: calc(100% + 6px);    left: 50%; transform: translate(-50%, -3px); }
.tip[data-p="left"]   { right: calc(100% + 6px);   top: 50%; transform: translate(3px, -50%); }
.tip[data-p="right"]  { left: calc(100% + 6px);    top: 50%; transform: translate(-3px, -50%); }
:host(:hover) .tip, :host(:focus-within) .tip, :host([open]) .tip { opacity: 1; }
:host(:hover) .tip[data-p="top"],    :host(:focus-within) .tip[data-p="top"],    :host([open]) .tip[data-p="top"]    { transform: translate(-50%, 0); }
:host(:hover) .tip[data-p="bottom"], :host(:focus-within) .tip[data-p="bottom"], :host([open]) .tip[data-p="bottom"] { transform: translate(-50%, 0); }
:host(:hover) .tip[data-p="left"],   :host(:focus-within) .tip[data-p="left"],   :host([open]) .tip[data-p="left"]   { transform: translate(0, -50%); }
:host(:hover) .tip[data-p="right"],  :host(:focus-within) .tip[data-p="right"],  :host([open]) .tip[data-p="right"]  { transform: translate(0, -50%); }
.tip:empty { display: none; }
@media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-tooltip>` — a tiny hover/focus label for icon-only controls. Wrap any
 * trigger (the default slot) and give it a `label`; the dark pill appears on
 * hover or keyboard focus, on the chosen `placement` side. It is the shared
 * hover-label for every collapsed, icon-only surface — the scoop switcher's
 * compact pills, the freezer rail, the dock/sprinkle rail — so a glyph that
 * dropped its text still says what it is.
 *
 * Pure CSS reveal (no JS timers): `:host(:hover) / :host(:focus-within)`, plus an
 * `open` attribute to force it on (demos / tests). Self-contained shadow DOM,
 * themed via inherited tokens (`--ink`, `--canvas`, `--ui`); an empty label
 * renders nothing.
 *
 * @attr label - the tip text (empty → no tip shown)
 * @attr placement - `top` (default) | `bottom` | `left` | `right`
 * @attr open - boolean; force the tip visible regardless of hover/focus
 * @csspart tip - the floating label pill
 * @slot - the trigger the tip describes
 */
export class SliccTooltip extends HTMLElement {
  static readonly observedAttributes = ['label', 'placement'];

  readonly #root: ShadowRoot;
  #tip!: HTMLElement;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    this.#tip = h('span', { class: 'tip', part: 'tip', role: 'tooltip', 'aria-hidden': 'true' });
    this.#root.replaceChildren(h('slot'), this.#tip);
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    this.#render();
  }

  /** The tip text. */
  get label(): string {
    return this.getAttribute('label') ?? '';
  }
  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Which side of the trigger the tip sits on (default `top`). */
  get placement(): TooltipPlacement {
    const p = this.getAttribute('placement') as TooltipPlacement | null;
    return p && PLACEMENTS.has(p) ? p : 'top';
  }
  set placement(value: TooltipPlacement) {
    this.setAttribute('placement', value);
  }

  #render(): void {
    this.#tip.textContent = this.label;
    this.#tip.setAttribute('data-p', this.placement);
  }
}

define('slicc-tooltip', SliccTooltip);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tooltip': SliccTooltip;
  }
}
