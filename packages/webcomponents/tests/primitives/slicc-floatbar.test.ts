import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/nav/slicc-nav.js';
import { SliccFloatbar } from '../../src/primitives/slicc-floatbar.js';
import type { SliccFollowerHud } from '../../src/primitives/slicc-follower-hud.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('slicc-floatbar', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-floatbar')).toBe(SliccFloatbar);
  });

  it('renders the default label in its shadow root', () => {
    const el = document.createElement('slicc-floatbar');
    document.body.appendChild(el);
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.textContent).toContain('CLI float');
  });

  it('reflects the label attribute to the property and back', () => {
    const el = document.createElement('slicc-floatbar');
    el.label = 'CLI · tray · 1 follower';
    document.body.appendChild(el);
    expect(el.getAttribute('label')).toBe('CLI · tray · 1 follower');
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toContain(
      'CLI · tray · 1 follower'
    );

    el.removeAttribute('label');
    expect(el.label).toBe('CLI float');
  });

  it('reflects the linked boolean attribute to the property', () => {
    const el = document.createElement('slicc-floatbar');
    document.body.appendChild(el);
    expect(el.linked).toBe(false);
    el.linked = true;
    expect(el.hasAttribute('linked')).toBe(true);
    el.linked = false;
    expect(el.hasAttribute('linked')).toBe(false);
  });

  it('reflects the online boolean attribute to the property', () => {
    const el = document.createElement('slicc-floatbar');
    document.body.appendChild(el);
    expect(el.online).toBe(false);
    el.online = true;
    expect(el.hasAttribute('online')).toBe(true);
  });

  it('escapes label text', () => {
    const el = document.createElement('slicc-floatbar');
    el.label = '<script>x</script>';
    document.body.appendChild(el);
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.querySelector('script')).toBeNull();
    expect(label?.textContent).toBe('<script>x</script>');
  });

  describe('the status dot (online state)', () => {
    it('is absent by default', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.fdot')).toBeNull();
    });

    it('appears when online, exposing a `dot` part, painted green', () => {
      const el = document.createElement('slicc-floatbar');
      el.online = true;
      document.body.appendChild(el);
      const dot = el.shadowRoot?.querySelector('.fdot') as HTMLElement;
      expect(dot).not.toBeNull();
      expect(dot.getAttribute('part')).toBe('dot');
      // #22c55e === rgb(34, 197, 94)
      expect(getComputedStyle(dot).backgroundColor).toBe('rgb(34, 197, 94)');
    });

    it('toggles back off when online is cleared', () => {
      const el = document.createElement('slicc-floatbar');
      el.online = true;
      document.body.appendChild(el);
      el.online = false;
      expect(el.shadowRoot?.querySelector('.fdot')).toBeNull();
    });
  });

  describe('the pill appearance', () => {
    it('is a fully-rounded inline-flex pill at control height', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('inline-flex');
      expect(cs.borderTopLeftRadius).toBe('9999px');
      expect(cs.whiteSpace).toBe('nowrap');
      // --ctl-h defaults to 30px
      expect(cs.height).toBe('30px');
    });

    it('uses the neutral --line border when unlinked', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      // light --line === #e5e5e5
      expect(getComputedStyle(el).borderTopColor).toBe(rgb('#e5e5e5'));
    });

    it('rose-tints the border when linked', () => {
      const unlinked = document.createElement('slicc-floatbar');
      const linked = document.createElement('slicc-floatbar');
      linked.linked = true;
      document.body.append(unlinked, linked);
      const unlinkedColor = getComputedStyle(unlinked).borderTopColor;
      const linkedColor = getComputedStyle(linked).borderTopColor;
      // color-mix(--rose 40%, --line) differs from the plain --line border
      expect(linkedColor).not.toBe(unlinkedColor);
    });
  });

  describe('the cost segment (rate state)', () => {
    it('renders a zero hourly rate when rate is absent or zero', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$0.00/h');

      el.rate = 0;
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$0.00/h');
    });

    it('reflects the spent attribute to the property and back', () => {
      const el = document.createElement('slicc-floatbar');
      el.spent = '2.41';
      document.body.appendChild(el);
      expect(el.getAttribute('spent')).toBe('2.41');
      expect(el.spent).toBe('2.41');

      el.spent = null;
      expect(el.hasAttribute('spent')).toBe(false);
      expect(el.spent).toBeNull();
    });

    it('accepts a numeric value via the property setter', () => {
      const el = document.createElement('slicc-floatbar');
      el.spent = 2.41;
      document.body.appendChild(el);
      expect(el.getAttribute('spent')).toBe('2.41');
    });

    it('reflects the rate attribute to the property and back', () => {
      const el = document.createElement('slicc-floatbar');
      el.rate = 23.1;
      document.body.appendChild(el);
      expect(el.getAttribute('rate')).toBe('23.1');
      expect(el.rate).toBe('23.1');

      el.rate = null;
      expect(el.hasAttribute('rate')).toBe(false);
      expect(el.rate).toBeNull();
    });

    it('renders a divider, an svg icon, and the formatted amount', () => {
      const el = document.createElement('slicc-floatbar');
      el.rate = '23.1';
      el.spent = '99.50';
      document.body.appendChild(el);

      const sep = el.shadowRoot?.querySelector('.sep');
      expect(sep?.getAttribute('part')).toBe('sep');

      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      expect(spent).not.toBeNull();
      expect(spent.getAttribute('part')?.split(' ')).toEqual(['spent', 'rate']);
      // a real lucide <svg> is rendered (not an emoji / unicode glyph)
      expect(spent.querySelector('svg')).not.toBeNull();
      // the formatted amount, with the leading $
      expect(spent.querySelector('.amount')?.textContent).toBe('$23.10/h');
      // no bespoke currency glyph leaks through — only the $-prefixed amount
      expect(spent.textContent).toBe('$23.10/h');
      expect(spent.textContent).not.toMatch(/[💲💵🪙€£¢]/u);
    });

    it('formats a bare integer string to two decimals', () => {
      const el = document.createElement('slicc-floatbar');
      el.rate = '3';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$3.00/h');
    });

    it('tolerates a value that already carries a leading $', () => {
      const el = document.createElement('slicc-floatbar');
      el.setAttribute('rate', '$12.5');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$12.50/h');
    });

    it('renders zero for blank or non-numeric rate values', () => {
      const el = document.createElement('slicc-floatbar');
      el.setAttribute('rate', '   ');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$0.00/h');

      el.setAttribute('rate', 'free');
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$0.00/h');
    });

    it('falls back to zero when rate is cleared', () => {
      const el = document.createElement('slicc-floatbar');
      el.rate = '2.41';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$2.41/h');
      el.rate = null;
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$0.00/h');
    });

    it('coexists with the online status dot and the label', () => {
      const el = document.createElement('slicc-floatbar');
      el.online = true;
      el.rate = '12.07';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.fdot')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.label')?.textContent).toContain('CLI float');
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$12.07/h');
      expect(el.shadowRoot?.querySelector('.spent svg')).not.toBeNull();
    });
  });

  describe('dark mode', () => {
    it('flips the canvas/line/text tokens but keeps the dot green', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      const el = document.createElement('slicc-floatbar');
      el.online = true;
      wrap.appendChild(el);
      document.body.appendChild(wrap);

      const cs = getComputedStyle(el);
      // dark --canvas === #161618, dark --line === #2a2a2e
      expect(cs.backgroundColor).toBe(rgb('#161618'));
      expect(cs.borderTopColor).toBe(rgb('#2a2a2e'));

      const dot = el.shadowRoot?.querySelector('.fdot') as HTMLElement;
      expect(getComputedStyle(dot).backgroundColor).toBe('rgb(34, 197, 94)');
    });
  });

  describe('progressive available-space collapse', () => {
    const mountAt = (width: number): SliccFloatbar => {
      const nav = document.createElement('slicc-nav');
      nav.style.width = `${width}px`;
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.label = 'CLI · tray · 1 follower';
      el.online = true;
      el.rate = '2.41';
      nav.appendChild(el);
      document.body.appendChild(nav);
      return el;
    };

    it('shows every segment in a wide nav', () => {
      const el = mountAt(980);
      expect(getComputedStyle(el.shadowRoot?.querySelector('.detail') as Element).display).not.toBe(
        'none'
      );
      expect(getComputedStyle(el.shadowRoot?.querySelector('.spent') as Element).display).not.toBe(
        'none'
      );
      expect(getComputedStyle(el.shadowRoot?.querySelector('.tip') as Element).display).toBe(
        'none'
      );
      expect(el.hasAttribute('title')).toBe(false);
    });

    it('drops tray and follower before cost and runtime at mid width', () => {
      const el = mountAt(640);
      expect(getComputedStyle(el.shadowRoot?.querySelector('.detail') as Element).display).toBe(
        'none'
      );
      expect(getComputedStyle(el.shadowRoot?.querySelector('.spent') as Element).display).not.toBe(
        'none'
      );
      expect(
        getComputedStyle(el.shadowRoot?.querySelector('.runtime') as Element).display
      ).not.toBe('none');
    });

    it('drops cost before the runtime name when space tightens further', () => {
      const el = mountAt(500);
      expect(getComputedStyle(el.shadowRoot?.querySelector('.detail') as Element).display).toBe(
        'none'
      );
      expect(getComputedStyle(el.shadowRoot?.querySelector('.spent') as Element).display).toBe(
        'none'
      );
      expect(
        getComputedStyle(el.shadowRoot?.querySelector('.runtime') as Element).display
      ).not.toBe('none');
    });

    it('keeps only the status light in a square badge at 360px', () => {
      const el = mountAt(360);
      expect(getComputedStyle(el.shadowRoot?.querySelector('.label') as Element).display).toBe(
        'none'
      );
      expect(el.getBoundingClientRect().width).toBeCloseTo(30, 1);
      expect(el.getBoundingClientRect().height).toBeCloseTo(30, 1);
    });

    it('parses the label into a persistent runtime and droppable detail', () => {
      const el = mountAt(980);
      expect(el.shadowRoot?.querySelector('.runtime')?.textContent).toBe('CLI');
      expect(el.shadowRoot?.querySelector('.detail')?.textContent).toBe(' · tray · 1 follower');
    });

    it('renders a decorative tip part derived from the label, rate context, and state', () => {
      const el = mountAt(640);

      const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
      expect(tip).not.toBeNull();
      expect(tip.getAttribute('part')).toBe('tip');
      // decorative — the accessible name rides the host title, not the tip node
      expect(tip.getAttribute('aria-hidden')).toBe('true');
      expect(tip.textContent).toBe(
        'CLI · tray · 1 follower · $2.41/h · recency-weighted session avg · online'
      );
    });

    it('keeps the title threshold aligned with the container content box', () => {
      const collapsed = mountAt(750);
      expect(
        getComputedStyle(collapsed.shadowRoot?.querySelector('.detail') as Element).display
      ).toBe('none');
      expect(collapsed.hasAttribute('title')).toBe(true);

      const wide = mountAt(760);
      expect(
        getComputedStyle(wide.shadowRoot?.querySelector('.detail') as Element).display
      ).not.toBe('none');
      expect(wide.hasAttribute('title')).toBe(false);
    });

    it('reflects the offline state and the zero rate when unset', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.tip')?.textContent).toBe(
        'CLI float · $0.00/h · recency-weighted session avg · offline'
      );
    });

    it('keeps the tooltip out of layout until hover or focus', () => {
      const el = mountAt(640);
      expect(getComputedStyle(el.shadowRoot?.querySelector('.tip') as Element).display).toBe(
        'none'
      );
      expect(el.shadowRoot?.querySelector('.tip')?.textContent).toContain('tray · 1 follower');
      const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
      expect(
        Array.from(sheet.cssRules).some(
          (rule) =>
            rule.cssText.includes(':host(:hover) .tip') && rule.cssText.includes('display: block')
        )
      ).toBe(true);
    });

    it('exposes the tip text as an accessible host title only when collapsed', () => {
      const el = mountAt(640);
      expect(el.getAttribute('title')).toBe(
        'CLI · tray · 1 follower · $2.41/h · recency-weighted session avg · online'
      );
    });

    it('omits the host title in the wide pill (no redundant tooltip)', () => {
      expect(mountAt(980).hasAttribute('title')).toBe(false);
    });

    it('updates the accessible title when available nav width changes', async () => {
      const el = mountAt(980);
      const nav = el.closest('slicc-nav') as HTMLElement;
      nav.style.width = '640px';
      await vi.waitFor(() => expect(el.getAttribute('title')).toContain('tray · 1 follower'));

      nav.style.width = '980px';
      await vi.waitFor(() => expect(el.hasAttribute('title')).toBe(false));
    });
  });

  describe('cost overlay integration', () => {
    it('exposes costModels and costScoops properties', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);

      expect(el.costModels).toEqual([]);
      expect(el.costScoops).toEqual([]);

      const models = [{ model: 'claude-opus-4-6', cost: 1.5, turns: 3, tokens: 50000 }];
      const scoops = [{ name: 'sliccy', model: 'opus-4-6', cost: 1.5, type: 'cone' as const }];
      el.costModels = models;
      el.costScoops = scoops;
      expect(el.costModels).toBe(models);
      expect(el.costScoops).toBe(scoops);
    });

    it('creates and shows overlay on mouseenter of the spent segment', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.spent = '2.41';
      el.costModels = [{ model: 'claude-opus-4-6', cost: 2.41, turns: 5, tokens: 100000 }];
      document.body.appendChild(el);

      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      expect(spent).not.toBeNull();

      spent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

      const overlay = el.shadowRoot?.querySelector('slicc-cost-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay?.hasAttribute('open')).toBe(true);
    });

    it('shows rate in the pill and spent as the cumulative overlay total', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.rate = 23.1;
      el.spent = 23.19;
      el.costModels = [{ model: 'active-model', cost: 4.5, turns: 8 }];
      document.body.appendChild(el);

      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$23.10/h');
      const rate = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      rate.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const overlay = el.shadowRoot?.querySelector('slicc-cost-overlay');
      expect(overlay?.shadowRoot?.querySelector('.total-cost')?.textContent).toBe('$23.19');
    });

    it('hides overlay on mouseleave after delay', async () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.spent = '2.41';
      el.costModels = [{ model: 'claude-opus-4-6', cost: 2.41, turns: 5, tokens: 100000 }];
      document.body.appendChild(el);

      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      spent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      spent.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

      await new Promise((r) => setTimeout(r, 200));

      const overlay = el.shadowRoot?.querySelector('slicc-cost-overlay');
      expect(overlay?.hasAttribute('open')).toBe(false);
    });

    it('does not re-render when attribute value is unchanged', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.spent = '2.41';
      el.costModels = [{ model: 'claude-opus-4-6', cost: 2.41, turns: 5, tokens: 100000 }];
      document.body.appendChild(el);

      // Show overlay
      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      spent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const overlay = el.shadowRoot?.querySelector('slicc-cost-overlay');
      expect(overlay?.hasAttribute('open')).toBe(true);

      // Set same value — should NOT re-render and destroy overlay
      el.setAttribute('spent', '2.41');
      const overlayAfter = el.shadowRoot?.querySelector('slicc-cost-overlay');
      expect(overlayAfter).not.toBeNull();
      expect(overlayAfter?.hasAttribute('open')).toBe(true);
    });

    it('passes updated costModels to the overlay when set after creation', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      el.spent = '1.00';
      el.costModels = [{ model: 'claude-opus-4-6', cost: 1.0, turns: 2, tokens: 30000 }];
      document.body.appendChild(el);

      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      spent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

      const newModels = [{ model: 'claude-sonnet-4-6', cost: 2.0, turns: 4, tokens: 60000 }];
      el.costModels = newModels;

      const overlay = el.shadowRoot?.querySelector('slicc-cost-overlay') as any;
      expect(overlay.models).toBe(newModels);
    });
  });

  describe('followers segment', () => {
    const rows = () => [
      {
        id: 'follower-cli1',
        icon: 'terminal',
        title: 'CLI · build-box',
        state: 'active' as const,
        stateText: 'connected 2h',
        chips: ['can run commands'],
      },
      {
        id: 'follower-ios1',
        icon: 'smartphone',
        title: 'iOS · phone1',
        state: 'active' as const,
        stateText: 'connected 4m',
      },
    ];

    it('renders nothing until there are followers', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.followers')).toBeNull();
      expect(el.hasAttribute('follower-count')).toBe(false);
    });

    it('renders the count and reflects follower-count once followers arrive', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLElement;
      expect(segment).not.toBeNull();
      expect(segment.textContent).toContain('2');
      expect(el.getAttribute('follower-count')).toBe('2');
    });

    it('drops the segment and the attribute when the last follower leaves', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      el.followers = [];
      expect(el.shadowRoot?.querySelector('.followers')).toBeNull();
      expect(el.hasAttribute('follower-count')).toBe(false);
    });

    it('is a button with an accessible name naming the count', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = [rows()[0]];
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLButtonElement;
      expect(segment.tagName).toBe('BUTTON');
      expect(segment.getAttribute('aria-label')).toMatch(/^1 follower connected/);
      expect(segment.getAttribute('aria-haspopup')).toBe('dialog');
    });

    it('opens the follower HUD on hover and closes it on leave', async () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLElement;

      segment.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const hud = el.shadowRoot?.querySelector('slicc-follower-hud');
      expect(hud?.hasAttribute('open')).toBe(true);

      segment.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hud?.hasAttribute('open')).toBe(false);
    });

    it('opens the HUD on keyboard focus too', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLElement;
      segment.dispatchEvent(new FocusEvent('focus'));
      expect(el.shadowRoot?.querySelector('slicc-follower-hud')?.hasAttribute('open')).toBe(true);
    });

    it('closes the HUD on Escape', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLElement;
      segment.dispatchEvent(new FocusEvent('focus'));
      segment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(el.shadowRoot?.querySelector('slicc-follower-hud')?.hasAttribute('open')).toBe(false);
    });

    it('hands the HUD the current rows', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      const segment = el.shadowRoot?.querySelector('.followers') as HTMLElement;
      segment.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const hud = el.shadowRoot?.querySelector('slicc-follower-hud') as SliccFollowerHud;
      expect(hud.rows).toHaveLength(2);
      expect(hud.shadowRoot?.textContent).toContain('CLI · build-box');
    });

    it('emits a composed slicc-followers-click on activation', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      let seen = 0;
      document.addEventListener('slicc-followers-click', () => {
        seen += 1;
      });
      (el.shadowRoot?.querySelector('.followers') as HTMLButtonElement).click();
      expect(seen).toBe(1);
    });

    it('surfaces the follower count in the collapsed-view tip', () => {
      const el = document.createElement('slicc-floatbar') as SliccFloatbar;
      document.body.appendChild(el);
      el.followers = rows();
      expect(el.shadowRoot?.querySelector('.tip')?.textContent).toContain('2 followers');
    });
  });
});
