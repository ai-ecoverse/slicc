import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
:host { display: inline-grid; }
:host([hidden]) { display: none; }
.iconbtn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  margin: 0;
  -webkit-appearance: none;
  appearance: none;
}
.iconbtn:hover { background: var(--ghost); color: var(--ink); }
.iconbtn:disabled {
  cursor: default;
  opacity: 0.45;
}
.iconbtn:disabled:hover { background: var(--canvas); color: var(--txt-2); }
.icon { display: grid; place-items: center; pointer-events: none; }
.icon svg { display: block; }
`;
const SHEET = sheet(STYLE);

const DEFAULT_ICON = 'plus';

const ICON_SIZE = 16;

export class SliccIconButton extends HTMLElement {
  static readonly observedAttributes = ['icon', 'disabled', 'label'];

  readonly #root: ShadowRoot;

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

  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const label = this.label;
    const glyph = iconEl(this.icon, { size: ICON_SIZE, part: 'icon' });
    const slot = h('slot', null, h('span', { class: 'icon' }, glyph));
    const button = h(
      'button',
      {
        type: 'button',
        class: 'iconbtn',
        part: 'button',
        'aria-label': label ?? undefined,
        title: label ?? undefined,
        disabled: this.disabled,
      },
      slot
    );
    this.#root.replaceChildren(button);
  }
}

define('slicc-icon-button', SliccIconButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-icon-button': SliccIconButton;
  }
}
