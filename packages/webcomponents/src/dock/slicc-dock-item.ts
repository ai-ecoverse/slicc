import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { attachLongPressGesture, type LongPressHandle } from '../internal/long-press.js';

/**
 * Per-instance stylesheet for the dock launcher button, lifted verbatim from the
 * prototype `.dock .di` family (`.di`, `.di.sp`, `.di.on`, `.di.lit`, `.tip`).
 *
 * `--h` (the per-item kind hue) is set inline from the `hue` attribute and falls
 * back to `var(--violet)`, exactly as the prototype's `var(--h,var(--violet))`
 * guards. `--ctx` (the active context accent) and the surface tokens
 * (`--ghost`, `--ink`, `--line`, `--txt-2`, `--canvas`, `--ui`) are inherited
 * and resolve against whatever theme scope wraps the host.
 *
 * Dark mode: the `.on` glow uses `--ctx` over a `transparent` base, and the
 * `.lit` tint mixes `--h` over the inherited `var(--canvas)` (which is `#fff`
 * in light and `#161618` in dark). Mixing over `var(--canvas)` re-bases the
 * tint automatically without `:host-context` — the prototype's `body.dark`
 * override exists only because its light rule mixed over a hardcoded `#fff`.
 */
const STYLE = `
:host { display: inline-grid; }
:host([hidden]) { display: none; }

.di {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--txt-2);
  cursor: pointer;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-family: var(--ui);
  padding: 0;
  margin: 0;
  line-height: 1;
  -webkit-appearance: none;
  appearance: none;
}

.di:hover { background: var(--ghost); color: var(--ink); }

/* sprinkle launcher: status dot in the per-kind hue (--h, default violet) */
.di.sp::after {
  content: "";
  position: absolute;
  right: 5px;
  top: 6px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--h, var(--violet));
}

/* active / open: subtle outer glow in the active context accent (--ctx) — no
   blinding solid fill in dark mode, just a tint + ring + glow */
.di.on {
  background: color-mix(in srgb, var(--ctx) 14%, transparent);
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ctx) 35%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ctx) 45%, transparent),
    0 0 12px 2px color-mix(in srgb, var(--ctx) 38%, transparent);
}

/* lit: transient ring + tint in the per-kind hue (--h). The fill mixes over the
   inherited var(--canvas) so it re-bases correctly in dark mode. */
.di.lit {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--h, var(--violet)) 45%, transparent);
  background: color-mix(in srgb, var(--h, var(--violet)) 16%, var(--canvas));
  color: var(--ink);
  transition: box-shadow 0.3s, background 0.3s;
}

/* tooltip to the left of the button — absolutely positioned, no reflow */
.tip {
  position: absolute;
  right: 42px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--ink);
  color: #fff;
  font-size: 11px;
  font-family: var(--ui);
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 6px;
  opacity: 0;
  pointer-events: none;
  transition: 0.12s;
}

.di:hover .tip { opacity: 1; }

.glyph { display: grid; place-items: center; line-height: 1; }
.glyph svg { display: block; }
`;
const SHEET = sheet(STYLE);

/** Item kind: `tool` (no status dot) vs `sprinkle` (`.sp`, colored status dot). */
export type DockItemKind = 'tool' | 'sprinkle';

/** Default lucide icon when no `icon` attribute (and no slotted glyph) is set. */
const DEFAULT_ICON = 'square';
/** Rendered lucide glyph size (px) inside the 34×34 dock button. */
const ICON_SIZE = 18;

/**
 * `<slicc-dock-item>` — the prototype dock launcher button (`.dock .di`): a
 * 34×34 rounded-square icon button with a **lucide** glyph and a `.tip` tooltip
 * that fades in on hover, pinned to the button's left so it never reflows the
 * rail.
 *
 * The glyph is a lucide icon named by the kebab-case `icon` attribute (default
 * `square`), rendered via the shared `iconEl` helper at 18px — never emoji or
 * bespoke unicode symbols. The prototype's hand-drawn dock glyphs map to lucide:
 * sprinkles → `sparkles`, browser → `globe` (or `layout`), files → `folder`,
 * terminal → `square-terminal`, memory → `brain` (or `database`), new → `plus`.
 * The icon inherits the button's `currentColor`, so it tracks the idle / hover /
 * active palette automatically. Slotting a custom `<svg>` into the default slot
 * overrides the lucide `icon` entirely.
 *
 * States mirror the prototype dock:
 *   - idle: transparent surface, `--txt-2` glyph
 *   - hover: `--ghost` background, `--ink` glyph (CSS `:hover`)
 *   - active / open (`active` → `.di.on`): `--ctx`-tinted fill + ring + outer glow
 *   - lit (`lit` → `.di.lit`): transient ring + tint in the kind hue `--h`
 *   - sprinkle (`kind="sprinkle"` → `.di.sp`): adds a status dot in `--h`
 *
 * Clicking emits a composed, bubbling event carrying the `item-id`:
 *   - `select` normally (open / focus this surface), or
 *   - `collapse` when the item is already `active` (i.e. its surface is open),
 *     matching the prototype's "click the open dock item to collapse the shell".
 *
 * Self-contained shadow DOM; themes via inherited tokens.
 *
 * @attr item-id - logical id for this launcher (the prototype `data-t`); echoed in events
 * @attr kind - `tool` (default) | `sprinkle`; sprinkle adds the colored status dot
 * @attr hue - CSS color for the per-kind accent (`--h`); defaults to `var(--violet)`
 * @attr icon - lucide icon name, kebab-case (default `square`)
 * @attr tip - tooltip label shown on hover (also used as the accessible name)
 * @attr active - boolean; the open/active state (`.di.on`) — ctx glow
 * @attr lit - boolean; the transient lit state (`.di.lit`) — kind-hue ring + tint
 * @fires select - `CustomEvent<{ id: string | null }>` when an idle item is clicked
 * @fires collapse - `CustomEvent<{ id: string | null }>` when an already-active item is clicked
 * @fires longpress - `CustomEvent<{ id: string | null }>` when the item is click-held
 *   past the long-press threshold (or modifier-clicked) — the secondary action
 * @csspart button - the inner `.di` button
 * @csspart glyph - the glyph wrapper
 * @csspart icon - the lucide `<svg>` glyph
 * @csspart tip - the tooltip
 * @slot - a custom glyph that overrides the lucide `icon` (e.g. a bespoke `<svg>`)
 */
