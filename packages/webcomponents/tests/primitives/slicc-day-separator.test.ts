import { beforeEach, describe, expect, it } from 'vitest';
import { SliccDaySeparator } from '../../src/primitives/slicc-day-separator.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/**
 * Extract the alpha channel from a computed `background-color` string.
 * `rgb(...)` (no alpha) is fully opaque → 1; `rgba(r, g, b, a)` → a.
 */
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
      // .08em letter-spacing at 11px resolves to ~0.88px.
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
      // flex:1 hairlines fill each side, so each is well over zero width.
      expect(parseFloat(before.width)).toBeGreaterThan(50);
      expect(parseFloat(after.width)).toBeGreaterThan(50);
      // light-mode --line is #e5e5e5.
      expect(before.backgroundColor).toBe('rgb(229, 229, 229)');
    });

    it('renders BOTH hairlines with non-zero width and a non-transparent fill', () => {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', 'Today');
      document.body.appendChild(el);
      el.style.width = '400px';

      // The host itself must be flex for the pseudo-elements to lay out as lines.
      expect(getComputedStyle(el).display).toBe('flex');

      for (const pseudo of ['::before', '::after'] as const) {
        const line = getComputedStyle(el, pseudo);
        // The line is visibly present: it has content, height and width.
        expect(line.content).toBe('""');
        expect(parseFloat(line.height)).toBe(1);
        expect(parseFloat(line.width)).toBeGreaterThan(0);
        // ...and it is actually painted — the background is opaque, not transparent.
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

      // dark --txt-3 is #6c6c72, dark --line is #2a2a2e.
      expect(getComputedStyle(el).color).toBe('rgb(108, 108, 114)');
      expect(getComputedStyle(el, '::before').backgroundColor).toBe('rgb(42, 42, 46)');
    });
  });
});
