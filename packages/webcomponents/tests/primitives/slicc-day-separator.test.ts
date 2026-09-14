import { beforeEach, describe, expect, it } from 'vitest';
import { SliccDaySeparator } from '../../src/primitives/slicc-day-separator.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

function alphaOf(color: string): number {
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return 1;
  const parts = m[1].split(',').map((p) => p.trim());
  return parts.length === 4 ? Number.parseFloat(parts[3]) : 1;
}

describe('slicc-day-separator', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-day-separator')).toBe(SliccDaySeparator);
  });

  it('renders a labelled caption in its shadow root', () => {
    const el = document.createElement('slicc-day-separator');
    el.setAttribute('label', 'Today');
    document.body.appendChild(el);
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.textContent).toBe('Today');
    expect(label?.getAttribute('part')).toBe('label');
  });

  it('reflects the label attribute to the property and back', () => {
    const el = document.createElement('slicc-day-separator');
    el.label = 'researcher scoop';
    document.body.appendChild(el);
    expect(el.getAttribute('label')).toBe('researcher scoop');
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('researcher scoop');

    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
  });

  it('renders a default slot when no label is set', () => {
    const el = document.createElement('slicc-day-separator');
    el.textContent = 'designer scoop';
    document.body.appendChild(el);
    const slot = el.shadowRoot?.querySelector('slot') as HTMLSlotElement;
    expect(slot).toBeTruthy();
    expect(
      slot
        .assignedNodes()
        .map((n) => n.textContent)
        .join('')
    ).toBe('designer scoop');
  });

  it('escapes label text', () => {
    const el = document.createElement('slicc-day-separator');
    el.label = '<script>x</script>';
    document.body.appendChild(el);
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.querySelector('script')).toBeNull();
    expect(label?.textContent).toBe('<script>x</script>');
  });

  describe('variants / states', () => {
    it.each([
      ['Today', 'Today'],
      ['scoop thread', 'tester scoop'],
      ['frozen session', 'hero redesign · frozen'],
    ])('renders the %s variant', (_name, label) => {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', label);
      document.body.appendChild(el);
      expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe(label);
    });
  });

  describe('appearance (real Chromium)', () => {
    it('lays out as a flex row with uppercased 11px label text', () => {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      document.body.appendChild(el);
      const host = getComputedStyle(el);
      expect(host.display).toBe('flex');
      expect(host.alignItems).toBe('center');
      expect(host.fontSize).toBe('11px');
      expect(host.textTransform).toBe('uppercase');

      expect(parseFloat(host.letterSpacing)).toBeCloseTo(0.88, 1);
    });

    it('draws full-width 1px hairlines via ::before / ::after using --line', () => {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      document.body.appendChild(el);
      el.style.width = '400px';

      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      expect(before.content).toBe('""');
      expect(after.content).toBe('""');
      expect(before.height).toBe('1px');
      expect(after.height).toBe('1px');

      expect(parseFloat(before.width)).toBeGreaterThan(50);
      expect(parseFloat(after.width)).toBeGreaterThan(50);

      expect(before.backgroundColor).toBe('rgb(229, 229, 229)');
    });

    it('renders BOTH hairlines with non-zero width and a non-transparent fill', () => {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      document.body.appendChild(el);
      el.style.width = '400px';

      expect(getComputedStyle(el).display).toBe('flex');

      for (const pseudo of ['::before', '::after'] as const) {
        const line = getComputedStyle(el, pseudo);

        expect(line.content).toBe('""');
        expect(parseFloat(line.height)).toBe(1);
        expect(parseFloat(line.width)).toBeGreaterThan(0);

        expect(line.backgroundColor).not.toBe('transparent');
        expect(line.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
        const alpha = alphaOf(line.backgroundColor);
        expect(alpha).toBeGreaterThan(0);
      }
    });

    it('flips hairline + text colors in dark mode via inherited tokens', () => {
      setTheme('dark');
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      document.body.appendChild(el);

      expect(getComputedStyle(el).color).toBe('rgb(108, 108, 114)');
      expect(getComputedStyle(el, '::before').backgroundColor).toBe('rgb(42, 42, 46)');
    });

    it('keeps the hairline visible against the themed --bg ground in dark mode', () => {
      setTheme('dark');
      const wrap = document.createElement('div');
      wrap.style.background = 'var(--bg)';
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      wrap.appendChild(el);
      el.style.width = '400px';

      const lineBg = getComputedStyle(el, '::before').backgroundColor;
      const groundBg = getComputedStyle(wrap).backgroundColor;

      expect(lineBg).not.toBe(groundBg);

      const channels = (c: string) =>
        (c.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
      const [lr, lg, lb] = channels(lineBg);
      const [gr, gg, gb] = channels(groundBg);

      expect(lr).toBeGreaterThan(gr);
      expect(lg).toBeGreaterThan(gg);
      expect(lb).toBeGreaterThan(gb);
    });
  });
});
