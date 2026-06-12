import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/** Rendered lucide glyph size (px) inside the 28×28 badge. */
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

/**
 * `<slicc-snowflake>` — the freezer "Snowflake Badge" from the prototype
 * (`.snow`): a 28×28 circular icon badge with a ghost-fill, a 1px `--line`
 * border, and a centered lucide `snowflake` glyph in `--txt-2`. Setting the
 * `thawed` boolean attribute flips it into the rose "thawing" flash (rose
 * border + rose-tinted fill + `#b91c4d` glyph) the prototype shows for ~1400ms
 * when a frozen session is reopened.
 *
 * The glyph is rendered via the shared `iconEl` helper (lucide `snowflake`),
 * never emoji — it inherits the badge's `currentColor`, so it tracks the
 * frozen / thawed palette automatically.
 *
 * Presentational only — it does not own the 1400ms timer; the host adds/removes
 * `thawed` (e.g. `el.thawed = true; setTimeout(() => el.thawed = false, 1400)`).
 *
 * The glyph can be overridden via the default slot (e.g. a bespoke `<svg>`).
 *
 * @attr thawed - boolean; flips the badge into the rose "thawing" flash state
 * @csspart badge - the circular badge container (the `.snow` node)
 * @csspart glyph - the lucide snowflake `<svg>` glyph
 * @slot - overrides the default lucide snowflake glyph
 */
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

  /** Whether the badge is in the rose "thawing" flash state. */
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
