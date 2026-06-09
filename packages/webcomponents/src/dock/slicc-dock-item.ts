import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

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
`;

/** Item kind: `tool` (no status dot) vs `sprinkle` (`.sp`, colored status dot). */
export type DockItemKind = 'tool' | 'sprinkle';

/**
 * `<slicc-dock-item>` — the prototype dock launcher button (`.dock .di`): a
 * 34×34 rounded-square icon button with a glyph (e.g. `✦` for sprinkles, or
 * `◳ ⌗ >_ ◉ ＋` for tools) and a `.tip` tooltip that fades in on hover, pinned
 * to the button's left so it never reflows the rail.
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
 * Self-contained shadow DOM; themes via inherited tokens. Place the glyph in the
 * default slot, or omit it and set the `glyph` attribute.
 *
 * @attr item-id - logical id for this launcher (the prototype `data-t`); echoed in events
 * @attr kind - `tool` (default) | `sprinkle`; sprinkle adds the colored status dot
 * @attr hue - CSS color for the per-kind accent (`--h`); defaults to `var(--violet)`
 * @attr glyph - glyph text rendered inside the button when the default slot is empty
 * @attr tip - tooltip label shown on hover (also used as the accessible name)
 * @attr active - boolean; the open/active state (`.di.on`) — ctx glow
 * @attr lit - boolean; the transient lit state (`.di.lit`) — kind-hue ring + tint
 * @fires select - `CustomEvent<{ id: string | null }>` when an idle item is clicked
 * @fires collapse - `CustomEvent<{ id: string | null }>` when an already-active item is clicked
 * @csspart button - the inner `.di` button
 * @csspart glyph - the glyph wrapper
 * @csspart tip - the tooltip
 * @slot - the glyph rendered inside the button (falls back to the `glyph` attribute)
 */
export class SliccDockItem extends HTMLElement {
  static readonly observedAttributes = ['item-id', 'kind', 'hue', 'glyph', 'tip', 'active', 'lit'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
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

  /** Glyph text rendered when the default slot is empty. */
  get glyph(): string | null {
    return this.getAttribute('glyph');
  }

  set glyph(value: string | null) {
    if (value == null) this.removeAttribute('glyph');
    else this.setAttribute('glyph', value);
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

    const hue = this.hue;
    const styleAttr = hue ? ` style="--h:${escapeHtml(hue)}"` : '';

    const tip = this.tip;
    const tipHtml = tip ? `<span class="tip" part="tip">${escapeHtml(tip)}</span>` : '';

    const glyph = this.glyph;
    const glyphInner = glyph != null ? escapeHtml(glyph) : '<slot></slot>';

    // The tooltip doubles as the accessible name; fall back to the item id.
    const aria = escapeHtml(tip ?? this.itemId ?? 'dock item');
    const pressed = this.active ? 'true' : 'false';

    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      `<button type="button" part="button" class="${classes.join(' ')}"${styleAttr} ` +
      `aria-label="${aria}" aria-pressed="${pressed}">` +
      `<span class="glyph" part="glyph">${glyphInner}</span>` +
      tipHtml +
      '</button>';

    this.#root.querySelector('button')?.addEventListener('click', this.#onClick);
  }

  /**
   * Active items collapse (close their open surface); idle items select.
   * Both events are composed + bubbling and carry the launcher id.
   */
  #onClick = (): void => {
    const type = this.active ? 'collapse' : 'select';
    this.dispatchEvent(
      new CustomEvent<{ id: string | null }>(type, {
        detail: { id: this.itemId },
        bubbles: true,
        composed: true,
      })
    );
  };
}

define('slicc-dock-item', SliccDockItem);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dock-item': SliccDockItem;
  }
}
