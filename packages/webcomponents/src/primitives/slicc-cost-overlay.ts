import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import {
  type BudgetUsage,
  budgetHue,
  budgetLevel,
  budgetRatio,
  budgetWindowLabel,
  formatBudgetFigure,
} from './budget-usage.js';

export interface CostOverlayModel {
  model: string;
  cost: number;
  turns: number;
  /** Total tokens (input + output + cache). Displayed as K/M shorthand. */
  tokens?: number;
}

/**
 * The rolling provider budget this session draws on, when there is one.
 *
 * Re-exported shape, not a second vocabulary: {@link BudgetUsage} is what the
 * floatbar hands down on hover, so the card and the pill can never disagree
 * about what `9.5%` means.
 */
export type CostOverlayBudget = BudgetUsage;

export interface CostOverlayScoop {
  name: string;
  model: string;
  cost: number;
  type: 'cone' | 'scoop';
}

interface CostOverlayBucket {
  count: number;
  cost: number;
}

const INDIVIDUAL_SCOOP_LIMIT = 5;
const MIN_BUCKET_COST = 1;

function shortModel(model: string): string {
  return model.replace('claude-', '');
}

function fmtTokens(n: number | undefined): string {
  if (n == null || n === 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function groupScoops(scoops: CostOverlayScoop[]): {
  individuals: CostOverlayScoop[];
  buckets: CostOverlayBucket[];
} {
  if (scoops.length <= INDIVIDUAL_SCOOP_LIMIT) {
    return { individuals: scoops, buckets: [] };
  }

  const sorted = [...scoops].sort((a, b) => b.cost - a.cost);
  const individuals = sorted.slice(0, INDIVIDUAL_SCOOP_LIMIT);
  const buckets: CostOverlayBucket[] = [];
  let tail: CostOverlayBucket = { count: 0, cost: 0 };

  for (const scoop of sorted.slice(INDIVIDUAL_SCOOP_LIMIT)) {
    tail.count += 1;
    tail.cost += scoop.cost;
    if (tail.cost >= MIN_BUCKET_COST) {
      buckets.push(tail);
      tail = { count: 0, cost: 0 };
    }
  }

  if (tail.count > 0) {
    const finalBucket = buckets.at(-1);
    if (finalBucket) {
      finalBucket.count += tail.count;
      finalBucket.cost += tail.cost;
    } else {
      buckets.push(tail);
    }
  }

  return { individuals, buckets };
}

const STYLE = `
:host {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 100;
  display: block;
  pointer-events: none;
}
:host([open]) { pointer-events: auto; }

.card {
  display: none;
  flex-direction: column;
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
  max-height: calc(100vh - 64px);
  overflow-x: hidden;
  overflow-y: auto;
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

/* The budget block leads the card and owns the only figure in it. What
   follows is a per-model / per-agent breakdown of the DOLLARS, which on a
   shared allowance is detail: a family-priced model can bill $0.00 while the
   window burns down. */
.budget {
  gap: 6px;
}
.budget-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.budget-figure {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--budget-hue, var(--ink));
}
.budget-used {
  font-size: 11px;
  color: var(--txt-2);
}
.budget-meter {
  display: block;
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--budget-hue, var(--ink)) 16%, var(--canvas));
  overflow: hidden;
}
.budget-meter__fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--budget-hue, var(--ink));
}
.budget-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--txt-2);
  font-size: 11px;
}
/* Refusal is carried by a WORD and a glyph, never by the bar color alone —
   --waffle is 2.09:1 on this surface. */
.budget-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--rose) 14%, transparent);
  color: var(--rose);
  font-weight: 600;
}
.budget-flag svg {
  display: block;
  width: 11px;
  height: 11px;
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
.scoop-row,
.bucket-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.bucket-row {
  margin-top: 2px;
  padding: 4px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ctx) 45%, transparent);
  color: var(--txt-2);
  font-weight: 600;
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
 * @property total - optional cumulative total overriding the per-model sum
 * @property budget - optional {@link CostOverlayBudget}; when set, the card
 *   leads with the rolling window (percent USED + meter) and the dollar total
 *   is relabelled "This session" — see {@link BudgetUsage}
 * @property open - boolean; reflects to/from the `open` attribute
 * @csspart bucket - an aggregate row for lower-cost agents
 * @csspart budget - the leading budget block (present only in budget mode)
 */
export class SliccCostOverlay extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;
  #models: CostOverlayModel[] = [];
  #scoops: CostOverlayScoop[] = [];
  #total: number | null = null;
  #budget: CostOverlayBudget | null = null;

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

  /** Explicit cumulative total. Falls back to the per-model sum when unset. */
  get total(): number | null {
    return this.#total;
  }

  set total(value: number | null) {
    this.#total = value != null && Number.isFinite(value) ? value : null;
    if (this.isConnected) this.#render();
  }

  /**
   * The rolling provider budget, or `null` on a metered provider. Setting it
   * is what puts the card in budget mode; a percent that is not a finite
   * number is treated as no budget at all rather than drawn as `NaN%`.
   */
  get budget(): CostOverlayBudget | null {
    return this.#budget;
  }

  set budget(value: CostOverlayBudget | null) {
    this.#budget = value && Number.isFinite(value.percent) ? value : null;
    if (this.isConnected) this.#render();
  }

  /**
   * The leading budget block: the figure, a meter, and the window's own small
   * print. The bar clamps at 100%; the figure does NOT — a provider reporting
   * 104% has said something true, and rounding it away hides an overrun.
   */
  #budgetSection(budget: CostOverlayBudget): HTMLElement {
    const level = budgetLevel(budget);
    const hue = budgetHue(level);
    const rateLimited = budget.status === 'rate-limited';
    return h(
      'div',
      {
        class: 'section budget',
        part: 'budget',
        'data-budget-level': level,
        'data-budget-status': budget.status ?? 'ok',
        style: `--budget-hue:${hue}`,
      },
      h('div', { class: 'section-title' }, budgetWindowLabel(budget).toUpperCase()),
      h(
        'div',
        { class: 'budget-head' },
        h('span', { class: 'budget-figure' }, formatBudgetFigure(budget.percent)),
        h('span', { class: 'budget-used' }, 'used')
      ),
      h(
        'span',
        { class: 'budget-meter' },
        h('span', {
          class: 'budget-meter__fill',
          style: `width:${(budgetRatio(budget.percent) * 100).toFixed(1)}%`,
        })
      ),
      h(
        'div',
        { class: 'budget-foot' },
        h('span', { class: 'budget-resets' }, budget.resets ?? ''),
        rateLimited
          ? h(
              'span',
              { class: 'budget-flag' },
              iconEl('octagon-alert', { size: 11 }),
              'rate-limited'
            )
          : false
      )
    );
  }

  #render(): void {
    const sections: Node[] = [];

    // BUDGET block — first, because on a budget provider it is the answer to
    // the question the card was opened to ask.
    if (this.#budget) sections.push(this.#budgetSection(this.#budget));

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
      const grouped = groupScoops(this.#scoops);
      const scoopRows = grouped.individuals.map((s) =>
        h(
          'div',
          { class: 'scoop-row' },
          h('span', { class: 'scoop-name' }, s.name),
          h('span', { class: 'scoop-cost' }, `$${s.cost.toFixed(2)}`)
        )
      );
      const bucketRows = grouped.buckets.map((bucket) =>
        h(
          'div',
          { class: 'bucket-row', part: 'bucket' },
          `${bucket.count} ${bucket.count === 1 ? 'agent' : 'agents'} · $${bucket.cost.toFixed(2)}`
        )
      );

      sections.push(
        h(
          'div',
          { class: 'section section--scoops' },
          h('div', { class: 'section-title' }, 'BY AGENT'),
          ...scoopRows,
          ...bucketRows
        )
      );
    }

    // Total row
    const total = this.#total ?? this.#models.reduce((sum, m) => sum + m.cost, 0);
    sections.push(
      h(
        'div',
        { class: 'total-row' },
        // "Total" is a lie under a budget block: the window above it is the
        // total that matters, and this row is one session's dollars.
        h('span', { class: 'total-label' }, this.#budget ? 'This session' : 'Total'),
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
