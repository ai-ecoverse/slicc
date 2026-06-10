import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * New-chat glyph — a **lucide** `square-pen` icon rendered via the shared
 * `iconEl` helper (never emoji or bespoke unicode). Sized ~16px to sit inside
 * the 28px circular `.nico` badge; the stroke inherits `currentColor`, so the
 * badge's `--ctx` context accent drives the glyph color.
 */
const NEW_CHAT_ICON = 'square-pen';
/** Rendered lucide glyph size (px) inside the 28×28 `.nico` badge. */
const ICON_SIZE = 16;

const DEFAULT_LABEL = 'New chat';

/**
 * Per-instance stylesheet. Mirrors the prototype's `.fznew` / `.nico` / `.nlbl`
 * rules. The prototype gates the expanded geometry on the parent `.freezer.open`
 * class; here that maps to the `expanded` boolean attribute on `:host`. All
 * colors/spacing/fonts use inherited prototype tokens (--ctx, --canvas, --line,
 * --ghost, --ink, --ui) so the badge tint and dark mode adapt automatically —
 * the `--ctx` color-mix into `--canvas`/`--line` flips with the theme.
 */
const STYLE = `
:host { display: block; }
:host([hidden]) { display: none; }
*{ box-sizing: border-box; }

/* .fznew — full-width new-chat button at the top of the freezer rail */
.fznew {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border-radius: 8px;
  cursor: pointer;
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--ink);
  font: inherit;
  font-family: var(--ui);
  text-align: left;
  width: 100%;
  transition: background-color .15s;
}
/* collapsed (icon-only) — prototype: .freezer:not(.open) .fznew */
:host(:not([expanded])) .fznew {
  gap: 0;
  justify-content: center;
  padding: 4px 0;
  width: auto;
  align-self: center;
}
.fznew:hover { background: var(--ghost); }
.fznew:focus-visible { outline: 2px solid var(--ctx); outline-offset: 2px; }

/* .nico — 28px circular icon badge, context-tinted with --ctx */
.nico {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ctx) 14%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--ctx) 40%, var(--line));
  color: var(--ctx);
  flex: 0 0 auto;
}
.nico svg { display: block; }

/* .nlbl — "New chat" label, fades in when expanded */
.nlbl {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transition: opacity .18s;
}
:host(:not([expanded])) .nlbl {
  width: 0;
  min-width: 0;
  flex: 0 0 0;
  overflow: hidden;
}
:host([expanded]) .nlbl {
  opacity: 1;
  transition: opacity .25s .15s;
}

/* Respect prefers-reduced-motion: no fade, just hold the static end state. */
@media (prefers-reduced-motion: reduce) {
  .fznew, .nlbl { transition: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-freezer-new>` — the **New Chat Affordance** at the top of the
 * prototype's freezer rail (`.fznew`): a full-width ghost-hover button wrapping
 * a 28px circular `.nico` badge (tinted with `--ctx`, the active context accent)
 * around a **lucide** `square-pen` new-chat glyph, plus a `.nlbl` "New chat"
 * label that fades in when the rail is expanded.
 *
 * The glyph is rendered via the shared `iconSvg` helper (never emoji or a
 * bespoke unicode symbol) and inherits the badge's `--ctx` color through
 * `currentColor`. Slotting a custom glyph into the named `icon` slot overrides
 * the lucide default.
 *
 * The prototype gates the expanded label on the parent `.freezer.open` class;
 * this self-contained element exposes that as the `expanded` boolean attribute.
 * Collapsed it is icon-only (label width 0, centered); expanded the label fades
 * in. The badge tint, hover ghost, and dark mode all derive from inherited
 * tokens, so theme/context changes flip it automatically. The label fade is
 * suppressed (held at its end state) under `prefers-reduced-motion: reduce`.
 *
 * Emits a composed, bubbling `new-session` `CustomEvent` on click.
 *
 * @attr expanded - boolean; reveals the fading "New chat" label (collapsed = icon-only)
 * @attr label - the label text / accessible name (default "New chat")
 * @csspart button - the inner `<button>` element (the `.fznew` node)
 * @csspart badge - the circular `.nico` icon badge
 * @csspart icon - the lucide `<svg>` glyph inside the badge
 * @csspart label - the `.nlbl` text span
 * @slot icon - overrides the default lucide glyph inside the badge
 * @slot - default slot overrides the label text
 * @fires new-session - when the affordance is activated
 */
export class SliccFreezerNew extends HTMLElement {
  static readonly observedAttributes = ['expanded', 'label'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Whether the rail is expanded (label fades in). Reflected to `expanded`. */
  get expanded(): boolean {
    return this.hasAttribute('expanded');
  }

  set expanded(value: boolean) {
    this.toggleAttribute('expanded', value);
  }

  /** Label text / accessible name (reflected to the `label` attribute). */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const label = this.label;

    const iconSlot = h(
      'slot',
      { name: 'icon' },
      iconEl(NEW_CHAT_ICON, { size: ICON_SIZE, part: 'icon' })
    );
    const badge = h('span', { class: 'nico', part: 'badge' }, iconSlot);
    const labelNode = h('span', { class: 'nlbl', part: 'label' }, h('slot', null, label));

    const button = h(
      'button',
      { class: 'fznew', part: 'button', type: 'button', 'aria-label': label, title: label },
      badge,
      labelNode
    ) as HTMLButtonElement;

    button.addEventListener('click', this.#onClick);
    this.#button = button;
    this.#root.replaceChildren(button);
  }

  readonly #onClick = (): void => {
    this.dispatchEvent(new CustomEvent('new-session', { bubbles: true, composed: true }));
  };
}

define('slicc-freezer-new', SliccFreezerNew);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-freezer-new': SliccFreezerNew;
  }
}
