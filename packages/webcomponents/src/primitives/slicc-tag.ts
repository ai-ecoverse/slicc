import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

/**
 * Supported tint hues. Each maps to a prototype accent token (`var(--rose)`
 * etc.). The default (unset / unknown) hue renders a neutral chip.
 */
const HUES = ['rose', 'cyan', 'violet', 'amber', 'waffle', 'green'] as const;
export type SliccTagHue = (typeof HUES)[number];

const HUE_SET = new Set<string>(HUES);

const STYLE = `
:host {
  display: inline-flex;
  vertical-align: middle;
}
/* Base chip — lifted from the prototype's .mtag / .ptag tinted-pill styling. */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  font-family: var(--ui);
  font-size: 10px;
  line-height: 1.4;
  border-radius: 26px;
  padding: 2px 9px;
  white-space: nowrap;
  /* Neutral default — no hue attribute. */
  color: var(--txt-2);
  background: color-mix(in srgb, var(--ink) 5%, var(--canvas));
  border: 1px solid var(--line);
}
/* Optional leading dot, shown via [has-dot]; tinted to the chip's text color. */
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.label {
  min-width: 0;
}

/*
 * Hue tints. color-mix re-bases over var(--canvas) (not #fff) so a single rule
 * is light/dark aware — exactly how the prototype's dark overrides re-route the
 * hardcoded #fff mixes to var(--canvas). Light is the default polarity.
 */
:host([hue="rose"]) .tag { color: var(--rose); background: color-mix(in srgb, var(--rose) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--rose) 28%, var(--line)); }
:host([hue="cyan"]) .tag { color: var(--cyan); background: color-mix(in srgb, var(--cyan) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--cyan) 28%, var(--line)); }
:host([hue="violet"]) .tag { color: var(--violet); background: color-mix(in srgb, var(--violet) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--violet) 28%, var(--line)); }
:host([hue="amber"]) .tag { color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--amber) 28%, var(--line)); }
:host([hue="waffle"]) .tag { color: var(--waffle); background: color-mix(in srgb, var(--waffle) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--waffle) 28%, var(--line)); }
:host([hue="green"]) .tag { color: var(--green); background: color-mix(in srgb, var(--green) 12%, var(--canvas)); border-color: color-mix(in srgb, var(--green) 28%, var(--line)); }

/*
 * Dark-mode deepening — mirrors the prototype's body.dark .mtag.* overrides
 * (22% fill / 38% border over var(--canvas)). Matches any dark scope wrapper.
 */
:host-context(.dark) .tag,
:host-context([data-theme="dark"]) .tag {
  background: color-mix(in srgb, var(--ink) 6%, var(--canvas));
}
:host-context(.dark)[hue="rose"] .tag, :host-context([data-theme="dark"])[hue="rose"] .tag { background: color-mix(in srgb, var(--rose) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--rose) 38%, var(--line)); }
:host-context(.dark)[hue="cyan"] .tag, :host-context([data-theme="dark"])[hue="cyan"] .tag { background: color-mix(in srgb, var(--cyan) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--cyan) 38%, var(--line)); }
:host-context(.dark)[hue="violet"] .tag, :host-context([data-theme="dark"])[hue="violet"] .tag { background: color-mix(in srgb, var(--violet) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--violet) 38%, var(--line)); }
:host-context(.dark)[hue="amber"] .tag, :host-context([data-theme="dark"])[hue="amber"] .tag { background: color-mix(in srgb, var(--amber) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--amber) 38%, var(--line)); }
:host-context(.dark)[hue="waffle"] .tag, :host-context([data-theme="dark"])[hue="waffle"] .tag { background: color-mix(in srgb, var(--waffle) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--waffle) 38%, var(--line)); }
:host-context(.dark)[hue="green"] .tag, :host-context([data-theme="dark"])[hue="green"] .tag { background: color-mix(in srgb, var(--green) 22%, var(--canvas)); border-color: color-mix(in srgb, var(--green) 38%, var(--line)); }
`;

/**
 * `<slicc-tag>` — a small tinted pill/badge derived from the prototype's
 * `.mtag` (memory tags `.us`/`.fb`/`.pj`), `.ptag`/`.dip .dh .tag` pane tags,
 * and the `.lick .lk`/`.lb` chips. A rounded chip whose fill/border/text tint
 * over `var(--canvas)` from a `hue` attribute (rose | cyan | violet | amber |
 * waffle | green), light/dark aware, with an optional leading dot and a label
 * supplied via attribute or the default slot.
 *
 * Presentational only — no events.
 *
 * @attr hue - tint hue; one of rose | cyan | violet | amber | waffle | green.
 *             Unset / unknown renders a neutral chip.
 * @attr label - chip text. Ignored when default-slot content is provided.
 * @attr dot - boolean; when present, shows a leading tinted dot.
 * @slot - default slot for rich label content (overrides the `label` attr).
 * @csspart tag - the chip container.
 * @csspart dot - the optional leading dot.
 * @csspart label - the label text wrapper.
 */
export class SliccTag extends HTMLElement {
  static readonly observedAttributes = ['hue', 'label', 'dot'];

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

  /** Tint hue, reflected to the `hue` attribute. `null` clears it (neutral). */
  get hue(): SliccTagHue | null {
    const value = this.getAttribute('hue');
    return value && HUE_SET.has(value) ? (value as SliccTagHue) : null;
  }

  set hue(value: SliccTagHue | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  /** Label text, reflected to the `label` attribute. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Whether the leading dot is shown, reflected to the boolean `dot` attribute. */
  get dot(): boolean {
    return this.hasAttribute('dot');
  }

  set dot(value: boolean) {
    if (value) this.setAttribute('dot', '');
    else this.removeAttribute('dot');
  }

  #render(): void {
    const label = this.label;
    const dotHtml = this.dot ? '<span class="dot" part="dot"></span>' : '';
    // The default slot wins when populated; otherwise fall back to the attr.
    const labelHtml = label != null ? escapeHtml(label) : '<slot></slot>';
    this.#root.innerHTML = `<style>${STYLE}</style><span class="tag" part="tag">${dotHtml}<span class="label" part="label">${labelHtml}</span></span>`;
  }
}

define('slicc-tag', SliccTag);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tag': SliccTag;
  }
}
