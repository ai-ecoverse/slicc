import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CostOverlayBudget,
  type CostOverlayModel,
  type CostOverlayScoop,
  SliccCostOverlay,
} from '../../src/primitives/slicc-cost-overlay.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function liveScaleScoops(): CostOverlayScoop[] {
  return [
    { name: 'sliccy', model: 'opus-4-6', cost: 12.45, type: 'cone' },
    { name: 'architect', model: 'opus-4-6', cost: 4.12, type: 'scoop' },
    { name: 'implementer', model: 'sonnet-4-6', cost: 2.1, type: 'scoop' },
    { name: 'reviewer', model: 'sonnet-4-6', cost: 1.15, type: 'scoop' },
    { name: 'researcher', model: 'haiku-4-5', cost: 0.95, type: 'scoop' },
    ...Array.from({ length: 117 }, (_, index) => ({
      name: `agent-${index + 1}`,
      model: 'haiku-4-5',
      cost: index === 0 ? 0.1 : 0.02,
      type: 'scoop' as const,
    })),
  ];
}

describe('slicc-cost-overlay', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-cost-overlay')).toBe(SliccCostOverlay);
  });

  describe('visibility', () => {
    it('card is hidden (display:none) when open attribute is absent', () => {
      const el = document.createElement('slicc-cost-overlay');
      document.body.appendChild(el);
      const card = el.shadowRoot?.querySelector('.card') as HTMLElement;
      expect(card).not.toBeNull();
      expect(getComputedStyle(card).display).toBe('none');
    });

    it('card is visible when open is set', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.open = true;
      document.body.appendChild(el);
      const card = el.shadowRoot?.querySelector('.card') as HTMLElement;
      expect(card).not.toBeNull();
      expect(getComputedStyle(card).display).toBe('flex');
    });

    it('open property reflects to/from attribute', () => {
      const el = document.createElement('slicc-cost-overlay');
      document.body.appendChild(el);

      expect(el.open).toBe(false);
      expect(el.hasAttribute('open')).toBe(false);

      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);

      el.setAttribute('open', '');
      expect(el.open).toBe(true);

      el.removeAttribute('open');
      expect(el.open).toBe(false);
    });
  });

  describe('per-model rows', () => {
    it('renders model rows from the models property', () => {
      const el = document.createElement('slicc-cost-overlay');
      const models: CostOverlayModel[] = [
        { model: 'claude-opus-4-6', cost: 3.5, turns: 8, tokens: 150_000 },
        { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3, tokens: 45_000 },
        { model: 'claude-haiku-4-5', cost: 0.02, turns: 1, tokens: 2_000 },
      ];
      el.models = models;
      el.open = true;
      document.body.appendChild(el);

      const modelSection = el.shadowRoot?.querySelector('.section--models');
      expect(modelSection).not.toBeNull();

      const rows = modelSection?.querySelectorAll('.model-row');
      expect(rows?.length).toBe(3);

      const firstRow = rows?.[0];
      expect(firstRow?.textContent).toContain('opus-4-6');
      expect(firstRow?.textContent).toContain('150K');
      expect(firstRow?.textContent).toContain('$3.50');
    });

    it('formats tokens as M for millions', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [{ model: 'claude-opus-4-6', cost: 5.0, turns: 20, tokens: 2_500_000 }];
      el.open = true;
      document.body.appendChild(el);

      const row = el.shadowRoot?.querySelector('.model-row');
      expect(row?.textContent).toContain('2.5M');
    });

    it('omits token display when tokens is 0 or undefined', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [{ model: 'claude-opus-4-6', cost: 1.0, turns: 2 }];
      el.open = true;
      document.body.appendChild(el);

      const tokenEl = el.shadowRoot?.querySelector('.model-tokens');
      expect(tokenEl).toBeNull();
    });

    it('strips claude- prefix from model names', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [
        { model: 'claude-opus-4-20250514', cost: 1.0, turns: 2, tokens: 50_000 },
        { model: 'claude-sonnet-4-6', cost: 0.5, turns: 1, tokens: 20_000 },
      ];
      el.open = true;
      document.body.appendChild(el);

      const rows = el.shadowRoot?.querySelectorAll('.model-row');
      expect(rows?.[0]?.textContent).toContain('opus-4-20250514');
      expect(rows?.[1]?.textContent).toContain('sonnet-4-6');
    });

    it('handles empty models array', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [];
      el.open = true;
      document.body.appendChild(el);

      const rows = el.shadowRoot?.querySelectorAll('.model-row');
      expect(rows?.length).toBe(0);
    });
  });

  describe('per-scoop rows', () => {
    it('renders scoop rows from the scoops property', () => {
      const el = document.createElement('slicc-cost-overlay');
      const scoops: CostOverlayScoop[] = [
        { name: 'sliccy', model: 'opus-4-6', cost: 2.8, type: 'cone' },
        { name: 'researcher', model: 'sonnet-4-6', cost: 0.94, type: 'scoop' },
        { name: 'code-review', model: 'sonnet-4-6', cost: 0.2, type: 'scoop' },
        { name: 'quick-lookup', model: 'haiku-4-5', cost: 0.02, type: 'scoop' },
      ];
      el.scoops = scoops;
      el.open = true;
      document.body.appendChild(el);

      const scoopSection = el.shadowRoot?.querySelector('.section--scoops');
      expect(scoopSection).not.toBeNull();

      const rows = scoopSection?.querySelectorAll('.scoop-row');
      expect(rows?.length).toBe(4);
      expect(scoopSection?.querySelector('.bucket-row')).toBeNull();

      // Check first scoop row content
      const firstRow = rows?.[0];
      expect(firstRow?.textContent).toContain('sliccy');
      expect(firstRow?.textContent).toContain('$2.80');
    });

    it('keeps five agents as individual rows without sorting or bucketing', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.scoops = Array.from({ length: 5 }, (_, index) => ({
        name: `agent-${index + 1}`,
        model: 'haiku-4-5',
        cost: (index + 1) * 0.1,
        type: 'scoop' as const,
      }));
      el.open = true;
      document.body.appendChild(el);

      const section = el.shadowRoot?.querySelector('.section--scoops');
      const rows = section?.querySelectorAll('.scoop-row');
      expect(rows).toHaveLength(5);
      expect(rows?.[0]?.textContent).toContain('agent-1');
      expect(section?.querySelectorAll('.bucket-row')).toHaveLength(0);
    });

    it('renders 122 agents as five highest-cost rows plus $1-or-larger buckets', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [{ model: 'all-models', cost: 23.19, turns: 122 }];
      el.scoops = liveScaleScoops();
      el.open = true;
      document.body.appendChild(el);

      const section = el.shadowRoot?.querySelector('.section--scoops');
      const individualRows = Array.from(section?.querySelectorAll('.scoop-row') ?? []);
      expect(individualRows).toHaveLength(5);
      expect(individualRows.map((row) => row.querySelector('.scoop-name')?.textContent)).toEqual([
        'sliccy',
        'architect',
        'implementer',
        'reviewer',
        'researcher',
      ]);

      const bucketRows = Array.from(section?.querySelectorAll('.bucket-row') ?? []);
      expect(bucketRows.length).toBeGreaterThan(0);
      expect(bucketRows.map((row) => row.textContent)).toEqual([
        '46 agents · $1.00',
        '71 agents · $1.42',
      ]);
      const bucketCosts = bucketRows.map((row) => {
        expect(row.getAttribute('part')).toBe('bucket');
        expect(row.textContent).toMatch(/^[0-9]+ agents? · \$[0-9]+\.[0-9]{2}$/);
        return Number.parseFloat(row.textContent?.split('$')[1] ?? '0');
      });
      expect(bucketCosts.every((cost) => cost >= 1)).toBe(true);

      const individualTotal = individualRows.reduce((sum, row) => {
        return (
          sum + Number.parseFloat(row.querySelector('.scoop-cost')?.textContent?.slice(1) ?? '0')
        );
      }, 0);
      expect(individualTotal + bucketCosts.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(
        23.19,
        2
      );
      expect(el.shadowRoot?.querySelector('.total-cost')?.textContent).toBe('$23.19');
    });

    it('handles empty scoops array', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.scoops = [];
      el.open = true;
      document.body.appendChild(el);

      const rows = el.shadowRoot?.querySelectorAll('.scoop-row');
      expect(rows?.length).toBe(0);
    });
  });

  describe('total row', () => {
    it('renders a total row summing model costs', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [
        { model: 'opus-4-6', cost: 3.5, turns: 8 },
        { model: 'sonnet-4-6', cost: 0.44, turns: 3 },
        { model: 'haiku-4-5', cost: 0.02, turns: 1 },
      ];
      el.open = true;
      document.body.appendChild(el);

      const totalRow = el.shadowRoot?.querySelector('.total-row');
      expect(totalRow).not.toBeNull();
      expect(totalRow?.textContent).toContain('Total');
      expect(totalRow?.textContent).toContain('$3.96');
    });

    it('displays $0.00 when models array is empty', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [];
      el.open = true;
      document.body.appendChild(el);

      const totalRow = el.shadowRoot?.querySelector('.total-row');
      expect(totalRow?.textContent).toContain('$0.00');
    });

    it('uses an explicit cumulative total when provided', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [{ model: 'active-model', cost: 2.41, turns: 3 }];
      el.total = 23.19;
      el.open = true;
      document.body.appendChild(el);

      expect(el.shadowRoot?.querySelector('.total-cost')?.textContent).toBe('$23.19');
    });
  });

  describe('complete UI structure', () => {
    it('renders all three sections with headers when data is provided', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [{ model: 'opus-4-6', cost: 2.0, turns: 5 }];
      el.scoops = [{ name: 'sliccy', model: 'opus-4-6', cost: 2.0, type: 'cone' }];
      el.open = true;
      document.body.appendChild(el);

      const modelHeader = el.shadowRoot?.querySelector('.section-title');
      expect(modelHeader?.textContent).toContain('BY MODEL');

      const scoopHeader = Array.from(el.shadowRoot?.querySelectorAll('.section-title') || []).find(
        (h) => h.textContent?.includes('BY AGENT')
      );
      expect(scoopHeader).toBeDefined();
      expect(scoopHeader?.textContent).toContain('BY AGENT');

      const totalRow = el.shadowRoot?.querySelector('.total-row');
      expect(totalRow).not.toBeNull();
    });
  });

  describe('positioning', () => {
    it('host is absolutely positioned below its parent', () => {
      const el = document.createElement('slicc-cost-overlay');
      document.body.appendChild(el);

      const cs = getComputedStyle(el);
      expect(cs.position).toBe('absolute');
      expect(cs.zIndex).toBe('100');
    });
  });
});

