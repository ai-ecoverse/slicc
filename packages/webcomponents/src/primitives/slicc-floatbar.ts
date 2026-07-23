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
function formatSpent(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number.parseFloat(trimmed.replace(/^\$/, ''));
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

const NARROW_QUERY = '(max-width: 560px)';

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

/* thin divider between the label and the cost segment */
.sep {
  width: 1px;
  height: 12px;
  flex: 0 0 auto;
  background: var(--line);
}

/* $ SPENT cost segment: lucide coin icon + formatted amount */
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

/* Hover/focus tip surfacing the collapsed label + spend + connection state.
   Hidden in the wide pill (the full label already shows everything); only the
   narrow square badge reveals it, mirroring slicc-pill's dark .tip convention.
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

/* Narrow / extension-sidebar: collapse to just the connection status light —
   the runtime label, its divider, and the cost segment all drop, and the host
   shrinks to a square (width == height == --ctl-h) so it reads as a compact
   round badge instead of an elongated upright pill, never crowding the
   switcher / avatar / theme toggle. */
@media (max-width: 560px) {
  :host {
    width: var(--ctl-h, 30px);
    aspect-ratio: 1 / 1;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
  .label, .sep, .spent { display: none; }
  .tip { display: block; }
  :host(:hover) .tip,
  :host(:focus-within) .tip {
    opacity: 1;
    transform: translateX(-50%);
  }
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
 * @attr spent - cost spent, a number or numeric string (e.g. `2.41`); renders a
 *   coin-icon + formatted `$2.41` cost segment after a thin divider
 * @csspart dot - the green status dot (present only when `online`)
 * @csspart label - the runtime label span
 * @csspart sep - the thin divider before the cost segment (present only when `spent`)
 * @csspart spent - the cost segment wrapper (present only when `spent`)
 * @csspart tip - the narrow-view hover/focus tooltip surfacing the collapsed label
 * @slot - default slot overrides the label text
 */
export class SliccFloatbar extends HTMLElement {
  static readonly observedAttributes = ['label', 'linked', 'online', 'spent'];

  readonly #root: ShadowRoot;
  readonly #narrow: MediaQueryList | null;
  readonly #onNarrowChange = (): void => {
    if (this.isConnected) this.#syncTitle();
  };
  #overlay: HTMLElement | null = null;
  #costModels: CostOverlayModel[] = [];
  #costScoops: CostOverlayScoop[] = [];
  #hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    this.#narrow =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(NARROW_QUERY)
        : null;
  }

  connectedCallback(): void {
    this.#narrow?.addEventListener('change', this.#onNarrowChange);
    this.#render();
  }

  disconnectedCallback(): void {
    this.#narrow?.removeEventListener('change', this.#onNarrowChange);
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
   * spend (when present), and the connection state, joined with the same ` · `
   * separator the verbose label uses, so the collapsed badge stays legible.
   */
  #tipText(): string {
    const parts: string[] = [this.label];
    const amount = formatSpent(this.spent);
    if (amount != null) parts.push(amount);
    parts.push(this.online ? 'online' : 'offline');
    return parts.join(' · ');
  }

  /**
   * Mirror the tip text onto the host `title` only while collapsed, giving the
   * narrow badge an accessible (keyboard / AT) tooltip without duplicating the
   * already-visible text in the wide pill.
   */
  #syncTitle(): void {
    if (this.#narrow?.matches) this.setAttribute('title', this.#tipText());
    else this.removeAttribute('title');
  }

  #render(): void {
    const nodes: Node[] = [];

    if (this.online) nodes.push(h('span', { class: 'fdot', part: 'dot' }));

    nodes.push(h('span', { class: 'label', part: 'label' }, h('slot', null, this.label)));

    const amount = formatSpent(this.spent);
    if (amount != null) {
      nodes.push(h('span', { class: 'sep', part: 'sep' }));
      const spentEl = h(
        'span',
        { class: 'spent', part: 'spent' },
        iconEl('circle-dollar-sign', { size: 12 }),
        h('span', { class: 'amount' }, amount)
      );
      spentEl.addEventListener('mouseenter', () => this.#showOverlay());
      spentEl.addEventListener('mouseleave', () => this.#scheduleHide());
      nodes.push(spentEl);
    }

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
