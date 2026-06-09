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
});
