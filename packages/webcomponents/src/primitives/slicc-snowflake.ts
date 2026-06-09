import { define } from '../internal/define.js';

/**
 * Inline six-point snowflake, drawn as crisp vector geometry so the badge stays
 * sharp at any DPR (the Unicode `❄` glyph rasterizes softly at 14px). Stroke
 * inherits `currentColor`, so the badge's `color` token drives the glyph fill —
 * matching the prototype's `.snow { color: var(--txt-2) }` /
 * `.fzcard.thawed .snow { color: #b91c4d }` contract.
 */
const SNOWFLAKE_SVG = `<svg part="glyph" class="ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2v20"/>
    <path d="M3.34 7 20.66 17"/>
    <path d="M20.66 7 3.34 17"/>
    <path d="M12 5.2 9.6 7.6M12 5.2l2.4 2.4M12 18.8l-2.4-2.4M12 18.8l2.4-2.4"/>
    <path d="m5.1 8 .3 3.3M5.1 8l-3.2.9M18.9 16l-.3-3.3M18.9 16l3.2-.9"/>
    <path d="m18.9 8-.3 3.3M18.9 8l3.2.9M5.1 16l.3-3.3M5.1 16l-3.2-.9"/>
  </g>
</svg>`;

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
  font-size: 14px;
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

/* glyph + slotted overrides; the slot's fallback ❄ shows when nothing is slotted */
::slotted(*), .glyph, .glyphslot { line-height: 1; }

/* SVG mode swaps the ❄ glyph slot for the crisp inline vector */
:host([svg]) .glyphslot { display: none; }
:host(:not([svg])) .ic { display: none; }

.ic { display: block; }
`;

/**
 * `<slicc-snowflake>` — the freezer "Snowflake Badge" from the prototype
 * (`.snow`): a 28×28 circular icon badge with a ghost-fill, a 1px `--line`
 * border, and a centered `❄` glyph in `--txt-2`. Setting the `thawed` boolean
 * attribute flips it into the rose "thawing" flash (rose border + rose-tinted
 * fill + `#b91c4d` glyph) the prototype shows for ~1400ms when a frozen session
 * is reopened.
 *
 * Presentational only — it does not own the 1400ms timer; the host adds/removes
 * `thawed` (e.g. `el.thawed = true; setTimeout(() => el.thawed = false, 1400)`).
 *
 * By default it renders the Unicode `❄` glyph (prototype-faithful). Add the
 * `svg` boolean attribute to swap in a crisp inline six-point vector instead.
 * The glyph can also be overridden via the default slot.
 *
 * @attr thawed - boolean; flips the badge into the rose "thawing" flash state
 * @attr svg - boolean; render the crisp inline six-point SVG instead of `❄`
 * @csspart badge - the circular badge container (the `.snow` node)
 * @csspart glyph - the snowflake glyph (`❄` span, or the inline `<svg>` in `svg` mode)
 * @slot - overrides the default `❄` glyph
 */
export class SliccSnowflake extends HTMLElement {
  static readonly observedAttributes = ['thawed', 'svg'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.innerHTML = `<style>${STYLE}</style><span class="snow" part="badge"><slot class="glyphslot"><span class="glyph" part="glyph">❄</span></slot>${SNOWFLAKE_SVG}</span>`;
  }

  /** Whether the badge is in the rose "thawing" flash state. */
  get thawed(): boolean {
    return this.hasAttribute('thawed');
  }

  set thawed(value: boolean) {
    this.toggleAttribute('thawed', value);
  }

  /** Whether to render the crisp inline six-point SVG instead of the `❄` glyph. */
  get svg(): boolean {
    return this.hasAttribute('svg');
  }

  set svg(value: boolean) {
    this.toggleAttribute('svg', value);
  }
}

define('slicc-snowflake', SliccSnowflake);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-snowflake': SliccSnowflake;
  }
}
