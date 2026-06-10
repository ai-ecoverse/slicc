import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

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

const STYLE = `
:host {
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

/* Narrow / extension-sidebar: drop the runtime label (and its divider) to a
   compact dot + cost pill so the bar never crowds the avatar / theme toggle. */
@media (max-width: 560px) {
  :host { padding: 0 9px; }
  .label, .sep { display: none; }
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
 * @slot - default slot overrides the label text
 */
export class SliccFloatbar extends HTMLElement {
  static readonly observedAttributes = ['label', 'linked', 'online', 'spent'];

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

  #render(): void {
    const nodes: Node[] = [];

    if (this.online) nodes.push(h('span', { class: 'fdot', part: 'dot' }));

    nodes.push(h('span', { class: 'label', part: 'label' }, h('slot', null, this.label)));

    const amount = formatSpent(this.spent);
    if (amount != null) {
      nodes.push(h('span', { class: 'sep', part: 'sep' }));
      nodes.push(
        h(
          'span',
          { class: 'spent', part: 'spent' },
          iconEl('circle-dollar-sign', { size: 12 }),
          h('span', { class: 'amount' }, amount)
        )
      );
    }

    this.#root.replaceChildren(...nodes);
  }
}

define('slicc-floatbar', SliccFloatbar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-floatbar': SliccFloatbar;
  }
}
