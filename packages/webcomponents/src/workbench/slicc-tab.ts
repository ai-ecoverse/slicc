import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

/**
 * Workbench tab styles, lifted verbatim from the prototype `.tab` / `.tab.sp`
 * / `.tab.on` / `.gl` / `.sg` / `.x` rules (proto/StellarRubySwift.html lines
 * 202-210, 43).
 *
 * The active-sprinkle tint is mixed over the inherited `var(--canvas)` token
 * (`#fff` in light, `#161618` in dark) instead of the prototype's literal
 * `#fff`, so it flips with the theme WITHOUT a `:host-context()` rule — exactly
 * matching the prototype light value (canvas is `#fff` in light) while reading
 * correctly in dark. An explicit `theme="dark"` host attribute opts into the
 * prototype's heavier dark percentages (violet 18% bg / 40% border).
 */
const STYLE = `
:host{display:inline-flex;white-space:nowrap;}
.tab{display:inline-flex;align-items:center;gap:7px;font-family:var(--ui);font-size:12px;color:var(--txt-2);background:transparent;border:1px solid transparent;border-radius:8px;padding:6px 10px;cursor:pointer;white-space:nowrap;}
.tab:hover{background:var(--ghost);color:var(--ink);}
.tab.on{color:var(--ink);background:var(--ghost);}
.gl{font-size:11px;color:var(--txt-3);}
.tab.on .gl{color:var(--ink);}
/* sprinkle tabs read as defined chips (more visible), violet-tinted when active */
.tab.sp{color:var(--ink);background:var(--canvas);border-color:var(--line);}
.tab.sp:hover{border-color:color-mix(in srgb,var(--violet) 30%,var(--line));background:var(--canvas);}
.tab.sp.on{background:color-mix(in srgb,var(--violet) 9%,var(--canvas));border-color:color-mix(in srgb,var(--violet) 34%,var(--line));color:var(--ink);}
:host([theme="dark"]) .tab.sp.on{background:color-mix(in srgb,var(--violet) 18%,var(--canvas));border-color:color-mix(in srgb,var(--violet) 40%,var(--line));}
.sg{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:4px;font-size:8px;color:#fff;background:var(--rainbow);}
.x{margin-left:3px;width:15px;height:15px;border-radius:4px;display:grid;place-items:center;font-size:10px;color:var(--txt-3);}
.x:hover{background:var(--line);color:var(--ink);}
`;

/** Default sparkle glyph for a sprinkle badge (prototype `✦`). */
const DEFAULT_BADGE = '✦';
/** Close-button glyph (prototype `✕`). */
const CLOSE_GLYPH = '✕';

/**
 * `<slicc-tab>` — a single workbench tab chip from the prototype tab strip
 * (`.tab`). A quiet ghost chip by default: tool tabs are plain (transparent
 * bg/border, `--txt-2`, with an optional leading `.gl` glyph), sprinkle tabs
 * (`kind="sprinkle"`) read as defined chips (`--canvas` bg, `--line` border)
 * carrying a rainbow `.sg` sparkle badge and violet-tinted when active. An
 * optional `.x` close affordance can be enabled with `closable`.
 *
 * Self-contained shadow DOM; all colors/spacing/fonts come from inherited
 * prototype tokens (`--canvas`, `--ink`, `--ghost`, `--line`, `--violet`,
 * `--rainbow`, `--txt-2/3`, `--ui`) — none are re-declared. The active
 * sprinkle tint mixes over `var(--canvas)` so it flips with the theme without
 * `:host-context()`.
 *
 * Clicking the chip emits a composed, bubbling `select` event carrying
 * `{ tabId }` (unless the close affordance was the click target). Clicking the
 * close `.x` emits a composed, bubbling `close` event carrying `{ tabId }` and
 * stops propagation so it does not also select.
 *
 * @attr tab-id - identifier reported on the `select` / `close` event detail (and the
 *   `data-t` attribute, mirroring the prototype)
 * @attr kind - `tool` (default) | `sprinkle`; sprinkle adds the chip frame + `.sg` badge
 * @attr active - boolean; the `.on` selected state
 * @attr closable - boolean; render the `.x` close affordance
 * @attr badge - sprinkle badge glyph (sprinkle kind only; defaults to `✦`)
 * @attr glyph - optional leading `.gl` glyph (tool kind only)
 * @attr theme - `dark` opts into the prototype's heavier dark sprinkle-active tint
 * @csspart tab - the tab button
 * @csspart badge - the sprinkle `.sg` sparkle badge
 * @csspart glyph - the tool `.gl` leading glyph
 * @csspart close - the `.x` close button
 * @slot - the tab label (used when no text is otherwise provided)
 * @fires select - `{ tabId }`; the tab body was clicked (not the close affordance)
 * @fires close - `{ tabId }`; the close affordance was clicked
 */
