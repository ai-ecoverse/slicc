import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

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

/** The default thinking level (prototype starts at index 3 = `bombastica`). */
const DEFAULT_THINKING: ThinkingLevel = 'bombastica';

/**
 * The brain glyph from the prototype thinking pill (lucide "brain-circuit"
 * style), drawn in `currentColor` so the `.brain` rule can tint it violet.
 */
const BRAIN_SVG =
  '<svg class="brain" part="brain" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 18V5"/>' +
  '<path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/>' +
  '<path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/>' +
  '<path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/>' +
  '<path d="M18 18a4 4 0 0 0 2-7.464"/>' +
  '<path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/>' +
  '<path d="M6 18a4 4 0 0 1-2-7.464"/>' +
  '<path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>' +
  '</svg>';

/**
 * Per-instance stylesheet, lifted faithfully from the prototype `.meta` /
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
  .ctl .ic{background:var(--rainbow);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700;}
  .ctl .cx{color:var(--txt-3);font-size:10px;}
  .ctl.tsel.x{border-color:color-mix(in srgb,var(--violet) 35%,var(--line));}
  .brain{color:var(--violet);display:inline-block;vertical-align:-2px;flex:0 0 auto;}
  .mspacer{flex:1;}
  .hint{font-size:11px;color:var(--txt-3);display:inline-flex;align-items:center;gap:7px;}
  .hint .kbd{font-family:var(--ui);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--txt-2);}
  .hint .sep{width:3px;height:3px;border-radius:50%;background:var(--line);}
  :host([narrow]) .hint{display:none;}
`;

/**
 * `<slicc-composer-meta>` — the "Steep-style" meta row that sits below the
 * composer input card in the prototype (`.meta`). It carries a model-select
 * pill (`.ctl.msel` — sparkle ✦ rainbow-gradient icon + label + ▾ caret), a
 * thinking-effort pill (`.ctl.tsel` — brain glyph + level label + ▾), a flex
 * spacer (`.mspacer`), and a keyboard hint (`.hint` — `⏎` send / `⇧⏎` newline /
 * "review before shipping"). The row is centered with a 680px max width.
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
 * @csspart brain - the brain glyph inside the thinking pill
 * @csspart hint - the keyboard-hint span
 * @slot hint - overrides the default keyboard-hint content
 */
export class SliccComposerMeta extends HTMLElement {
  static readonly observedAttributes = ['model', 'thinking', 'narrow'];

  readonly #root: ShadowRoot;
  #onModelClick: (() => void) | null = null;
  #onThinkingClick: (() => void) | null = null;
  #modelEl: HTMLButtonElement | null = null;
  #thinkingEl: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbind();
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

    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      '<div class="meta" part="meta">' +
      `<button type="button" class="ctl msel" part="model"><span class="ic">✦</span> ${escapeHtml(model)} <span class="cx">▾</span></button>` +
      `<button type="button" class="ctl tsel${accented ? ' x' : ''}" part="thinking">${BRAIN_SVG} <span class="tlabel">${escapeHtml(thinking)}</span> <span class="cx">▾</span></button>` +
      '<div class="mspacer"></div>' +
      '<span class="hint" part="hint"><slot name="hint">' +
      '<span class="kbd">⏎</span> send <span class="sep"></span> ' +
      '<span class="kbd">⇧⏎</span> newline <span class="sep"></span> review before shipping' +
      '</slot></span>' +
      '</div>';

    this.#modelEl = this.#root.querySelector('.msel');
    this.#thinkingEl = this.#root.querySelector('.tsel');
    this.#bind();
  }

  #bind(): void {
    if (this.#modelEl) {
      this.#onModelClick = () => this.#emitModel();
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
  }

  /** Emit `model-change` (the model picker is owned by the host application). */
  #emitModel(): void {
    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { model: this.model },
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
