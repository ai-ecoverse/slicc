import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const STYLE = `
:host { display: inline-flex; }
:host([hidden]) { display: none; }

.sw {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--swatch-color, transparent);
  cursor: pointer;
  padding: 0;
  margin: 0;
  font: inherit;
  -webkit-appearance: none;
  appearance: none;
  display: block;
  box-sizing: border-box;
}

/* Hue/accent swatch: drop the border so the hue fills edge to edge. */
.sw.hue { border: none; }

/* Selected: violet double-ring (white inner ring + violet outer ring). */
.sw.on { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--violet); }

.sw:focus-visible {
  outline: 2px solid var(--violet);
  outline-offset: 2px;
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-swatch>` — the 28×28 color swatch button from the prototype hero-studio
 * controls (`.sw`, `.sw.hue`, `.sw.on`). A rounded, bordered button whose fill is
 * set via the `color` attribute. The `hue` modifier removes the border so an
 * accent hue fills edge to edge; the `selected` state shows a violet double-ring.
 *
 * Clicking the swatch sets `selected` and emits a composed, bubbling `select`
 * event carrying the swatch color. Self-contained shadow DOM; themes via the
 * inherited tokens `--line`, `--violet`, `--canvas`.
 *
 * @attr color - CSS color used as the swatch fill (inline background)
 * @attr hue - boolean; borderless accent/hue swatch (fills edge to edge)
 * @attr selected - boolean; renders the violet double-ring
 * @attr label - optional accessible label for the button (defaults to the color)
 * @fires select - `CustomEvent<{ color: string | null }>` on click
 * @csspart button - the inner `.sw` button element
 * @slot - optional overlay content rendered on top of the swatch fill
 */
export class SliccSwatch extends HTMLElement {
  static readonly observedAttributes = ['color', 'hue', 'selected', 'label'];

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

  /** CSS color used as the swatch fill. */
  get color(): string | null {
    return this.getAttribute('color');
  }

  set color(value: string | null) {
    if (value == null) this.removeAttribute('color');
    else this.setAttribute('color', value);
  }

  /** Borderless accent/hue swatch when true. */
  get hue(): boolean {
    return this.hasAttribute('hue');
  }

  set hue(value: boolean) {
    this.toggleAttribute('hue', !!value);
  }

  /** Renders the violet double-ring when true. */
  get selected(): boolean {
    return this.hasAttribute('selected');
  }

  set selected(value: boolean) {
    this.toggleAttribute('selected', !!value);
  }

  /** Optional accessible label; falls back to the color value. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const color = this.color;
    const classes = ['sw'];
    if (this.hue) classes.push('hue');
    if (this.selected) classes.push('on');

    const button = h(
      'button',
      {
        type: 'button',
        part: 'button',
        class: classes.join(' '),
        'aria-pressed': this.selected ? 'true' : 'false',
        'aria-label': this.label ?? color ?? 'color swatch',
      },
      h('slot')
    );
    if (color) button.style.setProperty('--swatch-color', color);

    button.addEventListener('click', this.#onClick);
    this.#root.replaceChildren(button);
  }

  #onClick = (): void => {
    this.selected = true;
    this.dispatchEvent(
      new CustomEvent<{ color: string | null }>('select', {
        detail: { color: this.color },
        bubbles: true,
        composed: true,
      })
    );
  };
}

define('slicc-swatch', SliccSwatch);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-swatch': SliccSwatch;
  }
}