export class SliccDockItem extends HTMLElement {
  static readonly observedAttributes = ['item-id', 'kind', 'hue', 'icon', 'tip', 'active', 'lit'];

  readonly #root: ShadowRoot;
  /** Live click-and-hold gesture on the current button (re-armed per render). */
  #gesture: LongPressHandle | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  disconnectedCallback(): void {
    this.#gesture?.destroy();
    this.#gesture = null;
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Logical id for this launcher (prototype `data-t`); echoed in events. */
  get itemId(): string | null {
    return this.getAttribute('item-id');
  }

  set itemId(value: string | null) {
    if (value == null) this.removeAttribute('item-id');
    else this.setAttribute('item-id', value);
  }

  /** Item kind — `sprinkle` adds the status dot, anything else is `tool`. */
  get kind(): DockItemKind {
    return this.getAttribute('kind') === 'sprinkle' ? 'sprinkle' : 'tool';
  }

  set kind(value: DockItemKind) {
    this.setAttribute('kind', value === 'sprinkle' ? 'sprinkle' : 'tool');
  }

  /** Per-kind accent color, applied to `--h`; falls back to `var(--violet)`. */
  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  /** The lucide icon name (kebab-case); falls back to `square`. */
  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  /** Tooltip label (also the accessible name). */
  get tip(): string | null {
    return this.getAttribute('tip');
  }

  set tip(value: string | null) {
    if (value == null) this.removeAttribute('tip');
    else this.setAttribute('tip', value);
  }

  /** Open/active state (`.di.on`) — the ctx-tinted glow. */
  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', !!value);
  }

  /** Transient lit state (`.di.lit`) — the kind-hue ring + tint. */
  get lit(): boolean {
    return this.hasAttribute('lit');
  }

  set lit(value: boolean) {
    this.toggleAttribute('lit', !!value);
  }

  #render(): void {
    const classes = ['di'];
    if (this.kind === 'sprinkle') classes.push('sp');
    if (this.active) classes.push('on');
    if (this.lit) classes.push('lit');

    const tip = this.tip;

    // A slotted custom glyph wins; otherwise render the lucide icon. The slot's
    // fallback content is the lucide `<svg>`, so consumers can override it.
    const glyph = iconEl(this.icon, { size: ICON_SIZE, part: 'icon' });

    // The tooltip doubles as the accessible name; fall back to the item id.
    const aria = tip ?? this.itemId ?? 'dock item';

    const button = h(
      'button',
      {
        type: 'button',
        part: 'button',
        class: classes.join(' '),
        'aria-label': aria,
        'aria-pressed': this.active ? 'true' : 'false',
      },
      h('span', { class: 'glyph', part: 'glyph' }, h('slot', null, glyph)),
      tip ? h('span', { class: 'tip', part: 'tip' }, tip) : null
    );

    // The per-kind hue feeds `--h`; setting it via the style API (not markup)
    // keeps the value out of any HTML-string context.
    const hue = this.hue;
    if (hue) button.style.setProperty('--h', hue);

    // Click-and-hold gesture (shared contract): a short click keeps the
    // select / collapse semantics, holding past the threshold (or a
    // modifier-click) fires the secondary `longpress` action instead.
    this.#gesture?.destroy();
    this.#gesture = attachLongPressGesture(button, {
      onShortClick: this.#onClick,
      onLongPress: () => this.#emit('longpress'),
    });

    this.#root.replaceChildren(button);
  }

  /**
   * Active items collapse (close their open surface); idle items select.
   * Both events are composed + bubbling and carry the launcher id.
   */
  #onClick = (): void => {
    this.#emit(this.active ? 'collapse' : 'select');
  };

  #emit(type: 'select' | 'collapse' | 'longpress'): void {
    this.dispatchEvent(
      new CustomEvent<{ id: string | null }>(type, {
        detail: { id: this.itemId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

define('slicc-dock-item', SliccDockItem);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dock-item': SliccDockItem;
  }
}
