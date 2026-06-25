import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

export interface CostOverlayModel {
  model: string;
  cost: number;
  turns: number;
  /** Total tokens (input + output + cache). Displayed as K/M shorthand. */
  tokens?: number;
}

export interface CostOverlayScoop {
  name: string;
  model: string;
  cost: number;
  type: 'cone' | 'scoop';
}

function shortModel(model: string): string {
  return model.replace('claude-', '');
}

function fmtTokens(n: number | undefined): string {
  if (n == null || n === 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const STYLE = `
:host {
  display: block;
}

.card {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 100;

  display: none;
  flex-direction: column;
  gap: 0;

  min-width: 220px;
  max-width: 320px;

  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);

  font-family: var(--ui);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink);

  overflow: hidden;
}

:host([open]) .card {
  display: flex;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.section:last-child {
  border-bottom: none;
}

.section-title {
  font-size: 9px;
  text-transform: uppercase;
  color: var(--txt-2);
  font-weight: 600;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.model-row,
.scoop-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.model-row {
  display: flex;
  gap: 8px;
}

.model-name {
  flex: 1;
  font-weight: 500;
  color: var(--ink);
}

.model-tokens {
  font-variant-numeric: tabular-nums;
  color: var(--txt-2);
  text-align: right;
  font-size: 11px;
}

.model-cost,
.scoop-cost {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--ink);
  text-align: right;
  min-width: 5ch;
}

.scoop-name {
  flex: 1;
  font-weight: 500;
  color: var(--ink);
}

.total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  font-weight: 600;
  font-size: 13px;
  border-top: 1px solid var(--line);
}

.total-label {
  color: var(--ink);
}

.total-cost {
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-cost-overlay>` — a floating card that renders per-model and per-scoop
 * cost breakdown. Anchored absolute below its parent (typically the floatbar's
 * `.spent` segment). Shows/hides via the `open` boolean attribute.
 *
 * @attr open - boolean; shows the card when present, hides when absent
 * @property models - array of {@link CostOverlayModel} — per-model costs
 * @property scoops - array of {@link CostOverlayScoop} — per-scoop costs
 * @property open - boolean; reflects to/from the `open` attribute
 */
export class SliccCostOverlay extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;
  #models: CostOverlayModel[] = [];
  #scoops: CostOverlayScoop[] = [];

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

  /** Whether the overlay card is visible. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', !!value);
  }

  /** Per-model cost breakdown. */
  get models(): CostOverlayModel[] {
    return this.#models;
  }

  set models(value: CostOverlayModel[]) {
    this.#models = value;
    if (this.isConnected) this.#render();
  }

  /** Per-scoop cost breakdown. */
  get scoops(): CostOverlayScoop[] {
    return this.#scoops;
  }

  set scoops(value: CostOverlayScoop[]) {
    this.#scoops = value;
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const sections: Node[] = [];

    // BY MODEL section
    if (this.#models.length > 0) {
      const modelRows = this.#models.map((m) => {
        const tok = fmtTokens(m.tokens);
        return h(
          'div',
          { class: 'model-row' },
          h('span', { class: 'model-name' }, shortModel(m.model)),
          tok ? h('span', { class: 'model-tokens' }, tok) : false,
          h('span', { class: 'model-cost' }, `$${m.cost.toFixed(2)}`)
        );
      });

      sections.push(
        h(
          'div',
          { class: 'section section--models' },
          h('div', { class: 'section-title' }, 'BY MODEL'),
          ...modelRows
        )
      );
    }

    // BY AGENT section
    if (this.#scoops.length > 0) {
      const scoopRows = this.#scoops.map((s) =>
        h(
          'div',
          { class: 'scoop-row' },
          h('span', { class: 'scoop-name' }, s.name),
          h('span', { class: 'scoop-cost' }, `$${s.cost.toFixed(2)}`)
        )
      );

      sections.push(
        h(
          'div',
          { class: 'section section--scoops' },
          h('div', { class: 'section-title' }, 'BY AGENT'),
          ...scoopRows
        )
      );
    }

    // Total row
    const total = this.#models.reduce((sum, m) => sum + m.cost, 0);
    sections.push(
      h(
        'div',
        { class: 'total-row' },
        h('span', { class: 'total-label' }, 'Total'),
        h('span', { class: 'total-cost' }, `$${total.toFixed(2)}`)
      )
    );

    const card = h('div', { class: 'card' }, ...sections);
    this.#root.replaceChildren(card);
  }
}

define('slicc-cost-overlay', SliccCostOverlay);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-cost-overlay': SliccCostOverlay;
  }
}
