import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';
import './slicc-cost-overlay.js';
import type { CostOverlayBudget } from './slicc-cost-overlay.js';
import type { SliccFloatbar } from './slicc-floatbar.js';

const meta: Meta = {
  title: 'Primitives/CostOverlay',
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

const liveScaleScoops = () => [
  { name: 'sliccy', model: 'claude-opus-4-6', cost: 12.45, type: 'cone' as const },
  { name: 'architect', model: 'claude-opus-4-6', cost: 4.12, type: 'scoop' as const },
  { name: 'implementer', model: 'claude-sonnet-4-6', cost: 2.1, type: 'scoop' as const },
  { name: 'reviewer', model: 'claude-sonnet-4-6', cost: 1.15, type: 'scoop' as const },
  { name: 'researcher', model: 'claude-haiku-4-5', cost: 0.95, type: 'scoop' as const },
  ...Array.from({ length: 117 }, (_, index) => ({
    name: `agent-${String(index + 1).padStart(3, '0')}`,
    model: 'claude-haiku-4-5',
    cost: index === 0 ? 0.1 : 0.02,
    type: 'scoop' as const,
  })),
];

/** Standalone overlay card (always open) showing typical session data. */
export const Standalone: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [
      { model: 'claude-opus-4-6', cost: 3.5, turns: 8, tokens: 1_200_000 },
      { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3, tokens: 85_000 },
      { model: 'claude-haiku-4-5', cost: 0.02, turns: 1, tokens: 4_500 },
    ];
    el.scoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 2.8, type: 'cone' },
      { name: 'researcher', model: 'claude-sonnet-4-6', cost: 0.94, type: 'scoop' },
      { name: 'code-review', model: 'claude-sonnet-4-6', cost: 0.2, type: 'scoop' },
      { name: 'quick-lookup', model: 'claude-haiku-4-5', cost: 0.02, type: 'scoop' },
    ];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

/** Floatbar with cost overlay — hover the $ amount to see the overlay. */
export const FloatbarWithOverlay: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.justifyContent = 'flex-end';
    wrapper.style.padding = '16px 24px';

    const fb = document.createElement('slicc-floatbar') as SliccFloatbar;
    fb.label = 'npx';
    fb.connection = 'live';
    fb.floatKind = 'npx';
    fb.spent = '3.96';
    fb.costModels = [
      { model: 'claude-opus-4-6', cost: 3.5, turns: 8, tokens: 1_200_000 },
      { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3, tokens: 85_000 },
      { model: 'claude-haiku-4-5', cost: 0.02, turns: 1, tokens: 4_500 },
    ];
    fb.costScoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 2.8, type: 'cone' },
      { name: 'researcher', model: 'claude-sonnet-4-6', cost: 0.94, type: 'scoop' },
      { name: 'code-review', model: 'claude-sonnet-4-6', cost: 0.2, type: 'scoop' },
      { name: 'quick-lookup', model: 'claude-haiku-4-5', cost: 0.02, type: 'scoop' },
    ];
    wrapper.appendChild(fb);
    return wrapper;
  },
};

/** Overlay with only models (no scoops section). */
export const ModelsOnly: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [{ model: 'claude-opus-4-6', cost: 1.23, turns: 4, tokens: 450_000 }];
    el.scoops = [];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

/** Large session with many models and agents. */
export const LargeSession: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [
      { model: 'claude-opus-4-6', cost: 12.45, turns: 30, tokens: 4_200_000 },
      { model: 'claude-sonnet-4-6', cost: 3.21, turns: 15, tokens: 1_800_000 },
      { model: 'claude-haiku-4-5', cost: 0.18, turns: 8, tokens: 120_000 },
    ];
    el.scoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 8.5, type: 'cone' },
      { name: 'architect', model: 'claude-opus-4-6', cost: 3.95, type: 'scoop' },
      { name: 'implementer-1', model: 'claude-sonnet-4-6', cost: 1.8, type: 'scoop' },
      { name: 'implementer-2', model: 'claude-sonnet-4-6', cost: 1.41, type: 'scoop' },
      { name: 'reviewer', model: 'claude-haiku-4-5', cost: 0.18, type: 'scoop' },
    ];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

/** Live-scale 122-agent session: five leaders plus bounded aggregate buckets. */
export const HundredTwentyTwoAgents: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.margin = '16px 0 0 100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [
      { model: 'claude-opus-4-6', cost: 16.57, turns: 36, tokens: 5_400_000 },
      { model: 'claude-sonnet-4-6', cost: 3.25, turns: 28, tokens: 1_900_000 },
      { model: 'claude-haiku-4-5', cost: 3.37, turns: 122, tokens: 840_000 },
    ];
    el.scoops = liveScaleScoops();
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