export class SliccTab extends HTMLElement {
  static readonly observedAttributes = [
    'tab-id',
    'kind',
    'active',
    'closable',
    'badge',
    'glyph',
    'label',
    'theme',
  ];

  readonly #root: ShadowRoot;
  #onClick: ((e: Event) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Tab identifier, reported on `select` / `close` and mirrored to `data-t`. */
  get tabId(): string | null {
    return this.getAttribute('tab-id');
  }

  set tabId(value: string | null) {
    if (value == null) this.removeAttribute('tab-id');
    else this.setAttribute('tab-id', value);
  }

  /** Tab kind — `sprinkle` renders the chip frame + badge, otherwise `tool`. */
  get kind(): 'tool' | 'sprinkle' {
    return this.getAttribute('kind') === 'sprinkle' ? 'sprinkle' : 'tool';
  }

  set kind(value: 'tool' | 'sprinkle') {
    this.setAttribute('kind', value === 'sprinkle' ? 'sprinkle' : 'tool');
  }

  /** Whether the tab is selected (`.on`). */
  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', value);
  }

  /** Whether the tab shows a close (`.x`) affordance. */
  get closable(): boolean {
    return this.hasAttribute('closable');
  }

  set closable(value: boolean) {
    this.toggleAttribute('closable', value);
  }

  /** Sprinkle badge glyph (sprinkle kind only). */
  get badge(): string | null {
    return this.getAttribute('badge');
  }

  set badge(value: string | null) {
    if (value == null) this.removeAttribute('badge');
    else this.setAttribute('badge', value);
  }

  /** Optional leading `.gl` glyph (tool kind only). */
  get glyph(): string | null {
    return this.getAttribute('glyph');
  }

  set glyph(value: string | null) {
    if (value == null) this.removeAttribute('glyph');
    else this.setAttribute('glyph', value);
  }

  /** Tab label text; falls back to slotted content when absent. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const isSprinkle = this.kind === 'sprinkle';
    const cls = `tab${isSprinkle ? ' sp' : ''}${this.active ? ' on' : ''}`;
    const dataT = this.tabId != null ? ` data-t="${escapeHtml(this.tabId)}"` : '';

    let lead = '';
    if (isSprinkle) {
      const badge = this.badge ?? DEFAULT_BADGE;
      lead = `<span class="sg" part="badge" aria-hidden="true">${escapeHtml(badge)}</span>`;
    } else if (this.glyph != null) {
      lead = `<span class="gl" part="glyph" aria-hidden="true">${escapeHtml(this.glyph)}</span>`;
    }

    const label = this.label;
    const labelHtml = label != null ? escapeHtml(label) : '<slot></slot>';

    const close = this.closable
      ? `<span class="x" part="close" data-close="" role="button" aria-label="Close tab">${CLOSE_GLYPH}</span>`
      : '';

    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      `<button class="${cls}" part="tab" type="button"${dataT}>${lead}${labelHtml}${close}</button>`;
  }

  #bind(): void {
    if (this.#onClick) return;
    this.#onClick = (e: Event) => this.#handleClick(e);
    this.#root.addEventListener('click', this.#onClick);
  }

  #unbind(): void {
    if (!this.#onClick) return;
    this.#root.removeEventListener('click', this.#onClick);
    this.#onClick = null;
  }

  /** Route a click to either `close` (X hit) or `select` (tab body). */
  #handleClick(e: Event): void {
    const target = e.target as HTMLElement | null;
    const detail = { tabId: this.tabId };
    if (target?.closest('[data-close]')) {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('close', { detail, bubbles: true, composed: true }));
      return;
    }
    this.dispatchEvent(new CustomEvent('select', { detail, bubbles: true, composed: true }));
  }
}

define('slicc-tab', SliccTab);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tab': SliccTab;
  }
}
