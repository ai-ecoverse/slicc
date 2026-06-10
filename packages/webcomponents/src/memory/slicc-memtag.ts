import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/** Memory-tag kinds, in the prototype's vocabulary (`.mtag.us/.fb/.pj`). */
export type MemtagType = 'user' | 'feedback' | 'project';

const TYPES = new Set<string>(['user', 'feedback', 'project']);

/** Per-type tint hue token + default label, lifted from the prototype. */
const TYPE_HUE: Record<MemtagType, { hue: string; label: string }> = {
  user: { hue: '--rose', label: 'user' },
  feedback: { hue: '--cyan', label: 'feedback' },
  project: { hue: '--violet', label: 'project' },
};

/** Coerce an arbitrary string to a known {@link MemtagType}, defaulting to `user`. */
function normalizeType(value: string | null): MemtagType {
  return value === 'feedback' || value === 'project' ? value : 'user';
}

/**
 * Per-instance stylesheet for the memory tag. The tint hue is selected by the
 * inner `--mtag-hue` custom property (set inline from `type`); the fill / border
 * mix strengths come from `--mtag-fill` / `--mtag-border`, which default to the
 * prototype's light values (12% / 28%) and are deepened to the dark values
 * (22% / 38%) by the host-side `.dark` / `[data-theme="dark"]` document rules
 * below. Every mix re-bases over the inherited `var(--canvas)` token (`#fff` in
 * light, `#161618` in dark), so the same rule is theme-aware without
 * `:host-context`.
 *
 * Base geometry is the prototype's `.memrow .mtag` rule: 10px `--ui` font,
 * 26px radius, `1px 8px` padding — a fixed-height inline pill that never wraps.
 */
const STYLE = `
:host {
  display: inline-flex;
  vertical-align: middle;
  --mtag-fill: 12%;
  --mtag-border: 28%;
}
:host([hidden]) { display: none; }
.mtag {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  font-family: var(--ui);
  font-size: 10px;
  line-height: 1.4;
  border-radius: 26px;
  padding: 1px 8px;
  white-space: nowrap;
  color: var(--mtag-hue, var(--rose));
  background: color-mix(in srgb, var(--mtag-hue, var(--rose)) var(--mtag-fill), var(--canvas));
  border: 1px solid color-mix(in srgb, var(--mtag-hue, var(--rose)) var(--mtag-border), var(--line));
}
`;
const SHEET = sheet(STYLE);

const STYLE_ID = 'slicc-memtag-dark';

/**
 * Host-side dark deepening. The element lives in the light DOM, so a plain
 * document rule pierces to set the mix strengths consumed inside the shadow —
 * mirroring the prototype's `body.dark .mtag.*` overrides (22% / 38%) and the
 * `slicc-memrow` host-stylesheet pattern, but without `:host-context`. Injected
 * once per document (idempotent).
 */
const DARK_STYLE = `
.dark slicc-memtag,
[data-theme="dark"] slicc-memtag {
  --mtag-fill: 22%;
  --mtag-border: 38%;
}
`;

/** Inject the host-side dark-deepening stylesheet into a document once. */
function ensureDarkStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DARK_STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-memtag>` — the memory-type pill from the prototype's memory panel
 * (`.mtag` / `.mtag.us` / `.mtag.fb` / `.mtag.pj`). A small rounded type label
 * with three hue variants — `user` → rose, `feedback` → cyan, `project` →
 * violet — each a hue-tinted fill with a matching border and hue text. The
 * `type` attribute selects the hue and the default label; it is presentational
 * (no events). Self-contained shadow DOM; themes via the inherited tokens
 * `--rose` / `--cyan` / `--violet` / `--line` / `--canvas` / `--ui`.
 *
 * Each tint `color-mix`es over `var(--canvas)` (not a hardcoded `#fff`) so a
 * single rule is light/dark aware; dark mode deepens the mix strengths via a
 * host-side `.dark` / `[data-theme="dark"]` document rule (12%/28% → 22%/38%),
 * matching the prototype's `body.dark` overrides without `:host-context`.
 *
 * @attr type - `user` | `feedback` | `project` (default `user`); selects the
 *   hue + the fallback label.
 * @attr label - optional chip text; overrides the per-type default label.
 * @csspart tag - the pill element (override padding / radius / color from outside).
 * @slot - optional custom label content; defaults to the `label` attr, then the
 *   per-type default text.
 */
export class SliccMemtag extends HTMLElement {
  static readonly observedAttributes = ['type', 'label'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    ensureDarkStyle(this.ownerDocument);
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** The tag type — `user` | `feedback` | `project` (defaults to `user`). */
  get type(): MemtagType {
    return normalizeType(this.getAttribute('type'));
  }

  set type(value: MemtagType) {
    this.setAttribute('type', TYPES.has(value) ? value : 'user');
  }

  /** Optional label override; `null` falls back to the per-type default. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const { hue, label: defaultLabel } = TYPE_HUE[this.type];
    const label = this.label;
    // The label attr wins when set (an escaped text node); otherwise a default
    // <slot> carries the per-type fallback text (overridable by slotted content).
    const inner = label != null ? label : h('slot', null, defaultLabel);
    const tag = h('span', { class: 'mtag', part: 'tag', style: `--mtag-hue:var(${hue})` }, inner);
    this.#root.replaceChildren(tag);
  }
}

define('slicc-memtag', SliccMemtag);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-memtag': SliccMemtag;
  }
}