const budgetModels = () => [
  { model: 'claude-opus-4-6', cost: 20.34, turns: 36, tokens: 5_400_000 },
  { model: 'claude-sonnet-4-6', cost: 6.85, turns: 28, tokens: 1_900_000 },
  { model: 'claude-haiku-4-5', cost: 1.87, turns: 41, tokens: 840_000 },
];

const budgetScoops = () => [
  { name: 'sliccy', model: 'claude-opus-4-6', cost: 17.2, type: 'cone' as const },
  { name: 'loose-ends', model: 'claude-sonnet-4-6', cost: 5.4, type: 'scoop' as const },
  { name: 'review', model: 'claude-sonnet-4-6', cost: 3.62, type: 'scoop' as const },
  { name: 'agent-memory-curator', model: 'claude-haiku-4-5', cost: 2.84, type: 'scoop' as const },
];

function budgetCard(budget: CostOverlayBudget): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:inline-block;margin:16px 0 0 100px;';
  const el = document.createElement('slicc-cost-overlay');
  el.models = budgetModels();
  el.scoops = budgetScoops();
  el.budget = budget;
  el.total = 29.06;
  el.open = true;
  wrapper.appendChild(el);
  return wrapper;
}

/**
 * Budget mode, mid-window. The rolling window leads the card with the percent
 * USED and a meter; BY MODEL / BY AGENT are unchanged below it, and the total
 * row is relabelled "This session" — under a shared allowance those dollars
 * are one session's share, not the total that decides whether work continues.
 */
export const BudgetStandalone: Story = {
  render: () => budgetCard({ percent: 9.5, status: 'ok', resets: 'resets Sun 14 Sep' }),
};

/** Amber from 80% — the window, not the spend, is what changed color. */
export const BudgetNearLimit: Story = {
  render: () => budgetCard({ percent: 92, status: 'ok', resets: 'resets in 18h' }),
};

/**
 * The provider is refusing calls. The rate-limited chip carries a word and a
 * glyph, not just the rose bar: `--waffle`/`--rose` alone would not clear
 * contrast on this surface.
 */
export const BudgetRateLimited: Story = {
  render: () => budgetCard({ percent: 96, status: 'rate-limited', resets: 'resets in 18h' }),
};

/** An overrun window: the bar clamps at 100%, the figure reports 104%. */
export const BudgetOverrun: Story = {
  render: () => budgetCard({ percent: 104, status: 'rate-limited', resets: 'resets Mon 09:00' }),
};

/**
 * The same session, both billing modes, side by side — metered on the left
 * (today's card, unchanged) and budget on the right.
 */
export const DollarVsBudget: Story = {
  render: () => {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;gap:64px;padding:16px 24px 220px;align-items:flex-start;';

    const column = (title: string, note: string, card: HTMLElement) => {
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-width:340px;';
      const h3 = document.createElement('h3');
      h3.style.cssText = 'font:600 12px/1 var(--ui,system-ui);margin:0;color:var(--ink,#111);';
      h3.textContent = title;
      const p = document.createElement('p');
      p.style.cssText = 'font:11px/1.4 var(--ui,system-ui);color:var(--txt-2,#666);margin:0;';
      p.textContent = note;
      col.append(h3, p, card);
      return col;
    };

    const metered = document.createElement('div');
    metered.style.cssText = 'position:relative;display:inline-block;';
    const meteredCard = document.createElement('slicc-cost-overlay');
    meteredCard.models = budgetModels();
    meteredCard.scoops = budgetScoops();
    meteredCard.total = 29.06;
    meteredCard.open = true;
    metered.appendChild(meteredCard);

    const budget = document.createElement('div');
    budget.style.cssText = 'position:relative;display:inline-block;';
    const budgetEl = document.createElement('slicc-cost-overlay');
    budgetEl.models = budgetModels();
    budgetEl.scoops = budgetScoops();
    budgetEl.total = 29.06;
    budgetEl.budget = { percent: 9.5, status: 'ok', resets: 'resets Sun 14 Sep' };
    budgetEl.open = true;
    budget.appendChild(budgetEl);

    root.append(
      column('Metered', 'Dollars are the whole story; "Total" is the total.', metered),
      column('Budget', 'The window leads; the same dollars survive as "This session".', budget)
    );
    return root;
  },
};

/** Floatbar in budget mode with its card open — hover the % to reveal it. */
export const FloatbarWithBudgetOverlay: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;justify-content:flex-end;padding:16px 24px 320px;';

    const fb = document.createElement('slicc-floatbar') as SliccFloatbar;
    fb.label = 'npx';
    fb.connection = 'live';
    fb.floatKind = 'npx';
    fb.trayRole = 'leader';
    fb.spent = '29.06';
    fb.budget = { percent: 63.2, status: 'ok', resets: 'resets in 3d' };
    fb.costModels = budgetModels();
    fb.costScoops = budgetScoops();
    wrapper.appendChild(fb);
    return wrapper;
  },
};
