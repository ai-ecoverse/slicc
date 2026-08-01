import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import type { CostOverlayModel, CostOverlayScoop, SliccCostOverlay } from './slicc-cost-overlay.js';
import './slicc-cost-overlay.js';

const DEFAULT_LABEL = 'CLI float';

/**
 * Format a spend value into a `$2.41` string. Accepts a number or a numeric
 * string; non-numeric / blank input yields `null` (no cost segment rendered).
 */
function parseSpent(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number.parseFloat(trimmed.replace(/^\$/, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatSpent(raw: string | null): string | null {
  const value = parseSpent(raw);
  return value == null ? null : `$${value.toFixed(2)}`;
}

function formatRate(raw: string | null): string {
  return `${formatSpent(raw) ?? '$0.00'}/h`;
}

const DETAIL_CUTOFF = 720;

const STYLE = `
:host {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: var(--ctl-h, 30px);
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 9999px;
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
:host([hidden]) { display: none; }

/* linked → rose-tinted border (mixes --rose into --line) */
:host([linked]) {
  border-color: color-mix(in srgb, var(--rose) 40%, var(--line));
}

.fdot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 22%, transparent);
}

.label { white-space: nowrap; }
.detail { white-space: nowrap; }

/* thin divider between the label and the cost segment */
.sep {
  width: 1px;
  height: 12px;
  flex: 0 0 auto;
  background: var(--line);
}

/* Hourly rate segment: lucide coin icon + formatted amount */
.spent {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.spent svg {
  display: block;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
}

/* Hover/focus tip surfacing the collapsed label + rate + connection state.
   Hidden in the wide pill (the full label already shows everything); each
   progressively collapsed form reveals it with a dark tooltip surface.
   Decorative (aria-hidden); the accessible name rides the host title attribute. */
.tip {
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%) translateY(-3px);
  background: var(--ink);
  color: var(--canvas, #fff);
  font-family: var(--ui);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
  z-index: 30;
  display: none;
}

/* Yield to the tabs in three stages, based on the nav's actual inline size:
   auxiliary tray/follower detail, then spend, then the runtime name. */
@container slicc-nav (max-width: 720px) {
  .detail { display: none; }
  :host(:hover) .tip,
  :host(:focus-within) .tip {
    display: block;
    opacity: 1;
    transform: translateX(-50%);
  }
}

@container slicc-nav (max-width: 560px) {
  .sep, .spent { display: none; }
}

@container slicc-nav (max-width: 420px) {
  :host {
    width: var(--ctl-h, 30px);
    aspect-ratio: 1 / 1;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
  .label { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tip { transition: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-floatbar>` — the Runtime Float Pill from the prototype nav
 * (`.floatbar`). An inline-flex rounded pill carrying a status dot (`.fdot`)
 * and a runtime label such as `CLI · tray · 1 follower`. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --rose, --ui,
 * --ctl-h). The green status dot and the linked rose tint are fixed across
 * light/dark.
 *
 * @attr label - the runtime label text (defaults to "CLI float")
 * @attr linked - boolean; rose-tints the border to signal a linked runtime
 * @attr online - boolean; shows the green status dot
 * @attr rate - hourly cost, a number or numeric string (e.g. `23.1`); renders a
 *   coin-icon + formatted `$23.10/h` cost segment after a thin divider
 * @attr spent - cumulative cost shown in the cost overlay's total row
 * @csspart dot - the green status dot (present only when `online`)
 * @csspart label - the runtime label span
 * @csspart sep - the thin divider before the cost segment
 * @csspart spent - the cost segment wrapper
 * @csspart rate - alias for the cost segment wrapper
 * @csspart tip - the narrow-view hover/focus tooltip surfacing the collapsed label
 * @slot - default slot overrides the label text
 */
export class SliccFloatbar extends HTMLElement {
  static readonly observedAttributes = ['label', 'linked', 'online', 'rate', 'spent'];

  readonly #root: ShadowRoot;
  #resizeObserver: ResizeObserver | null = null;
  #overlay: SliccCostOverlay | null = null;
  #costModels: CostOverlayModel[] = [];
  #costScoops: CostOverlayScoop[] = [];
  #hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    const nav = this.closest('slicc-nav');
    if (nav && typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#syncTitle());
      this.#resizeObserver.observe(nav);
    }
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    clearTimeout(this.#hideTimer);
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (this.isConnected) this.#render();
  }

  /** Runtime label text. Falls back to "CLI float" when unset. */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Whether the runtime is linked (rose-tinted border). */
  get linked(): boolean {
    return this.hasAttribute('linked');
  }

  set linked(value: boolean) {
    this.toggleAttribute('linked', !!value);
  }

  /** Whether the status dot is shown (online/green). */
  get online(): boolean {
    return this.hasAttribute('online');
  }

  set online(value: boolean) {
    this.toggleAttribute('online', !!value);
  }

  /** Raw `spent` attribute value (number/string), or `null` when unset. */
  get spent(): string | null {
    return this.getAttribute('spent');
  }

  set spent(value: string | number | null) {
    if (value == null) this.removeAttribute('spent');
    else this.setAttribute('spent', String(value));
  }

  /** Raw hourly `rate` attribute value, or `null` when unset. */
  get rate(): string | null {
    return this.getAttribute('rate');
  }

  set rate(value: string | number | null) {
    if (value == null) this.removeAttribute('rate');
    else this.setAttribute('rate', String(value));
  }

  get costModels(): CostOverlayModel[] {
    return this.#costModels;
  }

  set costModels(value: CostOverlayModel[]) {
    this.#costModels = value;
    if (this.#overlay) this.#overlay.models = value;
  }

  get costScoops(): CostOverlayScoop[] {
    return this.#costScoops;
  }

  set costScoops(value: CostOverlayScoop[]) {
    this.#costScoops = value;
    if (this.#overlay) this.#overlay.scoops = value;
  }

  /**
   * The tooltip text for the narrow square badge — the label, the formatted
   * hourly rate, its recency-weighted session context, and connection state,
   * joined with the same ` · `
   * separator the verbose label uses, so the collapsed badge stays legible.
   */
  #tipText(): string {
    const parts: string[] = [this.label];
    parts.push(formatRate(this.rate));
    parts.push('recency-weighted session avg');
    parts.push(this.online ? 'online' : 'offline');
    return parts.join(' · ');
  }

  /** Mirror the full tip onto `title` whenever any detail has been collapsed. */
  #syncTitle(): void {
    const nav = this.closest('slicc-nav');
    const style = nav ? getComputedStyle(nav) : null;
    const inlineSize = nav
      ? nav.clientWidth -
        Number.parseFloat(style?.paddingLeft ?? '0') -
        Number.parseFloat(style?.paddingRight ?? '0')
      : Infinity;
    if (inlineSize <= DETAIL_CUTOFF) this.setAttribute('title', this.#tipText());
    else this.removeAttribute('title');
  }

  #render(): void {
    const nodes: Node[] = [];

    if (this.online) nodes.push(h('span', { class: 'fdot', part: 'dot' }));

    const [runtime, ...detail] = this.label.split(' · ');
    const fallback = [h('span', { class: 'runtime' }, runtime)];
    if (detail.length > 0) {
      fallback.push(h('span', { class: 'detail' }, ` · ${detail.join(' · ')}`));
    }
    nodes.push(h('span', { class: 'label', part: 'label' }, h('slot', null, ...fallback)));

    nodes.push(h('span', { class: 'sep', part: 'sep' }));
    const spentEl = h(
      'span',
      { class: 'spent', part: 'spent rate' },
      iconEl('circle-dollar-sign', { size: 12 }),
      h('span', { class: 'amount' }, formatRate(this.rate))
    );
    spentEl.addEventListener('mouseenter', () => this.#showOverlay());
    spentEl.addEventListener('mouseleave', () => this.#scheduleHide());
    nodes.push(spentEl);

    nodes.push(h('span', { class: 'tip', part: 'tip', 'aria-hidden': 'true' }, this.#tipText()));

    this.#overlay = null;
    this.#root.replaceChildren(...nodes);
    this.#syncTitle();
  }

  #showOverlay(): void {
    clearTimeout(this.#hideTimer);
    if (!this.#overlay) {
      const overlay = document.createElement('slicc-cost-overlay') as SliccCostOverlay;
      overlay.models = this.#costModels;
      overlay.scoops = this.#costScoops;
      overlay.total = parseSpent(this.spent);
      overlay.addEventListener('mouseenter', () => this.#showOverlay());
      overlay.addEventListener('mouseleave', () => this.#scheduleHide());
      this.#root.appendChild(overlay);
      this.#overlay = overlay;
    }
    this.#overlay.toggleAttribute('open', true);
  }

  #scheduleHide(): void {
    this.#hideTimer = setTimeout(() => {
      if (this.#overlay) this.#overlay.removeAttribute('open');
    }, 150);
  }
}

define('slicc-floatbar', SliccFloatbar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-floatbar': SliccFloatbar;
  }
}
