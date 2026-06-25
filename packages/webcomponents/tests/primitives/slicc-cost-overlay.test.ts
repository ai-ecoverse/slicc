import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CostOverlayModel,
  type CostOverlayScoop,
  SliccCostOverlay,
} from '../../src/primitives/slicc-cost-overlay.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

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
        { model: 'claude-opus-4-6', cost: 3.5, turns: 8 },
        { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3 },
        { model: 'claude-haiku-4-5', cost: 0.02, turns: 1 },
      ];
      el.models = models;
      el.open = true;
      document.body.appendChild(el);

      const modelSection = el.shadowRoot?.querySelector('.section--models');
      expect(modelSection).not.toBeNull();

      const rows = modelSection?.querySelectorAll('.model-row');
      expect(rows?.length).toBe(3);

      // Check first model row content
      const firstRow = rows?.[0];
      expect(firstRow?.textContent).toContain('opus-4-6');
      expect(firstRow?.textContent).toContain('8');
      expect(firstRow?.textContent).toContain('$3.50');
    });

    it('strips claude- prefix and trailing date from model names', () => {
      const el = document.createElement('slicc-cost-overlay');
      el.models = [
        { model: 'claude-opus-4-20250514', cost: 1.0, turns: 2 },
        { model: 'claude-sonnet-4-6', cost: 0.5, turns: 1 },
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

      // Check first scoop row content
      const firstRow = rows?.[0];
      expect(firstRow?.textContent).toContain('sliccy');
      expect(firstRow?.textContent).toContain('$2.80');
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
    it('is absolutely positioned below its parent', () => {
      const el = document.createElement('slicc-cost-overlay');
      document.body.appendChild(el);

      const card = el.shadowRoot?.querySelector('.card') as HTMLElement;
      const cs = getComputedStyle(card);
      expect(cs.position).toBe('absolute');
      expect(cs.top).toBe('calc(100% + 8px)');
      expect(cs.right).toBe('0px');
    });

    it('has a high z-index to float above content', () => {
      const el = document.createElement('slicc-cost-overlay');
      document.body.appendChild(el);

      const card = el.shadowRoot?.querySelector('.card') as HTMLElement;
      expect(getComputedStyle(card).zIndex).toBe('100');
    });
  });
});