describe('slicc-cost-overlay budget mode', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  const models: CostOverlayModel[] = [
    { model: 'claude-opus-4-6', cost: 20.34, turns: 36, tokens: 5_400_000 },
    { model: 'claude-sonnet-4-6', cost: 8.72, turns: 28, tokens: 1_900_000 },
  ];

  const mount = (budget: CostOverlayBudget | null): SliccCostOverlay => {
    const el = document.createElement('slicc-cost-overlay');
    el.models = models;
    el.total = 29.06;
    el.budget = budget;
    el.open = true;
    document.body.appendChild(el);
    return el;
  };

  it('renders no budget block on a metered provider', () => {
    const el = mount(null);
    expect(el.shadowRoot?.querySelector('.budget')).toBeNull();
    expect(el.shadowRoot?.querySelector('.total-label')?.textContent).toBe('Total');
  });

  it('leads the card with the window and demotes the dollar total', () => {
    const el = mount({ percent: 9.5, status: 'ok', resets: 'resets Sun 14 Sep' });
    const sections = [...(el.shadowRoot?.querySelectorAll('.section') ?? [])];
    expect(sections[0]?.classList.contains('budget')).toBe(true);
    expect(el.shadowRoot?.querySelector('.section-title')?.textContent).toBe('WEEKLY BUDGET');
    expect(el.shadowRoot?.querySelector('.budget-figure')?.textContent).toBe('9.5%');
    expect(el.shadowRoot?.querySelector('.budget-used')?.textContent).toBe('used');
    expect(el.shadowRoot?.querySelector('.budget-resets')?.textContent).toBe('resets Sun 14 Sep');
    // The dollars survive — as one session's share, not as "the total".
    expect(el.shadowRoot?.querySelector('.total-label')?.textContent).toBe('This session');
    expect(el.shadowRoot?.querySelector('.total-cost')?.textContent).toBe('$29.06');
  });

  it('fills the meter to the reported percent', () => {
    const el = mount({ percent: 63.2 });
    const fill = el.shadowRoot?.querySelector('.budget-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('63.2%');
  });

  it('clamps the bar at an overrun but keeps the figure honest', () => {
    const el = mount({ percent: 104, status: 'rate-limited' });
    const fill = el.shadowRoot?.querySelector('.budget-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(el.shadowRoot?.querySelector('.budget-figure')?.textContent).toBe('104%');
  });

  it('carries a rate-limited window as a word, not only as a color', () => {
    const el = mount({ percent: 96, status: 'rate-limited', resets: 'resets in 18h' });
    const block = el.shadowRoot?.querySelector('.budget') as HTMLElement;
    expect(block.dataset.budgetLevel).toBe('critical');
    expect(block.dataset.budgetStatus).toBe('rate-limited');
    const flag = el.shadowRoot?.querySelector('.budget-flag');
    expect(flag?.textContent).toContain('rate-limited');
    expect(flag?.querySelector('svg')).not.toBeNull();
  });

  it('shows no refusal chip on a healthy window', () => {
    const el = mount({ percent: 9.5, status: 'ok' });
    expect(el.shadowRoot?.querySelector('.budget-flag')).toBeNull();
  });

  it('names a custom window in the section title', () => {
    const el = mount({ percent: 40, window: 'monthly' });
    expect(el.shadowRoot?.querySelector('.section-title')?.textContent).toBe('MONTHLY BUDGET');
  });

  it('treats a non-finite percent as no budget at all', () => {
    const el = mount({ percent: Number.NaN });
    expect(el.budget).toBeNull();
    expect(el.shadowRoot?.querySelector('.budget')).toBeNull();
  });

  it('re-renders when the window is cleared', () => {
    const el = mount({ percent: 9.5 });
    el.budget = null;
    expect(el.shadowRoot?.querySelector('.budget')).toBeNull();
    expect(el.shadowRoot?.querySelector('.total-label')?.textContent).toBe('Total');
  });
});
