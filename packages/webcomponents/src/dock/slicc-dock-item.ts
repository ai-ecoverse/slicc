import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { attachLongPressGesture, type LongPressHandle } from '../internal/long-press.js';

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
  /* --canvas, not #fff: --ink flips near-white in dark mode and hardcoded
     white text would vanish on it (the freezer-card tip got this right). */
  color: var(--canvas, #fff);
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

export type DockItemKind = 'tool' | 'sprinkle';

const DEFAULT_ICON = 'square';

const ICON_SIZE = 18;

export class SliccDockItem extends HTMLElement {
  static readonly observedAttributes = ['item-id', 'kind', 'hue', 'icon', 'tip', 'active', 'lit'];

  readonly #root: ShadowRoot;

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

  get itemId(): string | null {
    return this.getAttribute('item-id');
  }

  set itemId(value: string | null) {
    if (value == null) this.removeAttribute('item-id');
    else this.setAttribute('item-id', value);
  }

  get kind(): DockItemKind {
    return this.getAttribute('kind') === 'sprinkle' ? 'sprinkle' : 'tool';
  }

  set kind(value: DockItemKind) {
    this.setAttribute('kind', value === 'sprinkle' ? 'sprinkle' : 'tool');
  }

  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  get tip(): string | null {
    return this.getAttribute('tip');
  }

  set tip(value: string | null) {
    if (value == null) this.removeAttribute('tip');
    else this.setAttribute('tip', value);
  }

  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', !!value);
  }

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

    const glyph = iconEl(this.icon, { size: ICON_SIZE, part: 'icon' });

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

    const hue = this.hue;
    if (hue) button.style.setProperty('--h', hue);

    this.#gesture?.destroy();
    this.#gesture = attachLongPressGesture(button, {
      onShortClick: this.#onClick,
      onLongPress: () => this.#emit('longpress'),
    });

    this.#root.replaceChildren(button);
  }

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
