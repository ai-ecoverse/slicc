import { beforeEach, describe, expect, it } from 'vitest';
import { SliccFloatbar } from '../../src/primitives/slicc-floatbar.js';
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

  describe('the cost segment (spent state)', () => {
    it('is absent by default', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.spent')).toBeNull();
      expect(el.shadowRoot?.querySelector('.sep')).toBeNull();
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

    it('renders a divider, an svg icon, and the formatted amount', () => {
      const el = document.createElement('slicc-floatbar');
      el.spent = '2.41';
      document.body.appendChild(el);

      const sep = el.shadowRoot?.querySelector('.sep');
      expect(sep?.getAttribute('part')).toBe('sep');

      const spent = el.shadowRoot?.querySelector('.spent') as HTMLElement;
      expect(spent).not.toBeNull();
      expect(spent.getAttribute('part')).toBe('spent');
      // a real lucide <svg> is rendered (not an emoji / unicode glyph)
      expect(spent.querySelector('svg')).not.toBeNull();
      // the formatted amount, with the leading $
      expect(spent.querySelector('.amount')?.textContent).toBe('$2.41');
      // no bespoke currency glyph leaks through — only the $-prefixed amount
      expect(spent.textContent).toBe('$2.41');
      expect(spent.textContent).not.toMatch(/[💲💵🪙€£¢]/u);
    });

    it('formats a bare integer string to two decimals', () => {
      const el = document.createElement('slicc-floatbar');
      el.spent = '3';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$3.00');
    });

    it('tolerates a value that already carries a leading $', () => {
      const el = document.createElement('slicc-floatbar');
      el.setAttribute('spent', '$12.5');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$12.50');
    });

    it('renders nothing for blank or non-numeric values', () => {
      const el = document.createElement('slicc-floatbar');
      el.setAttribute('spent', '   ');
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.spent')).toBeNull();

      el.setAttribute('spent', 'free');
      expect(el.shadowRoot?.querySelector('.spent')).toBeNull();
    });

    it('toggles back off when spent is cleared', () => {
      const el = document.createElement('slicc-floatbar');
      el.spent = '2.41';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.spent')).not.toBeNull();
      el.spent = null;
      expect(el.shadowRoot?.querySelector('.spent')).toBeNull();
      expect(el.shadowRoot?.querySelector('.sep')).toBeNull();
    });

    it('coexists with the online status dot and the label', () => {
      const el = document.createElement('slicc-floatbar');
      el.online = true;
      el.spent = '12.07';
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.fdot')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.label')?.textContent).toContain('CLI float');
      expect(el.shadowRoot?.querySelector('.amount')?.textContent).toBe('$12.07');
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

  describe('narrow / extension-sidebar', () => {
    const narrowMedia = (el: SliccFloatbar): CSSMediaRule => {
      const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
      const media = Array.from(sheet.cssRules).find(
        (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('560px')
      );
      expect(media).toBeDefined();
      return media as CSSMediaRule;
    };

    it('collapses to just the status light below 560px (label, divider + cost all hidden)', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      const hideRule = Array.from(narrowMedia(el).cssRules).find(
        (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('.spent')
      );
      // One rule hides .label, .sep AND .spent — leaving only the .fdot dot.
      expect(hideRule?.style.display).toBe('none');
      expect(hideRule?.selectorText).toContain('.label');
      expect(hideRule?.selectorText).toContain('.spent');
    });

    it('shrinks the host to a square badge below 560px (width == height, not a tall pill)', () => {
      const el = document.createElement('slicc-floatbar');
      document.body.appendChild(el);
      const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];

      // The wide-view :host carries the control height but no explicit width, so
      // it grows to fit its content (an elongated pill in the dot-only state).
      const baseHost = Array.from(sheet.cssRules).find(
        (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ':host'
      );
      const baseHeight = baseHost?.style.getPropertyValue('height').trim();
      expect(baseHeight).toBe('var(--ctl-h, 30px)');
      expect(baseHost?.style.getPropertyValue('width').trim()).toBe('');

      // The narrow :host pins width to that same height token (and reinforces it
      // with aspect-ratio), so the rendered box is square — a round badge.
      const narrowHost = Array.from(narrowMedia(el).cssRules).find(
        (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ':host'
      );
      const narrowWidth = narrowHost?.style.getPropertyValue('width').trim();
      expect(narrowWidth).toBe('var(--ctl-h, 30px)');
      // width longhand matches the base height longhand → square (1:1) box.
      expect(narrowWidth).toBe(baseHeight);
      expect(narrowHost?.style.getPropertyValue('aspect-ratio').trim()).toBe('1 / 1');
    });
  });
});
