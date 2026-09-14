import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const ICON_SIZE = 14;

const STYLE = `
:host {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  vertical-align: middle;
}
:host([hidden]) { display: none; }

.snow {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--ghost);
  border: 1px solid var(--line);
  color: var(--txt-2);
  line-height: 1;
  flex: 0 0 auto;
  font-family: var(--ui);
}

/* thawing — rose flash (prototype: .fzcard.thawed .snow) */
:host([thawed]) .snow {
  border-color: color-mix(in srgb, var(--rose) 45%, var(--line));
  background: color-mix(in srgb, var(--rose) 14%, var(--canvas));
  color: #b91c4d;
}

/* slotted overrides + the default lucide glyph; the slot's fallback shows when
   nothing is slotted */
::slotted(*), .ic { line-height: 1; }
.ic { display: block; }
`;
const SHEET = sheet(STYLE);

export class SliccSnowflake extends HTMLElement {
  static readonly observedAttributes = ['thawed'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    const glyph = iconEl('snowflake', { size: ICON_SIZE, part: 'glyph', class: 'ic' });
    const badge = h('span', { class: 'snow', part: 'badge' }, h('slot', null, glyph));
    this.#root.replaceChildren(badge);
  }

  get thawed(): boolean {
    return this.hasAttribute('thawed');
  }

  set thawed(value: boolean) {
    this.toggleAttribute('thawed', value);
  }
}

define('slicc-snowflake', SliccSnowflake);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-snowflake': SliccSnowflake;
  }
}
